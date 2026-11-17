import { decodeContainer, inspectContainer, ldNetworks, parseLdNetwork, parseLocalVariables, propertyValue, sections } from './containers.js';
import { readDuts, readTasks } from './authoring.js';
import { netToIl, parseNetworks } from './mpu2il.js';
import { Instruction } from './il2mpu.js';
import { FileTransformError, computeContentHash, decodeCodepage } from './limits.js';
import { evaluateSafeNumericExpr } from './safeExpr.js';
import {
  MemoryBreakdown,
  NetworkTimingSummary,
  PouTimingSummary,
  ScanSample,
  analyzeSimulationDiagnostics,
  computeMemoryBreakdown,
} from './simDiagnostics.js';
import { readFileBuffer } from './workspace.js';

export interface SimNetworkTrace {
  pou: string;
  network_index: number;
  net_id: string;
  label?: string;
  active: boolean;
  energized: boolean;
  il: string[];
  outputs_written: Record<string, boolean | number>;
}

export interface SimStTrace {
  pou: string;
  statements_executed: number;
  outputs_written: Record<string, boolean | number>;
}

export interface WatchSample {
  scan_count: number;
  elapsed_ms: number;
  values: Record<string, boolean | number>;
}

export interface TimerState {
  pv: number;
  sv: number;
  done: boolean;
  prevIn: boolean;
  accMs: number;
  baseMs: number;
}

export interface CounterState {
  pv: number;
  sv: number;
  done: boolean;
  prevIn: boolean;
}

export interface BreakpointRule {
  id: string;
  expr: string;
  enabled: boolean;
  hit_count: number;
  last_hit_scan: number | null;
}

export interface SimLocalVarMeta {
  identifier: string;
  type: string;
  address: string | null;
  varClass: string;
  initial: number | boolean;
}

export interface SimPouProgram {
  name: string;
  lang: string;
  pouType: string;
  active: boolean;
  localVars: SimLocalVarMeta[];
  networks: Array<{ index: number; net_id: string; label: string; active: boolean; il: Instruction[] }>;
  stCode: string;
}

export interface SimulatorDiagnosticsState {
  total_scans_profiled: number;
  overrun_count: number;
  total_scan_exec_ms: number;
  min_scan_ms: number | null;
  max_scan_ms: number;
  last_scan_ms: number;
  scan_history: ScanSample[];
  pou_metrics: Map<string, PouTimingSummary>;
  network_metrics: Map<string, NetworkTimingSummary>;
  baseline_words_count: number;
  baseline_bits_count: number;
  baseline_state_bytes: number;
  baseline_heap_used_bytes: number;
}

export interface SimulatorSession {
  session_id: string;
  project_path: string;
  project_hash: string;
  model: string;
  mode: 'STOP' | 'RUN';
  scan_count: number;
  elapsed_ms: number;
  scan_interval_ms: number;
  raw_isp_bytes: Buffer;
  bits: Map<string, boolean>;
  prevBits: Map<string, boolean>;
  edgeStates: Map<string, boolean>;
  words: Map<string, number>;
  forcedBits: Map<string, boolean>;
  forcedWords: Map<string, number>;
  timers: Map<string, TimerState>;
  counters: Map<string, CounterState>;
  symbols: Map<string, { address: string | null; type: string; value: number | boolean; initial: number | boolean }>;
  dutFields: Map<string, string[]>;
  tasks: ReturnType<typeof readTasks>;
  pouPrograms: SimPouProgram[];
  lastRungTrace: SimNetworkTrace[];
  lastStTrace: SimStTrace[];
  watchLists: Map<string, string[]>;
  traceBuffer: WatchSample[];
  breakpoints: BreakpointRule[];
  lastBreakpointHit: BreakpointRule | null;
  diagnostics: SimulatorDiagnosticsState;
  created_at: string;
  last_scan_at: string | null;
  last_touched_at_ms: number;
}

const sessions = new Map<string, SimulatorSession>();
const runTimers = new Map<string, NodeJS.Timeout>();
let nextSimId = 1;
let nextBpId = 1;

const MAX_CONTINUOUS_RUN_TICKS = 6000;
const MAX_SIM_MEMORY_KEYS = 100_000;

function maxSimSessions(): number {
  const n = Number(process.env.ISPSOFT_SIM_MAX_SESSIONS || 32);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 32;
}

function simIdleTtlMs(): number {
  const n = Number(process.env.ISPSOFT_SIM_IDLE_TTL_MS || 30 * 60 * 1000);
  return Number.isFinite(n) && n >= 1000 ? Math.trunc(n) : 30 * 60 * 1000;
}

export function reapIdleSimulatorSessions(now = Date.now()): string[] {
  const ttl = simIdleTtlMs();
  const reaped: string[] = [];
  for (const [id, sess] of sessions.entries()) {
    if (sess.mode !== 'RUN' && now - sess.last_touched_at_ms > ttl) {
      clearRunTimer(id);
      sessions.delete(id);
      reaped.push(id);
    }
  }
  return reaped;
}

export function shutdownAllSimulators(): number {
  const count = sessions.size;
  for (const id of [...sessions.keys()]) {
    clearRunTimer(id);
    sessions.delete(id);
  }
  return count;
}

function clearRunTimer(sessionId: string): void {
  const existing = runTimers.get(sessionId);
  if (existing) {
    clearInterval(existing);
    runTimers.delete(sessionId);
  }
}

function startRunTimer(sess: SimulatorSession): void {
  clearRunTimer(sess.session_id);
  let autoTicks = 0;
  const period = Math.max(25, Math.min(2000, sess.scan_interval_ms));
  const timer = setInterval(() => {
    const live = sessions.get(sess.session_id);
    if (!live || live.mode !== 'RUN' || autoTicks >= MAX_CONTINUOUS_RUN_TICKS) {
      if (live && autoTicks >= MAX_CONTINUOUS_RUN_TICKS) {
        live.mode = 'STOP';
      }
      clearRunTimer(sess.session_id);
      return;
    }
    autoTicks += 1;
    stepSimulator(sess.session_id, 1);
  }, period);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runTimers.set(sess.session_id, timer);
}

function normAddr(addr: string): string {
  return addr.trim().toUpperCase();
}

function toInt16(n: number): number {
  const v = Math.trunc(n) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
}

function toInt32(n: number): number {
  return Math.trunc(n) | 0;
}

function timerTimebaseMs(timerAddr: string): number {
  const m = /^T(\d+)$/i.exec(timerAddr.trim());
  if (!m) return 100;
  const num = parseInt(m[1], 10);
  if (num >= 246) return 1;
  if (num >= 200) return 10;
  return 100;
}

function is32BitCounter(addr: string): boolean {
  const m = /^C(\d+)$/i.exec(addr.trim());
  if (!m) return false;
  const num = parseInt(m[1], 10);
  return num >= 200 && num <= 255;
}

function parseBitOfWord(addr: string): { wordAddr: string; bitIdx: number } | null {
  const m = /^([DRVZ]\d+)\.([0-9]|1[0-5]|[A-Fa-f])$/i.exec(addr.trim());
  if (!m) return null;
  const rawBit = m[2];
  const bitIdx = /^[0-9]+$/.test(rawBit) ? parseInt(rawBit, 10) : parseInt(rawBit, 16);
  if (bitIdx < 0 || bitIdx > 15) return null;
  return { wordAddr: m[1].toUpperCase(), bitIdx };
}

function resolveSymbol(sess: SimulatorSession, name: string) {
  const trimmed = name.trim();
  if (sess.symbols.has(trimmed)) {
    return { key: trimmed, entry: sess.symbols.get(trimmed)! };
  }
  const upper = trimmed.toUpperCase();
  for (const [k, v] of sess.symbols.entries()) {
    if (k.toUpperCase() === upper) {
      return { key: k, entry: v };
    }
  }
  return null;
}

function resolveHardwareOrWordKey(sess: SimulatorSession, rawName: string): string {
  const resolved = resolveSymbol(sess, rawName);
  if (resolved?.entry.address) {
    return normAddr(resolved.entry.address);
  }
  return normAddr(rawName);
}

function isBitAddress(addr: string): boolean {
  const t = addr.trim();
  return /^(X|Y|M|S)\d+$/i.test(t) || parseBitOfWord(t) !== null;
}

function parseConst(token: string, sess: SimulatorSession): number {
  const t = token.trim();
  if (/^[Kk](-?\d+)$/.test(t)) return parseInt(t.slice(1), 10);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[Hh]([0-9A-Fa-f]+)$/.test(t)) return parseInt(t.slice(1), 16);
  if (parseBitOfWord(t)) return readBit(sess, t) ? 1 : 0;
  const sym = resolveSymbol(sess, t);
  if (sym) {
    if (sym.entry.address) {
      return isBitAddress(sym.entry.address)
        ? readBit(sess, sym.entry.address) ? 1 : 0
        : readWord(sess, sym.entry.address);
    }
    return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? 1 : 0) : Number(sym.entry.value);
  }
  return readWord(sess, t);
}

function readBit(sess: SimulatorSession, rawAddr: string): boolean {
  const addr = normAddr(rawAddr);
  if (sess.forcedBits.has(addr)) return sess.forcedBits.get(addr)!;

  const bow = parseBitOfWord(addr);
  if (bow) {
    const w = readWord(sess, bow.wordAddr);
    return ((w >>> bow.bitIdx) & 1) === 1;
  }

  const dotT = /^(T\d+)\.(Q|DONE)$/i.exec(addr);
  if (dotT) {
    if (sess.forcedBits.has(dotT[1])) return sess.forcedBits.get(dotT[1])!;
    return sess.timers.get(dotT[1])?.done ?? false;
  }
  const dotC = /^(C\d+)\.(Q|DONE)$/i.exec(addr);
  if (dotC) {
    if (sess.forcedBits.has(dotC[1])) return sess.forcedBits.get(dotC[1])!;
    return sess.counters.get(dotC[1])?.done ?? false;
  }

  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) return readBit(sess, sym.entry.address);
    return Boolean(sym.entry.value);
  }
  if (/^T\d+$/.test(addr)) {
    return sess.timers.get(addr)?.done ?? false;
  }
  if (/^C\d+$/.test(addr)) {
    return sess.counters.get(addr)?.done ?? false;
  }
  return sess.bits.get(addr) ?? false;
}

function writeBit(sess: SimulatorSession, rawAddr: string, val: boolean): void {
  const addr = normAddr(rawAddr);
  if (sess.forcedBits.has(addr)) return;

  const bow = parseBitOfWord(addr);
  if (bow) {
    const cur = readWord(sess, bow.wordAddr) & 0xffff;
    const next = val ? (cur | (1 << bow.bitIdx)) : (cur & ~(1 << bow.bitIdx));
    writeWord(sess, bow.wordAddr, toInt16(next));
    return;
  }

  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) {
      writeBit(sess, sym.entry.address, val);
      return;
    }
    sym.entry.value = val;
    sess.bits.set(normAddr(sym.key), val);
    return;
  }
  if (/^T\d+$/.test(addr)) {
    const t = sess.timers.get(addr) ?? {
      pv: 0,
      sv: 0,
      done: false,
      prevIn: false,
      accMs: 0,
      baseMs: timerTimebaseMs(addr),
    };
    t.done = val;
    sess.timers.set(addr, t);
    return;
  }
  if (/^C\d+$/.test(addr)) {
    const c = sess.counters.get(addr) ?? { pv: 0, sv: 0, done: false, prevIn: false };
    c.done = val;
    sess.counters.set(addr, c);
    return;
  }
  if (!sess.bits.has(addr) && sess.bits.size >= MAX_SIM_MEMORY_KEYS) {
    throw new FileTransformError(`Simulator bit memory limit reached (${MAX_SIM_MEMORY_KEYS} keys)`);
  }
  sess.bits.set(addr, val);
}

function readWord(sess: SimulatorSession, rawAddr: string): number {
  const addr = normAddr(rawAddr);
  if (sess.forcedWords.has(addr)) return sess.forcedWords.get(addr)!;

  const dotT = /^(T\d+)\.PV$/i.exec(addr);
  if (dotT) {
    if (sess.forcedWords.has(dotT[1])) return sess.forcedWords.get(dotT[1])!;
    return sess.timers.get(dotT[1])?.pv ?? 0;
  }
  const dotC = /^(C\d+)\.PV$/i.exec(addr);
  if (dotC) {
    if (sess.forcedWords.has(dotC[1])) return sess.forcedWords.get(dotC[1])!;
    return sess.counters.get(dotC[1])?.pv ?? 0;
  }

  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) return readWord(sess, sym.entry.address);
    return Number(sym.entry.value) || 0;
  }
  if (/^T\d+$/.test(addr)) {
    return sess.timers.get(addr)?.pv ?? 0;
  }
  if (/^C\d+$/.test(addr)) {
    return sess.counters.get(addr)?.pv ?? 0;
  }
  return sess.words.get(addr) ?? 0;
}

