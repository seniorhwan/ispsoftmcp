import {
  decodeContainer,
  inspectContainer,
  ldNetworks,
  parseLdNetwork,
  parseLocalVariables,
  patchSt,
  propertyValue,
  replaceLdPouNetworks,
  sections,
} from './containers.js';
import {
  buildNetworksFromIl,
  patchFbdPouInSource,
  patchIlPouInSource,
  patchSfcPouInSource,
  readDuts,
  readTasks,
} from './authoring.js';
import { parseIl } from './dvp.js';
import {
  DeviceInitEntry,
  HwConfigDocument,
  RetainConfigDocument,
  isDeviceRetained,
  readDeviceInitFromSource,
  readHwConfigFromSource,
  readRetainConfigFromSource,
} from './hwConfig.js';
import { netToIl, parseNetworks } from './mpu2il.js';
import { Instruction, splitNets } from './il2mpu.js';
import {
  FileTransformError,
  assertNoStructuralDelimiters,
  computeContentHash,
  decodeCodepage,
  encodeCodepage,
} from './limits.js';
import { ExprNode, compileSymbolicStExpr, evaluateSafeNumericExpr, evaluateSymbolicStAst } from './safeExpr.js';
import {
  FbdBlock,
  FbdDiagram,
  SfcChart,
  SfcStep,
  SfcTransition,
  parseFbdFromPouBody,
  parseSfcFromPouBody,
  topologicalSortFbd,
  validateFbdDiagram,
  validateSfcChart,
} from './sfcFbd.js';
import {
  MemoryBreakdown,
  NetworkTimingSummary,
  PouTimingSummary,
  ScanSample,
  analyzeSimulationDiagnostics,
  computeMemoryBreakdown,
} from './simDiagnostics.js';
import { readFileBuffer, writeFileBuffer } from './workspace.js';

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

export interface SfcStepRuntimeState {
  active: boolean;
  elapsedMs: number;
  enteredThisScan: boolean;
}

export interface SfcRuntimeState {
  initialized: boolean;
  steps: Map<string, SfcStepRuntimeState>;
  storedActions: Map<string, { name: string; code: string }>;
}

export interface PidRuntimeState {
  integral: number;
  prevError: number;
  prevPv: number;
  initialized: boolean;
}

export interface FbInstanceState {
  type: string;
  fields: Record<string, number | boolean>;
  internal: Record<string, number | boolean>;
}

export interface SimSfcTrace {
  pou: string;
  active_steps: string[];
  transitions_fired: string[];
  outputs_written: Record<string, boolean | number>;
}

export interface SimFbdTrace {
  pou: string;
  blocks_evaluated: number;
  outputs_written: Record<string, boolean | number>;
}

export interface SimPouProgram {
  name: string;
  lang: string;
  pouType: string;
  active: boolean;
  localVars: SimLocalVarMeta[];
  networks: Array<{ index: number; net_id: string; label: string; active: boolean; il: Instruction[] }>;
  stCode: string;
  sfcChart?: SfcChart | null;
  fbdDiagram?: FbdDiagram | null;
  _cachedFbdOrder?: FbdBlock[];
  _cachedSfcPlan?: { stepByName: Map<string, SfcStep>; sortedTrans: SfcTransition[] };
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
  symbolsByUpper: Map<
    string,
    { key: string; entry: { address: string | null; type: string; value: number | boolean; initial: number | boolean } }
  >;
  dutFields: Map<string, string[]>;
  hwConfig: HwConfigDocument;
  retainConfig: RetainConfigDocument;
  deviceInit: DeviceInitEntry[];
  moduleBfm: Map<number, Map<number, number>>;
  sfcStates: Map<string, SfcRuntimeState>;
  pidStates: Map<string, PidRuntimeState>;
  fbInstances: Map<string, FbInstanceState>;
  taskLastRunMs: Map<string, number>;
  interruptsEnabled: boolean;
  tasks: ReturnType<typeof readTasks>;
  sortedActiveTasks: ReturnType<typeof readTasks>;
  pouPrograms: SimPouProgram[];
  pouByName: Map<string, SimPouProgram>;
  pouByUpperName: Map<string, SimPouProgram>;
  lastRungTrace: SimNetworkTrace[];
  lastStTrace: SimStTrace[];
  lastSfcTrace: SimSfcTrace[];
  lastFbdTrace: SimFbdTrace[];
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
  if (!addr.includes('.')) return null;
  const m = /^([DRVZ]\d+)\.([0-9]|1[0-5]|[A-Fa-f])$/i.exec(addr.trim());
  if (!m) return null;
  const rawBit = m[2];
  const bitIdx = /^[0-9]+$/.test(rawBit) ? parseInt(rawBit, 10) : parseInt(rawBit, 16);
  if (bitIdx < 0 || bitIdx > 15) return null;
  return { wordAddr: m[1].toUpperCase(), bitIdx };
}

function buildSymbolUpperIndex(
  symbols: SimulatorSession['symbols'],
): SimulatorSession['symbolsByUpper'] {
  const idx: SimulatorSession['symbolsByUpper'] = new Map();
  for (const [k, v] of symbols.entries()) {
    const up = k.toUpperCase();
    if (!idx.has(up)) idx.set(up, { key: k, entry: v });
  }
  return idx;
}

function rebuildScheduleIndexes(sess: SimulatorSession): void {
  sess.sortedActiveTasks = sess.tasks.filter((t) => t.active).sort((a, b) => a.priority - b.priority);
  sess.pouByName = new Map();
  sess.pouByUpperName = new Map();
  for (const p of sess.pouPrograms) {
    sess.pouByName.set(p.name, p);
    sess.pouByUpperName.set(p.name.toUpperCase(), p);
  }
}

function resolveSymbol(sess: SimulatorSession, name: string) {
  const trimmed = name.trim();
  const exact = sess.symbols.get(trimmed);
  if (exact !== undefined) {
    return { key: trimmed, entry: exact };
  }
  return sess.symbolsByUpper.get(trimmed.toUpperCase()) ?? null;
}

const _f32Buf = new ArrayBuffer(4);
const _f32View = new DataView(_f32Buf);

function float32ToInt32(val: number): number {
  _f32View.setFloat32(0, val, true);
  return _f32View.getInt32(0, true);
}

function int32ToFloat32(bits: number): number {
  _f32View.setInt32(0, bits | 0, true);
  return _f32View.getFloat32(0, true);
}

function isFloatType(typeName?: string): boolean {
  const u = (typeName ?? '').trim().toUpperCase();
  return u === 'REAL' || u === 'LREAL';
}

const STANDARD_IEC_FBS = new Set([
  'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'SR', 'RS', 'PID_FB', 'SCALE',
]);

function resolveIndexRegisterAddr(sess: SimulatorSession, rawAddr: string): string {
  const up = normAddr(rawAddr);
  // Fast-path: indexed addressing always has V, Z, or E after digits (e.g. D10Z0, X0V1)
  if (up.length < 4 || (!up.includes('V') && !up.includes('Z') && !up.includes('E'))) {
    return up;
  }
  const m = /^([XYMSTCDR])(\d+)([VZE])(\d+)$/.exec(up);
  if (!m) return up;
  const area = m[1];
  const isOctal = area === 'X' || area === 'Y';
  const base = parseInt(m[2], isOctal ? 8 : 10);
  const idxReg = `${m[3]}${m[4]}`;
  const offset = Math.trunc(sess.words.get(idxReg) ?? 0);
  const effective = Math.max(0, base + offset);
  return isOctal ? `${area}${effective.toString(8).toUpperCase()}` : `${area}${effective}`;
}

function resolveHardwareOrWordKey(sess: SimulatorSession, rawName: string): string {
  const resolved = resolveSymbol(sess, rawName);
  if (resolved?.entry.address) {
    return resolveIndexRegisterAddr(sess, resolved.entry.address);
  }
  return resolveIndexRegisterAddr(sess, rawName);
}

function isBitAddress(addr: string): boolean {
  const t = addr.trim();
  if (!t) return false;
  if (t.includes('.')) {
    return /^(X|Y)\d+\.\d+$/i.test(t) || parseBitOfWord(t) !== null;
  }
  const c0 = t.charCodeAt(0);
  if (c0 !== 88 && c0 !== 120 && c0 !== 89 && c0 !== 121 && c0 !== 77 && c0 !== 109 && c0 !== 83 && c0 !== 115) {
    return false;
  }
  return /^(X|Y|M|S|SM)\d+$/i.test(t) || /^(X|Y|M|S)\d+[VZE]\d+$/i.test(t);
}

function parseConst(token: string, sess: SimulatorSession): number {
  const t = token.trim();
  if (/^[Kk](-?\d+)$/.test(t)) return parseInt(t.slice(1), 10);
  if (/^[Ff](-?\d+(?:\.\d+)?)$/.test(t)) return parseFloat(t.slice(1));
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[Hh]([0-9A-Fa-f]+)$/.test(t)) return parseInt(t.slice(1), 16);
  if (parseBitOfWord(t)) return readBit(sess, t) ? 1 : 0;
  const sym = resolveSymbol(sess, t);
  if (sym) {
    if (sym.entry.address) {
      if (isFloatType(sym.entry.type)) {
        return readFloat32(sess, sym.entry.address);
      }
      return isBitAddress(sym.entry.address)
        ? readBit(sess, sym.entry.address) ? 1 : 0
        : readWord(sess, sym.entry.address);
    }
    return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? 1 : 0) : Number(sym.entry.value);
  }
  const idxResolved = resolveIndexRegisterAddr(sess, t);
  return readWord(sess, idxResolved);
}

function readBit(sess: SimulatorSession, rawAddr: string): boolean {
  const addr = resolveIndexRegisterAddr(sess, rawAddr);
  if (sess.forcedBits.size > 0 && sess.forcedBits.has(addr)) return sess.forcedBits.get(addr)!;

  if (addr.includes('.')) {
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
  }

  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) return readBit(sess, sym.entry.address);
    return Boolean(sym.entry.value);
  }
  const c0 = addr.charCodeAt(0);
  if (c0 === 84 && /^T\d+$/.test(addr)) {
    return sess.timers.get(addr)?.done ?? false;
  }
  if (c0 === 67 && /^C\d+$/.test(addr)) {
    return sess.counters.get(addr)?.done ?? false;
  }
  return sess.bits.get(addr) ?? false;
}

