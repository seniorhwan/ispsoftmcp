import { decodeContainer, inspectContainer, ldNetworks, parseLdNetwork, parseLocalVariables, propertyValue, sections } from './containers.js';
import { readTasks } from './authoring.js';
import { netToIl, parseNetworks } from './mpu2il.js';
import { Instruction } from './il2mpu.js';
import { FileTransformError, computeContentHash, decodeCodepage } from './limits.js';
import { readFileBuffer } from './workspace.js';

export interface SimNetworkTrace {
  pou: string;
  network_index: number;
  net_id: string;
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
  tasks: ReturnType<typeof readTasks>;
  pouPrograms: Array<{
    name: string;
    lang: string;
    pouType: string;
    networks: Array<{ index: number; net_id: string; active: boolean; il: Instruction[] }>;
    stCode: string;
  }>;
  lastRungTrace: SimNetworkTrace[];
  lastStTrace: SimStTrace[];
  watchLists: Map<string, string[]>;
  traceBuffer: WatchSample[];
  created_at: string;
  last_scan_at: string | null;
}

const sessions = new Map<string, SimulatorSession>();
const runTimers = new Map<string, NodeJS.Timeout>();
let nextSimId = 1;

const MAX_CONTINUOUS_RUN_TICKS = 6000;

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

function timerTimebaseMs(timerAddr: string): number {
  const m = /^T(\d+)$/i.exec(timerAddr.trim());
  if (!m) return 100;
  const num = parseInt(m[1], 10);
  if (num >= 246) return 1;
  if (num >= 200) return 10;
  return 100;
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
  return /^(X|Y|M|S)\d+$/i.test(addr.trim());
}

function parseConst(token: string, sess: SimulatorSession): number {
  const t = token.trim();
  if (/^[Kk](-?\d+)$/.test(t)) return parseInt(t.slice(1), 10);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[Hh]([0-9A-Fa-f]+)$/.test(t)) return parseInt(t.slice(1), 16);
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
  sess.words.set(addr, intVal);
}

function getSession(sessionId: string): SimulatorSession {
  const sess = sessions.get(sessionId);
  if (!sess) {
    throw new FileTransformError(`Simulator session ${JSON.stringify(sessionId)} not found`);
  }
  return sess;
}

function parseProjectForSim(rawBytes: Buffer) {
  const container = decodeContainer(rawBytes);
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const tasks = readTasks(text);

  const symbols: SimulatorSession['symbols'] = new Map();
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
    }
  }

  const pouPrograms: SimulatorSession['pouPrograms'] = [];
  for (const pouMatch of sections(text, 'POU')) {
    const name = propertyValue(pouMatch.inner, 'P_Name') ?? 'Unknown';
    const lang = propertyValue(pouMatch.inner, 'P_Lang') ?? '1';
    const pouType = propertyValue(pouMatch.inner, 'P_type') ?? '0';
    const localVarSec = sections(pouMatch.inner, 'LOCAL_VAR')[0]?.inner ?? '';
    const parsedLocal = parseLocalVariables(localVarSec);
    for (const entry of parsedLocal.entries) {
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
    }

    const networks: SimulatorSession['pouPrograms'][number]['networks'] = [];
    if (lang === '1') {
      const rawNets = ldNetworks(pouMatch.inner);
      rawNets.forEach((raw, idx) => {
        const parsed = parseLdNetwork(raw);
        const netId = parsed.properties.NET_ID ?? parsed.properties.NetworkID ?? String(idx + 1);
        const active = (parsed.properties.NET_ACTIVE ?? 'TRUE').toUpperCase() !== 'FALSE';
        let il: Instruction[] = [];
        try {
          const parsedIl = parseNetworks(`<NETWORK_START>\n${raw}\n<NETWORK_END>`);
          if (parsedIl.length === 1) {
            il = netToIl(parsedIl[0]);
          }
        } catch {
          il = [];
        }
        networks.push({ index: idx + 1, net_id: netId, active, il });
      });
    }
    const stCode = sections(pouMatch.inner, 'IL_ST_CODE')[0]?.inner ?? '';
    pouPrograms.push({ name, lang, pouType, networks, stCode });
  }

  return { info, tasks, symbols, pouPrograms };
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