function writeWord(sess: SimulatorSession, rawAddr: string, val: number): void {
  const addr = normAddr(rawAddr);
  if (sess.forcedWords.has(addr)) return;
  const intVal = Math.trunc(val);
  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) {
      writeWord(sess, sym.entry.address, intVal);
      return;
    }
    sym.entry.value = intVal;
    sess.words.set(normAddr(sym.key), intVal);
    return;
  }
  if (/^T\d+$/.test(addr)) {
    const t = sess.timers.get(addr) ?? {
      pv: 0,
      sv: 0,
      done: false,
      prevIn: false,
      accMs: 0,
      baseMs: timerTimebaseMs(addr),
    };
    t.pv = intVal;
    sess.timers.set(addr, t);
    return;
  }
  if (/^C\d+$/.test(addr)) {
    const c = sess.counters.get(addr) ?? { pv: 0, sv: 0, done: false, prevIn: false };
    c.pv = intVal;
    sess.counters.set(addr, c);
    return;
  }
  if (!sess.words.has(addr) && sess.words.size >= MAX_SIM_MEMORY_KEYS) {
    throw new FileTransformError(`Simulator word memory limit reached (${MAX_SIM_MEMORY_KEYS} keys)`);
  }
  sess.words.set(addr, intVal);
}

function shiftIndexedDevice(addr: string, offset: number): string {
  const m = /^([A-Z]+)(\d+)$/i.exec(addr.trim());
  if (!m) return normAddr(addr);
  const area = m[1].toUpperCase();
  const base = area === 'X' || area === 'Y' ? parseInt(m[2], 8) : parseInt(m[2], 10);
  const next = base + offset;
  return area === 'X' || area === 'Y' ? `${area}${next.toString(8).toUpperCase()}` : `${area}${next}`;
}

function readDWord(sess: SimulatorSession, token: string): number {
  const t = token.trim();
  if (/^[Kk](-?\d+)$/.test(t) || /^-?\d+$/.test(t) || /^[Hh]([0-9A-Fa-f]+)$/.test(t)) {
    return toInt32(parseConst(t, sess));
  }
  const key = resolveHardwareOrWordKey(sess, t);
  if (is32BitCounter(key)) {
    return toInt32(readWord(sess, key));
  }
  if (/^[DRVZ]\d+$/i.test(key)) {
    const lo = readWord(sess, key) & 0xffff;
    const hi = readWord(sess, shiftIndexedDevice(key, 1)) & 0xffff;
    return toInt32((hi << 16) | lo);
  }
  return toInt32(readWord(sess, key));
}

function writeDWord(sess: SimulatorSession, rawAddr: string, val: number): void {
  const v32 = toInt32(val);
  const key = resolveHardwareOrWordKey(sess, rawAddr);
  if (is32BitCounter(key)) {
    writeWord(sess, key, v32);
    return;
  }
  if (/^[DRVZ]\d+$/i.test(key)) {
    writeWord(sess, key, toInt16(v32 & 0xffff));
    writeWord(sess, shiftIndexedDevice(key, 1), toInt16((v32 >>> 16) & 0xffff));
    return;
  }
  writeWord(sess, key, v32);
}

function getSession(sessionId: string): SimulatorSession {
  const sess = sessions.get(sessionId);
  if (!sess) {
    throw new FileTransformError(`Unknown simulator session ${JSON.stringify(sessionId)}`);
  }
  sess.last_touched_at_ms = Date.now();
  return sess;
}

function parseProjectForSim(rawBytes: Buffer) {
  const container = decodeContainer(rawBytes);
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const tasks = readTasks(text);

  const dutFields = new Map<string, string[]>();
  const dutFieldMeta = new Map<string, Array<{ name: string; type: string }>>();
  for (const dut of readDuts(text)) {
    const fields: string[] = [];
    const metas: Array<{ name: string; type: string }> = [];
    for (const line of dut.content.split(/\r?\n/)) {
      const fm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line.trim());
      if (fm && fm[1].toUpperCase() !== 'TYPE' && fm[1].toUpperCase() !== 'END_STRUCT') {
        fields.push(fm[1]);
        metas.push({ name: fm[1], type: fm[2].toUpperCase() });
      }
    }
    dutFields.set(dut.name, fields);
    dutFieldMeta.set(dut.name, metas);
  }

  const symbols: SimulatorSession['symbols'] = new Map();
  const registerStructSubfields = (identifier: string, entryType: string) => {
    const metas = dutFieldMeta.get(entryType);
    if (!metas) return;
    for (const f of metas) {
      const fBool = f.type === 'BOOL';
      symbols.set(`${identifier}.${f.name}`, {
        address: null,
        type: f.type,
        value: fBool ? false : 0,
        initial: fBool ? false : 0,
      });
    }
  };

  const globalSecs = sections(text, 'GLOBAL_VAR');
  for (const gs of globalSecs) {
    const parsed = parseLocalVariables(gs.inner);
    for (const entry of parsed.entries) {
      const initToken = entry.initial_value.replace(/\[@[^\]]+@\]/g, '').trim();
      const isBool = entry.type.toUpperCase() === 'BOOL';
      const initNum = /^-?\d+$/.test(initToken) ? parseInt(initToken, 10) : /^TRUE$/i.test(initToken) ? 1 : 0;
      const initVal = isBool ? Boolean(initNum) : initNum;
      symbols.set(entry.identifier, {
        address: entry.address,
        type: entry.type,
        value: initVal,
        initial: initVal,
      });
      registerStructSubfields(entry.identifier, entry.type);
    }
  }

  const pouPrograms: SimPouProgram[] = [];
  for (const pouMatch of sections(text, 'POU')) {
    const name = propertyValue(pouMatch.inner, 'P_Name') ?? 'Unknown';
    const lang = propertyValue(pouMatch.inner, 'P_Lang') ?? '1';
    const pouType = propertyValue(pouMatch.inner, 'P_type') ?? '0';
    const active = (propertyValue(pouMatch.inner, 'P_Active') ?? 'TRUE').trim().toUpperCase() !== 'FALSE';
    const localVarSec = sections(pouMatch.inner, 'LOCAL_VAR')[0]?.inner ?? '';
    const parsedLocal = parseLocalVariables(localVarSec);
    const localVars: SimLocalVarMeta[] = [];

    for (const entry of parsedLocal.entries) {
      const initToken = entry.initial_value.replace(/\[@[^\]]+@\]/g, '').trim();
      const isBool = entry.type.toUpperCase() === 'BOOL';
      const initNum = /^-?\d+$/.test(initToken) ? parseInt(initToken, 10) : /^TRUE$/i.test(initToken) ? 1 : 0;
      const initVal = isBool ? Boolean(initNum) : initNum;
      localVars.push({
        identifier: entry.identifier,
        type: entry.type,
        address: entry.address,
        varClass: entry.class,
        initial: initVal,
      });
      symbols.set(entry.identifier, {
        address: entry.address,
        type: entry.type,
        value: initVal,
        initial: initVal,
      });
      registerStructSubfields(entry.identifier, entry.type);
    }

    const networks: SimPouProgram['networks'] = [];
    if (lang === '1') {
      const rawNets = ldNetworks(pouMatch.inner);
      rawNets.forEach((raw, idx) => {
        const parsed = parseLdNetwork(raw);
        const netId = parsed.properties.NET_ID ?? parsed.properties.NetworkID ?? String(idx + 1);
        const label = (parsed.properties.NET_LABEL ?? '').trim();
        const netActive = (parsed.properties.NET_ACTIVE ?? 'TRUE').toUpperCase() !== 'FALSE';
        let il: Instruction[] = [];
        try {
          const parsedIl = parseNetworks(`<NETWORK_START>\n${raw}\n<NETWORK_END>`);
          if (parsedIl.length === 1) {
            il = netToIl(parsedIl[0]);
          }
        } catch {
          il = [];
        }
        networks.push({ index: idx + 1, net_id: netId, label, active: netActive, il });
      });
    }
    const stCode = sections(pouMatch.inner, 'IL_ST_CODE')[0]?.inner ?? '';
    pouPrograms.push({ name, lang, pouType, active, localVars, networks, stCode });
  }

  return { info, tasks, symbols, dutFields, pouPrograms };
}

function seedInitialSymbolMemory(sess: SimulatorSession): void {
  for (const [name, sym] of sess.symbols.entries()) {
    sym.value = sym.initial;
    if (sym.address) {
      if (isBitAddress(sym.address) || sym.type.toUpperCase() === 'BOOL') {
        sess.bits.set(normAddr(sym.address), Boolean(sym.initial));
      } else {
        sess.words.set(normAddr(sym.address), Number(sym.initial) || 0);
      }
    } else if (sym.type.toUpperCase() === 'BOOL') {
      sess.bits.set(normAddr(name), Boolean(sym.initial));
    } else {
      sess.words.set(normAddr(name), Number(sym.initial) || 0);
    }
  }
}

function computeSessionMemoryBreakdown(sess: SimulatorSession): MemoryBreakdown {
  let traceSampleValueKeysCount = 0;
  for (const sample of sess.traceBuffer) {
    traceSampleValueKeysCount += Object.keys(sample.values).length;
  }
  return computeMemoryBreakdown({
    bitsKeys: [...sess.bits.keys()],
    prevBitsCount: sess.prevBits.size,
    edgeStatesCount: sess.edgeStates.size,
    wordsKeys: [...sess.words.keys()],
    forcedBitsCount: sess.forcedBits.size,
    forcedWordsCount: sess.forcedWords.size,
    timersCount: sess.timers.size,
    countersCount: sess.counters.size,
    symbolsCount: sess.symbols.size,
    dutFieldsCount: sess.dutFields.size,
    traceBufferLength: sess.traceBuffer.length,
    traceSampleValueKeysCount,
    lastRungTraceCount: sess.lastRungTrace.length,
    lastStTraceCount: sess.lastStTrace.length,
    scanHistoryLength: sess.diagnostics?.scan_history.length ?? 0,
    rawIspBytes: sess.raw_isp_bytes.length,
  });
}

function createInitialDiagnosticsState(): SimulatorDiagnosticsState {
  return {
    total_scans_profiled: 0,
    overrun_count: 0,
    total_scan_exec_ms: 0,
    min_scan_ms: null,
    max_scan_ms: 0,
    last_scan_ms: 0,
    scan_history: [],
    pou_metrics: new Map(),
    network_metrics: new Map(),
    baseline_words_count: 0,
    baseline_bits_count: 0,
    baseline_state_bytes: 0,
    baseline_heap_used_bytes: process.memoryUsage().heapUsed,
  };
}

function captureDiagnosticsBaseline(sess: SimulatorSession): void {
  const mem = computeSessionMemoryBreakdown(sess);
  sess.diagnostics.baseline_words_count = sess.words.size;
  sess.diagnostics.baseline_bits_count = sess.bits.size;
  sess.diagnostics.baseline_state_bytes = mem.estimated_bytes.total_simulator_state;
  sess.diagnostics.baseline_heap_used_bytes = process.memoryUsage().heapUsed;
}

function resetDiagnosticsState(sess: SimulatorSession): void {
  sess.diagnostics = createInitialDiagnosticsState();
  captureDiagnosticsBaseline(sess);
}

export function listSimulatorSessions() {
  reapIdleSimulatorSessions();
  return [...sessions.values()].map((s) => ({
    session_id: s.session_id,
    project_path: s.project_path,
    model: s.model,
    mode: s.mode,
    scan_count: s.scan_count,
    elapsed_ms: s.elapsed_ms,
    last_scan_ms: Math.round(s.diagnostics.last_scan_ms * 1000) / 1000,
    breakpoint_count: s.breakpoints.length,
    created_at: s.created_at,
  }));
}

export function startSimulatorSession(projectPath: string, scanIntervalMs = 100): SimulatorSession {
  reapIdleSimulatorSessions();
  const cap = maxSimSessions();
  if (sessions.size >= cap) {
    throw new FileTransformError(
      `Maximum active simulator sessions (${cap}) reached; close an idle session via ispsoft_sim_control CLOSE.`,
    );
  }
  const rawBytes = readFileBuffer(projectPath);
  const { info, tasks, symbols, dutFields, pouPrograms } = parseProjectForSim(rawBytes);

  const sessionId = `sim-${nextSimId++}`;
  const defaultWatch = ['X0', 'X1', 'Y0', 'M0', 'M10', 'T0', 'D10', 'D100'];
  for (const symName of symbols.keys()) {
    if (!defaultWatch.includes(symName) && defaultWatch.length < 16) {
      defaultWatch.push(symName);
    }
  }

  const nowMs = Date.now();
  const session: SimulatorSession = {
    session_id: sessionId,
    project_path: projectPath,
    project_hash: computeContentHash('isp', rawBytes),
    model: String(info.project_model ?? 'ES2'),
    mode: 'STOP',
    scan_count: 0,
    elapsed_ms: 0,
    scan_interval_ms: Math.max(10, Math.min(10_000, scanIntervalMs)),
    raw_isp_bytes: rawBytes,
    bits: new Map([['M1000', true], ['M1001', false], ['M1002', true], ['M1003', false]]),
    prevBits: new Map(),
    edgeStates: new Map(),
    words: new Map(),
    forcedBits: new Map(),
    forcedWords: new Map(),
    timers: new Map(),
    counters: new Map(),
    symbols,
    dutFields,
    tasks,
    pouPrograms,
    lastRungTrace: [],
    lastStTrace: [],
    watchLists: new Map([['default', defaultWatch]]),
    traceBuffer: [],
    breakpoints: [],
    lastBreakpointHit: null,
    diagnostics: createInitialDiagnosticsState(),
    created_at: new Date(nowMs).toISOString(),
    last_scan_at: null,
    last_touched_at_ms: nowMs,
  };
  seedInitialSymbolMemory(session);
  captureDiagnosticsBaseline(session);
  sessions.set(sessionId, session);
  return session;
}