function writeBit(sess: SimulatorSession, rawAddr: string, val: boolean): void {
  const addr = resolveIndexRegisterAddr(sess, rawAddr);
  if (sess.forcedBits.size > 0 && sess.forcedBits.has(addr)) return;

  if (addr.includes('.')) {
    const bow = parseBitOfWord(addr);
    if (bow) {
      const cur = readWord(sess, bow.wordAddr) & 0xffff;
      const next = val ? (cur | (1 << bow.bitIdx)) : (cur & ~(1 << bow.bitIdx));
      writeWord(sess, bow.wordAddr, toInt16(next));
      return;
    }
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
  const c0 = addr.charCodeAt(0);
  if (c0 === 84 && /^T\d+$/.test(addr)) {
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
  if (c0 === 67 && /^C\d+$/.test(addr)) {
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
  const addr = resolveIndexRegisterAddr(sess, rawAddr);
  if (sess.forcedWords.size > 0 && sess.forcedWords.has(addr)) return sess.forcedWords.get(addr)!;

  if (addr.includes('.')) {
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
  }

  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (sym.entry.address) {
      if (isFloatType(sym.entry.type)) return readFloat32(sess, sym.entry.address);
      return readWord(sess, sym.entry.address);
    }
    return Number(sym.entry.value) || 0;
  }
  const c0 = addr.charCodeAt(0);
  if (c0 === 84 && /^T\d+$/.test(addr)) {
    return sess.timers.get(addr)?.pv ?? 0;
  }
  if (c0 === 67 && /^C\d+$/.test(addr)) {
    return sess.counters.get(addr)?.pv ?? 0;
  }
  return sess.words.get(addr) ?? 0;
}

function writeWord(sess: SimulatorSession, rawAddr: string, val: number): void {
  const addr = resolveIndexRegisterAddr(sess, rawAddr);
  if (sess.forcedWords.size > 0 && sess.forcedWords.has(addr)) return;
  const sym = resolveSymbol(sess, rawAddr);
  if (sym) {
    if (isFloatType(sym.entry.type)) {
      const fVal = Number.isFinite(val) ? val : 0;
      if (sym.entry.address) {
        writeFloat32(sess, sym.entry.address, fVal);
        return;
      }
      sym.entry.value = fVal;
      sess.words.set(normAddr(sym.key), fVal);
      return;
    }
    const intVal = Math.trunc(val);
    if (sym.entry.address) {
      writeWord(sess, sym.entry.address, intVal);
      return;
    }
    sym.entry.value = intVal;
    sess.words.set(normAddr(sym.key), intVal);
    return;
  }
  const intVal = Math.trunc(val);
  const c0 = addr.charCodeAt(0);
  if (c0 === 84 && /^T\d+$/.test(addr)) {
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
  if (c0 === 67 && /^C\d+$/.test(addr)) {
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
  if (/^[DRVZE]\d+$/i.test(key) || /^SR\d+$/i.test(key)) {
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
  if (/^[DRVZE]\d+$/i.test(key) || /^SR\d+$/i.test(key)) {
    writeWord(sess, key, toInt16(v32 & 0xffff));
    writeWord(sess, shiftIndexedDevice(key, 1), toInt16((v32 >>> 16) & 0xffff));
    return;
  }
  writeWord(sess, key, v32);
}

function readFloat32(sess: SimulatorSession, token: string): number {
  const t = token.trim();
  if (/^[Ff](-?\d+(?:\.\d+)?)$/.test(t)) return parseFloat(t.slice(1));
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (/^[Kk](-?\d+)$/.test(t)) return parseInt(t.slice(1), 10);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  const sym = resolveSymbol(sess, t);
  if (sym && !sym.entry.address) {
    return Number(sym.entry.value) || 0;
  }
  return int32ToFloat32(readDWord(sess, t));
}

function writeFloat32(sess: SimulatorSession, rawAddr: string, val: number): void {
  const f = Number.isFinite(val) ? val : 0;
  const sym = resolveSymbol(sess, rawAddr);
  if (sym && !sym.entry.address) {
    sym.entry.value = f;
    sess.words.set(normAddr(sym.key), f);
    return;
  }
  writeDWord(sess, rawAddr, float32ToInt32(f));
}

function getSession(sessionId: string): SimulatorSession {
  const sess = sessions.get(sessionId);
  if (!sess) {
    throw new FileTransformError(`Unknown simulator session ${JSON.stringify(sessionId)}`);
  }
  sess.last_touched_at_ms = Date.now();
  return sess;
}

function parseInitTokenValue(typeName: string, rawInitial: string): number | boolean {
  const initToken = rawInitial.replace(/\[@[^\]]+@\]/g, '').trim();
  if (typeName.toUpperCase() === 'BOOL') {
    if (/^TRUE$/i.test(initToken) || initToken === '1') return true;
    return false;
  }
  if (isFloatType(typeName)) {
    const n = Number.parseFloat(initToken);
    return Number.isFinite(n) ? n : 0;
  }
  if (/^-?\d+$/.test(initToken)) return parseInt(initToken, 10);
  if (/^TRUE$/i.test(initToken)) return 1;
  return 0;
}

function parseIlCodeToNetworks(ilCode: string): SimPouProgram['networks'] {
  try {
    const parsed = parseIl(ilCode);
    const nets = splitNets(parsed);
    return nets.map((net, idx) => ({
      index: idx + 1,
      net_id: String(idx + 1),
      label: net.label ?? '',
      active: true,
      il: net.seq && net.seq.length > 0 ? net.seq : [...net.in, ...net.out],
    }));
  } catch {
    return [];
  }
}

function parseProjectForSim(rawBytes: Buffer) {
  const container = decodeContainer(rawBytes);
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const tasks = readTasks(text);
  const hwConfig = readHwConfigFromSource(text);
  const retainConfig = readRetainConfigFromSource(text);
  const deviceInit = readDeviceInitFromSource(text);

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
  const fbInstances = new Map<string, FbInstanceState>();

  const registerStructSubfields = (identifier: string, entryType: string) => {
    const metas = dutFieldMeta.get(entryType);
    if (metas) {
      for (const f of metas) {
        const fBool = f.type === 'BOOL';
        symbols.set(`${identifier}.${f.name}`, {
          address: null,
          type: f.type,
          value: fBool ? false : 0,
          initial: fBool ? false : 0,
        });
      }
    }
    const upType = entryType.toUpperCase();
    if (STANDARD_IEC_FBS.has(upType)) {
      const fields: Record<string, number | boolean> = {};
      if (upType === 'TON' || upType === 'TOF' || upType === 'TP') {
        Object.assign(fields, { IN: false, PT: 0, Q: false, ET: 0 });
      } else if (upType === 'CTU') {
        Object.assign(fields, { CU: false, R: false, PV: 0, Q: false, CV: 0 });
      } else if (upType === 'CTD') {
        Object.assign(fields, { CD: false, LD: false, PV: 0, Q: false, CV: 0 });
      } else if (upType === 'CTUD') {
        Object.assign(fields, { CU: false, CD: false, R: false, LD: false, PV: 0, QU: false, QD: false, CV: 0 });
      } else if (upType === 'R_TRIG' || upType === 'F_TRIG') {
        Object.assign(fields, { CLK: false, Q: false });
      } else if (upType === 'SR' || upType === 'RS') {
        Object.assign(fields, { S1: false, S: false, R: false, R1: false, Q1: false, Q: false });
      } else if (upType === 'PID_FB') {
        Object.assign(fields, { SV: 0, PV: 0, KP: 100, TI: 0, TD: 0, EN: true, MV: 0 });
      } else if (upType === 'SCALE') {
        Object.assign(fields, { IN: 0, IN_MIN: 0, IN_MAX: 4000, OUT_MIN: 0, OUT_MAX: 100, OUT: 0 });
      }
      fbInstances.set(identifier.toUpperCase(), { type: upType, fields, internal: {} });
      for (const [fn, fv] of Object.entries(fields)) {
        symbols.set(`${identifier}.${fn}`, {
          address: null,
          type: typeof fv === 'boolean' ? 'BOOL' : isFloatType(upType) ? 'REAL' : 'INT',
          value: fv,
          initial: fv,
        });
      }
    }
  };

  const globalSecs = sections(text, 'GLOBAL_VAR');
  for (const gs of globalSecs) {
    const parsed = parseLocalVariables(gs.inner);
    for (const entry of parsed.entries) {
      const initVal = parseInitTokenValue(entry.type, entry.initial_value);
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
      const initVal = parseInitTokenValue(entry.type, entry.initial_value);
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

    const stCode = sections(pouMatch.inner, 'IL_ST_CODE')[0]?.inner ?? '';
    let networks: SimPouProgram['networks'] = [];
    let sfcChart: SfcChart | null = null;
    let fbdDiagram: FbdDiagram | null = null;

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
    } else if (lang === '3') {
      networks = parseIlCodeToNetworks(stCode);
    } else if (lang === '4') {
      sfcChart = parseSfcFromPouBody(pouMatch.inner).chart;
    } else if (lang === '5') {
      fbdDiagram = parseFbdFromPouBody(pouMatch.inner).diagram;
    }

    pouPrograms.push({ name, lang, pouType, active, localVars, networks, stCode, sfcChart, fbdDiagram });
  }

  // Register user-defined FB instances declared as symbols (e.g., Motor1 : MotorFB)
  const userFbs = new Map<string, SimPouProgram>();
  for (const p of pouPrograms) {
    if (p.pouType === '1') userFbs.set(p.name.toUpperCase(), p);
  }
  for (const [symName, sym] of [...symbols.entries()]) {
    const fbDef = userFbs.get(sym.type.toUpperCase());
    if (fbDef && !fbInstances.has(symName.toUpperCase())) {
      const fields: Record<string, number | boolean> = {};
      for (const lv of fbDef.localVars) {
        fields[lv.identifier] = lv.initial;
        symbols.set(`${symName}.${lv.identifier}`, {
          address: null,
          type: lv.type,
          value: lv.initial,
          initial: lv.initial,
        });
      }
      fbInstances.set(symName.toUpperCase(), { type: fbDef.name, fields, internal: {} });
    }
  }

  return { info, tasks, symbols, dutFields, pouPrograms, hwConfig, retainConfig, deviceInit, fbInstances };
}

function seedModuleBfmFromHwConfig(sess: SimulatorSession): void {
  sess.moduleBfm.clear();
  for (const mod of sess.hwConfig.modules) {
    const crMap = new Map<number, number>();
    for (const [k, v] of Object.entries(mod.cr_init ?? {})) {
      const crNum = Number(k);
      if (Number.isInteger(crNum) && crNum >= 0) {
        crMap.set(crNum, Math.trunc(Number(v) || 0));
      }
    }
    sess.moduleBfm.set(mod.slot, crMap);
  }
}

function seedInitialSymbolMemory(sess: SimulatorSession): void {
  for (const [name, sym] of sess.symbols.entries()) {
    sym.value = sym.initial;
    if (sym.address) {
      if (isBitAddress(sym.address) || sym.type.toUpperCase() === 'BOOL') {
        sess.bits.set(normAddr(sym.address), Boolean(sym.initial));
      } else if (isFloatType(sym.type)) {
        writeFloat32(sess, sym.address, Number(sym.initial) || 0);
      } else {
        sess.words.set(normAddr(sym.address), Number(sym.initial) || 0);
      }
    } else if (sym.type.toUpperCase() === 'BOOL') {
      sess.bits.set(normAddr(name), Boolean(sym.initial));
    } else {
      sess.words.set(normAddr(name), Number(sym.initial) || 0);
    }
  }
  for (const entry of sess.deviceInit) {
    const dev = normAddr(entry.device);
    const dt = entry.data_type.toUpperCase();
    if (dt === 'BOOL' || isBitAddress(dev)) {
      sess.bits.set(dev, Boolean(entry.value));
    } else if (dt === 'REAL') {
      writeFloat32(sess, dev, Number(entry.value) || 0);
    } else if (dt === 'DINT' || dt === 'DWORD') {
      writeDWord(sess, dev, Number(entry.value) || 0);
    } else if (dt === 'STRING') {
      const s = String(entry.value ?? '');
      for (let i = 0; i < Math.ceil(s.length / 2); i++) {
        const lo = s.charCodeAt(i * 2) || 0;
        const hi = s.charCodeAt(i * 2 + 1) || 0;
        sess.words.set(shiftIndexedDevice(dev, i), toInt16((hi << 8) | lo));
      }
    } else {
      sess.words.set(dev, toInt16(Number(entry.value) || 0));
    }
  }
  seedModuleBfmFromHwConfig(sess);
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
  const { info, tasks, symbols, dutFields, pouPrograms, hwConfig, retainConfig, deviceInit, fbInstances } =
    parseProjectForSim(rawBytes);

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
    symbolsByUpper: buildSymbolUpperIndex(symbols),
    dutFields,
    hwConfig,
    retainConfig,
    deviceInit,
    moduleBfm: new Map(),
    sfcStates: new Map(),
    pidStates: new Map(),
    fbInstances,
    taskLastRunMs: new Map(),
    interruptsEnabled: true,
    tasks,
    sortedActiveTasks: [],
    pouPrograms,
    pouByName: new Map(),
    pouByUpperName: new Map(),
    lastRungTrace: [],
    lastStTrace: [],
    lastSfcTrace: [],
    lastFbdTrace: [],
    watchLists: new Map([['default', defaultWatch]]),
    traceBuffer: [],
    breakpoints: [],
    lastBreakpointHit: null,
    diagnostics: createInitialDiagnosticsState(),
    created_at: new Date(nowMs).toISOString(),
    last_scan_at: null,
    last_touched_at_ms: nowMs,
  };
  rebuildScheduleIndexes(session);
  seedInitialSymbolMemory(session);
  captureDiagnosticsBaseline(session);
  sessions.set(sessionId, session);
  return session;
}

export function reloadSimulatorSession(sessionId: string, projectPath?: string, resetState = false) {
  const sess = getSession(sessionId);
  const targetPath = projectPath?.trim() || sess.project_path;
  const rawBytes = readFileBuffer(targetPath);
  const { info, tasks, symbols, dutFields, pouPrograms, hwConfig, retainConfig, deviceInit, fbInstances } =
    parseProjectForSim(rawBytes);

  sess.project_path = targetPath;
  sess.project_hash = computeContentHash('isp', rawBytes);
  sess.model = String(info.project_model ?? sess.model);
  sess.raw_isp_bytes = rawBytes;
  sess.tasks = tasks;
  sess.pouPrograms = pouPrograms;
  sess.dutFields = dutFields;
  sess.symbols = symbols;
  sess.symbolsByUpper = buildSymbolUpperIndex(symbols);
  rebuildScheduleIndexes(sess);
  sess.hwConfig = hwConfig;
  sess.retainConfig = retainConfig;
  sess.deviceInit = deviceInit;
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
    sess.sfcStates.clear();
    sess.pidStates.clear();
    sess.fbInstances = fbInstances;
    sess.taskLastRunMs.clear();
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.lastSfcTrace = [];
    sess.lastFbdTrace = [];
    sess.traceBuffer = [];
    sess.lastBreakpointHit = null;
    seedInitialSymbolMemory(sess);
    resetDiagnosticsState(sess);
  } else {
    for (const [k, v] of fbInstances.entries()) {
      if (!sess.fbInstances.has(k)) sess.fbInstances.set(k, v);
    }
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
  const is32 = op.startsWith('D');
  const a = is32 ? readDWord(sess, ops[0] ?? '0') : parseConst(ops[0] ?? '0', sess);
  const b = is32 ? readDWord(sess, ops[1] ?? '0') : parseConst(ops[1] ?? '0', sess);
  if (op.endsWith('<>')) return a !== b;
  if (op.endsWith('>=')) return a >= b;
  if (op.endsWith('<=')) return a <= b;
  if (op.endsWith('=')) return a === b;
  if (op.endsWith('>')) return a > b;
  if (op.endsWith('<')) return a < b;
  return false;
}

const LD_STARTER_OPS = new Set([
  'LD', 'LDI', 'LDP', 'LDF',
  'LD=', 'LD<>', 'LD>', 'LD>=', 'LD<', 'LD<=',
  'DLD=', 'DLD<>', 'DLD>', 'DLD>=', 'DLD<', 'DLD<=',
]);
const AND_CONTACT_OPS = new Set([
  'AND', 'ANI', 'ANDP', 'ANDF',
  'AND=', 'AND<>', 'AND>', 'AND>=', 'AND<', 'AND<=',
  'DAND=', 'DAND<>', 'DAND>', 'DAND>=', 'DAND<', 'DAND<=',
]);
const OR_CONTACT_OPS = new Set([
  'OR', 'ORI', 'ORP', 'ORF',
  'OR=', 'OR<>', 'OR>', 'OR>=', 'OR<', 'OR<=',
  'DOR=', 'DOR<>', 'DOR>', 'DOR>=', 'DOR<', 'DOR<=',
]);

const INPUT_OPS = new Set([
  ...LD_STARTER_OPS,
  ...AND_CONTACT_OPS,
  ...OR_CONTACT_OPS,
  'ANB', 'ORB', 'INV',
]);

const PULSEABLE_BASE_OPS = new Set([
  'MOV', 'DMOV', 'BMOV', 'FMOV', 'ADD', 'DADD', 'SUB', 'DSUB', 'MUL', 'DMUL', 'DIV', 'DDIV',
  'INC', 'DINC', 'DEC', 'DDEC', 'ANDW', 'ORW', 'XORW', 'DANDW', 'DORW', 'DXORW', 'NEG', 'DNEG',
  'SWAP', 'XCH', 'CMP', 'DCMP', 'ZCP', 'DZCP', 'ALT', 'ZRST', 'ROL', 'ROR', 'DROL', 'DROR',
  'SHL', 'SHR', 'SFTL', 'SFTR', 'DECO', 'ENCO', 'SUM', 'DSUM', 'BON', 'DBON', 'BCD', 'DBCD',
  'BIN', 'DBIN', 'FLT', 'DFLT', 'INT', 'DINT', 'EADD', 'ESUB', 'EMUL', 'EDIV', 'ESQR',
  'ECMP', 'EZCP', 'SQR', 'DSQR', 'SCL', 'MEAN', 'SORT', 'FROM', 'DFROM', 'TO', 'DTO',
  'TRD', 'TWR', 'MODRD', 'MODWR', 'MODRW',
]);

function intToBcd16(n: number): number {
  const clamped = Math.max(0, Math.min(9999, Math.trunc(Math.abs(n))));
  const d3 = Math.floor(clamped / 1000) % 10;
  const d2 = Math.floor(clamped / 100) % 10;
  const d1 = Math.floor(clamped / 10) % 10;
  const d0 = clamped % 10;
  return (d3 << 12) | (d2 << 8) | (d1 << 4) | d0;
}

function bcd16ToInt(bcd: number): number {
  const u = bcd & 0xffff;
  const d3 = (u >>> 12) & 0xf;
  const d2 = (u >>> 8) & 0xf;
  const d1 = (u >>> 4) & 0xf;
  const d0 = u & 0xf;
  return d3 * 1000 + d2 * 100 + d1 * 10 + d0;
}

function updateAluFlags(sess: SimulatorSession, rawResult: number, is32 = false): void {
  const min = is32 ? -2147483648 : -32768;
  const max = is32 ? 2147483647 : 32767;
  sess.bits.set('M1020', rawResult === 0);
  sess.bits.set('M1021', rawResult < min);
  sess.bits.set('M1022', rawResult > max);
}

function execOutputInstruction(
  sess: SimulatorSession,
  pouName: string,
  netIndex: number,
  rawOp: string,
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
  let op = rawOp.toUpperCase();
  if (op === 'SRET' || op === 'IRET') {
    if (flow) flow.subReturn = true;
    return;
  }
  if (op === 'FEND') {
    if (flow) flow.endMain = true;
    return;
  }
  if (op === 'WDT' || op === 'NOP') {
    return;
  }
  if (op === 'EI') {
    sess.interruptsEnabled = true;
    return;
  }
  if (op === 'DI') {
    sess.interruptsEnabled = false;
    return;
  }

  // Handle pulse-triggered (P suffix) application instructions (e.g., MOVP, ADDP, INCP, SCLP, FROMP)
  if (op.length > 2 && op.endsWith('P') && PULSEABLE_BASE_OPS.has(op.slice(0, -1))) {
    const edgeKey = `${pouName}:${netIndex}:PULSE:${op}:${ops.join(',')}`;
    const prev = sess.edgeStates.get(edgeKey) ?? false;
    sess.edgeStates.set(edgeKey, powerIn);
    if (!(powerIn && !prev)) return;
    op = op.slice(0, -1);
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
    const tAddr = resolveHardwareOrWordKey(sess, ops[0]);
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
    const cAddr = resolveHardwareOrWordKey(sess, ops[0]);
    const sv = parseConst(ops[1] ?? '0', sess);
    const c = sess.counters.get(cAddr) ?? { pv: 0, sv, done: false, prevIn: false };
    c.sv = sv;
    if (powerIn && !c.prevIn) {
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
  } else if (op === 'CMP' || op === 'DCMP') {
    const s1 = op === 'DCMP' ? readDWord(sess, ops[0]) : toInt16(parseConst(ops[0], sess));
    const s2 = op === 'DCMP' ? readDWord(sess, ops[1]) : toInt16(parseConst(ops[1], sess));
    const d0 = resolveHardwareOrWordKey(sess, ops[2]);
    const d1 = shiftIndexedDevice(d0, 1);
    const d2 = shiftIndexedDevice(d0, 2);
    writeBit(sess, d0, s1 > s2);
    writeBit(sess, d1, s1 === s2);
    writeBit(sess, d2, s1 < s2);
    outputsWritten[d0] = s1 > s2;
    outputsWritten[d1] = s1 === s2;
    outputsWritten[d2] = s1 < s2;
  } else if (op === 'ZCP' || op === 'DZCP') {
    const s1 = op === 'DZCP' ? readDWord(sess, ops[0]) : toInt16(parseConst(ops[0], sess));
    const s2 = op === 'DZCP' ? readDWord(sess, ops[1]) : toInt16(parseConst(ops[1], sess));
    const s = op === 'DZCP' ? readDWord(sess, ops[2]) : toInt16(parseConst(ops[2], sess));
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
  } else if (op === 'DANDW' || op === 'DORW' || op === 'DXORW') {
    const a = readDWord(sess, ops[0]);
    const b = readDWord(sess, ops[1]);
    const res = toInt32(op === 'DANDW' ? a & b : op === 'DORW' ? a | b : a ^ b);
    writeDWord(sess, ops[2], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = res;
  } else if (op === 'NEG') {
    const res = toInt16(-readWord(sess, ops[0]));
    writeWord(sess, ops[0], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = res;
  } else if (op === 'DNEG') {
    const res = toInt32(-readDWord(sess, ops[0]));
    writeDWord(sess, ops[0], res);
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
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    const dstBase = resolveHardwareOrWordKey(sess, ops[1]);
    for (let i = 0; i < count; i++) {
      const val = readWord(sess, shiftIndexedDevice(srcBase, i));
      const dst = shiftIndexedDevice(dstBase, i);
      writeWord(sess, dst, val);
      outputsWritten[dst] = val;
    }
  } else if (op === 'FMOV') {
    const val = toInt16(parseConst(ops[0], sess));
    const count = Math.max(0, Math.min(256, parseConst(ops[2] ?? '1', sess)));
    const dstBase = resolveHardwareOrWordKey(sess, ops[1]);
    for (let i = 0; i < count; i++) {
      const dst = shiftIndexedDevice(dstBase, i);
      writeWord(sess, dst, val);
      outputsWritten[dst] = val;
    }
  } else if (op === 'ADD') {
    const raw = parseConst(ops[0], sess) + parseConst(ops[1], sess);
    updateAluFlags(sess, raw, false);
    const val = toInt16(raw);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DADD') {
    const raw = readDWord(sess, ops[0]) + readDWord(sess, ops[1]);
    updateAluFlags(sess, raw, true);
    const val = toInt32(raw);
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'SUB') {
    const raw = parseConst(ops[0], sess) - parseConst(ops[1], sess);
    updateAluFlags(sess, raw, false);
    const val = toInt16(raw);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DSUB') {
    const raw = readDWord(sess, ops[0]) - readDWord(sess, ops[1]);
    updateAluFlags(sess, raw, true);
    const val = toInt32(raw);
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'MUL') {
    const raw = parseConst(ops[0], sess) * parseConst(ops[1], sess);
    updateAluFlags(sess, raw, false);
    const val = toInt16(raw);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DMUL') {
    const raw = readDWord(sess, ops[0]) * readDWord(sess, ops[1]);
    updateAluFlags(sess, raw, true);
    const val = toInt32(raw);
    writeDWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DIV') {
    const denom = parseConst(ops[1], sess);
    if (denom !== 0) {
      const numer = parseConst(ops[0], sess);
      const val = toInt16(Math.trunc(numer / denom));
      const rem = toInt16(numer % denom);
      updateAluFlags(sess, val, false);
      const dst = resolveHardwareOrWordKey(sess, ops[2]);
      writeWord(sess, dst, val);
      if (/^[DRVZ]\d+$/i.test(dst)) {
        writeWord(sess, shiftIndexedDevice(dst, 1), rem);
      }
      outputsWritten[dst] = val;
    }
  } else if (op === 'DDIV') {
    const denom = readDWord(sess, ops[1]);
    if (denom !== 0) {
      const numer = readDWord(sess, ops[0]);
      const val = toInt32(Math.trunc(numer / denom));
      updateAluFlags(sess, val, true);
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
  } else if (op === 'SQR' || op === 'DSQR') {
    const src = Math.max(0, op === 'DSQR' ? readDWord(sess, ops[0]) : parseConst(ops[0], sess));
    const res = Math.trunc(Math.sqrt(src));
    if (op === 'DSQR') writeDWord(sess, ops[1], res);
    else writeWord(sess, ops[1], toInt16(res));
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = res;
  } else if (op === 'ROL' || op === 'ROR' || op === 'SHL' || op === 'SHR') {
    const target = resolveHardwareOrWordKey(sess, ops[0]);
    const n = Math.max(0, Math.min(16, parseConst(ops[1] ?? '1', sess)));
    const w = readWord(sess, target) & 0xffff;
    let out = w;
    if (op === 'ROL') out = ((w << (n % 16)) | (w >>> (16 - (n % 16)))) & 0xffff;
    else if (op === 'ROR') out = ((w >>> (n % 16)) | (w << (16 - (n % 16)))) & 0xffff;
    else if (op === 'SHL') out = (w << n) & 0xffff;
    else if (op === 'SHR') out = (w >>> n) & 0xffff;
    const res = toInt16(out);
    writeWord(sess, target, res);
    outputsWritten[target] = res;
  } else if (op === 'DROL' || op === 'DROR') {
    const target = resolveHardwareOrWordKey(sess, ops[0]);
    const n = ((parseConst(ops[1] ?? '1', sess) % 32) + 32) % 32;
    const v = readDWord(sess, target) >>> 0;
    const out = op === 'DROL' ? ((v << n) | (v >>> (32 - n))) : ((v >>> n) | (v << (32 - n)));
    const res = toInt32(out);
    writeDWord(sess, target, res);
    outputsWritten[target] = res;
  } else if (op === 'SFTL' || op === 'SFTR') {
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    const dstBase = resolveHardwareOrWordKey(sess, ops[1]);
    const totalBits = Math.max(1, Math.min(256, parseConst(ops[2] ?? '8', sess)));
    const shiftBits = Math.max(1, Math.min(totalBits, parseConst(ops[3] ?? '1', sess)));
    const cur: boolean[] = [];
    for (let i = 0; i < totalBits; i++) cur.push(readBit(sess, shiftIndexedDevice(dstBase, i)));
    const inBits: boolean[] = [];
    for (let i = 0; i < shiftBits; i++) inBits.push(readBit(sess, shiftIndexedDevice(srcBase, i)));
    const next = new Array<boolean>(totalBits).fill(false);
    if (op === 'SFTL') {
      for (let i = 0; i < totalBits; i++) {
        next[i] = i < shiftBits ? inBits[i] : cur[i - shiftBits];
      }
    } else {
      for (let i = 0; i < totalBits; i++) {
        next[i] = i >= totalBits - shiftBits ? inBits[i - (totalBits - shiftBits)] : cur[i + shiftBits];
      }
    }
    for (let i = 0; i < totalBits; i++) {
      const addr = shiftIndexedDevice(dstBase, i);
      writeBit(sess, addr, next[i]);
      outputsWritten[addr] = next[i];
    }
  } else if (op === 'DECO') {
    const n = Math.max(1, Math.min(8, parseConst(ops[2] ?? '4', sess)));
    const val = parseConst(ops[0], sess) & ((1 << n) - 1);
    const dstBase = resolveHardwareOrWordKey(sess, ops[1]);
    if (isBitAddress(dstBase)) {
      for (let i = 0; i < (1 << n); i++) {
        const addr = shiftIndexedDevice(dstBase, i);
        writeBit(sess, addr, i === val);
        outputsWritten[addr] = i === val;
      }
    } else {
      const out = toInt16(1 << (val & 0xf));
      writeWord(sess, dstBase, out);
      outputsWritten[dstBase] = out;
    }
  } else if (op === 'ENCO') {
    const n = Math.max(1, Math.min(8, parseConst(ops[2] ?? '4', sess)));
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    let highest = 0;
    if (isBitAddress(srcBase)) {
      for (let i = 0; i < (1 << n); i++) {
        if (readBit(sess, shiftIndexedDevice(srcBase, i))) highest = i;
      }
    } else {
      const w = readWord(sess, srcBase) & 0xffff;
      for (let i = 0; i < Math.min(16, 1 << n); i++) {
        if ((w >>> i) & 1) highest = i;
      }
    }
    const dst = resolveHardwareOrWordKey(sess, ops[1]);
    writeWord(sess, dst, highest);
    outputsWritten[dst] = highest;
  } else if (op === 'SUM' || op === 'DSUM') {
    let v = op === 'DSUM' ? readDWord(sess, ops[0]) >>> 0 : parseConst(ops[0], sess) & 0xffff;
    let cnt = 0;
    while (v !== 0) {
      cnt += v & 1;
      v >>>= 1;
    }
    const dst = resolveHardwareOrWordKey(sess, ops[1]);
    writeWord(sess, dst, cnt);
    sess.bits.set('M1020', cnt === 0);
    outputsWritten[dst] = cnt;
  } else if (op === 'BON' || op === 'DBON') {
    const v = op === 'DBON' ? readDWord(sess, ops[0]) >>> 0 : parseConst(ops[0], sess) & 0xffff;
    const bitIdx = Math.max(0, Math.min(op === 'DBON' ? 31 : 15, parseConst(ops[2] ?? '0', sess)));
    const bitOn = ((v >>> bitIdx) & 1) === 1;
    const dst = resolveHardwareOrWordKey(sess, ops[1]);
    writeBit(sess, dst, bitOn);
    outputsWritten[dst] = bitOn;
  } else if (op === 'BCD' || op === 'DBCD') {
    const src = op === 'DBCD' ? readDWord(sess, ops[0]) : parseConst(ops[0], sess);
    const out = intToBcd16(src);
    if (op === 'DBCD') writeDWord(sess, ops[1], out);
    else writeWord(sess, ops[1], toInt16(out));
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = out;
  } else if (op === 'BIN' || op === 'DBIN') {
    const src = op === 'DBIN' ? readDWord(sess, ops[0]) : parseConst(ops[0], sess);
    const out = bcd16ToInt(src);
    if (op === 'DBIN') writeDWord(sess, ops[1], out);
    else writeWord(sess, ops[1], toInt16(out));
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = out;
  } else if (op === 'FLT' || op === 'DFLT') {
    const src = op === 'DFLT' ? readDWord(sess, ops[0]) : parseConst(ops[0], sess);
    writeFloat32(sess, ops[1], src);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = src;
  } else if (op === 'INT' || op === 'DINT') {
    const f = readFloat32(sess, ops[0]);
    const iv = Math.trunc(f);
    if (op === 'DINT') writeDWord(sess, ops[1], iv);
    else writeWord(sess, ops[1], toInt16(iv));
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = iv;
  } else if (op === 'EADD' || op === 'ESUB' || op === 'EMUL' || op === 'EDIV') {
    const a = readFloat32(sess, ops[0]);
    const b = readFloat32(sess, ops[1]);
    let res = 0;
    if (op === 'EADD') res = a + b;
    else if (op === 'ESUB') res = a - b;
    else if (op === 'EMUL') res = a * b;
    else if (op === 'EDIV') res = b !== 0 ? a / b : 0;
    writeFloat32(sess, ops[2], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = Math.round(res * 10000) / 10000;
  } else if (op === 'ESQR') {
    const a = Math.max(0, readFloat32(sess, ops[0]));
    const res = Math.sqrt(a);
    writeFloat32(sess, ops[1], res);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = Math.round(res * 10000) / 10000;
  } else if (op === 'ECMP') {
    const a = readFloat32(sess, ops[0]);
    const b = readFloat32(sess, ops[1]);
    const d0 = resolveHardwareOrWordKey(sess, ops[2]);
    const d1 = shiftIndexedDevice(d0, 1);
    const d2 = shiftIndexedDevice(d0, 2);
    writeBit(sess, d0, a > b);
    writeBit(sess, d1, Math.abs(a - b) < 1e-6);
    writeBit(sess, d2, a < b);
    outputsWritten[d0] = a > b;
    outputsWritten[d1] = Math.abs(a - b) < 1e-6;
    outputsWritten[d2] = a < b;
  } else if (op === 'EZCP') {
    const s1 = readFloat32(sess, ops[0]);
    const s2 = readFloat32(sess, ops[1]);
    const s = readFloat32(sess, ops[2]);
    const d0 = resolveHardwareOrWordKey(sess, ops[3]);
    const d1 = shiftIndexedDevice(d0, 1);
    const d2 = shiftIndexedDevice(d0, 2);
    writeBit(sess, d0, s < s1);
    writeBit(sess, d1, s >= s1 && s <= s2);
    writeBit(sess, d2, s > s2);
    outputsWritten[d0] = s < s1;
    outputsWritten[d1] = s >= s1 && s <= s2;
    outputsWritten[d2] = s > s2;
  } else if (op === 'MEAN') {
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    const n = Math.max(1, Math.min(64, parseConst(ops[2] ?? '1', sess)));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += readWord(sess, shiftIndexedDevice(srcBase, i));
    const avg = toInt16(Math.trunc(sum / n));
    writeWord(sess, ops[1], avg);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[1])] = avg;
  } else if (op === 'SORT') {
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    const n = Math.max(1, Math.min(64, parseConst(ops[1] ?? '1', sess)));
    const vals: number[] = [];
    for (let i = 0; i < n; i++) vals.push(readWord(sess, shiftIndexedDevice(srcBase, i)));
    vals.sort((a, b) => a - b);
    const dstBase = ops[2] ? resolveHardwareOrWordKey(sess, ops[2]) : srcBase;
    for (let i = 0; i < n; i++) {
      const dst = shiftIndexedDevice(dstBase, i);
      writeWord(sess, dst, vals[i]);
      outputsWritten[dst] = vals[i];
    }
  } else if (op === 'SCL') {
    // Delta SCL S1 S2 D: S2=srcMax, S2+1=srcMin, S2+2=dstMax, S2+3=dstMin
    const x = parseConst(ops[0], sess);
    const pBase = resolveHardwareOrWordKey(sess, ops[1]);
    const srcMax = readWord(sess, pBase);
    const srcMin = readWord(sess, shiftIndexedDevice(pBase, 1));
    const dstMax = readWord(sess, shiftIndexedDevice(pBase, 2));
    const dstMin = readWord(sess, shiftIndexedDevice(pBase, 3));
    const span = srcMax - srcMin;
    const scaled = span !== 0 ? Math.round(dstMin + ((x - srcMin) * (dstMax - dstMin)) / span) : dstMin;
    const out = toInt16(scaled);
    writeWord(sess, ops[2], out);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = out;
  } else if (op === 'PID') {
    // Delta PID S1(SV) S2(PV) S3(param block) D(MV)
    // S3+0: Ts (sampling time in 10ms units, default 10 -> 100ms)
    // S3+1: Kp (proportional gain %, e.g. 100 = 1.0x)
    // S3+2: Ti (integral time in 0.1s units, 0 = disabled)
    // S3+3: Td (derivative time in 0.01s units, 0 = disabled)
    // S3+4: Direction/mode (bit0=1 -> reverse action)
    const sv = parseConst(ops[0], sess);
    const pv = parseConst(ops[1], sess);
    const pBase = resolveHardwareOrWordKey(sess, ops[2]);
    const dst = resolveHardwareOrWordKey(sess, ops[3]);
    const tsMs = Math.max(10, (readWord(sess, pBase) || 10) * 10);
    const kp = (readWord(sess, shiftIndexedDevice(pBase, 1)) || 100) / 100;
    const tiSec = (readWord(sess, shiftIndexedDevice(pBase, 2)) || 0) * 0.1;
    const tdSec = (readWord(sess, shiftIndexedDevice(pBase, 3)) || 0) * 0.01;
    const mode = readWord(sess, shiftIndexedDevice(pBase, 4));
    const reverse = (mode & 1) === 1;
    const dtSec = Math.max(0.01, sess.scan_interval_ms / 1000);
    const pidKey = `${pouName}:${pBase}:${dst}`;
    const state = sess.pidStates.get(pidKey) ?? { integral: 0, prevError: 0, prevPv: pv, initialized: false };
    const err = reverse ? pv - sv : sv - pv;
    const pTerm = kp * err;
    if (tiSec > 0) {
      state.integral = Math.max(-4000, Math.min(4000, state.integral + (kp / tiSec) * err * dtSec));
    }
    const dTerm = state.initialized && tdSec > 0 ? kp * tdSec * ((err - state.prevError) / Math.max(dtSec, tsMs / 1000)) : 0;
    state.prevError = err;
    state.prevPv = pv;
    state.initialized = true;
    sess.pidStates.set(pidKey, state);
    const mv = toInt16(Math.max(0, Math.min(4000, Math.round(pTerm + state.integral + dTerm))));
    writeWord(sess, dst, mv);
    outputsWritten[dst] = mv;
  } else if (op === 'FROM' || op === 'DFROM') {
    const slot = parseConst(ops[0], sess);
    const crStart = parseConst(ops[1], sess);
    const dstBase = resolveHardwareOrWordKey(sess, ops[2]);
    const n = Math.max(1, Math.min(64, parseConst(ops[3] ?? '1', sess)));
    const modMap = sess.moduleBfm.get(slot) ?? new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (op === 'DFROM') {
        const lo = (modMap.get(crStart + i * 2) ?? 0) & 0xffff;
        const hi = (modMap.get(crStart + i * 2 + 1) ?? 0) & 0xffff;
        const v32 = toInt32((hi << 16) | lo);
        const dst = shiftIndexedDevice(dstBase, i * 2);
        writeDWord(sess, dst, v32);
        outputsWritten[dst] = v32;
      } else {
        const val = toInt16(modMap.get(crStart + i) ?? 0);
        const dst = shiftIndexedDevice(dstBase, i);
        writeWord(sess, dst, val);
        outputsWritten[dst] = val;
      }
    }
  } else if (op === 'TO' || op === 'DTO') {
    const slot = parseConst(ops[0], sess);
    const crStart = parseConst(ops[1], sess);
    const n = Math.max(1, Math.min(64, parseConst(ops[3] ?? '1', sess)));
    let modMap = sess.moduleBfm.get(slot);
    if (!modMap) {
      modMap = new Map<number, number>();
      sess.moduleBfm.set(slot, modMap);
    }
    const isConstSrc = /^[KkHh]-?\d+$/i.test(ops[2].trim()) || /^-?\d+$/.test(ops[2].trim());
    const srcBase = isConstSrc ? '' : resolveHardwareOrWordKey(sess, ops[2]);
    for (let i = 0; i < n; i++) {
      if (op === 'DTO') {
        const v32 = isConstSrc ? toInt32(parseConst(ops[2], sess)) : readDWord(sess, shiftIndexedDevice(srcBase, i * 2));
        modMap.set(crStart + i * 2, toInt16(v32 & 0xffff));
        modMap.set(crStart + i * 2 + 1, toInt16((v32 >>> 16) & 0xffff));
        outputsWritten[`MOD${slot}.CR${crStart + i * 2}`] = v32;
      } else {
        const val = isConstSrc ? toInt16(parseConst(ops[2], sess)) : readWord(sess, shiftIndexedDevice(srcBase, i));
        modMap.set(crStart + i, val);
        outputsWritten[`MOD${slot}.CR${crStart + i}`] = val;
      }
    }
  } else if (op === 'ALT') {
    const next = !readBit(sess, ops[0]);
    writeBit(sess, ops[0], next);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = next;
  } else if (op === 'ZRST') {
    const m1 = /^([A-Z]+)(\d+)$/i.exec(resolveHardwareOrWordKey(sess, ops[0]));
    const m2 = /^([A-Z]+)(\d+)$/i.exec(resolveHardwareOrWordKey(sess, ops[1]));
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
  } else if (op === 'PLSY' || op === 'DPLSY' || op === 'PLSR' || op === 'PWM') {
    const freq = parseConst(ops[0], sess);
    const pulsesOrPeriod = parseConst(ops[1], sess);
    const target = resolveHardwareOrWordKey(sess, ops[ops.length - 1]);
    const active = freq > 0 && pulsesOrPeriod >= 0;
    writeBit(sess, target, active);
    if (active && op !== 'PWM') {
      const posReg = target === 'Y1' ? 'D1032' : 'D1030';
      const delta = pulsesOrPeriod > 0 ? pulsesOrPeriod : Math.round((freq * sess.scan_interval_ms) / 1000);
      writeDWord(sess, posReg, readDWord(sess, posReg) + delta);
      sess.bits.set('M1029', true);
    }
    outputsWritten[target] = readBit(sess, target);
  } else if (op === 'DDRVI' || op === 'DDRVA') {
    const dist = readDWord(sess, ops[0]);
    const freq = readDWord(sess, ops[1]);
    const pulseOut = resolveHardwareOrWordKey(sess, ops[2]);
    const dirOut = resolveHardwareOrWordKey(sess, ops[3]);
    const posReg = pulseOut === 'Y1' ? 'D1032' : 'D1030';
    const curPos = readDWord(sess, posReg);
    const nextPos = op === 'DDRVI' ? curPos + dist : dist;
    writeBit(sess, pulseOut, freq > 0);
    writeBit(sess, dirOut, nextPos < curPos);
    writeDWord(sess, posReg, nextPos);
    sess.bits.set('M1029', true);
    outputsWritten[posReg] = nextPos;
  } else if (op === 'ZRN' || op === 'DZRN') {
    const pulseOut = resolveHardwareOrWordKey(sess, ops[3] ?? 'Y0');
    const posReg = pulseOut === 'Y1' ? 'D1032' : 'D1030';
    writeDWord(sess, posReg, 0);
    sess.bits.set('M1029', true);
    outputsWritten[posReg] = 0;
  } else if (op === 'TRD') {
    const dstBase = resolveHardwareOrWordKey(sess, ops[0]);
    const now = new Date();
    const vals = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), now.getDay()];
    vals.forEach((v, idx) => {
      const addr = shiftIndexedDevice(dstBase, idx);
      writeWord(sess, addr, v);
      outputsWritten[addr] = v;
    });
  } else if (op === 'TWR') {
    const srcBase = resolveHardwareOrWordKey(sess, ops[0]);
    for (let i = 0; i < 7; i++) {
      sess.words.set(`D${1013 + i}`, readWord(sess, shiftIndexedDevice(srcBase, i)));
    }
    outputsWritten['D1013'] = readWord(sess, 'D1013');
  } else if (op === 'TCMP' || op === 'TZCP') {
    const nowSec = (sess.words.get('D1016') ?? 0) * 3600 + (sess.words.get('D1017') ?? 0) * 60 + (sess.words.get('D1018') ?? 0);
    if (op === 'TCMP') {
      const refSec = parseConst(ops[0], sess) * 3600 + parseConst(ops[1], sess) * 60 + parseConst(ops[2], sess);
      const d0 = resolveHardwareOrWordKey(sess, ops[4] ?? ops[3]);
      writeBit(sess, d0, nowSec < refSec);
      writeBit(sess, shiftIndexedDevice(d0, 1), nowSec === refSec);
      writeBit(sess, shiftIndexedDevice(d0, 2), nowSec > refSec);
      outputsWritten[d0] = nowSec < refSec;
    }
  } else if (op === 'MODRD' || op === 'MODWR' || op === 'MODRW') {
    sess.bits.set('M1127', true);
    sess.bits.set('M1129', false);
    outputsWritten['M1127'] = true;
  }
}

interface LdExecStats {
  instructions: number;
  jumpCapHits: number;
  callDepthMax: number;
  networkMetrics?: Map<string, NetworkTimingSummary>;
}

const MAX_ST_STATEMENTS_PER_SCAN = 50_000;
const MAX_STEP_WALL_MS = 4_000;

interface StExecStats {
  loopIterations: number;
  loopCapHits: number;
  callDepthMax: number;
  totalStatements?: number;
  budgetExceeded?: boolean;
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

  const forStack: Array<{ startIdx: number; remaining: number }> = [];

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
    if (firstOut?.[0] === 'SRET' || firstOut?.[0] === 'IRET') {
      trace.push({
        pou: pou.name,
        network_index: net.index,
        net_id: net.net_id,
        label: net.label || undefined,
        active: true,
        energized: true,
        il: [firstOut[0]],
        outputs_written: {},
      });
      if (stopOnSret) break;
      idx += 1;
      continue;
    }
    if (firstOut?.[0] === 'FOR') {
      const iterations = Math.max(0, Math.min(2000, parseConst(firstOut[1][0] ?? '1', sess)));
      if (iterations > 0) {
        forStack.push({ startIdx: idx + 1, remaining: iterations });
      }
      idx += 1;
      continue;
    }
    if (firstOut?.[0] === 'NEXT') {
      const top = forStack[forStack.length - 1];
      if (top) {
        top.remaining -= 1;
        if (top.remaining > 0) {
          idx = top.startIdx;
          continue;
        }
        forStack.pop();
      }
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
      if (LD_STARTER_OPS.has(op)) {
        if (acc !== null) stack.push(acc);
        acc = evalContact(sess, op, ops);
        continue;
      }
      if (AND_CONTACT_OPS.has(op)) {
        const val: boolean = evalContact(sess, op, ops);
        acc = (acc ?? true) && val;
        continue;
      }
      if (OR_CONTACT_OPS.has(op)) {
        const val: boolean = evalContact(sess, op, ops);
        acc = (acc ?? false) || val;
        continue;
      }
      if (op === 'INV') {
        acc = !(acc ?? false);
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
          if (subPou.lang === '1' || subPou.lang === '3') {
            executeLdPou(sess, subPou, trace, 0, true, callDepth + 1, execStats);
          } else if (subPou.lang === '2') {
            executeStBlock(subPou.stCode, sess, callDepth + 1);
          } else if (subPou.lang === '4' && subPou.sfcChart) {
            executeSfcPou(sess, subPou);
          } else if (subPou.lang === '5' && subPou.fbdDiagram) {
            executeFbdPou(sess, subPou);
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
function executeStandardFb(
  sess: SimulatorSession,
  instKey: string,
  fbType: string,
  inputs: Record<string, number>,
): Record<string, number | boolean> {
  const upType = fbType.toUpperCase();
  const key = instKey.toUpperCase();
  let state = sess.fbInstances.get(key);
  if (!state) {
    state = { type: upType, fields: {}, internal: {} };
    sess.fbInstances.set(key, state);
  }
  const f = state.fields;
  const intl = state.internal;

  if (upType === 'TON') {
    const inVal = Boolean(inputs.IN ?? f.IN ?? false);
    const pt = Math.max(0, Math.trunc(inputs.PT ?? Number(f.PT ?? 0)));
    let et = Number(f.ET ?? 0);
    let q = false;
    if (!inVal) {
      et = 0;
      q = false;
    } else {
      et = Math.min(pt, et + sess.scan_interval_ms);
      q = et >= pt;
    }
    Object.assign(f, { IN: inVal, PT: pt, ET: et, Q: q });
    return { Q: q, ET: et };
  }
  if (upType === 'TOF') {
    const inVal = Boolean(inputs.IN ?? f.IN ?? false);
    const pt = Math.max(0, Math.trunc(inputs.PT ?? Number(f.PT ?? 0)));
    let et = Number(f.ET ?? 0);
    const prevIn = Boolean(intl.prevIn ?? false);
    let running = Boolean(intl.running ?? false);
    let q = false;
    if (inVal) {
      et = 0;
      q = true;
      running = false;
    } else {
      if (prevIn) running = true;
      if (running) {
        et = Math.min(pt, et + sess.scan_interval_ms);
        q = et < pt;
        if (et >= pt) running = false;
      } else {
        q = false;
      }
    }
    intl.prevIn = inVal;
    intl.running = running;
    Object.assign(f, { IN: inVal, PT: pt, ET: et, Q: q });
    return { Q: q, ET: et };
  }
  if (upType === 'TP') {
    const inVal = Boolean(inputs.IN ?? f.IN ?? false);
    const pt = Math.max(0, Math.trunc(inputs.PT ?? Number(f.PT ?? 0)));
    const prevIn = Boolean(intl.prevIn ?? false);
    let active = Boolean(intl.active ?? false);
    let et = Number(f.ET ?? 0);
    if (inVal && !prevIn && !active) {
      active = true;
      et = 0;
    }
    let q = false;
    if (active) {
      et += sess.scan_interval_ms;
      if (et >= pt) {
        et = pt;
        active = false;
        q = false;
      } else {
        q = true;
      }
    } else if (!inVal) {
      et = 0;
    }
    intl.prevIn = inVal;
    intl.active = active;
    Object.assign(f, { IN: inVal, PT: pt, ET: et, Q: q });
    return { Q: q, ET: et };
  }
  if (upType === 'CTU') {
    const cu = Boolean(inputs.CU ?? f.CU ?? false);
    const r = Boolean(inputs.R ?? f.R ?? false);
    const pv = Math.trunc(inputs.PV ?? Number(f.PV ?? 0));
    const prevCu = Boolean(intl.prevCu ?? false);
    let cv = Number(f.CV ?? 0);
    if (r) cv = 0;
    else if (cu && !prevCu) cv += 1;
    const q = cv >= pv;
    intl.prevCu = cu;
    Object.assign(f, { CU: cu, R: r, PV: pv, CV: cv, Q: q });
    return { Q: q, CV: cv };
  }
  if (upType === 'CTD') {
    const cd = Boolean(inputs.CD ?? f.CD ?? false);
    const ld = Boolean(inputs.LD ?? f.LD ?? false);
    const pv = Math.trunc(inputs.PV ?? Number(f.PV ?? 0));
    const prevCd = Boolean(intl.prevCd ?? false);
    let cv = Number(f.CV ?? 0);
    if (ld) cv = pv;
    else if (cd && !prevCd) cv -= 1;
    const q = cv <= 0;
    intl.prevCd = cd;
    Object.assign(f, { CD: cd, LD: ld, PV: pv, CV: cv, Q: q });
    return { Q: q, CV: cv };
  }
  if (upType === 'CTUD') {
    const cu = Boolean(inputs.CU ?? f.CU ?? false);
    const cd = Boolean(inputs.CD ?? f.CD ?? false);
    const r = Boolean(inputs.R ?? f.R ?? false);
    const ld = Boolean(inputs.LD ?? f.LD ?? false);
    const pv = Math.trunc(inputs.PV ?? Number(f.PV ?? 0));
    let cv = Number(f.CV ?? 0);
    if (r) cv = 0;
    else if (ld) cv = pv;
    else {
      if (cu && !Boolean(intl.prevCu ?? false)) cv += 1;
      if (cd && !Boolean(intl.prevCd ?? false)) cv -= 1;
    }
    intl.prevCu = cu;
    intl.prevCd = cd;
    const qu = cv >= pv;
    const qd = cv <= 0;
    Object.assign(f, { CU: cu, CD: cd, R: r, LD: ld, PV: pv, CV: cv, QU: qu, QD: qd });
    return { QU: qu, QD: qd, CV: cv };
  }
  if (upType === 'R_TRIG') {
    const clk = Boolean(inputs.CLK ?? f.CLK ?? false);
    const prev = Boolean(intl.prev ?? false);
    const q = clk && !prev;
    intl.prev = clk;
    Object.assign(f, { CLK: clk, Q: q });
    return { Q: q };
  }
  if (upType === 'F_TRIG') {
    const clk = Boolean(inputs.CLK ?? f.CLK ?? false);
    const prev = Boolean(intl.prev ?? false);
    const q = !clk && prev;
    intl.prev = clk;
    Object.assign(f, { CLK: clk, Q: q });
    return { Q: q };
  }
  if (upType === 'SR') {
    const s1 = Boolean(inputs.S1 ?? inputs.S ?? false);
    const r = Boolean(inputs.R ?? false);
    let q1 = Boolean(f.Q1 ?? false);
    q1 = s1 || (!r && q1);
    Object.assign(f, { S1: s1, R: r, Q1: q1, Q: q1 });
    return { Q1: q1, Q: q1 };
  }
  if (upType === 'RS') {
    const s = Boolean(inputs.S ?? false);
    const r1 = Boolean(inputs.R1 ?? inputs.R ?? false);
    let q1 = Boolean(f.Q1 ?? false);
    q1 = !r1 && (s || q1);
    Object.assign(f, { S: s, R1: r1, Q1: q1, Q: q1 });
    return { Q1: q1, Q: q1 };
  }
  if (upType === 'PID_FB') {
    const en = inputs.EN === undefined ? true : Boolean(inputs.EN);
    const sv = Number(inputs.SV ?? f.SV ?? 0);
    const pv = Number(inputs.PV ?? f.PV ?? 0);
    const kp = Number(inputs.KP ?? f.KP ?? 100) / 100;
    const ti = Number(inputs.TI ?? f.TI ?? 0);
    const td = Number(inputs.TD ?? f.TD ?? 0);
    const dt = Math.max(0.01, sess.scan_interval_ms / 1000);
    let mv = 0;
    if (en) {
      const err = sv - pv;
      let integ = Number(intl.integral ?? 0);
      if (ti > 0) integ = Math.max(-4000, Math.min(4000, integ + (kp / ti) * err * dt));
      const prevErr = Number(intl.prevErr ?? err);
      const deriv = td > 0 ? kp * td * ((err - prevErr) / dt) : 0;
      intl.integral = integ;
      intl.prevErr = err;
      mv = Math.max(0, Math.min(4000, Math.round(kp * err + integ + deriv)));
    }
    Object.assign(f, { EN: en, SV: sv, PV: pv, KP: kp * 100, TI: ti, TD: td, MV: mv });
    return { MV: mv };
  }
  if (upType === 'SCALE') {
    const x = Number(inputs.IN ?? 0);
    const inMin = Number(inputs.IN_MIN ?? 0);
    const inMax = Number(inputs.IN_MAX ?? 4000);
    const outMin = Number(inputs.OUT_MIN ?? 0);
    const outMax = Number(inputs.OUT_MAX ?? 100);
    const out = inMax !== inMin ? outMin + ((x - inMin) * (outMax - outMin)) / (inMax - inMin) : outMin;
    Object.assign(f, { IN: x, IN_MIN: inMin, IN_MAX: inMax, OUT_MIN: outMin, OUT_MAX: outMax, OUT: out });
    return { OUT: out };
  }
  return {};
}

function syncFbInstanceFieldsToSymbols(sess: SimulatorSession, instName: string, fields: Record<string, number | boolean>): void {
  for (const [fn, fv] of Object.entries(fields)) {
    const dotted = `${instName}.${fn}`;
    const sym = resolveSymbol(sess, dotted);
    if (sym) {
      sym.entry.value = fv;
    } else {
      const entry = {
        address: null,
        type: typeof fv === 'boolean' ? 'BOOL' : Number.isInteger(fv) ? 'INT' : 'REAL',
        value: fv,
        initial: fv,
      };
      sess.symbols.set(dotted, entry);
      sess.symbolsByUpper.set(dotted.toUpperCase(), { key: dotted, entry });
    }
    const up = normAddr(dotted);
    if (typeof fv === 'boolean') sess.bits.set(up, fv);
    else sess.words.set(up, fv);
  }
}

function invokeFbInstanceCall(
  sess: SimulatorSession,
  instName: string,
  instState: FbInstanceState,
  argTokens: string[],
  callerLoopVars: Map<string, number>,
  callDepth: number,
  execStats?: StExecStats,
): number {
  const namedInputs: Record<string, number> = {};
  const outBindings: Array<{ formal: string; actual: string }> = [];
  const positional: number[] = [];

  for (const tok of argTokens) {
    const namedOut = /^([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*([A-Za-z_][A-Za-z0-9_.]*)$/.exec(tok);
    const namedIn = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/.exec(tok);
    if (namedOut) {
      outBindings.push({ formal: namedOut[1], actual: namedOut[2] });
    } else if (namedIn) {
      namedInputs[namedIn[1].toUpperCase()] = evalStExpression(namedIn[2], sess, callerLoopVars, callDepth, execStats);
    } else if (tok) {
      positional.push(evalStExpression(tok, sess, callerLoopVars, callDepth, execStats));
    }
  }

  if (STANDARD_IEC_FBS.has(instState.type.toUpperCase())) {
    const outs = executeStandardFb(sess, instName, instState.type, namedInputs);
    syncFbInstanceFieldsToSymbols(sess, instName, instState.fields);
    for (const ob of outBindings) {
      const val = instState.fields[ob.formal.toUpperCase()] ?? instState.fields[ob.formal] ?? 0;
      assignStLhs(sess, ob.actual, typeof val === 'boolean' ? (val ? 1 : 0) : Number(val), {});
    }
    const primary = outs.Q ?? outs.Q1 ?? outs.QU ?? outs.MV ?? outs.OUT ?? 0;
    return typeof primary === 'boolean' ? (primary ? 1 : 0) : Number(primary);
  }

  // User-defined FB instance: isolate instance fields around POU invocation
  const targetPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === instState.type.toUpperCase());
  if (!targetPou || callDepth >= 8) return 0;

  const savedLocals = new Map<string, number | boolean>();
  for (const lv of targetPou.localVars) {
    const sym = resolveSymbol(sess, lv.identifier);
    if (sym) savedLocals.set(sym.key, sym.entry.value);
    const instVal = instState.fields[lv.identifier] ?? lv.initial;
    if (lv.type.toUpperCase() === 'BOOL') writeBit(sess, lv.identifier, Boolean(instVal));
    else writeWord(sess, lv.identifier, Number(instVal) || 0);
  }

  const inputs = targetPou.localVars.filter((v) => v.varClass === 'VAR_INPUT' || v.varClass === 'VAR_IN_OUT');
  positional.forEach((v, idx) => {
    if (inputs[idx]) namedInputs[inputs[idx].identifier.toUpperCase()] = v;
  });
  for (const lv of targetPou.localVars) {
    const nv = namedInputs[lv.identifier.toUpperCase()];
    if (nv !== undefined) {
      if (lv.type.toUpperCase() === 'BOOL') writeBit(sess, lv.identifier, Boolean(nv));
      else writeWord(sess, lv.identifier, nv);
    }
  }

  if (targetPou.lang === '2') {
    executeStBlock(targetPou.stCode, sess, callDepth + 1, execStats);
  } else if (targetPou.lang === '1' || targetPou.lang === '3') {
    executeLdPou(sess, targetPou, [], 0, true, callDepth + 1);
  } else if (targetPou.lang === '5' && targetPou.fbdDiagram) {
    executeFbdPou(sess, targetPou);
  }

  for (const lv of targetPou.localVars) {
    const val = lv.type.toUpperCase() === 'BOOL' ? readBit(sess, lv.identifier) : readWord(sess, lv.identifier);
    instState.fields[lv.identifier] = val;
  }
  syncFbInstanceFieldsToSymbols(sess, instName, instState.fields);

  for (const ob of outBindings) {
    const foundKey = Object.keys(instState.fields).find((k) => k.toUpperCase() === ob.formal.toUpperCase());
    const val = foundKey ? instState.fields[foundKey] : 0;
    assignStLhs(sess, ob.actual, typeof val === 'boolean' ? (val ? 1 : 0) : Number(val), {});
  }

  for (const [k, oldVal] of savedLocals.entries()) {
    const sym = sess.symbols.get(k);
    if (sym) sym.value = oldVal;
  }
  return 0;
}

function evalStBuiltinOrCall(
  expr: string,
  sess: SimulatorSession,
  loopVars: Map<string, number>,
  callDepth: number,
  execStats?: StExecStats,
): string {
  let current = expr;
  const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)/;
  let guard = 0;
  while (guard++ < 32) {
    const m = callRe.exec(current);
    if (!m) break;
    const rawName = m[1];
    const fnName = rawName.toUpperCase();
    const rawArgs = m[2].trim();
    const argTokens = rawArgs ? rawArgs.split(',').map((a) => a.trim()) : [];

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
    } else if (fnName === 'SQRT') {
      val = Math.sqrt(Math.max(0, evalArgs()[0] ?? 0));
    } else if (fnName === 'SIN') {
      val = Math.sin(evalArgs()[0] ?? 0);
    } else if (fnName === 'COS') {
      val = Math.cos(evalArgs()[0] ?? 0);
    } else if (fnName === 'TAN') {
      val = Math.tan(evalArgs()[0] ?? 0);
    } else if (fnName === 'ASIN') {
      val = Math.asin(Math.max(-1, Math.min(1, evalArgs()[0] ?? 0)));
    } else if (fnName === 'ACOS') {
      val = Math.acos(Math.max(-1, Math.min(1, evalArgs()[0] ?? 0)));
    } else if (fnName === 'ATAN') {
      val = Math.atan(evalArgs()[0] ?? 0);
    } else if (fnName === 'LN') {
      val = Math.log(Math.max(1e-12, evalArgs()[0] ?? 1));
    } else if (fnName === 'LOG') {
      val = Math.log10(Math.max(1e-12, evalArgs()[0] ?? 1));
    } else if (fnName === 'EXP') {
      val = Math.exp(evalArgs()[0] ?? 0);
    } else if (fnName === 'EXPT') {
      const [b = 0, e = 0] = evalArgs();
      val = Math.pow(b, e);
    } else if (fnName === 'TRUNC' || fnName === 'REAL_TO_INT' || fnName === 'DINT_TO_INT' || fnName === 'WORD_TO_INT') {
      val = Math.trunc(evalArgs()[0] ?? 0);
    } else if (fnName === 'ROUND') {
      val = Math.round(evalArgs()[0] ?? 0);
    } else if (fnName === 'INT_TO_REAL' || fnName === 'INT_TO_DINT' || fnName === 'BOOL_TO_INT') {
      val = Number(evalArgs()[0] ?? 0);
    } else if (fnName === 'INT_TO_BOOL') {
      val = (evalArgs()[0] ?? 0) !== 0 ? 1 : 0;
    } else if (fnName === 'INT_TO_BCD') {
      val = intToBcd16(evalArgs()[0] ?? 0);
    } else if (fnName === 'BCD_TO_INT') {
      val = bcd16ToInt(evalArgs()[0] ?? 0);
    } else if (fnName === 'SCALE') {
      const [x = 0, inMin = 0, inMax = 4000, outMin = 0, outMax = 100] = evalArgs();
      val = inMax !== inMin ? outMin + ((x - inMin) * (outMax - outMin)) / (inMax - inMin) : outMin;
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
    } else if (sess.fbInstances.has(fnName)) {
      const instState = sess.fbInstances.get(fnName)!;
      val = invokeFbInstanceCall(sess, rawName, instState, argTokens, loopVars, callDepth + 1, execStats);
    } else {
      const targetPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === fnName);
      if (targetPou && callDepth < 8) {
        val = invokeUserPouCall(sess, targetPou, argTokens, loopVars, callDepth + 1, execStats);
      } else {
        break;
      }
    }
    const safeVal = typeof val === 'number' && Number.isFinite(val) ? val : 0;
    current = current.slice(0, m.index) + String(safeVal) + current.slice(m.index + m[0].length);
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
  } else if (pou.lang === '1' || pou.lang === '3') {
    executeLdPou(sess, pou, [], 0, true, callDepth);
  } else if (pou.lang === '4' && pou.sfcChart) {
    executeSfcPou(sess, pou);
  } else if (pou.lang === '5' && pou.fbdDiagram) {
    executeFbdPou(sess, pou);
  }

  for (const ob of outBindings) {
    const symFormal = resolveSymbol(sess, ob.formal);
    const v = symFormal?.entry.type.toUpperCase() === 'BOOL' ? (readBit(sess, ob.formal) ? 1 : 0) : readWord(sess, ob.formal);
    assignStLhs(sess, ob.actual, v, {});
  }

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

function resolveStTokenNumericValue(
  tok: string,
  sess: SimulatorSession,
  loopVars: Map<string, number>,
): number {
  if (loopVars.size > 0) {
    const lv = loopVars.get(tok);
    if (lv !== undefined) return lv;
  }
  const dotIdx = tok.indexOf('.');
  if (dotIdx !== -1) {
    const tcMatch = /^((?:T|C)\d+)\.(Q|DONE|PV)$/i.exec(tok);
    if (tcMatch) {
      const upProp = tcMatch[2].toUpperCase();
      if (upProp === 'PV') return readWord(sess, tcMatch[1]);
      return readBit(sess, tcMatch[1]) ? 1 : 0;
    }
    if (/^[DRVZ]\d+\.(?:1[0-5]|[0-9]|[A-Fa-f])$/i.test(tok)) {
      return readBit(sess, tok) ? 1 : 0;
    }
    const sym = resolveSymbol(sess, tok);
    if (sym) {
      return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? 1 : 0) : Number(sym.entry.value) || 0;
    }
    const up = tok.toUpperCase();
    if (sess.bits.has(up)) return sess.bits.get(up) ? 1 : 0;
    if (sess.words.has(up)) return sess.words.get(up) ?? 0;
    return 0;
  }

  const c0 = tok.charCodeAt(0);
  const c1 = tok.length > 1 ? tok.charCodeAt(1) : 0;
  if (c1 >= 48 && c1 <= 57) {
    // Fast-path for standard Delta hardware addresses (X/Y/M/S/T/C/D)
    if (
      (c0 === 68 || c0 === 100) &&
      /^D\d+$/i.test(tok)
    ) {
      return readWord(sess, tok);
    }
    if (
      (c0 === 88 || c0 === 120 || c0 === 89 || c0 === 121 || c0 === 77 || c0 === 109 || c0 === 83 || c0 === 115 || c0 === 84 || c0 === 116 || c0 === 67 || c0 === 99) &&
      /^(X|Y|M|S|T|C)\d+$/i.test(tok)
    ) {
      return readBit(sess, tok) ? 1 : 0;
    }
  }

  const sym = resolveSymbol(sess, tok);
  if (sym) {
    if (sym.entry.address) {
      return isBitAddress(sym.entry.address)
        ? (readBit(sess, sym.entry.address) ? 1 : 0)
        : readWord(sess, sym.entry.address);
    }
    return typeof sym.entry.value === 'boolean' ? (sym.entry.value ? 1 : 0) : Number(sym.entry.value) || 0;
  }
  const up = tok.toUpperCase();
  if (sess.bits.has(up)) return sess.bits.get(up) ? 1 : 0;
  if (sess.words.has(up)) return sess.words.get(up) ?? 0;
  return 0;
}

function evalStExpression(
  expr: string,
  sess: SimulatorSession,
  loopVars: Map<string, number> = new Map(),
  callDepth = 0,
  execStats?: StExecStats,
): number {
  const trimmed = expr.trim();
  if (!trimmed) return 0;

  // Fast-path 1: Symbolic cached AST (handles 95%+ of ST expressions, loops, conditions, and breakpoints with zero regex work)
  if (!trimmed.includes('[')) {
    const symAst = compileSymbolicStExpr(trimmed);
    if (symAst !== null) {
      return evaluateSymbolicStAst(symAst, (name) => resolveStTokenNumericValue(name, sess, loopVars));
    }
  }

  // Fallback path for function/FB calls and array indexing expressions
  let clean = trimmed.replace(/\bTRUE\b/gi, '1').replace(/\bFALSE\b/gi, '0');
  if (clean.includes('#')) {
    clean = clean.replace(/16#([0-9A-Fa-f_]+)/g, (_m, h) => String(parseInt(String(h).replace(/_/g, ''), 16)));
    clean = clean.replace(/2#([01_]+)/g, (_m, b) => String(parseInt(String(b).replace(/_/g, ''), 2)));
    clean = clean.replace(/8#([0-7_]+)/g, (_m, o) => String(parseInt(String(o).replace(/_/g, ''), 8)));
  }
  if (clean.includes('(')) {
    clean = evalStBuiltinOrCall(clean, sess, loopVars, callDepth, execStats);
  }
  if (clean.includes('[')) {
    clean = resolveArrayAccess(clean, sess, loopVars, callDepth, execStats);
  }

  let withDots = clean;
  if (withDots.includes('.')) {
    // Replace T0.Q / T0.PV / C0.Q / C0.PV / D0.0 first
    withDots = withDots.replace(/\b((?:T|C)\d+)\.(Q|DONE|PV)\b/gi, (_m, dev, prop) => {
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
  }

  const replaced = withDots.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (tok) => {
    const up = tok.toUpperCase();
    if (up === 'AND') return '&&';
    if (up === 'OR') return '||';
    if (up === 'XOR') return '^';
    if (up === 'NOT') return '!';
    if (up === 'MOD') return '%';
    return String(resolveStTokenNumericValue(tok, sess, loopVars));
  });

  const jsExpr = replaced
    .replace(/<>/g, '!=')
    .replace(/(?<![<>!=])=(?!=)/g, '==');

  if (!/^[\d\s+\-*/%()&|^!<>=.]+$/.test(jsExpr)) {
    return 0;
  }
  return evaluateSafeNumericExpr(jsExpr);
}

const ST_TOKEN_CACHE_LIMIT = 1024;
const stTokenCache = new Map<string, string[]>();
const END_TOKENS_IF = new Set(['ELSIF', 'ELSE', 'END_IF']);
const EMPTY_END_TOKENS = new Set<string>();

function getTokenizedStStatements(stCode: string): string[] {
  const cached = stTokenCache.get(stCode);
  if (cached !== undefined) return cached;
  const stmts = tokenizeStStatements(stCode);
  if (stTokenCache.size >= ST_TOKEN_CACHE_LIMIT) {
    const first = stTokenCache.keys().next().value;
    if (first !== undefined) stTokenCache.delete(first);
  }
  stTokenCache.set(stCode, stmts);
  return stmts;
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
  if (lhs.includes('[')) {
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
  } else if (sym && isFloatType(sym.entry.type)) {
    writeWord(sess, lhs, rhsVal);
    outputsWritten[sym.key] = rhsVal;
  } else {
    const intVal = Math.trunc(rhsVal);
    writeWord(sess, lhs, intVal);
    outputsWritten[sym ? sym.key : normAddr(lhs)] = intVal;
  }
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

interface CompiledExpr {
  raw: string;
  ast: ExprNode | null;
}

type CompiledStStmt =
  | { kind: 'exit' }
  | { kind: 'return' }
  | { kind: 'assign'; lhs: string; rhs: CompiledExpr }
  | { kind: 'call'; raw: string }
  | { kind: 'if'; branches: Array<{ cond: CompiledExpr; body: CompiledStStmt[] }>; elseBody: CompiledStStmt[] }
  | { kind: 'for'; varName: string; start: CompiledExpr; end: CompiledExpr; step: CompiledExpr | null; body: CompiledStStmt[] }
  | { kind: 'while'; cond: CompiledExpr; body: CompiledStStmt[] }
  | { kind: 'repeat'; body: CompiledStStmt[]; until: CompiledExpr }
  | { kind: 'case'; selector: CompiledExpr; branches: Array<{ ranges: Array<[number, number]>; body: CompiledStStmt[] }>; elseBody: CompiledStStmt[] };

function compileStExprOnce(expr: string): CompiledExpr {
  const raw = expr.trim();
  const ast = raw && !raw.includes('[') ? compileSymbolicStExpr(raw) : null;
  return { raw, ast };
}

function parseCaseRanges(selector: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of selector.split(',')) {
    const p = part.trim();
    const range = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(p);
    if (range) {
      ranges.push([parseInt(range[1], 10), parseInt(range[2], 10)]);
    } else if (/^-?\d+$/.test(p)) {
      const v = parseInt(p, 10);
      ranges.push([v, v]);
    }
  }
  return ranges;
}

function compileStTokenSlice(
  stmts: string[],
  startIdx: number,
  endTokens: Set<string>,
): { nodes: CompiledStStmt[]; nextIdx: number } {
  const nodes: CompiledStStmt[] = [];
  let idx = startIdx;

  while (idx < stmts.length) {
    const raw = stmts[idx].trim();
    const upper = raw.toUpperCase().replace(/;$/, '').trim();
    if (endTokens.has(upper) || (endTokens.has('CASE_LABEL') && upper.startsWith('CASE_LABEL:'))) {
      return { nodes, nextIdx: idx };
    }
    if (endTokens.has('UNTIL') && upper.startsWith('UNTIL ')) {
      return { nodes, nextIdx: idx };
    }
    if (endTokens.has('ELSIF') && upper.startsWith('ELSIF ')) {
      return { nodes, nextIdx: idx };
    }
    if (upper === 'EXIT') {
      nodes.push({ kind: 'exit' });
      idx += 1;
      continue;
    }
    if (upper === 'RETURN') {
      nodes.push({ kind: 'return' });
      idx += 1;
      continue;
    }

    if (upper.startsWith('IF ') && upper.endsWith(' THEN')) {
      const branches: Array<{ cond: CompiledExpr; body: CompiledStStmt[] }> = [];
      let elseBody: CompiledStStmt[] = [];
      let curCond = compileStExprOnce(raw.slice(3, -5));
      let curIdx = idx + 1;
      let inElse = false;

      while (curIdx <= stmts.length) {
        const sub = compileStTokenSlice(stmts, curIdx, END_TOKENS_IF);
        if (inElse) {
          elseBody = sub.nodes;
        } else {
          branches.push({ cond: curCond, body: sub.nodes });
        }
        curIdx = sub.nextIdx;
        if (curIdx >= stmts.length) break;
        const tokRaw = stmts[curIdx].trim();
        const tokUp = tokRaw.toUpperCase().replace(/;$/, '').trim();
        if (tokUp === 'END_IF') {
          curIdx += 1;
          break;
        } else if (tokUp.startsWith('ELSIF ') && tokUp.endsWith(' THEN')) {
          inElse = false;
          curCond = compileStExprOnce(tokRaw.slice(6, -5));
          curIdx += 1;
        } else if (tokUp === 'ELSE') {
          inElse = true;
          curIdx += 1;
        } else {
          curIdx += 1;
        }
      }
      nodes.push({ kind: 'if', branches, elseBody });
      idx = curIdx;
      continue;
    }

    const caseMatch = /^CASE\s+(.+?)\s+OF$/i.exec(raw);
    if (caseMatch) {
      const endCaseIdx = findMatchingEnd(stmts, idx, /^CASE\b.+\bOF$/i, 'END_CASE');
      const inner = stmts.slice(idx + 1, endCaseIdx);
      const branches: Array<{ ranges: Array<[number, number]>; body: CompiledStStmt[] }> = [];
      let elseBody: CompiledStStmt[] = [];
      let cIdx = 0;
      while (cIdx < inner.length) {
        const cur = inner[cIdx].trim();
        const curUp = cur.toUpperCase();
        if (curUp.startsWith('CASE_LABEL:')) {
          const sel = cur.slice('CASE_LABEL:'.length);
          let d = 0;
          let j = cIdx + 1;
          while (j < inner.length) {
            const iu = inner[j].trim().toUpperCase();
            if (/^CASE\b.+\bOF$/i.test(iu)) d++;
            else if (iu === 'END_CASE') d--;
            else if (d === 0 && (iu.startsWith('CASE_LABEL:') || iu === 'ELSE')) break;
            j++;
          }
          const sub = compileStTokenSlice(inner.slice(cIdx + 1, j), 0, EMPTY_END_TOKENS);
          branches.push({ ranges: parseCaseRanges(sel), body: sub.nodes });
          cIdx = j;
          continue;
        }
        if (curUp === 'ELSE') {
          elseBody = compileStTokenSlice(inner.slice(cIdx + 1), 0, EMPTY_END_TOKENS).nodes;
          break;
        }
        cIdx += 1;
      }
      nodes.push({
        kind: 'case',
        selector: compileStExprOnce(caseMatch[1]),
        branches,
        elseBody,
      });
      idx = endCaseIdx + 1;
      continue;
    }

    const forMatch = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(raw);
    if (forMatch) {
      const endIdx = findMatchingEnd(stmts, idx, /^FOR\b.+\bDO$/i, 'END_FOR');
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      nodes.push({
        kind: 'for',
        varName: forMatch[1],
        start: compileStExprOnce(forMatch[2]),
        end: compileStExprOnce(forMatch[3]),
        step: forMatch[4] ? compileStExprOnce(forMatch[4]) : null,
        body: compileStTokenSlice(bodyStmts, 0, EMPTY_END_TOKENS).nodes,
      });
      idx = endIdx + 1;
      continue;
    }

    const whileMatch = /^WHILE\s+(.+?)\s+DO$/i.exec(raw);
    if (whileMatch) {
      const endIdx = findMatchingEnd(stmts, idx, /^WHILE\b.+\bDO$/i, 'END_WHILE');
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      nodes.push({
        kind: 'while',
        cond: compileStExprOnce(whileMatch[1]),
        body: compileStTokenSlice(bodyStmts, 0, EMPTY_END_TOKENS).nodes,
      });
      idx = endIdx + 1;
      continue;
    }

    if (upper === 'REPEAT') {
      const endIdx = findMatchingEnd(stmts, idx, /^REPEAT$/i, 'END_REPEAT');
      const untilIdx = stmts.findIndex((s, i) => i > idx && i < endIdx && /^UNTIL\s+/i.test(s.trim()));
      const bodyEnd = untilIdx !== -1 ? untilIdx : endIdx;
      const untilExpr = untilIdx !== -1 ? stmts[untilIdx].trim().replace(/^UNTIL\s+/i, '') : 'TRUE';
      const bodyStmts = stmts.slice(idx + 1, bodyEnd);
      nodes.push({
        kind: 'repeat',
        body: compileStTokenSlice(bodyStmts, 0, EMPTY_END_TOKENS).nodes,
        until: compileStExprOnce(untilExpr),
      });
      idx = endIdx + 1;
      continue;
    }

    const assign = /^([A-Za-z_][A-Za-z0-9_.\[\]]*)\s*:=\s*(.+?);?\s*$/.exec(raw);
    if (assign) {
      nodes.push({
        kind: 'assign',
        lhs: assign[1],
        rhs: compileStExprOnce(assign[2]),
      });
      idx += 1;
      continue;
    }

    const procCall = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\);?\s*$/.exec(raw);
    if (procCall) {
      nodes.push({ kind: 'call', raw });
    }
    idx += 1;
  }

  return { nodes, nextIdx: idx };
}

const stCompiledCache = new Map<string, CompiledStStmt[]>();

function getCompiledStProgram(stCode: string): CompiledStStmt[] {
  const cached = stCompiledCache.get(stCode);
  if (cached !== undefined) return cached;
  const stmts = getTokenizedStStatements(stCode);
  const compiled = compileStTokenSlice(stmts, 0, EMPTY_END_TOKENS).nodes;
  if (stCompiledCache.size >= ST_TOKEN_CACHE_LIMIT) {
    const first = stCompiledCache.keys().next().value;
    if (first !== undefined) stCompiledCache.delete(first);
  }
  stCompiledCache.set(stCode, compiled);
  return compiled;
}

function evalCompiledExpr(
  ce: CompiledExpr,
  sess: SimulatorSession,
  loopVars: Map<string, number>,
  resolveVar: (name: string) => number,
  callDepth: number,
  execStats?: StExecStats,
): number {
  if (ce.ast !== null) {
    return evaluateSymbolicStAst(ce.ast, resolveVar);
  }
  return evalStExpression(ce.raw, sess, loopVars, callDepth, execStats);
}

function executeCompiledStStmts(
  nodes: CompiledStStmt[],
  sess: SimulatorSession,
  outputsWritten: Record<string, boolean | number>,
  loopVars: Map<string, number>,
  resolveVar: (name: string) => number,
  callDepth = 0,
  execStats?: StExecStats,
): { statementsExecuted: number; exited: boolean; returned?: boolean } {
  if (execStats && callDepth > execStats.callDepthMax) {
    execStats.callDepthMax = callDepth;
  }
  let statementsExecuted = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (execStats) {
      execStats.totalStatements = (execStats.totalStatements ?? 0) + 1;
      if (execStats.totalStatements > MAX_ST_STATEMENTS_PER_SCAN) {
        execStats.loopCapHits += 1;
        execStats.budgetExceeded = true;
        return { statementsExecuted, exited: true, returned: true };
      }
    }
    const stmt = nodes[i];
    switch (stmt.kind) {
      case 'assign': {
        const rhsVal = evalCompiledExpr(stmt.rhs, sess, loopVars, resolveVar, callDepth, execStats);
        assignStLhs(sess, stmt.lhs, rhsVal, outputsWritten, loopVars);
        statementsExecuted += 1;
        break;
      }
      case 'if': {
        let matched = false;
        for (let b = 0; b < stmt.branches.length; b++) {
          const br = stmt.branches[b];
          if (Boolean(evalCompiledExpr(br.cond, sess, loopVars, resolveVar, callDepth, execStats))) {
            matched = true;
            const res = executeCompiledStStmts(br.body, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
            statementsExecuted += res.statementsExecuted;
            if (res.exited) return { statementsExecuted, exited: true, returned: res.returned };
            break;
          }
        }
        if (!matched && stmt.elseBody.length > 0) {
          const res = executeCompiledStStmts(stmt.elseBody, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          if (res.exited) return { statementsExecuted, exited: true, returned: res.returned };
        }
        break;
      }
      case 'for': {
        const startVal = Math.trunc(evalCompiledExpr(stmt.start, sess, loopVars, resolveVar, callDepth, execStats));
        const endVal = Math.trunc(evalCompiledExpr(stmt.end, sess, loopVars, resolveVar, callDepth, execStats));
        const stepVal = stmt.step ? Math.trunc(evalCompiledExpr(stmt.step, sess, loopVars, resolveVar, callDepth, execStats)) : 1;
        if (stepVal !== 0) {
          let iter = 0;
          for (let v = startVal; stepVal > 0 ? v <= endVal : v >= endVal; v += stepVal) {
            if (++iter > 10_000) {
              if (execStats) execStats.loopCapHits += 1;
              break;
            }
            if (execStats) execStats.loopIterations += 1;
            loopVars.set(stmt.varName, v);
            assignStLhs(sess, stmt.varName, v, outputsWritten, loopVars);
            const res = executeCompiledStStmts(stmt.body, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
            statementsExecuted += res.statementsExecuted;
            if (res.returned) return { statementsExecuted, exited: true, returned: true };
            if (res.exited) break;
          }
        }
        break;
      }
      case 'while': {
        let iter = 0;
        while (Boolean(evalCompiledExpr(stmt.cond, sess, loopVars, resolveVar, callDepth, execStats))) {
          if (++iter > 10_000) {
            if (execStats) execStats.loopCapHits += 1;
            break;
          }
          if (execStats) execStats.loopIterations += 1;
          const res = executeCompiledStStmts(stmt.body, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          if (res.returned) return { statementsExecuted, exited: true, returned: true };
          if (res.exited) break;
        }
        break;
      }
      case 'repeat': {
        let iter = 0;
        while (true) {
          if (++iter > 10_000) {
            if (execStats) execStats.loopCapHits += 1;
            break;
          }
          if (execStats) execStats.loopIterations += 1;
          const res = executeCompiledStStmts(stmt.body, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          if (res.returned) return { statementsExecuted, exited: true, returned: true };
          if (res.exited) break;
          if (Boolean(evalCompiledExpr(stmt.until, sess, loopVars, resolveVar, callDepth, execStats))) break;
        }
        break;
      }
      case 'case': {
        const selectorVal = Math.trunc(evalCompiledExpr(stmt.selector, sess, loopVars, resolveVar, callDepth, execStats));
        let matched = false;
        for (let b = 0; b < stmt.branches.length; b++) {
          const br = stmt.branches[b];
          let hit = false;
          for (let r = 0; r < br.ranges.length; r++) {
            const [lo, hi] = br.ranges[r];
            if (selectorVal >= lo && selectorVal <= hi) {
              hit = true;
              break;
            }
          }
          if (hit) {
            matched = true;
            const res = executeCompiledStStmts(br.body, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
            statementsExecuted += res.statementsExecuted;
            if (res.exited) return { statementsExecuted, exited: true, returned: res.returned };
            break;
          }
        }
        if (!matched && stmt.elseBody.length > 0) {
          const res = executeCompiledStStmts(stmt.elseBody, sess, outputsWritten, loopVars, resolveVar, callDepth, execStats);
          statementsExecuted += res.statementsExecuted;
          if (res.exited) return { statementsExecuted, exited: true, returned: res.returned };
        }
        break;
      }
      case 'call': {
        evalStBuiltinOrCall(stmt.raw, sess, loopVars, callDepth, execStats);
        statementsExecuted += 1;
        break;
      }
      case 'exit':
        return { statementsExecuted: statementsExecuted + 1, exited: true };
      case 'return':
        return { statementsExecuted: statementsExecuted + 1, exited: true, returned: true };
    }
  }

  return { statementsExecuted, exited: false };
}

function executeStBlock(
  stCode: string,
  sess: SimulatorSession,
  callDepth = 0,
  execStats?: StExecStats,
): SimStTrace['outputs_written'] & { __count: number; outputs: Record<string, boolean | number> } {
  const program = getCompiledStProgram(stCode);
  const outputsWritten: Record<string, boolean | number> = {};
  const loopVars = new Map<string, number>();
  const resolveVar = (name: string) => resolveStTokenNumericValue(name, sess, loopVars);
  const stats: StExecStats = execStats ?? { loopIterations: 0, loopCapHits: 0, callDepthMax: 0, totalStatements: 0 };
  const res = executeCompiledStStmts(program, sess, outputsWritten, loopVars, resolveVar, callDepth, stats);
  return Object.assign({}, outputsWritten, { __count: res.statementsExecuted, outputs: outputsWritten });
}

export function evaluateConditionExpr(sess: SimulatorSession, expr: string): boolean {
  const clean = expr.trim();
  if (!clean) return false;
  return Boolean(evalStExpression(clean, sess));
}

// ===========================================================================
// IEC 61131-3 SFC & FBD/CFC Execution Engines
// ===========================================================================
function executeSfcPou(sess: SimulatorSession, pou: SimPouProgram): SimSfcTrace {
  const chart = pou.sfcChart;
  if (!chart || !chart.steps.length) {
    return { pou: pou.name, active_steps: [], transitions_fired: [], outputs_written: {} };
  }

  let state = sess.sfcStates.get(pou.name);
  if (!state) {
    state = { initialized: false, steps: new Map(), storedActions: new Map() };
    sess.sfcStates.set(pou.name, state);
  }
  for (const s of chart.steps) {
    if (!state.steps.has(s.name)) {
      state.steps.set(s.name, { active: false, elapsedMs: 0, enteredThisScan: false });
    }
  }
  if (!state.initialized) {
    for (const s of chart.steps) {
      if (s.initial) {
        const st = state.steps.get(s.name)!;
        st.active = true;
        st.elapsedMs = 0;
        st.enteredThisScan = true;
      }
    }
    state.initialized = true;
  }

  const syncStepVars = () => {
    for (const [stepName, st] of state!.steps.entries()) {
      sess.bits.set(`${stepName.toUpperCase()}.X`, st.active);
      sess.words.set(`${stepName.toUpperCase()}.T`, st.elapsedMs);
    }
  };

  syncStepVars();
  const outputsWritten: Record<string, boolean | number> = {};
  if (!pou._cachedSfcPlan) {
    pou._cachedSfcPlan = {
      stepByName: new Map(chart.steps.map((s) => [s.name, s])),
      sortedTrans: [...(chart.transitions ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)),
    };
  }
  const { stepByName, sortedTrans } = pou._cachedSfcPlan;

  // Execute active step actions
  for (const [stepName, st] of state.steps.entries()) {
    if (!st.active) continue;
    const stepDef = stepByName.get(stepName);
    if (!stepDef) continue;
    for (const act of stepDef.actions ?? []) {
      const q = act.qualifier;
      if (q === 'N') {
        const res = executeStBlock(act.code, sess);
        Object.assign(outputsWritten, res.outputs);
      } else if (q === 'P' || q === 'P1') {
        if (st.enteredThisScan) {
          const res = executeStBlock(act.code, sess);
          Object.assign(outputsWritten, res.outputs);
        }
      } else if (q === 'S') {
        const actKey = act.name?.trim() || `${stepName}:${act.code}`;
        state.storedActions.set(actKey, { name: actKey, code: act.code });
      } else if (q === 'R') {
        const actKey = act.name?.trim() || act.code.trim();
        state.storedActions.delete(actKey);
        if (act.code.trim() && act.code.includes(':=')) {
          const res = executeStBlock(act.code, sess);
          Object.assign(outputsWritten, res.outputs);
        }
      } else if (q === 'L') {
        if (st.elapsedMs < (act.time_ms ?? 0)) {
          const res = executeStBlock(act.code, sess);
          Object.assign(outputsWritten, res.outputs);
        }
      } else if (q === 'D') {
        if (st.elapsedMs >= (act.time_ms ?? 0)) {
          const res = executeStBlock(act.code, sess);
          Object.assign(outputsWritten, res.outputs);
        }
      }
    }
  }

  // Execute active stored ('S') actions
  for (const sa of state.storedActions.values()) {
    const res = executeStBlock(sa.code, sess);
    Object.assign(outputsWritten, res.outputs);
  }

  // Evaluate cached priority-sorted transitions
  const fired: string[] = [];
  const consumedFrom = new Set<string>();
  const toActivate = new Set<string>();
  const toDeactivate = new Set<string>();

  for (const tr of sortedTrans) {
    if (!tr.from.length || !tr.to.length) continue;
    const allFromActive = tr.from.every((fn) => state!.steps.get(fn)?.active && !consumedFrom.has(fn));
    if (!allFromActive) continue;
    if (Boolean(evalStExpression(tr.condition, sess))) {
      fired.push(tr.name);
      for (const fn of tr.from) {
        consumedFrom.add(fn);
        toDeactivate.add(fn);
      }
      for (const tn of tr.to) {
        toActivate.add(tn);
      }
    }
  }

  // Apply transition deactivations (running P0 exit actions) & activations
  for (const fn of toDeactivate) {
    const st = state.steps.get(fn);
    if (st) {
      const def = stepByName.get(fn);
      for (const act of def?.actions ?? []) {
        if (act.qualifier === 'P0') {
          const res = executeStBlock(act.code, sess);
          Object.assign(outputsWritten, res.outputs);
        }
      }
      st.active = false;
      st.enteredThisScan = false;
    }
  }
  for (const [stepName, st] of state.steps.entries()) {
    if (st.active && !toActivate.has(stepName)) {
      st.elapsedMs += sess.scan_interval_ms;
      st.enteredThisScan = false;
    }
  }
  for (const tn of toActivate) {
    const st = state.steps.get(tn);
    if (st) {
      st.active = true;
      st.elapsedMs = 0;
      st.enteredThisScan = true;
    }
  }

  syncStepVars();
  const activeSteps = [...state.steps.entries()].filter(([, s]) => s.active).map(([name]) => name);
  return {
    pou: pou.name,
    active_steps: activeSteps,
    transitions_fired: fired,
    outputs_written: outputsWritten,
  };
}

function executeFbdPou(sess: SimulatorSession, pou: SimPouProgram): SimFbdTrace {
  const diagram = pou.fbdDiagram;
  if (!diagram || !diagram.blocks.length) {
    return { pou: pou.name, blocks_evaluated: 0, outputs_written: {} };
  }

  if (!pou._cachedFbdOrder) {
    pou._cachedFbdOrder = topologicalSortFbd(diagram).order;
  }
  const order = pou._cachedFbdOrder;
  const pinValues = new Map<string, number>();
  const outputsWritten: Record<string, boolean | number> = {};

  const evalPinInput = (expr: string): number => {
    const trimmed = expr.trim();
    if (pinValues.has(trimmed.toUpperCase())) {
      return pinValues.get(trimmed.toUpperCase())!;
    }
    const prevKey = `${pou.name.toUpperCase()}:${trimmed.toUpperCase()}`;
    if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && sess.words.has(prevKey)) {
      return sess.words.get(prevKey)!;
    }
    return evalStExpression(trimmed, sess);
  };

  for (const block of order) {
    const op = block.op.trim().toUpperCase();
    const inEntries = Object.entries(block.inputs ?? {});
    const resolvedInputs: Record<string, number> = {};
    const orderedVals: number[] = [];
    for (const [pin, expr] of inEntries) {
      const val = evalPinInput(expr);
      resolvedInputs[pin.toUpperCase()] = val;
      orderedVals.push(val);
    }

    const blockOuts: Record<string, number | boolean> = {};
    if (op === 'AND') {
      blockOuts.OUT = orderedVals.length > 0 && orderedVals.every((v) => Boolean(v));
    } else if (op === 'OR') {
      blockOuts.OUT = orderedVals.some((v) => Boolean(v));
    } else if (op === 'XOR') {
      blockOuts.OUT = orderedVals.reduce((acc, v) => acc !== Boolean(v), false);
    } else if (op === 'NOT') {
      blockOuts.OUT = !Boolean(orderedVals[0] ?? 0);
    } else if (op === 'NAND') {
      blockOuts.OUT = !(orderedVals.length > 0 && orderedVals.every((v) => Boolean(v)));
    } else if (op === 'NOR') {
      blockOuts.OUT = !orderedVals.some((v) => Boolean(v));
    } else if (op === 'ADD') {
      blockOuts.OUT = orderedVals.reduce((a, b) => a + b, 0);
    } else if (op === 'SUB') {
      blockOuts.OUT = (orderedVals[0] ?? 0) - (orderedVals[1] ?? 0);
    } else if (op === 'MUL') {
      blockOuts.OUT = orderedVals.reduce((a, b) => a * b, 1);
    } else if (op === 'DIV') {
      const d = orderedVals[1] ?? 0;
      blockOuts.OUT = d !== 0 ? (orderedVals[0] ?? 0) / d : 0;
    } else if (op === 'MOD') {
      const d = orderedVals[1] ?? 0;
      blockOuts.OUT = d !== 0 ? (orderedVals[0] ?? 0) % d : 0;
    } else if (op === 'ABS') {
      blockOuts.OUT = Math.abs(orderedVals[0] ?? 0);
    } else if (op === 'SQRT') {
      blockOuts.OUT = Math.sqrt(Math.max(0, orderedVals[0] ?? 0));
    } else if (op === 'MIN') {
      blockOuts.OUT = orderedVals.length ? Math.min(...orderedVals) : 0;
    } else if (op === 'MAX') {
      blockOuts.OUT = orderedVals.length ? Math.max(...orderedVals) : 0;
    } else if (op === 'LIMIT') {
      const mn = resolvedInputs.MN ?? orderedVals[0] ?? 0;
      const x = resolvedInputs.IN ?? orderedVals[1] ?? 0;
      const mx = resolvedInputs.MX ?? orderedVals[2] ?? 0;
      blockOuts.OUT = Math.max(mn, Math.min(mx, x));
    } else if (op === 'MOVE') {
      blockOuts.OUT = orderedVals[0] ?? 0;
    } else if (op === 'SEL') {
      const g = resolvedInputs.G ?? orderedVals[0] ?? 0;
      const in0 = resolvedInputs.IN0 ?? orderedVals[1] ?? 0;
      const in1 = resolvedInputs.IN1 ?? orderedVals[2] ?? 0;
      blockOuts.OUT = g ? in1 : in0;
    } else if (op === 'MUX') {
      const k = Math.trunc(resolvedInputs.K ?? orderedVals[0] ?? 0);
      blockOuts.OUT = orderedVals[k + 1] ?? 0;
    } else if (op === 'EQ') {
      blockOuts.OUT = (orderedVals[0] ?? 0) === (orderedVals[1] ?? 0);
    } else if (op === 'NE') {
      blockOuts.OUT = (orderedVals[0] ?? 0) !== (orderedVals[1] ?? 0);
    } else if (op === 'GT') {
      blockOuts.OUT = (orderedVals[0] ?? 0) > (orderedVals[1] ?? 0);
    } else if (op === 'GE') {
      blockOuts.OUT = (orderedVals[0] ?? 0) >= (orderedVals[1] ?? 0);
    } else if (op === 'LT') {
      blockOuts.OUT = (orderedVals[0] ?? 0) < (orderedVals[1] ?? 0);
    } else if (op === 'LE') {
      blockOuts.OUT = (orderedVals[0] ?? 0) <= (orderedVals[1] ?? 0);
    } else if (STANDARD_IEC_FBS.has(op)) {
      const instKey = `${pou.name}:${block.instance || block.id}`;
      Object.assign(blockOuts, executeStandardFb(sess, instKey, op, resolvedInputs));
    } else {
      const userPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === op);
      if (userPou) {
        const argStrs = Object.entries(resolvedInputs).map(([k, v]) => `${k} := ${v}`);
        blockOuts.OUT = invokeUserPouCall(sess, userPou, argStrs, new Map(), 1);
      }
    }

    for (const [pin, val] of Object.entries(blockOuts)) {
      const numVal = typeof val === 'boolean' ? (val ? 1 : 0) : Number(val);
      const pinRef = `${block.id.toUpperCase()}.${pin.toUpperCase()}`;
      pinValues.set(pinRef, numVal);
      sess.words.set(`${pou.name.toUpperCase()}:${pinRef}`, numVal);
    }

    for (const [outPin, targetAddr] of Object.entries(block.outputs ?? {})) {
      const val = blockOuts[outPin.toUpperCase()] ?? blockOuts[outPin] ?? blockOuts.OUT ?? 0;
      const numVal = typeof val === 'boolean' ? (val ? 1 : 0) : Number(val);
      assignStLhs(sess, targetAddr, numVal, outputsWritten);
    }
  }

  return {
    pou: pou.name,
    blocks_evaluated: order.length,
    outputs_written: outputsWritten,
  };
}

function langCodeToSimLang(lang: string): 'LD' | 'ST' | 'IL' | 'SFC' | 'FBD' {
  if (lang === '2') return 'ST';
  if (lang === '3') return 'IL';
  if (lang === '4') return 'SFC';
  if (lang === '5') return 'FBD';
  return 'LD';
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
  const lang = langCodeToSimLang(pou.lang);
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
  const wallStartMs = Date.now();
  const rtcNow = new Date(wallStartMs);
  const rtcYear = rtcNow.getFullYear();
  const rtcMonth = rtcNow.getMonth() + 1;
  const rtcDate = rtcNow.getDate();
  const rtcHours = rtcNow.getHours();
  const rtcMinutes = rtcNow.getMinutes();
  const rtcSeconds = rtcNow.getSeconds();
  const rtcDay = rtcNow.getDay();
  let sampledHeapUsed = process.memoryUsage().heapUsed;

  for (let c = 0; c < count; c++) {
    if (c > 0 && (c & 15) === 0) {
      if (Date.now() - wallStartMs > MAX_STEP_WALL_MS) {
        throw new FileTransformError(
          `Simulator step execution exceeded wall-clock limit (${MAX_STEP_WALL_MS}ms after ${c}/${count} cycles); reduce cycle count or optimize hot loops via ispsoft_sim_diagnostics.`,
        );
      }
      sampledHeapUsed = process.memoryUsage().heapUsed;
    } else if (c > 0 && Date.now() - wallStartMs > MAX_STEP_WALL_MS) {
      throw new FileTransformError(
        `Simulator step execution exceeded wall-clock limit (${MAX_STEP_WALL_MS}ms after ${c}/${count} cycles); reduce cycle count or optimize hot loops via ispsoft_sim_diagnostics.`,
      );
    }
    const scanT0 = process.hrtime.bigint();
    sess.scan_count += 1;
    sess.elapsed_ms += sess.scan_interval_ms;

    // Update special PLC clock/status relays (DVP + AS/AH)
    const firstScan = sess.scan_count === 1;
    const clk10 = Math.floor(sess.elapsed_ms / 10) % 2 === 1;
    const clk100 = Math.floor(sess.elapsed_ms / 100) % 2 === 1;
    const clk1000 = Math.floor(sess.elapsed_ms / 1000) % 2 === 1;
    const clk60000 = Math.floor(sess.elapsed_ms / 60000) % 2 === 1;
    sess.bits.set('M1000', true);
    sess.bits.set('M1001', false);
    sess.bits.set('M1002', firstScan);
    sess.bits.set('M1003', !firstScan);
    sess.bits.set('M1011', clk10);
    sess.bits.set('M1012', clk100);
    sess.bits.set('M1013', clk1000);
    sess.bits.set('M1014', clk60000);
    // AS/AH special relays
    sess.bits.set('SM0', true);
    sess.bits.set('SM400', true);
    sess.bits.set('SM401', false);
    sess.bits.set('SM402', firstScan);
    sess.bits.set('SM403', !firstScan);
    sess.bits.set('SM411', clk10);
    sess.bits.set('SM412', clk100);
    sess.bits.set('SM413', clk1000);
    sess.bits.set('SM414', clk60000);
    // RTC & module count special registers
    sess.words.set('D1013', rtcYear);
    sess.words.set('D1014', rtcMonth);
    sess.words.set('D1015', rtcDate);
    sess.words.set('D1016', rtcHours);
    sess.words.set('D1017', rtcMinutes);
    sess.words.set('D1018', rtcSeconds);
    sess.words.set('D1019', rtcDay);
    sess.words.set('D1220', sess.hwConfig.modules.length);

    const trace: SimNetworkTrace[] = [];
    const stTrace: SimStTrace[] = [];
    const sfcTrace: SimSfcTrace[] = [];
    const fbdTrace: SimFbdTrace[] = [];
    const scanPouTimings: ScanSample['pou_timings'] = [];

    let orderedPous: SimPouProgram[];
    if (sess.tasks.length > 0) {
      orderedPous = [];
      for (const t of sess.sortedActiveTasks) {
        if (t.type >= 2) {
          // Interrupt / event tasks run via triggerSimulatorInterrupt
          continue;
        }
        if (t.type === 1) {
          const interval = Math.max(1, t.interval_ms || sess.scan_interval_ms);
          const lastRun = sess.taskLastRunMs.get(t.name) ?? -interval;
          if (sess.elapsed_ms - lastRun < interval) continue;
          sess.taskLastRunMs.set(t.name, sess.elapsed_ms);
        }
        const pou = sess.pouByName.get(t.program);
        if (pou && pou.active) orderedPous.push(pou);
      }
    } else {
      orderedPous = sess.pouPrograms.filter((p) => p.pouType === '0' && p.active);
    }

    for (const pou of orderedPous) {
      const pouT0 = process.hrtime.bigint();
      if (pou.lang === '1' || pou.lang === '3') {
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
          lang: langCodeToSimLang(pou.lang),
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
      } else if (pou.lang === '4' && pou.sfcChart) {
        const sfcRes = executeSfcPou(sess, pou);
        const pouMs = Number(process.hrtime.bigint() - pouT0) / 1_000_000;
        sfcTrace.push(sfcRes);
        recordPouMetric(sess, pou, pouMs, {
          instructions: sfcRes.active_steps.length,
          statements: sfcRes.transitions_fired.length,
          loopIterations: 0,
          loopCapHits: 0,
          jumpCapHits: 0,
          callDepthMax: 0,
        });
        scanPouTimings.push({
          pou: pou.name,
          lang: 'SFC',
          duration_ms: Math.round(pouMs * 1000) / 1000,
          work_units: sfcRes.active_steps.length,
        });
      } else if (pou.lang === '5' && pou.fbdDiagram) {
        const fbdRes = executeFbdPou(sess, pou);
        const pouMs = Number(process.hrtime.bigint() - pouT0) / 1_000_000;
        fbdTrace.push(fbdRes);
        recordPouMetric(sess, pou, pouMs, {
          instructions: fbdRes.blocks_evaluated,
          statements: 0,
          loopIterations: 0,
          loopCapHits: 0,
          jumpCapHits: 0,
          callDepthMax: 0,
        });
        scanPouTimings.push({
          pou: pou.name,
          lang: 'FBD',
          duration_ms: Math.round(pouMs * 1000) / 1000,
          work_units: fbdRes.blocks_evaluated,
        });
      }
    }

    sess.lastRungTrace = trace;
    sess.lastStTrace = stTrace;
    sess.lastSfcTrace = sfcTrace;
    sess.lastFbdTrace = fbdTrace;

    // Fast snapshot of prevBits for next scan edge detection (no temporary Set allocation or symbol scan)
    for (const [key, val] of sess.bits.entries()) {
      sess.prevBits.set(key, val);
    }
    for (const [key, t] of sess.timers.entries()) {
      sess.prevBits.set(key, t.done);
    }
    for (const [key, cnt] of sess.counters.entries()) {
      sess.prevBits.set(key, cnt.done);
    }
    for (const [key, fVal] of sess.forcedBits.entries()) {
      sess.prevBits.set(key, fVal);
    }

    // Record default watch sample
    const watchAddrs = sess.watchLists.get('default') ?? [];
    const sampleValues: Record<string, boolean | number> = {};
    for (const addr of watchAddrs) {
      if (/^(X|Y|M|S|SM)\d+$/i.test(addr) || parseBitOfWord(addr)) {
        sampleValues[addr] = readBit(sess, addr);
      } else if (/^(T|C|D|SR)\d+$/i.test(addr)) {
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
    // Update Delta scan-time registers (0.1ms units)
    const curTenthMs = Math.max(1, Math.round(scanDurationMs * 10));
    const minTenthMs = Math.max(1, Math.round((diag.min_scan_ms ?? scanDurationMs) * 10));
    const maxTenthMs = Math.max(1, Math.round(diag.max_scan_ms * 10));
    sess.words.set('D1010', curTenthMs);
    sess.words.set('D1011', minTenthMs);
    sess.words.set('D1012', maxTenthMs);
    sess.words.set('SR410', curTenthMs);
    sess.words.set('SR411', minTenthMs);
    sess.words.set('SR412', maxTenthMs);

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
      heap_used_bytes: sampledHeapUsed,
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
  sess.last_scan_at = new Date().toISOString();
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
    sess.sfcStates.clear();
    sess.pidStates.clear();
    sess.taskLastRunMs.clear();

    // Enforce project RETAIN_RANGE latched memory rules on WARM_RESET:
    // Keep retained M/S/T/C/D devices & forced I/O; clear non-retained memory.
    for (const k of [...sess.bits.keys()]) {
      if (!isDeviceRetained(k, sess.retainConfig)) {
        sess.bits.delete(k);
      }
    }
    for (const k of [...sess.words.keys()]) {
      if (!isDeviceRetained(k, sess.retainConfig)) {
        sess.words.delete(k);
      }
    }
    for (const k of [...sess.timers.keys()]) {
      if (!isDeviceRetained(k, sess.retainConfig)) {
        sess.timers.delete(k);
      }
    }
    for (const k of [...sess.counters.keys()]) {
      if (!isDeviceRetained(k, sess.retainConfig)) {
        sess.counters.delete(k);
      }
    }

    sess.bits.set('M1000', true);
    sess.bits.set('M1001', false);
    sess.bits.set('M1002', true);
    sess.bits.set('M1003', false);
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.lastSfcTrace = [];
    sess.lastFbdTrace = [];
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
    sess.sfcStates.clear();
    sess.pidStates.clear();
    sess.taskLastRunMs.clear();
    for (const inst of sess.fbInstances.values()) {
      inst.internal = {};
      for (const k of Object.keys(inst.fields)) {
        inst.fields[k] = typeof inst.fields[k] === 'boolean' ? false : 0;
      }
    }
    sess.lastRungTrace = [];
    sess.lastStTrace = [];
    sess.lastSfcTrace = [];
    sess.lastFbdTrace = [];
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
      if (/^(X|Y|M|S|SM)\d+$/.test(up) || parseBitOfWord(up)) {
        queryValues[up] = { value: readBit(sess, up), forced: sess.forcedBits.has(up) };
      } else if (/^T\d+$/.test(up)) {
        queryValues[up] = sess.timers.get(up) ?? { pv: 0, sv: 0, done: false, accMs: 0, baseMs: timerTimebaseMs(up) };
      } else if (/^C\d+$/.test(up)) {
        queryValues[up] = sess.counters.get(up) ?? { pv: 0, sv: 0, done: false };
      } else if (/^(T|C)\d+\.(Q|DONE|PV)$/.test(up)) {
        const isPv = up.endsWith('.PV');
        queryValues[up] = { value: isPv ? readWord(sess, up) : readBit(sess, up) };
      } else if (/^(D|SR|V|Z|E)\d+$/.test(up)) {
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
    sfc_trace: sess.lastSfcTrace,
    fbd_trace: sess.lastFbdTrace,
  };
}

export function stepSimulatorUntil(sessionId: string, expr: string, maxCycles = 500, addresses?: string[]) {
  const sess = getSession(sessionId);
  const limit = Math.max(1, Math.min(10_000, maxCycles));
  let cyclesExecuted = 0;
  let conditionMet = false;

  const wallStartMs = Date.now();
  for (let i = 0; i < limit; i++) {
    if (i > 0 && Date.now() - wallStartMs > MAX_STEP_WALL_MS) {
      throw new FileTransformError(
        `step_until exceeded wall-clock limit (${MAX_STEP_WALL_MS}ms after ${cyclesExecuted} cycles) waiting for: ${expr}`,
      );
    }
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
        const isFloatCompare =
          typeof actual === 'number' &&
          typeof expected === 'number' &&
          (!Number.isInteger(expected) || !Number.isInteger(actual) || (sym ? isFloatType(sym.entry.type) : false));
        const matches = isFloatCompare
          ? Math.abs((actual as number) - (expected as number)) <= 1e-5
          : actual === expected;
        if (!matches) {
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

// ===========================================================================
// Online Edit, Special Module BFM Simulation, Interrupt Trigger & Trace Analytics
// ===========================================================================

export function onlineEditSimulatorPou(
  sessionId: string,
  options: {
    pouName: string;
    ilCode?: string;
    stCode?: string;
    sfcChart?: SfcChart;
    fbdDiagram?: FbdDiagram;
    persistToDisk?: boolean;
  },
) {
  const sess = getSession(sessionId);
  const pou = sess.pouPrograms.find((p) => p.name.toUpperCase() === options.pouName.trim().toUpperCase());
  if (!pou) {
    throw new FileTransformError(`POU ${JSON.stringify(options.pouName)} not found in simulator session`);
  }

  // Validate and stage everything BEFORE mutating live simulator state (transactional safety)
  let updatedKind = '';
  let nextLang = pou.lang;
  let nextStCode = pou.stCode;
  let nextNetworks = pou.networks;
  let nextSfcChart = pou.sfcChart;
  let nextFbdDiagram = pou.fbdDiagram;

  if (typeof options.stCode === 'string') {
    assertNoStructuralDelimiters(options.stCode, 'ST code');
    if (options.persistToDisk && pou.lang !== '2') {
      throw new FileTransformError(`Cannot persist ST online edit to non-ST POU ${JSON.stringify(pou.name)} (P_Lang=${pou.lang})`);
    }
    nextLang = '2';
    nextStCode = options.stCode;
    updatedKind = 'ST';
  } else if (typeof options.ilCode === 'string') {
    assertNoStructuralDelimiters(options.ilCode, 'IL code');
    const nets = parseIlCodeToNetworks(options.ilCode);
    if (!nets.length && options.ilCode.trim()) {
      throw new FileTransformError('Online Edit failed: unable to parse IL code.');
    }
    if (options.persistToDisk && pou.lang !== '1' && pou.lang !== '3') {
      throw new FileTransformError(`Cannot persist IL/LD online edit to POU ${JSON.stringify(pou.name)} (P_Lang=${pou.lang})`);
    }
    nextLang = pou.lang === '1' ? '1' : '3';
    nextNetworks = nets;
    nextStCode = options.ilCode;
    updatedKind = nextLang === '1' ? 'LD' : 'IL';
  } else if (options.sfcChart) {
    const check = validateSfcChart(options.sfcChart);
    if (!check.valid) {
      throw new FileTransformError(`Invalid SFC chart in online edit: ${check.errors.join('; ')}`);
    }
    assertNoStructuralDelimiters(JSON.stringify(options.sfcChart), 'SFC chart');
    if (options.persistToDisk && pou.lang !== '4') {
      throw new FileTransformError(`Cannot persist SFC online edit to non-SFC POU ${JSON.stringify(pou.name)} (P_Lang=${pou.lang})`);
    }
    nextLang = '4';
    nextSfcChart = options.sfcChart;
    updatedKind = 'SFC';
  } else if (options.fbdDiagram) {
    const check = validateFbdDiagram(options.fbdDiagram);
    if (!check.valid) {
      throw new FileTransformError(`Invalid FBD diagram in online edit: ${check.errors.join('; ')}`);
    }
    assertNoStructuralDelimiters(JSON.stringify(options.fbdDiagram), 'FBD diagram');
    if (options.persistToDisk && pou.lang !== '5') {
      throw new FileTransformError(`Cannot persist FBD online edit to non-FBD POU ${JSON.stringify(pou.name)} (P_Lang=${pou.lang})`);
    }
    nextLang = '5';
    nextFbdDiagram = options.fbdDiagram;
    updatedKind = 'FBD';
  } else {
    throw new FileTransformError('Online Edit requires one of ilCode, stCode, sfcChart, or fbdDiagram.');
  }

  let persisted = false;
  let nextBytes: Buffer | null = null;
  if (options.persistToDisk) {
    const c = decodeContainer(sess.raw_isp_bytes);
    if (updatedKind === 'ST' && typeof options.stCode === 'string') {
      nextBytes = patchSt(c, pou.name, options.stCode, null);
    } else {
      let src = decodeCodepage(c.source, c.encoding);
      if (updatedKind === 'LD' && typeof options.ilCode === 'string') {
        const built = buildNetworksFromIl(options.ilCode, c.newline);
        src = replaceLdPouNetworks(src, pou.name, built, c.newline);
      } else if (updatedKind === 'IL' && typeof options.ilCode === 'string') {
        src = patchIlPouInSource(src, pou.name, options.ilCode, c.newline);
      } else if (updatedKind === 'SFC' && options.sfcChart) {
        src = patchSfcPouInSource(src, pou.name, options.sfcChart, c.newline);
      } else if (updatedKind === 'FBD' && options.fbdDiagram) {
        src = patchFbdPouInSource(src, pou.name, options.fbdDiagram, c.newline);
      }
      nextBytes = c.rebuild(encodeCodepage(src, c.encoding));
    }
    writeFileBuffer(sess.project_path, nextBytes, true);
    persisted = true;
  }

  // Commit staged updates atomically and invalidate cached SFC/FBD execution plans
  pou.lang = nextLang;
  pou.stCode = nextStCode;
  pou.networks = nextNetworks;
  pou.sfcChart = nextSfcChart;
  pou.fbdDiagram = nextFbdDiagram;
  pou._cachedFbdOrder = undefined;
  pou._cachedSfcPlan = undefined;
  if (nextBytes) {
    sess.raw_isp_bytes = nextBytes;
    sess.project_hash = computeContentHash('isp', nextBytes);
  }

  return {
    success: true,
    status: 'ONLINE_EDIT_APPLIED',
    session_id: sess.session_id,
    pou_name: pou.name,
    language: updatedKind,
    mode_preserved: sess.mode,
    scan_count_preserved: sess.scan_count,
    persisted_to_disk: persisted,
    project_hash: sess.project_hash,
  };
}

export function manageSimIoModules(
  sessionId: string,
  options: {
    action: 'list' | 'read' | 'write';
    slot?: number;
    cr_values?: Record<string, number>;
  },
) {
  const sess = getSession(sessionId);
  if (options.action === 'write') {
    if (typeof options.slot !== 'number' || !Number.isInteger(options.slot) || options.slot < 0) {
      throw new FileTransformError('slot (integer >= 0) is required for write action');
    }
    let crMap = sess.moduleBfm.get(options.slot);
    if (!crMap) {
      crMap = new Map<number, number>();
      sess.moduleBfm.set(options.slot, crMap);
    }
    for (const [k, v] of Object.entries(options.cr_values ?? {})) {
      const crNum = Number(k);
      if (!Number.isInteger(crNum) || crNum < 0) {
        throw new FileTransformError(`Invalid CR index: ${k}`);
      }
      crMap.set(crNum, toInt16(Number(v)));
    }
  }

  if (options.action === 'read' && typeof options.slot === 'number') {
    const crMap = sess.moduleBfm.get(options.slot) ?? new Map<number, number>();
    const cfg = sess.hwConfig.modules.find((m) => m.slot === options.slot);
    return {
      success: true,
      session_id: sess.session_id,
      slot: options.slot,
      model: cfg?.model ?? 'UNCONFIGURED',
      cr_values: Object.fromEntries([...crMap.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
    };
  }

  const allSlots = new Set<number>([
    ...sess.hwConfig.modules.map((m) => m.slot),
    ...sess.moduleBfm.keys(),
  ]);
  const modules = [...allSlots]
    .sort((a, b) => a - b)
    .map((slot) => {
      const cfg = sess.hwConfig.modules.find((m) => m.slot === slot);
      const crMap = sess.moduleBfm.get(slot) ?? new Map<number, number>();
      return {
        slot,
        model: cfg?.model ?? 'DYNAMIC',
        description: cfg?.description ?? '',
        x_start: cfg?.x_start ?? null,
        y_start: cfg?.y_start ?? null,
        cr_values: Object.fromEntries([...crMap.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      };
    });

  return {
    success: true,
    session_id: sess.session_id,
    module_count: modules.length,
    modules,
  };
}

export function triggerSimulatorInterrupt(
  sessionId: string,
  options: {
    taskName?: string;
    pouName?: string;
    label?: string;
  },
) {
  const sess = getSession(sessionId);
  if (!sess.interruptsEnabled) {
    return {
      success: false,
      status: 'INTERRUPTS_DISABLED_BY_DI',
      session_id: sess.session_id,
    };
  }

  let targetPou: SimPouProgram | undefined;
  let targetLabel = options.label?.trim();

  if (options.taskName) {
    const task = sess.tasks.find((t) => t.name.toUpperCase() === options.taskName!.trim().toUpperCase());
    if (!task) throw new FileTransformError(`Interrupt task ${JSON.stringify(options.taskName)} not found`);
    targetPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === task.program.toUpperCase());
  } else if (options.pouName) {
    targetPou = sess.pouPrograms.find((p) => p.name.toUpperCase() === options.pouName!.trim().toUpperCase());
  } else if (targetLabel) {
    targetPou = sess.pouPrograms.find((p) =>
      p.networks.some((n) => n.label.toUpperCase() === targetLabel!.toUpperCase()),
    );
  }

  if (!targetPou) {
    throw new FileTransformError('No matching interrupt POU/task/label found in simulator session');
  }

  const isrTrace: SimNetworkTrace[] = [];
  let stOutputs: Record<string, boolean | number> = {};

  if (targetPou.lang === '1' || targetPou.lang === '3') {
    let startIdx = 0;
    if (targetLabel) {
      const found = targetPou.networks.findIndex((n) => n.label.toUpperCase() === targetLabel!.toUpperCase());
      if (found < 0) throw new FileTransformError(`Interrupt label ${JSON.stringify(targetLabel)} not found in POU ${targetPou.name}`);
      startIdx = found;
    }
    executeLdPou(sess, targetPou, isrTrace, startIdx, true, 0);
  } else if (targetPou.lang === '2') {
    const res = executeStBlock(targetPou.stCode, sess);
    stOutputs = res.outputs;
  } else if (targetPou.lang === '4' && targetPou.sfcChart) {
    stOutputs = executeSfcPou(sess, targetPou).outputs_written;
  } else if (targetPou.lang === '5' && targetPou.fbdDiagram) {
    stOutputs = executeFbdPou(sess, targetPou).outputs_written;
  }

  return {
    success: true,
    status: 'INTERRUPT_EXECUTED',
    session_id: sess.session_id,
    pou: targetPou.name,
    label: targetLabel ?? null,
    rung_trace: isrTrace,
    outputs_written: stOutputs,
    snapshot: monitorSimulator(sessionId, undefined, true),
  };
}

export function analyzeSimulatorTrace(
  sessionId: string,
  options: {
    addresses?: string[];
    format?: 'summary' | 'csv';
  } = {},
) {
  const sess = getSession(sessionId);
  const samples = sess.traceBuffer;
  const targetAddrs =
    options.addresses && options.addresses.length > 0
      ? options.addresses
      : [...new Set(samples.flatMap((s) => Object.keys(s.values)))];

  const metrics: Record<string, Record<string, number | boolean | null>> = {};
  for (const addr of targetAddrs) {
    const vals = samples.map((s) => s.values[addr]).filter((v) => v !== undefined);
    if (!vals.length) {
      metrics[addr] = { sample_count: 0, min: null, max: null, avg: null, rising_edges: 0, falling_edges: 0, duty_cycle_pct: null };
      continue;
    }
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let highCount = 0;
    let rising = 0;
    let falling = 0;
    let prevBool: boolean | null = null;
    for (const v of vals) {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      const b = Boolean(v);
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
      if (b) highCount += 1;
      if (prevBool !== null) {
        if (b && !prevBool) rising += 1;
        if (!b && prevBool) falling += 1;
      }
      prevBool = b;
    }
    metrics[addr] = {
      sample_count: vals.length,
      min,
      max,
      avg: Math.round((sum / vals.length) * 1000) / 1000,
      last: vals[vals.length - 1],
      rising_edges: rising,
      falling_edges: falling,
      duty_cycle_pct: Math.round((highCount / vals.length) * 10000) / 100,
    };
  }

  let csv: string | undefined;
  if (options.format === 'csv') {
    const header = ['scan_count', 'elapsed_ms', ...targetAddrs].join(',');
    const rows = samples.map((s) =>
      [
        s.scan_count,
        s.elapsed_ms,
        ...targetAddrs.map((a) => {
          const v = s.values[a];
          if (v === undefined) return '';
          if (typeof v === 'boolean') return v ? '1' : '0';
          return String(v);
        }),
      ].join(','),
    );
    csv = [header, ...rows].join('\n');
  }

  return {
    success: true,
    session_id: sess.session_id,
    sample_count: samples.length,
    addresses: targetAddrs,
    metrics,
    csv,
  };
}