export function listSimulatorSessions() {
  return [...sessions.values()].map((s) => ({
    session_id: s.session_id,
    project_path: s.project_path,
    model: s.model,
    mode: s.mode,
    scan_count: s.scan_count,
    elapsed_ms: s.elapsed_ms,
    created_at: s.created_at,
  }));
}

export function startSimulatorSession(projectPath: string, scanIntervalMs = 100): SimulatorSession {
  const rawBytes = readFileBuffer(projectPath);
  const { info, tasks, symbols, pouPrograms } = parseProjectForSim(rawBytes);

  const sessionId = `sim-${nextSimId++}`;
  const defaultWatch = ['X0', 'X1', 'Y0', 'M0', 'M10', 'T0', 'D10', 'D100'];
  for (const symName of symbols.keys()) {
    if (!defaultWatch.includes(symName) && defaultWatch.length < 16) {
      defaultWatch.push(symName);
    }
  }

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
    tasks,
    pouPrograms,
    lastRungTrace: [],
    lastStTrace: [],
    watchLists: new Map([['default', defaultWatch]]),
    traceBuffer: [],
    created_at: new Date().toISOString(),
    last_scan_at: null,
  };
  seedInitialSymbolMemory(session);
  sessions.set(sessionId, session);
  return session;
}

export function reloadSimulatorSession(sessionId: string, projectPath?: string, resetState = false) {
  const sess = getSession(sessionId);
  const targetPath = projectPath?.trim() || sess.project_path;
  const rawBytes = readFileBuffer(targetPath);
  const { info, tasks, symbols, pouPrograms } = parseProjectForSim(rawBytes);

  sess.project_path = targetPath;
  sess.project_hash = computeContentHash('isp', rawBytes);
  sess.model = String(info.project_model ?? sess.model);
  sess.raw_isp_bytes = rawBytes;
  sess.tasks = tasks;
  sess.pouPrograms = pouPrograms;
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
    seedInitialSymbolMemory(sess);
  }
  return monitorSimulator(sessionId);
}