export function reloadSimulatorSession(sessionId: string, projectPath?: string, resetState = false) {
  const sess = getSession(sessionId);
  const targetPath = projectPath?.trim() || sess.project_path;
  const rawBytes = readFileBuffer(targetPath);
  const { info, tasks, symbols, dutFields, pouPrograms } = parseProjectForSim(rawBytes);

  sess.project_path = targetPath;
  sess.project_hash = computeContentHash('isp', rawBytes);
  sess.model = String(info.project_model ?? sess.model);
  sess.raw_isp_bytes = rawBytes;
  sess.tasks = tasks;
  sess.pouPrograms = pouPrograms;
  sess.dutFields = dutFields;
  sess.symbols = symbols;
  sess.edgeStates.clear();

  if (resetState) {
    clearRunTimer(sessionId);
    sess.mode = 'STOP';
    sess.scan_count = 0;
    sess.elapsed_ms = 0;
    sess.bits = new Map([['M1000', true], ['M1001', false], ['M1002', true], ['M1003', false]]);
    sess.prevBits.clear();
    sess.words.clear();
    sess.timers.clear();
    sess.counters.clear();
    sess.forcedBits.clear();
    sess.forcedWords.clear();
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.traceBuffer = [];
    sess.lastBreakpointHit = null;
    seedInitialSymbolMemory(sess);
    resetDiagnosticsState(sess);
  } else {
    // Clear stale POU/network timing buckets so reloaded code is measured cleanly
    resetDiagnosticsState(sess);
  }
  return monitorSimulator(sessionId);
}

function evalContact(sess: SimulatorSession, op: string, ops: string[]): boolean {
  const addr = ops[0] ?? '';
  if (op === 'LD' || op === 'AND' || op === 'OR') return readBit(sess, addr);
  if (op === 'LDI' || op === 'ANI' || op === 'ORI') return !readBit(sess, addr);
  if (op === 'LDP' || op === 'ANDP' || op === 'ORP') {
    const cur = readBit(sess, addr);
    const prev = sess.prevBits.get(resolveHardwareOrWordKey(sess, addr)) ?? false;
    return cur && !prev;
  }
  if (op === 'LDF' || op === 'ANDF' || op === 'ORF') {
    const cur = readBit(sess, addr);
    const prev = sess.prevBits.get(resolveHardwareOrWordKey(sess, addr)) ?? false;
    return !cur && prev;
  }
  const a = parseConst(ops[0] ?? '0', sess);
  const b = parseConst(ops[1] ?? '0', sess);
  if (op.endsWith('<=')) return a <= b;
  if (op.endsWith('=')) return a === b;
  if (op.endsWith('>')) return a > b;
  if (op.endsWith('<')) return a < b;
  return false;
}

const INPUT_OPS = new Set([
  'LD', 'LDI', 'LDP', 'LDF', 'AND', 'ANI', 'ANDP', 'ANDF', 'OR', 'ORI', 'ORP', 'ORF',
  'LD=', 'LD<=', 'LD>', 'LD<', 'AND=', 'AND<=', 'AND>', 'AND<', 'ANB', 'ORB',
]);

function execOutputInstruction(
  sess: SimulatorSession,
  pouName: string,
  netIndex: number,
  op: string,
  ops: string[],
  powerIn: boolean,
  outputsWritten: Record<string, boolean | number>,
  flow?: {
    jumpToLabel?: string;
    callTarget?: string;
    subReturn?: boolean;
    endMain?: boolean;
  },
): void {
  if (op === 'SRET') {
    if (flow) flow.subReturn = true;
    return;
  }
  if (op === 'FEND') {
    if (flow) flow.endMain = true;
    return;
  }
  if (op === 'WDT') {
    return;
  }
  if (op === 'OUT') {
    writeBit(sess, ops[0], powerIn);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'SET') {
    if (powerIn) writeBit(sess, ops[0], true);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'RST') {
    if (powerIn) {
      const target = resolveHardwareOrWordKey(sess, ops[0]);
      if (/^T\d+$/.test(target)) {
        sess.timers.set(target, {
          pv: 0,
          sv: sess.timers.get(target)?.sv ?? 0,
          done: false,
          prevIn: false,
          accMs: 0,
          baseMs: timerTimebaseMs(target),
        });
        outputsWritten[target] = 0;
        outputsWritten[`${target}.Q`] = false;
      } else if (/^C\d+$/.test(target)) {
        sess.counters.set(target, { pv: 0, sv: sess.counters.get(target)?.sv ?? 0, done: false, prevIn: false });
        outputsWritten[target] = 0;
        outputsWritten[`${target}.Q`] = false;
      } else if (parseBitOfWord(target)) {
        writeBit(sess, target, false);
        outputsWritten[target] = false;
      } else {
        writeBit(sess, target, false);
        writeWord(sess, target, 0);
        outputsWritten[target] = false;
      }
    }
    return;
  }
  if (op === 'PLS') {
    const key = `${pouName}:${netIndex}:PLS:${normAddr(ops[0])}`;
    const prev = sess.edgeStates.get(key) ?? false;
    const pulse = powerIn && !prev;
    sess.edgeStates.set(key, powerIn);
    writeBit(sess, ops[0], pulse);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'PLF') {
    const key = `${pouName}:${netIndex}:PLF:${normAddr(ops[0])}`;
    const prev = sess.edgeStates.get(key) ?? false;
    const pulse = !powerIn && prev;
    sess.edgeStates.set(key, powerIn);
    writeBit(sess, ops[0], pulse);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'TMR') {
    const tAddr = normAddr(ops[0]);
    const sv = Math.max(0, parseConst(ops[1] ?? '0', sess));
    const baseMs = timerTimebaseMs(tAddr);
    const t = sess.timers.get(tAddr) ?? { pv: 0, sv, done: false, prevIn: false, accMs: 0, baseMs };
    t.sv = sv;
    t.baseMs = baseMs;
    if (!powerIn) {
      t.pv = 0;
      t.accMs = 0;
      t.done = false;
    } else {
      t.accMs += sess.scan_interval_ms;
      const ticks = Math.floor(t.accMs / baseMs);
      if (ticks > 0) {
        t.accMs -= ticks * baseMs;
        t.pv = Math.min(sv, t.pv + ticks);
      }
      t.done = t.pv >= sv;
    }
    t.prevIn = powerIn;
    sess.timers.set(tAddr, t);
    outputsWritten[tAddr] = t.pv;
    outputsWritten[`${tAddr}.Q`] = t.done;
    return;
  }
  if (op === 'CNT' || op === 'DCNT') {
    const cAddr = normAddr(ops[0]);
    const sv = parseConst(ops[1] ?? '0', sess);
    const c = sess.counters.get(cAddr) ?? { pv: 0, sv, done: false, prevIn: false };
    c.sv = sv;
    if (powerIn && !c.prevIn) {
      // Delta DCNT direction relay M(1000 + counter_num), e.g., M1200 for C200
      const cm = /^C(\d+)$/.exec(cAddr);
      const dirDown = op === 'DCNT' && cm ? readBit(sess, `M${1000 + parseInt(cm[1], 10)}`) : false;
      c.pv += dirDown ? -1 : 1;
      c.done = c.pv >= sv;
    }
    c.prevIn = powerIn;
    sess.counters.set(cAddr, c);
    outputsWritten[cAddr] = c.pv;
    outputsWritten[`${cAddr}.Q`] = c.done;
    return;
  }

  if (!powerIn) return;

  if (op === 'CJ') {
    if (flow) flow.jumpToLabel = ops[0]?.trim();
  } else if (op === 'CALL') {
    if (flow) flow.callTarget = ops[0]?.trim();
  } else if (op === 'CMP') {
    const s1 = toInt16(parseConst(ops[0], sess));
    const s2 = toInt16(parseConst(ops[1], sess));
    const d0 = resolveHardwareOrWordKey(sess, ops[2]);
    const d1 = shiftIndexedDevice(d0, 1);
    const d2 = shiftIndexedDevice(d0, 2);
    writeBit(sess, d0, s1 > s2);
    writeBit(sess, d1, s1 === s2);
    writeBit(sess, d2, s1 < s2);
    outputsWritten[d0] = s1 > s2;
    outputsWritten[d1] = s1 === s2;
    outputsWritten[d2] = s1 < s2;
  } else if (op === 'ZCP') {
    const s1 = toInt16(parseConst(ops[0], sess));
    const s2 = toInt16(parseConst(ops[1], sess));
    const s = toInt16(parseConst(ops[2], sess));
    const d0 = resolveHardwareOrWordKey(sess, ops[3]);
    const d1 = shiftIndexedDevice(d0, 1);
    const d2 = shiftIndexedDevice(d0, 2);
    writeBit(sess, d0, s < s1);
    writeBit(sess, d1, s >= s1 && s <= s2);
    writeBit(sess, d2, s > s2);
    outputsWritten[d0] = s < s1;
    outputsWritten[d1] = s >= s1 && s <= s2;
    outputsWritten[d2] = s > s2;
  } else if (op === 'ANDW' || op === 'ORW' || op === 'XORW') {
    const a = parseConst(ops[0], sess) & 0xffff;
    const b = parseConst(ops[1], sess) & 0xffff;
    const res = toInt16(op === 'ANDW' ? a & b : op === 'ORW' ? a | b : a ^ b);
    writeWord(sess, ops[2], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = res;
  } else if (op === 'NEG') {
    const res = toInt16(-readWord(sess, ops[0]));
    writeWord(sess, ops[0], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = res;
  } else if (op === 'SWAP') {
    const cur = readWord(sess, ops[0]) & 0xffff;
    const res = toInt16(((cur & 0xff) << 8) | ((cur >>> 8) & 0xff));
    writeWord(sess, ops[0], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = res;
  } else if (op === 'XCH') {
    const a = readWord(sess, ops[0]);
    const b = readWord(sess, ops[1]);
    writeWord(sess, ops[0], b);
    writeWord(sess, ops[1], a);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = b;
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = a;
  } else if (op === 'MOV') {
    const val = toInt16(parseConst(ops[0], sess));
    writeWord(sess, ops[1], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = val;
  } else if (op === 'DMOV') {
    const val = readDWord(sess, ops[0]);
    writeDWord(sess, ops[1], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = val;
  } else if (op === 'BMOV') {
    const count = Math.max(0, Math.min(256, parseConst(ops[2] ?? '1', sess)));
    for (let i = 0; i < count; i++) {
      const val = readWord(sess, shiftIndexedDevice(ops[0], i));
      const dst = shiftIndexedDevice(ops[1], i);
      writeWord(sess, dst, val);
      outputsWritten[dst] = val;
    }
  } else if (op === 'FMOV') {
    const val = toInt16(parseConst(ops[0], sess));
    const count = Math.max(0, Math.min(256, parseConst(ops[2] ?? '1', sess)));
    for (let i = 0; i < count; i++) {
      const dst = shiftIndexedDevice(ops[1], i);
      writeWord(sess, dst, val);
      outputsWritten[dst] = val;
    }
  } else if (op === 'ADD') {
    const val = toInt16(parseConst(ops[0], sess) + parseConst(ops[1], sess));
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DADD') {
    const val = toInt32(readDWord(sess, ops[0]) + readDWord(sess, ops[1]));
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'SUB') {
    const val = toInt16(parseConst(ops[0], sess) - parseConst(ops[1], sess));
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DSUB') {
    const val = toInt32(readDWord(sess, ops[0]) - readDWord(sess, ops[1]));
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'MUL') {
    const val = toInt16(parseConst(ops[0], sess) * parseConst(ops[1], sess));
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DMUL') {
    const val = toInt32(readDWord(sess, ops[0]) * readDWord(sess, ops[1]));
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DIV') {
    const denom = parseConst(ops[1], sess);
    if (denom !== 0) {
      const val = toInt16(Math.trunc(parseConst(ops[0], sess) / denom));
      writeWord(sess, ops[2], val);
      outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
    }
  } else if (op === 'DDIV') {
    const denom = readDWord(sess, ops[1]);
    if (denom !== 0) {
      const val = toInt32(Math.trunc(readDWord(sess, ops[0]) / denom));
      writeDWord(sess, ops[2], val);
      outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
    }
  } else if (op === 'INC') {
    const val = toInt16(readWord(sess, ops[0]) + 1);
    writeWord(sess, ops[0], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = val;
  } else if (op === 'DINC') {
    const val = toInt32(readDWord(sess, ops[0]) + 1);
    writeDWord(sess, ops[0], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = val;
  } else if (op === 'DEC') {
    const val = toInt16(readWord(sess, ops[0]) - 1);
    writeWord(sess, ops[0], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = val;
  } else if (op === 'DDEC') {
    const val = toInt32(readDWord(sess, ops[0]) - 1);
    writeDWord(sess, ops[0], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = val;
  } else if (op === 'ALT') {
    const next = !readBit(sess, ops[0]);
    writeBit(sess, ops[0], next);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = next;
  } else if (op === 'ZRST') {
    const m1 = /^([A-Z]+)(\d+)$/i.exec(ops[0]);
    const m2 = /^([A-Z]+)(\d+)$/i.exec(ops[1]);
    if (m1 && m2 && m1[1].toUpperCase() === m2[1].toUpperCase()) {
      const area = m1[1].toUpperCase();
      const isOctal = area === 'X' || area === 'Y';
      const s = parseInt(m1[2], isOctal ? 8 : 10);
      const e = parseInt(m2[2], isOctal ? 8 : 10);
      for (let i = s; i <= Math.min(e, s + 256); i++) {
        const addr = `${area}${isOctal ? i.toString(8).toUpperCase() : i}`;
        if (area === 'T') {
          sess.timers.set(addr, { pv: 0, sv: 0, done: false, prevIn: false, accMs: 0, baseMs: timerTimebaseMs(addr) });
        } else if (area === 'C') {
          sess.counters.set(addr, { pv: 0, sv: 0, done: false, prevIn: false });
        } else {
          writeBit(sess, addr, false);
          writeWord(sess, addr, 0);
        }
        outputsWritten[addr] = 0;
      }
    }
  } else if (op === 'DPLSY') {
    const freq = parseConst(ops[0], sess);
    const pulses = parseConst(ops[1], sess);
    const target = resolveHardwareOrWordKey(sess, ops[2]);
    writeBit(sess, target, freq > 0 && pulses >= 0);
    outputsWritten[target] = readBit(sess, target);
  }
}

interface LdExecStats {
  instructions: number;
  jumpCapHits: number;
  callDepthMax: number;
  networkMetrics?: Map<string, NetworkTimingSummary>;
}

interface StExecStats {
  loopIterations: number;
  loopCapHits: number;
  callDepthMax: number;
}

function recordNetworkMetric(
  map: Map<string, NetworkTimingSummary> | undefined,
  pouName: string,
  net: SimPouProgram['networks'][number],
  durationMs: number,
): void {
  if (!map) return;
  const key = `${pouName}:${net.index}`;
  const existing = map.get(key);
  if (existing) {
    existing.executions += 1;
    existing.total_ms += durationMs;
    if (durationMs > existing.max_ms) existing.max_ms = durationMs;
    existing.avg_ms = existing.total_ms / existing.executions;
  } else {
    map.set(key, {
      pou: pouName,
      network_index: net.index,
      net_id: net.net_id,
      label: net.label || undefined,
      executions: 1,
      total_ms: durationMs,
      avg_ms: durationMs,
      max_ms: durationMs,
      instruction_count: net.il.length,
    });
  }
}

function executeLdPou(
  sess: SimulatorSession,
  pou: SimPouProgram,
  trace: SimNetworkTrace[],
  startNetIdx = 0,
  stopOnSret = false,
  callDepth = 0,
  execStats?: LdExecStats,
): void {
  if (execStats && callDepth > execStats.callDepthMax) {
    execStats.callDepthMax = callDepth;
  }
  if (callDepth > 8) return;
  let mcActive: boolean = true;
  let stlActive: boolean | null = null;
  let idx = startNetIdx;
  let jumpsTaken = 0;

  const labelIndexMap = new Map<string, number>();
  pou.networks.forEach((n, i) => {
    if (n.label) labelIndexMap.set(n.label.toUpperCase(), i);
  });

  while (idx < pou.networks.length) {
    const net = pou.networks[idx];
    if (!net.active) {
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: false,
        energized: false,
        il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
        outputs_written: {},
      });
      idx += 1;
      continue;
    }

    const netT0 = process.hrtime.bigint();
    const firstOut = net.il.find(([op]) => !INPUT_OPS.has(op) && op !== 'END');
    if (firstOut?.[0] === 'FEND') {
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: true,
        energized: true,
        il: ['FEND'],
        outputs_written: {},
      });
      break;
    }
    if (firstOut?.[0] === 'SRET') {
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: true,
        energized: true,
        il: ['SRET'],
        outputs_written: {},
      });
      if (stopOnSret) break;
      idx += 1;
      continue;
    }
    if (firstOut?.[0] === 'STL') {
      const stateAddr = firstOut[1][0];
      stlActive = readBit(sess, stateAddr);
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: true,
        energized: stlActive,
        il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
        outputs_written: {},
      });
      idx += 1;
      continue;
    }
    if (firstOut?.[0] === 'RET') {
      stlActive = null;
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: true,
        energized: true,
        il: ['RET'],
        outputs_written: {},
      });
      idx += 1;
      continue;
    }

    const stack: boolean[] = [];
    const branchStack: boolean[] = [];
    let acc: boolean | null = null;
    let rungEnergized = true;
    const outputsWritten: Record<string, boolean | number> = {};
    const flow: { jumpToLabel?: string; callTarget?: string; subReturn?: boolean; endMain?: boolean } = {};

    for (const [op, ops] of net.il) {
      if (execStats) execStats.instructions += 1;
      if (['LD', 'LDI', 'LDP', 'LDF', 'LD=', 'LD<=', 'LD>', 'LD<'].includes(op)) {
        if (acc !== null) stack.push(acc);
        acc = evalContact(sess, op, ops);
        continue;
      }
      if (['AND', 'ANI', 'ANDP', 'ANDF', 'AND=', 'AND<=', 'AND>', 'AND<'].includes(op)) {
        const val: boolean = evalContact(sess, op, ops);
        acc = (acc ?? true) && val;
        continue;
      }
      if (['OR', 'ORI', 'ORP', 'ORF'].includes(op)) {
        const val: boolean = evalContact(sess, op, ops);
        acc = (acc ?? false) || val;
        continue;
      }
      if (op === 'ANB') {
        const top: boolean = acc ?? true;
        const prev: boolean = stack.pop() ?? true;
        acc = prev && top;
        continue;
      }
      if (op === 'ORB') {
        const top: boolean = acc ?? false;
        const prev: boolean = stack.pop() ?? false;
        acc = prev || top;
        continue;
      }
      if (op === 'MPS') {
        branchStack.push(acc ?? true);
        continue;
      }
      if (op === 'MRD') {
        acc = branchStack[branchStack.length - 1] ?? true;
        continue;
      }
      if (op === 'MPP') {
        acc = branchStack.pop() ?? true;
        continue;
      }
      if (op === 'END') {
        continue;
      }
      const curPower: boolean = (acc ?? true) && mcActive && (stlActive === null || stlActive);
      rungEnergized = curPower;
      if (op === 'MC') {
        mcActive = curPower;
        continue;
      }
      if (op === 'MCR') {
        mcActive = true;
        continue;
      }
      execOutputInstruction(sess, pou.name, net.index, op, ops, curPower, outputsWritten, flow);
    }

    trace.push({
      pou: pou.name,
      network_index: net.index,
      net_id: net.net_id,
      label: net.label || undefined,
      active: true,
      energized: Object.keys(outputsWritten).length > 0 ? rungEnergized : (acc ?? true) && mcActive && (stlActive === null || stlActive),
      il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
      outputs_written: outputsWritten,
    });

    if (flow.callTarget) {
      const subIdx = labelIndexMap.get(flow.callTarget.toUpperCase());
      if (subIdx !== undefined) {
        executeLdPou(sess, pou, trace, subIdx, true, callDepth + 1, execStats);
      } else {
        const subPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === flow.callTarget!.toUpperCase());
        if (subPou) {
          if (subPou.lang === '1') {
            executeLdPou(sess, subPou, trace, 0, true, callDepth + 1, execStats);
          } else if (subPou.lang === '2') {
            executeStBlock(subPou.stCode, sess, callDepth + 1);
          }
        }
      }
    }

    recordNetworkMetric(
      execStats?.networkMetrics,
      pou.name,
      net,
      Number(process.hrtime.bigint() - netT0) / 1_000_000,
    );

    if (flow.endMain) break;
    if (flow.subReturn && stopOnSret) break;
    if (flow.jumpToLabel) {
      const targetIdx = labelIndexMap.get(flow.jumpToLabel.toUpperCase());
      if (targetIdx !== undefined) {
        if (jumpsTaken < 200) {
          jumpsTaken += 1;
          idx = targetIdx;
          continue;
        } else if (execStats) {
          execStats.jumpCapHits += 1;
        }
      }
    }
    idx += 1;
  }
}

// ===========================================================================
// Enhanced IEC ST Expression & Statement Engine
// Supports: CASE..OF..END_CASE, REPEAT..UNTIL, multi-line statements, arrays,
// struct dot fields, built-in IEC functions, and user FC/FB POU calls.
// ===========================================================================
function evalStBuiltinOrCall(
  expr: string,
  sess: SimulatorSession,
  loopVars: Map<string, number>,
  callDepth: number,
  execStats?: StExecStats,
): string {
  // Iteratively resolve innermost function calls Name(arg1, arg2, ...)
  let current = expr;
  const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)/;
  let guard = 0;
  while (guard++ < 32) {
    const m = callRe.exec(current);
    if (!m) break;
    const fnName = m[1].toUpperCase();
    const rawArgs = m[2].trim();
    const argTokens = rawArgs ? rawArgs.split(',').map((a) => a.trim()) : [];

    // Skip if fnName is ST logical operator like NOT(...) or precedence parentheses wouldn't match \bWord(
    if (fnName === 'NOT') {
      const v = evalStExpression(rawArgs, sess, loopVars, callDepth + 1, execStats);
      const repl = v ? '0' : '1';
      current = current.slice(0, m.index) + repl + current.slice(m.index + m[0].length);
      continue;
    }

    let val: number | null = null;
    const evalArgs = () => argTokens.map((a) => evalStExpression(a, sess, loopVars, callDepth + 1, execStats));

    if (fnName === 'ABS') {
      val = Math.abs(evalArgs()[0] ?? 0);
    } else if (fnName === 'MIN') {
      const vals = evalArgs();
      val = vals.length ? Math.min(...vals) : 0;
    } else if (fnName === 'MAX') {
      const vals = evalArgs();
      val = vals.length ? Math.max(...vals) : 0;
    } else if (fnName === 'LIMIT') {
      const [mn = 0, x = 0, mx = 0] = evalArgs();
      val = Math.max(mn, Math.min(mx, x));
    } else if (fnName === 'SEL') {
      const [g = 0, in0 = 0, in1 = 0] = evalArgs();
      val = g ? in1 : in0;
    } else if (fnName === 'MUX') {
      const vals = evalArgs();
      const k = Math.trunc(vals[0] ?? 0);
      val = vals[k + 1] ?? 0;
    } else if (fnName === 'SHL') {
      const [v = 0, n = 0] = evalArgs();
      val = Math.trunc(v) << Math.trunc(n);
    } else if (fnName === 'SHR') {
      const [v = 0, n = 0] = evalArgs();
      val = Math.trunc(v) >> Math.trunc(n);
    } else if (fnName === 'ROL') {
      const [v = 0, n = 0] = evalArgs();
      const s = ((Math.trunc(n) % 16) + 16) % 16;
      const w = Math.trunc(v) & 0xffff;
      val = toInt16(((w << s) | (w >>> (16 - s))) & 0xffff);
    } else if (fnName === 'ROR') {
      const [v = 0, n = 0] = evalArgs();
      const s = ((Math.trunc(n) % 16) + 16) % 16;
      const w = Math.trunc(v) & 0xffff;
      val = toInt16(((w >>> s) | (w << (16 - s))) & 0xffff);
    } else {
      // User-defined FC / FB call!
      const targetPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === fnName);
      if (targetPou && callDepth < 8) {
        val = invokeUserPouCall(sess, targetPou, argTokens, loopVars, callDepth + 1, execStats);
      } else {
        break;
      }
    }
    current = current.slice(0, m.index) + String(val) + current.slice(m.index + m[0].length);
  }
  return current;
}