function evalInputRung(sess: SimulatorSession, il: Instruction[]): boolean {
  let acc: boolean | null = null;
  let hasOr = false;
  const orValues: boolean[] = [];

  for (const [op, ops] of il) {
    if (['LD', 'LDI', 'LDP', 'LDF', 'LD=', 'LD<=', 'LD>', 'LD<'].includes(op)) {
      const val = evalContact(sess, op, ops);
      acc = val;
    } else if (['AND', 'ANI', 'ANDP', 'ANDF', 'AND=', 'AND<=', 'AND>', 'AND<'].includes(op)) {
      const val = evalContact(sess, op, ops);
      acc = (acc ?? true) && val;
    } else if (['OR', 'ORI', 'ORP', 'ORF'].includes(op)) {
      hasOr = true;
      orValues.push(evalContact(sess, op, ops));
    }
  }
  if (acc === null) return true;
  if (hasOr) {
    return acc || orValues.some(Boolean);
  }
  return acc;
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

function shiftIndexedDevice(addr: string, offset: number): string {
  const m = /^([A-Z]+)(\d+)$/i.exec(addr.trim());
  if (!m) return normAddr(addr);
  const area = m[1].toUpperCase();
  const base = area === 'X' || area === 'Y' ? parseInt(m[2], 8) : parseInt(m[2], 10);
  const next = base + offset;
  return area === 'X' || area === 'Y' ? `${area}${next.toString(8).toUpperCase()}` : `${area}${next}`;
}

function execOutputInstruction(
  sess: SimulatorSession,
  pouName: string,
  netIndex: number,
  op: string,
  ops: string[],
  powerIn: boolean,
  outputsWritten: Record<string, boolean | number>,
): void {
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
    const sv = Math.max(0, parseConst(ops[1] ?? '0', sess));
    const c = sess.counters.get(cAddr) ?? { pv: 0, sv, done: false, prevIn: false };
    c.sv = sv;
    if (powerIn && !c.prevIn) {
      c.pv += 1;
      if (c.pv >= sv) c.done = true;
    }
    c.prevIn = powerIn;
    sess.counters.set(cAddr, c);
    outputsWritten[cAddr] = c.pv;
    outputsWritten[`${cAddr}.Q`] = c.done;
    return;
  }

  if (!powerIn) return;

  if (op === 'MOV' || op === 'DMOV') {
    const val = parseConst(ops[0], sess);
    writeWord(sess, ops[1], val);
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
    const val = parseConst(ops[0], sess);
    const count = Math.max(0, Math.min(256, parseConst(ops[2] ?? '1', sess)));
    for (let i = 0; i < count; i++) {
      const dst = shiftIndexedDevice(ops[1], i);
      writeWord(sess, dst, val);
      outputsWritten[dst] = val;
    }
  } else if (op === 'ADD' || op === 'DADD') {
    const val = parseConst(ops[0], sess) + parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'SUB' || op === 'DSUB') {
    const val = parseConst(ops[0], sess) - parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'MUL' || op === 'DMUL') {
    const val = parseConst(ops[0], sess) * parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
  } else if (op === 'DIV' || op === 'DDIV') {
    const denom = parseConst(ops[1], sess);
    if (denom !== 0) {
      const val = Math.trunc(parseConst(ops[0], sess) / denom);
      writeWord(sess, ops[2], val);
      outputsWritten[resolveHardwareOrWordKey(sess, ops[2])] = val;
    }
  } else if (op === 'INC' || op === 'DINC') {
    const val = readWord(sess, ops[0]) + 1;
    writeWord(sess, ops[0], val);
    outputsWritten[resolveHardwareOrWordKey(sess, ops[0])] = val;
  } else if (op === 'DEC' || op === 'DDEC') {
    const val = readWord(sess, ops[0]) - 1;
    writeWord(sess, ops[0], val);
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

function evalStExpression(expr: string, sess: SimulatorSession, loopVars?: Map<string, number>): number {
  const clean = expr.trim().replace(/\bTRUE\b/gi, '1').replace(/\bFALSE\b/gi, '0');
  // Replace T0.Q / T0.PV / C0.Q / C0.PV first
  const withDots = clean.replace(/\b((?:T|C)\d+)\.(Q|DONE|PV)\b/gi, (_m, dev, prop) => {
    const upProp = String(prop).toUpperCase();
    if (upProp === 'PV') return String(readWord(sess, String(dev)));
    return readBit(sess, String(dev)) ? '1' : '0';
  });

  const replaced = withDots.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (tok) => {
    const up = tok.toUpperCase();
    if (up === 'AND') return '&&';
    if (up === 'OR') return '||';
    if (up === 'XOR') return '^';
    if (up === 'NOT') return '!';
    if (up === 'MOD') return '%';
    if (loopVars && loopVars.has(tok)) {
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
    .replace(/(?<![<>!])=(?!=)/g, '==');

  if (!/^[\d\s+\-*/%()&|^!<>=.]+$/.test(jsExpr)) {
    return 0;
  }
  try {
    const val = Function(`"use strict"; return (${jsExpr});`)();
    return typeof val === 'boolean' ? (val ? 1 : 0) : Number(val) || 0;
  } catch {
    return 0;
  }
}

function tokenizeStStatements(stCode: string): string[] {
  const stripped = stCode
    .replace(/\(\*[\s\S]*?\*\)/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
  const out: string[] = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    // Split multiple `;` statements on one line while preserving block headers
    let rest = rawLine.trim();
    while (rest) {
      const headerMatch = /^(IF\b.+?\bTHEN|ELSIF\b.+?\bTHEN|ELSE\b|FOR\b.+?\bDO|WHILE\b.+?\bDO|CASE\b.+?\bOF)\s+(.*)$/i.exec(rest);
      if (headerMatch) {
        out.push(headerMatch[1].trim());
        rest = headerMatch[2].trim();
        continue;
      }
      const semi = rest.indexOf(';');
      if (semi !== -1) {
        const stmt = rest.slice(0, semi).trim();
        if (stmt) out.push(stmt);
        rest = rest.slice(semi + 1).trim();
      } else {
        out.push(rest);
        rest = '';
      }
    }
  }
  return out.filter(Boolean);
}

function assignStLhs(
  sess: SimulatorSession,
  lhs: string,
  rhsVal: number,
  outputsWritten: Record<string, boolean | number>,
  loopVars?: Map<string, number>,
): void {
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

function executeStStatements(
  stmts: string[],
  startIdx: number,
  sess: SimulatorSession,
  outputsWritten: Record<string, boolean | number>,
  loopVars: Map<string, number>,
  endTokens: Set<string>,
): { nextIdx: number; statementsExecuted: number; exited: boolean } {
  let idx = startIdx;
  let statementsExecuted = 0;

  while (idx < stmts.length) {
    const raw = stmts[idx].trim();
    const upper = raw.toUpperCase().replace(/;$/, '').trim();
    if (endTokens.has(upper)) {
      return { nextIdx: idx, statementsExecuted, exited: false };
    }
    if (upper === 'EXIT') {
      return { nextIdx: idx + 1, statementsExecuted: statementsExecuted + 1, exited: true };
    }

    if (upper.startsWith('IF ') && upper.endsWith(' THEN')) {
      let branchTaken = Boolean(evalStExpression(raw.slice(3, -5), sess, loopVars));
      let curIdx = idx + 1;
      let doneIf = false;
      let shouldRunBranch = branchTaken;

      while (curIdx < stmts.length && !doneIf) {
        if (shouldRunBranch) {
          const res = executeStStatements(stmts, curIdx, sess, outputsWritten, loopVars, new Set(['ELSIF', 'ELSE', 'END_IF']));
          // Check actual stopper token at res.nextIdx or elsif header
          statementsExecuted += res.statementsExecuted;
          curIdx = res.nextIdx;
          if (res.exited) return { nextIdx: curIdx, statementsExecuted, exited: true };
        } else {
          // Skip until matching ELSIF/ELSE/END_IF at depth 0
          let depth = 0;
          while (curIdx < stmts.length) {
            const u = stmts[curIdx].trim().toUpperCase().replace(/;$/, '').trim();
            if ((u.startsWith('IF ') && u.endsWith(' THEN')) || (u.startsWith('FOR ') && u.endsWith(' DO')) || (u.startsWith('WHILE ') && u.endsWith(' DO'))) {
              depth += 1;
            } else if (u === 'END_IF' || u === 'END_FOR' || u === 'END_WHILE') {
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
            branchTaken = Boolean(evalStExpression(tokRaw.slice(6, -5), sess, loopVars));
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

    const forMatch = /^FOR\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO$/i.exec(raw);
    if (forMatch) {
      const varName = forMatch[1];
      const startVal = Math.trunc(evalStExpression(forMatch[2], sess, loopVars));
      const endVal = Math.trunc(evalStExpression(forMatch[3], sess, loopVars));
      const stepVal = forMatch[4] ? Math.trunc(evalStExpression(forMatch[4], sess, loopVars)) : 1;

      // Find matching END_FOR
      let depth = 0;
      let endIdx = idx + 1;
      while (endIdx < stmts.length) {
        const u = stmts[endIdx].trim().toUpperCase().replace(/;$/, '').trim();
        if (u.startsWith('FOR ') && u.endsWith(' DO')) depth += 1;
        else if (u === 'END_FOR') {
          if (depth === 0) break;
          depth -= 1;
        }
        endIdx += 1;
      }
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      if (stepVal !== 0) {
        let iter = 0;
        for (let v = startVal; stepVal > 0 ? v <= endVal : v >= endVal; v += stepVal) {
          if (++iter > 10_000) break;
          loopVars.set(varName, v);
          assignStLhs(sess, varName, v, outputsWritten, loopVars);
          const res = executeStStatements(bodyStmts, 0, sess, outputsWritten, loopVars, new Set());
          statementsExecuted += res.statementsExecuted;
          if (res.exited) break;
        }
      }
      idx = endIdx + 1;
      continue;
    }

    const whileMatch = /^WHILE\s+(.+?)\s+DO$/i.exec(raw);
    if (whileMatch) {
      let depth = 0;
      let endIdx = idx + 1;
      while (endIdx < stmts.length) {
        const u = stmts[endIdx].trim().toUpperCase().replace(/;$/, '').trim();
        if (u.startsWith('WHILE ') && u.endsWith(' DO')) depth += 1;
        else if (u === 'END_WHILE') {
          if (depth === 0) break;
          depth -= 1;
        }
        endIdx += 1;
      }
      const bodyStmts = stmts.slice(idx + 1, endIdx);
      let iter = 0;
      while (Boolean(evalStExpression(whileMatch[1], sess, loopVars)) && ++iter <= 10_000) {
        const res = executeStStatements(bodyStmts, 0, sess, outputsWritten, loopVars, new Set());
        statementsExecuted += res.statementsExecuted;
        if (res.exited) break;
      }
      idx = endIdx + 1;
      continue;
    }

    // Notice IF sub-block stopper check when encountering ELSIF header
    if (endTokens.has('ELSIF') && upper.startsWith('ELSIF ')) {
      return { nextIdx: idx, statementsExecuted, exited: false };
    }

    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?);?\s*$/.exec(raw);
    if (assign) {
      const rhsVal = evalStExpression(assign[2], sess, loopVars);
      assignStLhs(sess, assign[1], rhsVal, outputsWritten, loopVars);
      statementsExecuted += 1;
    }
    idx += 1;
  }
  return { nextIdx: idx, statementsExecuted, exited: false };
}

function executeStBlock(stCode: string, sess: SimulatorSession): SimStTrace['outputs_written'] & { __count: number; outputs: Record<string, boolean | number> } {
  const stmts = tokenizeStStatements(stCode);
  const outputsWritten: Record<string, boolean | number> = {};
  const loopVars = new Map<string, number>();
  const res = executeStStatements(stmts, 0, sess, outputsWritten, loopVars, new Set());
  return Object.assign({}, outputsWritten, { __count: res.statementsExecuted, outputs: outputsWritten });
}

export function stepSimulator(sessionId: string, cycles = 1): SimulatorSession {
  const sess = getSession(sessionId);
  const count = Math.max(1, Math.min(10_000, cycles));
  const INPUT_OPS = new Set([
    'LD', 'LDI', 'LDP', 'LDF', 'AND', 'ANI', 'ANDP', 'ANDF', 'OR', 'ORI', 'ORP', 'ORF',
    'LD=', 'LD<=', 'LD>', 'LD<', 'AND=', 'AND<=', 'AND>', 'AND<',
  ]);

  for (let c = 0; c < count; c++) {
    sess.scan_count += 1;
    sess.elapsed_ms += sess.scan_interval_ms;

    // Update special PLC clock/status relays
    sess.bits.set('M1000', true); // Always ON during scan
    sess.bits.set('M1001', false); // Always OFF
    sess.bits.set('M1002', sess.scan_count === 1); // Initial ON pulse (first scan)
    sess.bits.set('M1003', sess.scan_count > 1); // Initial OFF pulse
    sess.bits.set('M1012', Math.floor(sess.elapsed_ms / 100) % 2 === 1); // 100ms clock pulse
    sess.bits.set('M1013', Math.floor(sess.elapsed_ms / 1000) % 2 === 1); // 1s clock pulse

    const trace: SimNetworkTrace[] = [];
    const stTrace: SimStTrace[] = [];

    // Schedule POUs in task priority order if tasks are defined
    let orderedPous: SimulatorSession['pouPrograms'];
    if (sess.tasks.length > 0) {
      const activeTasks = [...sess.tasks]
        .filter((t) => t.active)
        .sort((a, b) => a.priority - b.priority);
      const pouByName = new Map(sess.pouPrograms.map((p) => [p.name, p]));
      orderedPous = activeTasks
        .map((t) => pouByName.get(t.program))
        .filter((p): p is SimulatorSession['pouPrograms'][number] => Boolean(p));
    } else {
      orderedPous = sess.pouPrograms.filter((p) => p.pouType === '0');
    }

    for (const pou of orderedPous) {
      if (pou.lang === '1') {
        let mcActive: boolean = true;
        let stlActive: boolean | null = null;

        for (const net of pou.networks) {
          if (!net.active) {
            trace.push({
              pou: pou.name,
              network_index: net.index,
              net_id: net.net_id,
              active: false,
              energized: false,
              il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
              outputs_written: {},
            });
            continue;
          }

          // Check STL / RET / MC / MCR zone transitions
          const firstOut = net.il.find(([op]) => !INPUT_OPS.has(op) && op !== 'END');
          if (firstOut?.[0] === 'STL') {
            const stateAddr = firstOut[1][0];
            stlActive = readBit(sess, stateAddr);
            trace.push({
              pou: pou.name,
              network_index: net.index,
              net_id: net.net_id,
              active: true,
              energized: stlActive,
              il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
              outputs_written: {},
            });
            continue;
          }
          if (firstOut?.[0] === 'RET') {
            stlActive = null;
            trace.push({
              pou: pou.name,
              network_index: net.index,
              net_id: net.net_id,
              active: true,
              energized: true,
              il: ['RET'],
              outputs_written: {},
            });
            continue;
          }

          const rawPower: boolean = evalInputRung(sess, net.il);
          const power: boolean = rawPower && mcActive && (stlActive === null || stlActive);
          const outputsWritten: Record<string, boolean | number> = {};

          for (const [op, ops] of net.il) {
            if (op === 'MC') {
              mcActive = power;
              continue;
            }
            if (op === 'MCR') {
              mcActive = true;
              continue;
            }
            if (!INPUT_OPS.has(op) && op !== 'END') {
              execOutputInstruction(sess, pou.name, net.index, op, ops, power, outputsWritten);
            }
          }
          trace.push({
            pou: pou.name,
            network_index: net.index,
            net_id: net.net_id,
            active: true,
            energized: power,
            il: net.il.map(([op, ops]) => `${op} ${ops.join(',')}`.trim()),
            outputs_written: outputsWritten,
          });
        }
      } else if (pou.lang === '2') {
        const res = executeStBlock(pou.stCode, sess);
        stTrace.push({
          pou: pou.name,
          statements_executed: res.__count,
          outputs_written: res.outputs,
        });
      }
    }

    sess.lastRungTrace = trace;
    sess.lastStTrace = stTrace;

    // Snapshot prevBits for next scan edge detection (LDP/LDF)
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
      if (/^(X|Y|M|S)\d+$/i.test(addr)) {
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
  }
  return sess;
}

export function controlSimulator(
  sessionId: string,
  command: 'RUN' | 'STOP' | 'STEP' | 'RESET' | 'CLOSE',
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
    startRunTimer(sess);
  } else if (command === 'STOP') {
    clearRunTimer(sessionId);
    sess.mode = 'STOP';
  } else if (command === 'STEP') {
    stepSimulator(sessionId, cycles);
  } else if (command === 'RESET') {
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
    seedInitialSymbolMemory(sess);
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
  // If live RUN mode is active, immediately run 1 scan so forced/written I/O propagates synchronously
  if (sess.mode === 'RUN') {
    stepSimulator(sessionId, 1);
  }
  return monitorSimulator(sessionId);
}

export function monitorSimulator(sessionId: string, addresses?: string[]) {
  const sess = getSession(sessionId);
  const queryValues: Record<string, unknown> = {};
  if (addresses && addresses.length > 0) {
    for (const addr of addresses) {
      const raw = addr.trim();
      const up = normAddr(raw);
      if (/^(X|Y|M|S)\d+$/.test(up)) {
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
    queried_addresses: queryValues,
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
  const snapshot = monitorSimulator(sessionId, tableAddrs);
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