function invokeUserPouCall(
  sess: SimulatorSession,
  pou: SimPouProgram,
  argTokens: string[],
  callerLoopVars: Map<string, number>,
  callDepth: number,
  execStats?: StExecStats,
): number {
  if (execStats && callDepth > execStats.callDepthMax) {
    execStats.callDepthMax = callDepth;
  }
  if (callDepth > 8) return 0;
  const inputs = pou.localVars.filter((v) => v.varClass === 'VAR_INPUT' || v.varClass === 'VAR_IN_OUT');
  const outBindings: Array<{ formal: string; actual: string }> = [];

  argTokens.forEach((tok, i) => {
    const namedIn = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/.exec(tok);
    const namedOut = /^([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*([A-Za-z_][A-Za-z0-9_.]*)$/.exec(tok);
    if (namedOut) {
      outBindings.push({ formal: namedOut[1], actual: namedOut[2] });
    } else if (namedIn) {
      const val = evalStExpression(namedIn[2], sess, callerLoopVars, callDepth, execStats);
      const sym = resolveSymbol(sess, namedIn[1]);
      if (sym?.entry.type.toUpperCase() === 'BOOL') writeBit(sess, namedIn[1], Boolean(val));
      else writeWord(sess, namedIn[1], val);
    } else if (inputs[i]) {
      const val = evalStExpression(tok, sess, callerLoopVars, callDepth, execStats);
      if (inputs[i].type.toUpperCase() === 'BOOL') writeBit(sess, inputs[i].identifier, Boolean(val));
      else writeWord(sess, inputs[i].identifier, val);
    }
  });

  if (pou.lang === '2') {
    executeStBlock(pou.stCode, sess, callDepth, execStats);
  } else if (pou.lang === '1') {
    executeLdPou(sess, pou, [], 0, true, callDepth);
  }

  for (const ob of outBindings) {
    const symFormal = resolveSymbol(sess, ob.formal);
    const v = symFormal?.entry.type.toUpperCase() === 'BOOL' ? (readBit(sess, ob.formal) ? 1 : 0) : readWord(sess, ob.formal);
    assignStLhs(sess, ob.actual, v, {});
  }

  // Convention: FC return value assigned to `<PouName> := ...;`
  const retSym = resolveSymbol(sess, pou.name);
  if (retSym) {
    return typeof retSym.entry.value === 'boolean' ? (retSym.entry.value ? 1 : 0) : Number(retSym.entry.value) || 0;
  }
  return readWord(sess, pou.name);
}

function resolveArrayAccess(
  expr: string,
  sess: SimulatorSession,
  loopVars: Map<string, number>,
  callDepth: number,
  execStats?: StExecStats,
): string {
  let out = expr;
  const arrRe = /\b([A-Za-z_][A-Za-z0-9_]*)\[([^\[\]]+)\]/g;
  for (let pass = 0; pass < 8 && arrRe.test(out); pass++) {
    arrRe.lastIndex = 0;
    out = out.replace(arrRe, (_m, name, idxExpr) => {
      const idx = Math.trunc(evalStExpression(String(idxExpr), sess, loopVars, callDepth + 1, execStats));
      const key = `${String(name).toUpperCase()}[${idx}]`;
      return String(sess.words.get(key) ?? (sess.bits.get(key) ? 1 : 0));
    });
  }
  return out;
}

function evalStExpression(
  expr: string,
  sess: SimulatorSession,
  loopVars: Map<string, number> = new Map(),
  callDepth = 0,
  execStats?: StExecStats,
): number {
  let clean = expr.trim().replace(/\bTRUE\b/gi, '1').replace(/\bFALSE\b/gi, '0');
  clean = clean.replace(/16#([0-9A-Fa-f_]+)/g, (_m, h) => String(parseInt(String(h).replace(/_/g, ''), 16)));
  clean = clean.replace(/2#([01_]+)/g, (_m, b) => String(parseInt(String(b).replace(/_/g, ''), 2)));
  clean = clean.replace(/8#([0-7_]+)/g, (_m, o) => String(parseInt(String(o).replace(/_/g, ''), 8)));
  clean = evalStBuiltinOrCall(clean, sess, loopVars, callDepth, execStats);
  clean = resolveArrayAccess(clean, sess, loopVars, callDepth, execStats);

  // Replace T0.Q / T0.PV / C0.Q / C0.PV / D0.0 first
  let withDots = clean.replace(/\b((?:T|C)\d+)\.(Q|DONE|PV)\b/gi, (_m, dev, prop) => {
    const upProp = String(prop).toUpperCase();
    if (upProp === 'PV') return String(readWord(sess, String(dev)));
    return readBit(sess, String(dev)) ? '1' : '0';
  });

  withDots = withDots.replace(/\b([DRVZ]\d+\.(?:1[0-5]|[0-9]|[A-Fa-f]))\b/gi, (_m, bitAddr) => {
    return readBit(sess, String(bitAddr)) ? '1' : '0';
  });

  // Replace struct fields like Pump.Speed
  withDots = withDots.replace(/\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/g, (tok) => {
    const sym = resolveSymbol(sess, tok);
    if (sym) {
      return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? '1' : '0') : String(sym.entry.value);
    }
    const up = tok.toUpperCase();
    if (sess.bits.has(up)) return sess.bits.get(up) ? '1' : '0';
    if (sess.words.has(up)) return String(sess.words.get(up) ?? 0);
    return '0';
  });

  const replaced = withDots.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (tok) => {
    const up = tok.toUpperCase();
    if (up === 'AND') return '&&';
    if (up === 'OR') return '||';
    if (up === 'XOR') return '^';
    if (up === 'NOT') return '!';
    if (up === 'MOD') return '%';
    if (loopVars.has(tok)) {
      return String(loopVars.get(tok)!);
    }
    if (/^(X|Y|M|S|T|C)\d+$/i.test(tok)) {
      return readBit(sess, tok) ? '1' : '0';
    }
    if (/^D\d+$/i.test(tok)) {
      return String(readWord(sess, tok));
    }
    const sym = resolveSymbol(sess, tok);
    if (sym) {
      if (sym.entry.address) {
        return isBitAddress(sym.entry.address)
          ? readBit(sess, sym.entry.address) ? '1' : '0'
          : String(readWord(sess, sym.entry.address));
      }
      return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? '1' : '0') : String(sym.entry.value);
    }
    if (sess.bits.has(up)) return sess.bits.get(up) ? '1' : '0';
    if (sess.words.has(up)) return String(sess.words.get(up) ?? 0);
    return tok;
  });

  const jsExpr = replaced
    .replace(/<>/g, '!=')
    .replace(/(?<![<>!=])=(?!=)/g, '==');

  if (!/^[\d\s+\-*/%()&|^!<>=.]+$/.test(jsExpr)) {
    return 0;
  }
  return evaluateSafeNumericExpr(jsExpr);
}

function tokenizeStStatements(stCode: string): string[] {
  const stripped = stCode
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\/\/[^\r\n]*/g, '');

  const out: string[] = [];
  let buf = '';

  const flushBuf = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (const rawLine of stripped.split(/\r?\n/)) {
    let rest = rawLine.trim();
    if (!rest) continue;

    // Handle combined buffer + rest
    while (rest) {
      const combined = (buf ? `${buf} ${rest}` : rest).trim();
      const headerMatch =
        /^(IF\b.+?\bTHEN|ELSIF\b.+?\bTHEN|ELSE\b|FOR\b.+?\bDO|WHILE\b.+?\bDO|CASE\b.+?\bOF|REPEAT\b)\s*(.*)$/i.exec(
          combined,
        );
      if (headerMatch) {
        const hdr = headerMatch[1].trim();
        const tail = headerMatch[2].trim();
        out.push(hdr);
        buf = '';
        rest = tail;
        continue;
      }
      const labelMatch =
        /^(-?\d+(?:\s*\.\.\s*-?\d+)?(?:\s*,\s*-?\d+(?:\s*\.\.\s*-?\d+)?)*)\s*:(?!=)\s*(.*)$/.exec(combined);
      if (labelMatch) {
        out.push(`CASE_LABEL:${labelMatch[1].trim()}`);
        buf = '';
        rest = labelMatch[2].trim();
        continue;
      }
      const untilEndRepeat = /^(UNTIL\s+.+?)\s+(END_REPEAT\b.*)$/i.exec(combined);
      if (untilEndRepeat) {
        out.push(untilEndRepeat[1].trim());
        buf = '';
        rest = untilEndRepeat[2].trim();
        continue;
      }

      const semi = rest.indexOf(';');
      if (semi !== -1) {
        buf = (buf ? `${buf} ` : '') + rest.slice(0, semi).trim();
        flushBuf();
        rest = rest.slice(semi + 1).trim();
      } else {
        buf = (buf ? `${buf} ` : '') + rest;
        const upBuf = buf.toUpperCase();
        if (
          ['END_IF', 'END_FOR', 'END_WHILE', 'END_CASE', 'END_REPEAT', 'ELSE', 'REPEAT'].includes(upBuf) ||
          /^UNTIL\s+/i.test(upBuf)
        ) {
          flushBuf();
        }
        rest = '';
      }
    }
  }
  flushBuf();
  return out.filter(Boolean);
}

function assignStLhs(
  sess: SimulatorSession,
  lhs: string,
  rhsVal: number,
  outputsWritten: Record<string, boolean | number>,
  loopVars?: Map<string, number>,
): void {
  const arrMatch = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\[\]]+)\]$/.exec(lhs.trim());
  if (arrMatch) {
    const idx = Math.trunc(evalStExpression(arrMatch[2], sess, loopVars ?? new Map()));
    const key = `${arrMatch[1].toUpperCase()}[${idx}]`;
    const intVal = Math.trunc(rhsVal);
    if (!sess.words.has(key) && sess.words.size >= MAX_SIM_MEMORY_KEYS) {
      throw new FileTransformError(`Simulator word memory limit reached (${MAX_SIM_MEMORY_KEYS} keys)`);
    }
    sess.words.set(key, intVal);
    outputsWritten[key] = intVal;
    return;
  }

  if (loopVars && loopVars.has(lhs)) {
    loopVars.set(lhs, Math.trunc(rhsVal));
  }
  const sym = resolveSymbol(sess, lhs);
  const treatAsBit =
    isBitAddress(lhs) ||
    (sym !== null && (sym.entry.type.toUpperCase() === 'BOOL' || (sym.entry.address !== null && isBitAddress(sym.entry.address))));

  if (treatAsBit) {
    const bVal = Boolean(rhsVal);
    writeBit(sess, lhs, bVal);
    outputsWritten[sym ? sym.key : normAddr(lhs)] = bVal;
  } else {
    const intVal = Math.trunc(rhsVal);
    writeWord(sess, lhs, intVal);
    outputsWritten[sym ? sym.key : normAddr(lhs)] = intVal;
  }
}

function matchCaseSelector(selector: string, val: number): boolean {
  for (const part of selector.split(',')) {
    const p = part.trim();
    const range = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(p);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (val >= a && val <= b) return true;
    } else if (/^-?\d+$/.test(p) && val === parseInt(p, 10)) {
      return true;
    }
  }
  return false;
}

function findMatchingEnd(stmts: string[], startIdx: number, openPrefix: RegExp, closeTok: string): number {
  let depth = 0;
  let i = startIdx + 1;
  while (i < stmts.length) {
    const u = stmts[i].trim().toUpperCase().replace(/;$/, '').trim();
    if (openPrefix.test(u)) depth += 1;
    else if (u === closeTok || u.startsWith(`${closeTok} `)) {
      if (depth === 0) break;
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function executeStStatements(
  stmts: string[],
  startIdx: number,
  sess: SimulatorSession,
  outputsWritten: Record<string, boolean | number>,
  loopVars: Map<string, number>,
  endTokens: Set<string>,
  callDepth = 0,
  execStats?: StExecStats,
): { nextIdx: number; statementsExecuted: number; exited: boolean; returned?: boolean } {
  if (execStats && callDepth > execStats.callDepthMax) {
    execStats.callDepthMax = callDepth;
  }
  let idx = startIdx;
  let statementsExecuted = 0;

  while (idx < stmts.length) {
    const raw = stmts[idx].trim();
    const upper = raw.toUpperCase().replace(/;$/, '').trim();
    if (endTokens.has(upper) || (endTokens.has('CASE_LABEL') && upper.startsWith('CASE_LABEL:'))) {
      return { nextIdx: idx, statementsExecuted, exited: false };
    }
    if (endTokens.has('UNTIL') && upper.startsWith('UNTIL ')) {
      return { nextIdx: idx, statementsExecuted, exited: false };
    }
    if (upper === 'EXIT') {
      return { nextIdx: idx + 1, statementsExecuted: statementsExecuted + 1, exited: true };
    }
    if (upper === 'RETURN') {
      return { nextIdx: stmts.length, statementsExecuted: statementsExecuted + 1, exited: true, returned: true };
    }

    if (upper.startsWith('IF ') && upper.endsWith(' THEN')) {
      let branchTaken = Boolean(evalStExpression(raw.slice(3, -5), sess, loopVars, callDepth, execStats));
      let curIdx = idx + 1;
      let doneIf = false;
      let shouldRunBranch = branchTaken;

      while (curIdx < stmts.length && !doneIf) {
        if (shouldRunBranch) {
          const res = executeStStatements(stmts, curIdx, sess, outputsWritten, loopVars, new Set(['ELSIF', 'ELSE', 'END_IF']), callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          curIdx = res.nextIdx;
          if (res.exited) return { nextIdx: curIdx, statementsExecuted, exited: true, returned: res.returned };
        } else {
          let depth = 0;
          while (curIdx < stmts.length) {
            const u = stmts[curIdx].trim().toUpperCase().replace(/;$/, '').trim();
            if (
              (u.startsWith('IF ') && u.endsWith(' THEN')) ||
              (u.startsWith('FOR ') && u.endsWith(' DO')) ||
              (u.startsWith('WHILE ') && u.endsWith(' DO')) ||
              (u.startsWith('CASE ') && u.endsWith(' OF')) ||
              u === 'REPEAT'
            ) {
              depth += 1;
            } else if (u === 'END_IF' || u === 'END_FOR' || u === 'END_WHILE' || u === 'END_CASE' || u === 'END_REPEAT') {
              if (depth === 0 && u === 'END_IF') break;
              depth = Math.max(0, depth - 1);
            } else if (depth === 0 && (u.startsWith('ELSIF ') || u === 'ELSE')) {
              break;
            }
            curIdx += 1;
          }
        }

        if (curIdx >= stmts.length) break;
        const tokRaw = stmts[curIdx].trim();
        const tokUp = tokRaw.toUpperCase().replace(/;$/, '').trim();
        if (tokUp === 'END_IF') {
          curIdx += 1;
          doneIf = true;
        } else if (tokUp.startsWith('ELSIF ') && tokUp.endsWith(' THEN')) {
          if (!branchTaken) {
            branchTaken = Boolean(evalStExpression(tokRaw.slice(6, -5), sess, loopVars, callDepth, execStats));
            shouldRunBranch = branchTaken;
          } else {
            shouldRunBranch = false;
          }
          curIdx += 1;
        } else if (tokUp === 'ELSE') {
          shouldRunBranch = !branchTaken;
          branchTaken = true;
          curIdx += 1;
        } else {
          curIdx += 1;
        }
      }
      idx = curIdx;
      continue;
    }

    const caseMatch = /^CASE\s+(.+?)\s+OF$/i.exec(raw);
    if (caseMatch) {
      const selectorVal = Math.trunc(evalStExpression(caseMatch[1], sess, loopVars, callDepth, execStats));
      const endCaseIdx = findMatchingEnd(stmts, idx, /^CASE\b.+\bOF$/i, 'END_CASE');
      const inner = stmts.slice(idx + 1, endCaseIdx);
      let cIdx = 0;
      let matched = false;
      while (cIdx < inner.length) {
        const cur = inner[cIdx].trim();
        const curUp = cur.toUpperCase();
        if (curUp.startsWith('CASE_LABEL:')) {
          const sel = cur.slice('CASE_LABEL:'.length);
          const nextBranchIdx = (() => {
            let d = 0;
            let j = cIdx + 1;
            while (j < inner.length) {
              const iu = inner[j].trim().toUpperCase();
              if (/^CASE\b.+\bOF$/i.test(iu)) d++;
              else if (iu === 'END_CASE') d--;
              else if (d === 0 && (iu.startsWith('CASE_LABEL:') || iu === 'ELSE')) break;
              j++;
            }
            return j;
          })();
          if (!matched && matchCaseSelector(sel, selectorVal)) {
            matched = true;
            const res = executeStStatements(inner.slice(cIdx + 1, nextBranchIdx), 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
            statementsExecuted += res.statementsExecuted;
            if (res.exited) return { nextIdx: endCaseIdx + 1, statementsExecuted, exited: true, returned: res.returned };
            break;
          }
          cIdx = nextBranchIdx;
          continue;
        }
        if (curUp === 'ELSE') {
          if (!matched) {
            const res = executeStStatements(inner.slice(cIdx + 1), 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
            statementsExecuted += res.statementsExecuted;
            if (res.exited) return { nextIdx: endCaseIdx + 1, statementsExecuted, exited: true, returned: res.returned };
          }
          break;
        }
        cIdx += 1;
      }
      idx = endCaseIdx + 1;
      continue;
    }

    const forMatch = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(raw);
    if (forMatch) {
      const varName = forMatch[1];
      const startVal = Math.trunc(evalStExpression(forMatch[2], sess, loopVars, callDepth, execStats));
      const endVal = Math.trunc(evalStExpression(forMatch[3], sess, loopVars, callDepth, execStats));
      const stepVal = forMatch[4] ? Math.trunc(evalStExpression(forMatch[4], sess, loopVars, callDepth, execStats)) : 1;
      const endIdx = findMatchingEnd(stmts, idx, /^FOR\b.+\bDO$/i, 'END_FOR');
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      if (stepVal !== 0) {
        let iter = 0;
        for (let v = startVal; stepVal > 0 ? v <= endVal : v >= endVal; v += stepVal) {
          if (++iter > 10_000) {
            if (execStats) execStats.loopCapHits += 1;
            break;
          }
          if (execStats) execStats.loopIterations += 1;
          loopVars.set(varName, v);
          assignStLhs(sess, varName, v, outputsWritten, loopVars);
          const res = executeStStatements(bodyStmts, 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          if (res.returned) return { nextIdx: endIdx + 1, statementsExecuted, exited: true, returned: true };
          if (res.exited) break;
        }
      }
      idx = endIdx + 1;
      continue;
    }

    const whileMatch = /^WHILE\s+(.+?)\s+DO$/i.exec(raw);
    if (whileMatch) {
      const endIdx = findMatchingEnd(stmts, idx, /^WHILE\b.+\bDO$/i, 'END_WHILE');
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      let iter = 0;
      while (Boolean(evalStExpression(whileMatch[1], sess, loopVars, callDepth, execStats))) {
        if (++iter > 10_000) {
          if (execStats) execStats.loopCapHits += 1;
          break;
        }
        if (execStats) execStats.loopIterations += 1;
        const res = executeStStatements(bodyStmts, 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
        statementsExecuted += res.statementsExecuted;
        if (res.returned) return { nextIdx: endIdx + 1, statementsExecuted, exited: true, returned: true };
        if (res.exited) break;
      }
      idx = endIdx + 1;
      continue;
    }

    if (upper === 'REPEAT') {
      const endIdx = findMatchingEnd(stmts, idx, /^REPEAT$/i, 'END_REPEAT');
      const untilIdx = stmts.findIndex((s, i) => i > idx && i < endIdx && /^UNTIL\s+/i.test(s.trim()));
      const bodyEnd = untilIdx !== -1 ? untilIdx : endIdx;
      const untilExpr = untilIdx !== -1 ? stmts[untilIdx].trim().replace(/^UNTIL\s+/i, '') : 'TRUE';
      const bodyStmts = stmts.slice(idx + 1, bodyEnd);
      let iter = 0;
      while (true) {
        if (++iter > 10_000) {
          if (execStats) execStats.loopCapHits += 1;
          break;
        }
        if (execStats) execStats.loopIterations += 1;
        const res = executeStStatements(bodyStmts, 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
        statementsExecuted += res.statementsExecuted;
        if (res.returned) return { nextIdx: endIdx + 1, statementsExecuted, exited: true, returned: true };
        if (res.exited) break;
        if (Boolean(evalStExpression(untilExpr, sess, loopVars, callDepth, execStats))) break;
      }
      idx = endIdx + 1;
      continue;
    }

    if (endTokens.has('ELSIF') && upper.startsWith('ELSIF ')) {
      return { nextIdx: idx, statementsExecuted, exited: false };
    }

    const assign = /^([A-Za-z_][A-Za-z0-9_.\[\]]*)\s*:=\s*(.+?);?\s*$/.exec(raw);
    if (assign) {
      const rhsVal = evalStExpression(assign[2], sess, loopVars, callDepth, execStats);
      assignStLhs(sess, assign[1], rhsVal, outputsWritten, loopVars);
      statementsExecuted += 1;
      idx += 1;
      continue;
    }

    // Standalone procedure / FB call statement: `MyPou(a := 1, b => X);`
    const procCall = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\);?\s*$/.exec(raw);
    if (procCall) {
      evalStBuiltinOrCall(raw, sess, loopVars, callDepth, execStats);
      statementsExecuted += 1;
    }
    idx += 1;
  }
  return { nextIdx: idx, statementsExecuted, exited: false };
}

function executeStBlock(
  stCode: string,
  sess: SimulatorSession,
  callDepth = 0,
  execStats?: StExecStats,
): SimStTrace['outputs_written'] & { __count: number; outputs: Record<string, boolean | number> } {
  const stmts = tokenizeStStatements(stCode);
  const outputsWritten: Record<string, boolean | number> = {};
  const loopVars = new Map<string, number>();
  const res = executeStStatements(stmts, 0, sess, outputsWritten, loopVars, new Set(), callDepth, execStats);
  return Object.assign({}, outputsWritten, { __count: res.statementsExecuted, outputs: outputsWritten });
}

export function evaluateConditionExpr(sess: SimulatorSession, expr: string): boolean {
  const clean = expr.trim();
  if (!clean) return false;
  return Boolean(evalStExpression(clean, sess));
}

function recordPouMetric(
  sess: SimulatorSession,
  pou: SimPouProgram,
  durationMs: number,
  counts: {
    instructions: number;
    statements: number;
    loopIterations: number;
    loopCapHits: number;
    jumpCapHits: number;
    callDepthMax: number;
  },
): void {
  const lang: 'LD' | 'ST' = pou.lang === '2' ? 'ST' : 'LD';
  const existing = sess.diagnostics.pou_metrics.get(pou.name);
  if (existing) {
    existing.executions += 1;
    existing.total_ms += durationMs;
    if (durationMs > existing.max_ms) existing.max_ms = durationMs;
    existing.avg_ms = existing.total_ms / existing.executions;
    existing.instructions_executed += counts.instructions;
    existing.statements_executed += counts.statements;
    existing.loop_iterations += counts.loopIterations;
    existing.loop_cap_hits += counts.loopCapHits;
    existing.jump_cap_hits += counts.jumpCapHits;
    if (counts.callDepthMax > existing.call_depth_max) existing.call_depth_max = counts.callDepthMax;
  } else {
    sess.diagnostics.pou_metrics.set(pou.name, {
      pou: pou.name,
      lang,
      executions: 1,
      total_ms: durationMs,
      avg_ms: durationMs,
      max_ms: durationMs,
      instructions_executed: counts.instructions,
      statements_executed: counts.statements,
      loop_iterations: counts.loopIterations,
      loop_cap_hits: counts.loopCapHits,
      jump_cap_hits: counts.jumpCapHits,
      call_depth_max: counts.callDepthMax,
    });
  }
}

export function stepSimulator(sessionId: string, cycles = 1): SimulatorSession {
  const sess = getSession(sessionId);
  const count = Math.max(1, Math.min(10_000, cycles));
  sess.lastBreakpointHit = null;

  for (let c = 0; c < count; c++) {
    const scanT0 = process.hrtime.bigint();
    sess.scan_count += 1;
    sess.elapsed_ms += sess.scan_interval_ms;

    // Update special PLC clock/status relays
    sess.bits.set('M1000', true);
    sess.bits.set('M1001', false);
    sess.bits.set('M1002', sess.scan_count === 1);
    sess.bits.set('M1003', sess.scan_count > 1);
    sess.bits.set('M1012', Math.floor(sess.elapsed_ms / 100) % 2 === 1);
    sess.bits.set('M1013', Math.floor(sess.elapsed_ms / 1000) % 2 === 1);

    const trace: SimNetworkTrace[] = [];
    const stTrace: SimStTrace[] = [];
    const scanPouTimings: ScanSample['pou_timings'] = [];

    let orderedPous: SimPouProgram[];
    if (sess.tasks.length > 0) {
      const activeTasks = [...sess.tasks]
        .filter((t) => t.active)
        .sort((a, b) => a.priority - b.priority);
      const pouByName = new Map(sess.pouPrograms.map((p) => [p.name, p]));
      orderedPous = activeTasks
        .map((t) => pouByName.get(t.program))
        .filter((p): p is SimPouProgram => Boolean(p && p.active));
    } else {
      orderedPous = sess.pouPrograms.filter((p) => p.pouType === '0' && p.active);
    }

    for (const pou of orderedPous) {
      const pouT0 = process.hrtime.bigint();
      if (pou.lang === '1') {
        const ldStats: LdExecStats = {
          instructions: 0,
          jumpCapHits: 0,
          callDepthMax: 0,
          networkMetrics: sess.diagnostics.network_metrics,
        };
        executeLdPou(sess, pou, trace, 0, false, 0, ldStats);
        const pouMs = Number(process.hrtime.bigint() - pouT0) / 1_000_000;
        recordPouMetric(sess, pou, pouMs, {
          instructions: ldStats.instructions,
          statements: 0,
          loopIterations: 0,
          loopCapHits: 0,
          jumpCapHits: ldStats.jumpCapHits,
          callDepthMax: ldStats.callDepthMax,
        });
        scanPouTimings.push({
          pou: pou.name,
          lang: 'LD',
          duration_ms: Math.round(pouMs * 1000) / 1000,
          work_units: ldStats.instructions,
        });
      } else if (pou.lang === '2') {
        const stStats: StExecStats = { loopIterations: 0, loopCapHits: 0, callDepthMax: 0 };
        const res = executeStBlock(pou.stCode, sess, 0, stStats);
        const pouMs = Number(process.hrtime.bigint() - pouT0) / 1_000_000;
        stTrace.push({
          pou: pou.name,
          statements_executed: res.__count,
          outputs_written: res.outputs,
        });
        recordPouMetric(sess, pou, pouMs, {
          instructions: 0,
          statements: res.__count,
          loopIterations: stStats.loopIterations,
          loopCapHits: stStats.loopCapHits,
          jumpCapHits: 0,
          callDepthMax: stStats.callDepthMax,
        });
        scanPouTimings.push({
          pou: pou.name,
          lang: 'ST',
          duration_ms: Math.round(pouMs * 1000) / 1000,
          work_units: res.__count,
        });
      }
    }

    sess.lastRungTrace = trace;
    sess.lastStTrace = stTrace;

    // Snapshot prevBits for next scan edge detection
    const allBitKeys = new Set([
      ...sess.bits.keys(),
      ...sess.forcedBits.keys(),
      ...sess.timers.keys(),
      ...sess.counters.keys(),
    ]);
    for (const key of allBitKeys) {
      sess.prevBits.set(key, readBit(sess, key));
    }

    // Record default watch sample
    const watchAddrs = sess.watchLists.get('default') ?? [];
    const sampleValues: Record<string, boolean | number> = {};
    for (const addr of watchAddrs) {
      if (/^(X|Y|M|S)\d+$/i.test(addr) || parseBitOfWord(addr)) {
        sampleValues[addr] = readBit(sess, addr);
      } else if (/^(T|C|D)\d+$/i.test(addr)) {
        sampleValues[addr] = readWord(sess, addr);
      } else {
        const sym = resolveSymbol(sess, addr);
        if (sym) {
          sampleValues[addr] = sym.entry.type.toUpperCase() === 'BOOL' ? readBit(sess, addr) : readWord(sess, addr);
        } else {
          sampleValues[addr] = sess.bits.has(normAddr(addr)) ? readBit(sess, addr) : readWord(sess, addr);
        }
      }
    }
    sess.traceBuffer.push({
      scan_count: sess.scan_count,
      elapsed_ms: sess.elapsed_ms,
      values: sampleValues,
    });
    if (sess.traceBuffer.length > 200) {
      sess.traceBuffer.shift();
    }
    sess.last_scan_at = new Date().toISOString();

    const scanDurationMs = Number(process.hrtime.bigint() - scanT0) / 1_000_000;
    const diag = sess.diagnostics;
    diag.total_scans_profiled += 1;
    diag.total_scan_exec_ms += scanDurationMs;
    diag.last_scan_ms = scanDurationMs;
    if (diag.min_scan_ms === null || scanDurationMs < diag.min_scan_ms) {
      diag.min_scan_ms = scanDurationMs;
    }
    if (scanDurationMs > diag.max_scan_ms) {
      diag.max_scan_ms = scanDurationMs;
    }
    const overBudget = scanDurationMs > sess.scan_interval_ms;
    if (overBudget) {
      diag.overrun_count += 1;
    }
    diag.scan_history.push({
      scan_count: sess.scan_count,
      duration_ms: Math.round(scanDurationMs * 1000) / 1000,
      budget_ms: sess.scan_interval_ms,
      over_budget: overBudget,
      words_count: sess.words.size,
      bits_count: sess.bits.size,
      heap_used_bytes: process.memoryUsage().heapUsed,
      pou_timings: scanPouTimings,
    });
    if (diag.scan_history.length > 500) {
      diag.scan_history.shift();
    }

    // Evaluate enabled breakpoints
    let bpHit: BreakpointRule | null = null;
    for (const bp of sess.breakpoints) {
      if (bp.enabled && evaluateConditionExpr(sess, bp.expr)) {
        bp.hit_count += 1;
        bp.last_hit_scan = sess.scan_count;
        bpHit = bp;
        break;
      }
    }
    if (bpHit) {
      sess.lastBreakpointHit = bpHit;
      sess.mode = 'STOP';
      clearRunTimer(sessionId);
      break;
    }
  }
  return sess;
}

export function controlSimulator(
  sessionId: string,
  command: 'RUN' | 'STOP' | 'STEP' | 'RESET' | 'COLD_RESET' | 'WARM_RESET' | 'CLOSE',
  cycles = 1,
) {
  const sess = getSession(sessionId);
  if (command === 'CLOSE') {
    clearRunTimer(sessionId);
    sessions.delete(sessionId);
    return {
      success: true,
      status: 'SESSION_CLOSED',
      session_id: sessionId,
    };
  }
  if (command === 'RUN') {
    sess.mode = 'RUN';
    stepSimulator(sessionId, Math.max(1, cycles));
    if (sess.mode === 'RUN') {
      startRunTimer(sess);
    }
  } else if (command === 'STOP') {
    clearRunTimer(sessionId);
    sess.mode = 'STOP';
  } else if (command === 'STEP') {
    stepSimulator(sessionId, cycles);
  } else if (command === 'WARM_RESET') {
    clearRunTimer(sessionId);
    sess.mode = 'STOP';
    sess.scan_count = 0;
    sess.elapsed_ms = 0;
    sess.prevBits.clear();
    sess.edgeStates.clear();
    sess.bits.set('M1000', true);
    sess.bits.set('M1001', false);
    sess.bits.set('M1002', true);
    sess.bits.set('M1003', false);
    // Preserve retentive words, forced I/O, and counters PV while resetting transient timers & trace
    sess.timers.clear();
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.lastBreakpointHit = null;
  } else if (command === 'RESET' || command === 'COLD_RESET') {
    clearRunTimer(sessionId);
    sess.mode = 'STOP';
    sess.scan_count = 0;
    sess.elapsed_ms = 0;
    sess.bits = new Map([['M1000', true], ['M1001', false], ['M1002', true], ['M1003', false]]);
    sess.prevBits.clear();
    sess.edgeStates.clear();
    sess.words.clear();
    sess.timers.clear();
    sess.counters.clear();
    sess.forcedBits.clear();
    sess.forcedWords.clear();
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.traceBuffer = [];
    sess.lastBreakpointHit = null;
    seedInitialSymbolMemory(sess);
    resetDiagnosticsState(sess);
  }
  return monitorSimulator(sessionId);
}

export function forceAndWriteSimulator(
  sessionId: string,
  options: {
    bits?: Record<string, boolean>;
    words?: Record<string, number>;
    force_bits?: Record<string, boolean | null>;
    force_words?: Record<string, number | null>;
    symbols?: Record<string, number | boolean>;
  },
) {
  const sess = getSession(sessionId);
  if (options.force_bits) {
    for (const [k, v] of Object.entries(options.force_bits)) {
      const addr = resolveHardwareOrWordKey(sess, k);
      if (v === null) sess.forcedBits.delete(addr);
      else sess.forcedBits.set(addr, Boolean(v));
    }
  }
  if (options.force_words) {
    for (const [k, v] of Object.entries(options.force_words)) {
      const addr = resolveHardwareOrWordKey(sess, k);
      if (v === null) sess.forcedWords.delete(addr);
      else sess.forcedWords.set(addr, Math.trunc(Number(v)));
    }
  }
  if (options.bits) {
    for (const [k, v] of Object.entries(options.bits)) {
      writeBit(sess, k, Boolean(v));
    }
  }
  if (options.words) {
    for (const [k, v] of Object.entries(options.words)) {
      writeWord(sess, k, Number(v));
    }
  }
  if (options.symbols) {
    for (const [name, val] of Object.entries(options.symbols)) {
      const sym = resolveSymbol(sess, name);
      if (!sym) throw new FileTransformError(`Unknown symbol ${JSON.stringify(name)}`);
      if (typeof val === 'boolean' || sym.entry.type.toUpperCase() === 'BOOL') {
        writeBit(sess, sym.key, Boolean(val));
      } else {
        writeWord(sess, sym.key, Number(val));
      }
    }
  }
  if (sess.mode === 'RUN') {
    stepSimulator(sessionId, 1);
  }
  return monitorSimulator(sessionId);
}

export function monitorSimulator(sessionId: string, addresses?: string[], compact = false) {
  const sess = getSession(sessionId);
  const queryValues: Record<string, unknown> = {};
  if (addresses && addresses.length > 0) {
    for (const addr of addresses) {
      const raw = addr.trim();
      const up = normAddr(raw);
      if (/^(X|Y|M|S)\d+$/.test(up) || parseBitOfWord(up)) {
        queryValues[up] = { value: readBit(sess, up), forced: sess.forcedBits.has(up) };
      } else if (/^T\d+$/.test(up)) {
        queryValues[up] = sess.timers.get(up) ?? { pv: 0, sv: 0, done: false, accMs: 0, baseMs: timerTimebaseMs(up) };
      } else if (/^C\d+$/.test(up)) {
        queryValues[up] = sess.counters.get(up) ?? { pv: 0, sv: 0, done: false };
      } else if (/^(T|C)\d+\.(Q|DONE|PV)$/.test(up)) {
        const isPv = up.endsWith('.PV');
        queryValues[up] = { value: isPv ? readWord(sess, up) : readBit(sess, up) };
      } else if (/^D\d+$/.test(up)) {
        queryValues[up] = { value: readWord(sess, up), forced: sess.forcedWords.has(up) };
      } else {
        const sym = resolveSymbol(sess, raw);
        if (sym) {
          const isBool = sym.entry.type.toUpperCase() === 'BOOL' || (sym.entry.address !== null && isBitAddress(sym.entry.address));
          queryValues[raw] = {
            address: sym.entry.address,
            type: sym.entry.type,
            value: isBool ? readBit(sess, sym.key) : readWord(sess, sym.key),
            forced: sym.entry.address ? (sess.forcedBits.has(normAddr(sym.entry.address)) || sess.forcedWords.has(normAddr(sym.entry.address))) : false,
          };
        } else if (sess.words.has(up)) {
          queryValues[raw] = { type: 'WORD', value: sess.words.get(up)!, forced: sess.forcedWords.has(up) };
        } else if (sess.bits.has(up)) {
          queryValues[raw] = { type: 'BOOL', value: sess.bits.get(up)!, forced: sess.forcedBits.has(up) };
        } else {
          queryValues[raw] = { known: false, value: null };
        }
      }
    }
  }

  const base = {
    success: true,
    execution_target: 'SOFT_PLC_SIMULATOR',
    qualification: 'SOFT_PLC_SIMULATOR',
    session_id: sess.session_id,
    project_path: sess.project_path,
    model: sess.model,
    mode: sess.mode,
    scan_count: sess.scan_count,
    elapsed_ms: sess.elapsed_ms,
    scan_interval_ms: sess.scan_interval_ms,
    last_scan_ms: Math.round(sess.diagnostics.last_scan_ms * 1000) / 1000,
    queried_addresses: queryValues,
    last_breakpoint_hit: sess.lastBreakpointHit,
  };

  if (compact) {
    return {
      ...base,
      compact: true,
      timers: Object.fromEntries(sess.timers.entries()),
      counters: Object.fromEntries(sess.counters.entries()),
      forced_bits: Object.fromEntries(sess.forcedBits.entries()),
      forced_words: Object.fromEntries(sess.forcedWords.entries()),
    };
  }

  const activeBits = Object.fromEntries(
    [...new Set([...sess.bits.keys(), ...sess.forcedBits.keys()])]
      .filter((k) => readBit(sess, k))
      .map((k) => [k, true]),
  );
  const nonZeroWords = Object.fromEntries(
    [...new Set([...sess.words.keys(), ...sess.forcedWords.keys()])]
      .filter((k) => readWord(sess, k) !== 0)
      .map((k) => [k, readWord(sess, k)]),
  );
  const symbolValues = Object.fromEntries(
    [...sess.symbols.entries()].map(([name, sym]) => [
      name,
      {
        address: sym.address,
        type: sym.type,
        value:
          sym.type.toUpperCase() === 'BOOL' || (sym.address !== null && isBitAddress(sym.address))
            ? readBit(sess, name)
            : readWord(sess, name),
      },
    ]),
  );

  return {
    ...base,
    active_bits: activeBits,
    non_zero_words: nonZeroWords,
    timers: Object.fromEntries(sess.timers.entries()),
    counters: Object.fromEntries(sess.counters.entries()),
    forced_bits: Object.fromEntries(sess.forcedBits.entries()),
    forced_words: Object.fromEntries(sess.forcedWords.entries()),
    symbols: symbolValues,
    rung_power_flow: sess.lastRungTrace,
    st_trace: sess.lastStTrace,
  };
}

export function stepSimulatorUntil(sessionId: string, expr: string, maxCycles = 500, addresses?: string[]) {
  const sess = getSession(sessionId);
  const limit = Math.max(1, Math.min(10_000, maxCycles));
  let cyclesExecuted = 0;
  let conditionMet = false;

  for (let i = 0; i < limit; i++) {
    stepSimulator(sessionId, 1);
    cyclesExecuted += 1;
    if (evaluateConditionExpr(sess, expr)) {
      conditionMet = true;
      break;
    }
    if (sess.lastBreakpointHit) {
      break;
    }
  }

  return {
    success: true,
    session_id: sessionId,
    condition: expr,
    condition_met: conditionMet,
    cycles_executed: cyclesExecuted,
    scan_count: sess.scan_count,
    elapsed_ms: sess.elapsed_ms,
    breakpoint_hit: sess.lastBreakpointHit,
    snapshot: monitorSimulator(sessionId, addresses, true),
  };
}

export function runSimulatorSequence(
  sessionId: string,
  steps: Array<{
    label?: string;
    bits?: Record<string, boolean>;
    words?: Record<string, number>;
    force_bits?: Record<string, boolean | null>;
    force_words?: Record<string, number | null>;
    symbols?: Record<string, number | boolean>;
    cycles?: number;
    step_until?: string;
    max_cycles?: number;
    expect?: Record<string, boolean | number>;
    assert_expr?: string;
  }>,
  stopOnFailure = false,
) {
  const sess = getSession(sessionId);
  const stepResults: Array<Record<string, unknown>> = [];
  let allPassed = true;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.bits || st.words || st.force_bits || st.force_words || st.symbols) {
      forceAndWriteSimulator(sessionId, {
        bits: st.bits,
        words: st.words,
        force_bits: st.force_bits,
        force_words: st.force_words,
        symbols: st.symbols,
      });
    }

    let conditionMet: boolean | null = null;
    let cyclesExecuted = 0;
    if (st.step_until) {
      const untilRes = stepSimulatorUntil(sessionId, st.step_until, st.max_cycles ?? 500);
      conditionMet = untilRes.condition_met;
      cyclesExecuted = untilRes.cycles_executed;
    } else if ((st.cycles ?? 0) > 0) {
      stepSimulator(sessionId, st.cycles!);
      cyclesExecuted = st.cycles!;
    }

    const assertionFailures: string[] = [];
    const observed: Record<string, boolean | number> = {};
    if (st.expect) {
      for (const [k, expected] of Object.entries(st.expect)) {
        const up = normAddr(k);
        const sym = resolveSymbol(sess, k);
        let actual: boolean | number;
        if (typeof expected === 'boolean' || isBitAddress(up) || /^(T|C)\d+\.(Q|DONE)$/.test(up) || sym?.entry.type.toUpperCase() === 'BOOL') {
          actual = readBit(sess, k);
        } else {
          actual = readWord(sess, k);
        }
        observed[k] = actual;
        if (actual !== expected) {
          assertionFailures.push(`${k}: expected ${String(expected)}, got ${String(actual)}`);
        }
      }
    }
    if (st.assert_expr) {
      const ok = evaluateConditionExpr(sess, st.assert_expr);
      if (!ok) {
        assertionFailures.push(`assert_expr failed: ${st.assert_expr}`);
      }
    }
    if (st.step_until && !conditionMet) {
      assertionFailures.push(`step_until timed out after ${cyclesExecuted} scans: ${st.step_until}`);
    }

    const passed = assertionFailures.length === 0;
    if (!passed) allPassed = false;
    stepResults.push({
      step: i + 1,
      label: st.label ?? `step_${i + 1}`,
      passed,
      cycles_executed: cyclesExecuted,
      scan_count: sess.scan_count,
      elapsed_ms: sess.elapsed_ms,
      observed,
      failures: assertionFailures,
    });
    if (!passed && stopOnFailure) break;
  }

  return {
    success: allPassed,
    status: allPassed ? 'SEQUENCE_PASSED' : 'SEQUENCE_ASSERTION_FAILED',
    session_id: sessionId,
    steps_run: stepResults.length,
    total_steps: steps.length,
    scan_count: sess.scan_count,
    elapsed_ms: sess.elapsed_ms,
    results: stepResults,
  };
}

export function dumpSimulatorMemory(
  sessionId: string,
  area: 'X' | 'Y' | 'M' | 'S' | 'T' | 'C' | 'D',
  start = 0,
  count = 32,
  onlyNonZero = false,
) {
  const sess = getSession(sessionId);
  const upArea = area.toUpperCase() as 'X' | 'Y' | 'M' | 'S' | 'T' | 'C' | 'D';
  const clampedCount = Math.max(1, Math.min(256, count));
  const isOctal = upArea === 'X' || upArea === 'Y';
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < clampedCount; i++) {
    const idx = start + i;
    const addr = `${upArea}${isOctal ? idx.toString(8).toUpperCase() : idx}`;
    if (upArea === 'D') {
      const val = readWord(sess, addr);
      if (onlyNonZero && val === 0 && !sess.forcedWords.has(addr)) continue;
      rows.push({ address: addr, value: val, forced: sess.forcedWords.has(addr) });
    } else if (upArea === 'T') {
      const t = sess.timers.get(addr);
      if (onlyNonZero && !t) continue;
      rows.push({ address: addr, pv: t?.pv ?? 0, sv: t?.sv ?? 0, done: t?.done ?? false });
    } else if (upArea === 'C') {
      const c = sess.counters.get(addr);
      if (onlyNonZero && !c) continue;
      rows.push({ address: addr, pv: c?.pv ?? 0, sv: c?.sv ?? 0, done: c?.done ?? false });
    } else {
      const val = readBit(sess, addr);
      if (onlyNonZero && !val && !sess.forcedBits.has(addr)) continue;
      rows.push({ address: addr, value: val, forced: sess.forcedBits.has(addr) });
    }
  }
  return {
    success: true,
    session_id: sessionId,
    area: upArea,
    start,
    count: clampedCount,
    entries: rows,
  };
}

export function manageBreakpoints(
  sessionId: string,
  action: 'list' | 'add' | 'remove' | 'clear',
  rule?: { id?: string; expr?: string; enabled?: boolean },
) {
  const sess = getSession(sessionId);
  if (action === 'add') {
    if (!rule?.expr?.trim()) throw new FileTransformError('expr is required when adding a breakpoint');
    const bp: BreakpointRule = {
      id: rule.id?.trim() || `bp-${nextBpId++}`,
      expr: rule.expr.trim(),
      enabled: rule.enabled !== false,
      hit_count: 0,
      last_hit_scan: null,
    };
    sess.breakpoints.push(bp);
    return { success: true, session_id: sessionId, added: bp, breakpoints: sess.breakpoints };
  }
  if (action === 'remove') {
    if (!rule?.id) throw new FileTransformError('id is required to remove a breakpoint');
    sess.breakpoints = sess.breakpoints.filter((b) => b.id !== rule.id);
    return { success: true, session_id: sessionId, breakpoints: sess.breakpoints };
  }
  if (action === 'clear') {
    sess.breakpoints = [];
    sess.lastBreakpointHit = null;
    return { success: true, session_id: sessionId, breakpoints: [] };
  }
  return {
    success: true,
    session_id: sessionId,
    last_breakpoint_hit: sess.lastBreakpointHit,
    breakpoints: sess.breakpoints,
  };
}

export function manageWatchTable(
  sessionId: string,
  action: 'list' | 'set' | 'read' | 'trace',
  tableName = 'default',
  addresses?: string[],
) {
  const sess = getSession(sessionId);
  if (action === 'set') {
    if (!addresses || !addresses.length) {
      throw new FileTransformError('addresses required to set a watch table');
    }
    sess.watchLists.set(tableName, addresses);
  }
  const tableAddrs = sess.watchLists.get(tableName) ?? [];
  const snapshot = monitorSimulator(sessionId, tableAddrs, true);
  return {
    success: true,
    session_id: sessionId,
    table_name: tableName,
    addresses: tableAddrs,
    current_values: snapshot.queried_addresses,
    trace_samples: action === 'trace' ? sess.traceBuffer : sess.traceBuffer.slice(-20),
    all_tables: Object.fromEntries(sess.watchLists.entries()),
  };
}

export function compareSimulatorWithProject(sessionId: string, projectPath?: string) {
  const sess = getSession(sessionId);
  const targetPath = projectPath?.trim() || sess.project_path;
  const targetBytes = readFileBuffer(targetPath);
  const targetHash = computeContentHash('isp', targetBytes);
  return {
    success: true,
    session_id: sessionId,
    simulator_project_path: sess.project_path,
    simulator_project_hash: sess.project_hash,
    compared_project_path: targetPath,
    compared_project_hash: targetHash,
    programs_match: sess.project_hash === targetHash,
    raw_isp_bytes: sess.raw_isp_bytes,
  };
}

export interface ProfileSimulatorOptions {
  sample_cycles?: number;
  slow_threshold_ms?: number;
  reset_metrics?: boolean;
  include_recent_scans?: boolean;
}

export function profileSimulatorSession(sessionId: string, options: ProfileSimulatorOptions = {}) {
  const sess = getSession(sessionId);
  if (options.reset_metrics) {
    resetDiagnosticsState(sess);
  }

  const requestedSampleCycles =
    typeof options.sample_cycles === 'number' && Number.isFinite(options.sample_cycles)
      ? Math.max(0, Math.min(2000, Math.trunc(options.sample_cycles)))
      : 0;

  let benchmarkExecuted: {
    cycles_requested: number;
    cycles_executed: number;
    wall_ms: number;
    scans_per_sec: number | null;
    words_growth: number;
    bits_growth: number;
    heap_delta_bytes: number;
    stopped_by_breakpoint: boolean;
  } | null = null;

  if (requestedSampleCycles > 0) {
    const startScan = sess.scan_count;
    const wordsBefore = sess.words.size;
    const bitsBefore = sess.bits.size;
    const heapBefore = process.memoryUsage().heapUsed;
    const wallT0 = process.hrtime.bigint();
    stepSimulator(sessionId, requestedSampleCycles);
    const wallMs = Number(process.hrtime.bigint() - wallT0) / 1_000_000;
    const cyclesExecuted = sess.scan_count - startScan;
    const heapAfter = process.memoryUsage().heapUsed;
    benchmarkExecuted = {
      cycles_requested: requestedSampleCycles,
      cycles_executed: cyclesExecuted,
      wall_ms: Math.round(wallMs * 1000) / 1000,
      scans_per_sec: wallMs > 0 ? Math.round((cyclesExecuted * 1000) / wallMs) : null,
      words_growth: sess.words.size - wordsBefore,
      bits_growth: sess.bits.size - bitsBefore,
      heap_delta_bytes: heapAfter - heapBefore,
      stopped_by_breakpoint: Boolean(sess.lastBreakpointHit),
    };
  }

  const slowThresholdMs =
    typeof options.slow_threshold_ms === 'number' && Number.isFinite(options.slow_threshold_ms) && options.slow_threshold_ms > 0
      ? options.slow_threshold_ms
      : Math.max(1, Math.min(25, sess.scan_interval_ms * 0.5));

  const diag = sess.diagnostics;
  const slowScanCount = diag.scan_history.filter((s) => s.duration_ms > slowThresholdMs).length;
  const memoryBreakdown = computeSessionMemoryBreakdown(sess);
  const procMem = process.memoryUsage();

  const report = analyzeSimulationDiagnostics({
    scanIntervalMs: sess.scan_interval_ms,
    slowThresholdMs,
    totalScansProfiled: diag.total_scans_profiled,
    overrunCount: diag.overrun_count,
    slowScanCount,
    totalScanExecMs: diag.total_scan_exec_ms,
    minScanMs: diag.min_scan_ms,
    maxScanMs: diag.max_scan_ms,
    recentScans: diag.scan_history,
    pouMetrics: [...diag.pou_metrics.values()],
    networkMetrics: [...diag.network_metrics.values()],
    memory: memoryBreakdown,
    baselineWordsCount: diag.baseline_words_count,
    baselineBitsCount: diag.baseline_bits_count,
    baselineStateBytes: diag.baseline_state_bytes,
    baselineHeapUsedBytes: diag.baseline_heap_used_bytes,
    currentHeapUsedBytes: procMem.heapUsed,
    currentHeapTotalBytes: procMem.heapTotal,
    currentRssBytes: procMem.rss,
    currentExternalBytes: procMem.external,
  });

  return {
    success: true,
    session_id: sess.session_id,
    project_path: sess.project_path,
    model: sess.model,
    mode: sess.mode,
    scan_count: sess.scan_count,
    elapsed_ms: sess.elapsed_ms,
    ...report,
    benchmark_executed: benchmarkExecuted,
    recent_scans: options.include_recent_scans ? diag.scan_history.slice(-25) : undefined,
  };
}
