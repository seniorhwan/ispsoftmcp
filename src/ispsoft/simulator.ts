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

export interface WatchSample {
  scan_count: number;
  elapsed_ms: number;
  values: Record<string, boolean | number>;
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
  words: Map<string, number>;
  forcedBits: Map<string, boolean>;
  forcedWords: Map<string, number>;
  timers: Map<string, { pv: number; sv: number; done: boolean; prevIn: boolean }>;
  counters: Map<string, { pv: number; sv: number; done: boolean; prevIn: boolean }>;
  symbols: Map<string, { address: string | null; type: string; value: number | boolean }>;
  tasks: ReturnType<typeof readTasks>;
  pouPrograms: Array<{
    name: string;
    lang: string;
    networks: Array<{ index: number; net_id: string; active: boolean; il: Instruction[] }>;
    stCode: string;
  }>;
  lastRungTrace: SimNetworkTrace[];
  watchLists: Map<string, string[]>;
  traceBuffer: WatchSample[];
  created_at: string;
  last_scan_at: string | null;
}

const sessions = new Map<string, SimulatorSession>();
let nextSimId = 1;

function normAddr(addr: string): string {
  return addr.trim().toUpperCase();
}

function parseConst(token: string, sess: SimulatorSession): number {
  const t = token.trim();
  if (/^[Kk](-?\d+)$/.test(t)) return parseInt(t.slice(1), 10);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[Hh]([0-9A-Fa-f]+)$/.test(t)) return parseInt(t.slice(1), 16);
  const sym = sess.symbols.get(t);
  if (sym) {
    if (sym.address) return readWord(sess, sym.address);
    return typeof sym.value === 'boolean' ? (sym.value ? 1 : 0) : Number(sym.value);
  }
  return readWord(sess, t);
}

function readBit(sess: SimulatorSession, rawAddr: string): boolean {
  const addr = normAddr(rawAddr);
  if (sess.forcedBits.has(addr)) return sess.forcedBits.get(addr)!;
  const sym = sess.symbols.get(rawAddr.trim());
  if (sym) {
    if (sym.address) return readBit(sess, sym.address);
    return Boolean(sym.value);
  }
  if (addr.startsWith('T')) {
    return sess.timers.get(addr)?.done ?? false;
  }
  if (addr.startsWith('C')) {
    return sess.counters.get(addr)?.done ?? false;
  }
  return sess.bits.get(addr) ?? false;
}

function writeBit(sess: SimulatorSession, rawAddr: string, val: boolean): void {
  const addr = normAddr(rawAddr);
  if (sess.forcedBits.has(addr)) return; // forced value takes priority
  const sym = sess.symbols.get(rawAddr.trim());
  if (sym) {
    if (sym.address) {
      writeBit(sess, sym.address, val);
      return;
    }
    sym.value = val;
    return;
  }
  sess.bits.set(addr, val);
}

function readWord(sess: SimulatorSession, rawAddr: string): number {
  const addr = normAddr(rawAddr);
  if (sess.forcedWords.has(addr)) return sess.forcedWords.get(addr)!;
  const sym = sess.symbols.get(rawAddr.trim());
  if (sym) {
    if (sym.address) return readWord(sess, sym.address);
    return Number(sym.value) || 0;
  }
  if (addr.startsWith('T')) {
    return sess.timers.get(addr)?.pv ?? 0;
  }
  if (addr.startsWith('C')) {
    return sess.counters.get(addr)?.pv ?? 0;
  }
  return sess.words.get(addr) ?? 0;
}

function writeWord(sess: SimulatorSession, rawAddr: string, val: number): void {
  const addr = normAddr(rawAddr);
  if (sess.forcedWords.has(addr)) return;
  const intVal = Math.trunc(val);
  const sym = sess.symbols.get(rawAddr.trim());
  if (sym) {
    if (sym.address) {
      writeWord(sess, sym.address, intVal);
      return;
    }
    sym.value = intVal;
    return;
  }
  if (addr.startsWith('T')) {
    const t = sess.timers.get(addr) ?? { pv: 0, sv: 0, done: false, prevIn: false };
    t.pv = intVal;
    sess.timers.set(addr, t);
    return;
  }
  if (addr.startsWith('C')) {
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
  const container = decodeContainer(rawBytes);
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const tasks = readTasks(text);

  const symbols = new Map<string, { address: string | null; type: string; value: number | boolean }>();
  const globalSecs = sections(text, 'GLOBAL_VAR');
  for (const gs of globalSecs) {
    const parsed = parseLocalVariables(gs.inner);
    for (const entry of parsed.entries) {
      const initNum = /^-?\d+$/.test(entry.initial_value) ? parseInt(entry.initial_value, 10) : 0;
      symbols.set(entry.identifier, {
        address: entry.address,
        type: entry.type,
        value: entry.type.toUpperCase() === 'BOOL' ? Boolean(initNum) : initNum,
      });
    }
  }

  const pouPrograms: SimulatorSession['pouPrograms'] = [];
  for (const pouMatch of sections(text, 'POU')) {
    const name = propertyValue(pouMatch.inner, 'P_Name') ?? 'Unknown';
    const lang = propertyValue(pouMatch.inner, 'P_Lang') ?? '1';
    const localVarSec = sections(pouMatch.inner, 'LOCAL_VAR')[0]?.inner ?? '';
    const parsedLocal = parseLocalVariables(localVarSec);
    for (const entry of parsedLocal.entries) {
      const initNum = /^-?\d+$/.test(entry.initial_value) ? parseInt(entry.initial_value, 10) : 0;
      symbols.set(entry.identifier, {
        address: entry.address,
        type: entry.type,
        value: entry.type.toUpperCase() === 'BOOL' ? Boolean(initNum) : initNum,
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
    pouPrograms.push({ name, lang, networks, stCode });
  }

  const sessionId = `sim-${nextSimId++}`;
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
    bits: new Map([['M1000', true], ['M1002', true]]),
    prevBits: new Map(),
    words: new Map(),
    forcedBits: new Map(),
    forcedWords: new Map(),
    timers: new Map(),
    counters: new Map(),
    symbols,
    tasks,
    pouPrograms,
    lastRungTrace: [],
    watchLists: new Map([['default', ['X0', 'X1', 'Y0', 'M0', 'M10', 'T0', 'D10', 'D100']]]),
    traceBuffer: [],
    created_at: new Date().toISOString(),
    last_scan_at: null,
  };
  sessions.set(sessionId, session);
  return session;
}

function evalInputRung(sess: SimulatorSession, il: Instruction[]): boolean {
  // Evaluate contacts/compares before outputs
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
  if (acc === null) return true; // direct bus (e.g., STL/RET or unconditional output)
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
    const prev = sess.prevBits.get(normAddr(addr)) ?? false;
    return cur && !prev;
  }
  if (op === 'LDF' || op === 'ANDF' || op === 'ORF') {
    const cur = readBit(sess, addr);
    const prev = sess.prevBits.get(normAddr(addr)) ?? false;
    return !cur && prev;
  }
  const a = parseConst(ops[0] ?? '0', sess);
  const b = parseConst(ops[1] ?? '0', sess);
  if (op.endsWith('=')) return a === b;
  if (op.endsWith('<=')) return a <= b;
  if (op.endsWith('>')) return a > b;
  if (op.endsWith('<')) return a < b;
  return false;
}

function execOutputInstruction(
  sess: SimulatorSession,
  op: string,
  ops: string[],
  powerIn: boolean,
  outputsWritten: Record<string, boolean | number>,
): void {
  if (op === 'OUT') {
    writeBit(sess, ops[0], powerIn);
    outputsWritten[normAddr(ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'SET') {
    if (powerIn) writeBit(sess, ops[0], true);
    outputsWritten[normAddr(ops[0])] = readBit(sess, ops[0]);
    return;
  }
  if (op === 'RST') {
    if (powerIn) {
      const target = normAddr(ops[0]);
      if (target.startsWith('T')) {
        sess.timers.set(target, { pv: 0, sv: sess.timers.get(target)?.sv ?? 0, done: false, prevIn: false });
      } else if (target.startsWith('C')) {
        sess.counters.set(target, { pv: 0, sv: sess.counters.get(target)?.sv ?? 0, done: false, prevIn: false });
      } else {
        writeBit(sess, target, false);
        writeWord(sess, target, 0);
      }
    }
    return;
  }
  if (op === 'TMR') {
    const tAddr = normAddr(ops[0]);
    const sv = Math.max(0, parseConst(ops[1] ?? '0', sess));
    const t = sess.timers.get(tAddr) ?? { pv: 0, sv, done: false, prevIn: false };
    t.sv = sv;
    if (!powerIn) {
      t.pv = 0;
      t.done = false;
    } else {
      // 100ms timebase per 100ms elapsed
      const ticks = Math.max(1, Math.round(sess.scan_interval_ms / 100));
      t.pv = Math.min(sv, t.pv + ticks);
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
    outputsWritten[normAddr(ops[1])] = val;
  } else if (op === 'ADD' || op === 'DADD') {
    const val = parseConst(ops[0], sess) + parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[normAddr(ops[2])] = val;
  } else if (op === 'SUB' || op === 'DSUB') {
    const val = parseConst(ops[0], sess) - parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[normAddr(ops[2])] = val;
  } else if (op === 'MUL' || op === 'DMUL') {
    const val = parseConst(ops[0], sess) * parseConst(ops[1], sess);
    writeWord(sess, ops[2], val);
    outputsWritten[normAddr(ops[2])] = val;
  } else if (op === 'DIV' || op === 'DDIV') {
    const denom = parseConst(ops[1], sess);
    if (denom !== 0) {
      const val = Math.trunc(parseConst(ops[0], sess) / denom);
      writeWord(sess, ops[2], val);
      outputsWritten[normAddr(ops[2])] = val;
    }
  } else if (op === 'INC' || op === 'DINC') {
    const val = readWord(sess, ops[0]) + 1;
    writeWord(sess, ops[0], val);
    outputsWritten[normAddr(ops[0])] = val;
  } else if (op === 'DEC' || op === 'DDEC') {
    const val = readWord(sess, ops[0]) - 1;
    writeWord(sess, ops[0], val);
    outputsWritten[normAddr(ops[0])] = val;
  } else if (op === 'ALT') {
    const next = !readBit(sess, ops[0]);
    writeBit(sess, ops[0], next);
    outputsWritten[normAddr(ops[0])] = next;
  } else if (op === 'ZRST') {
    const m1 = /^([A-Z]+)(\d+)$/i.exec(ops[0]);
    const m2 = /^([A-Z]+)(\d+)$/i.exec(ops[1]);
    if (m1 && m2 && m1[1].toUpperCase() === m2[1].toUpperCase()) {
      const area = m1[1].toUpperCase();
      const s = parseInt(m1[2], 10);
      const e = parseInt(m2[2], 10);
      for (let i = s; i <= Math.min(e, s + 256); i++) {
        writeBit(sess, `${area}${i}`, false);
        writeWord(sess, `${area}${i}`, 0);
      }
    }
  }
}

function evalStExpression(expr: string, sess: SimulatorSession): number {
  const clean = expr.trim().replace(/\bTRUE\b/gi, '1').replace(/\bFALSE\b/gi, '0');
  // Replace identifiers/devices with numeric values
  const replaced = clean.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (tok) => {
    const up = tok.toUpperCase();
    if (up === 'AND') return '&&';
    if (up === 'OR') return '||';
    if (up === 'NOT') return '!';
    if (up === 'MOD') return '%';
    if (/^(X|Y|M|S|T|C)\d+$/i.test(tok)) {
      return readBit(sess, tok) ? '1' : '0';
    }
    if (/^D\d+$/i.test(tok)) {
      return String(readWord(sess, tok));
    }
    if (sess.symbols.has(tok)) {
      const sym = sess.symbols.get(tok)!;
      if (sym.address) {
        return /^(X|Y|M|S|T|C)\d+$/i.test(sym.address)
          ? readBit(sess, sym.address) ? '1' : '0'
          : String(readWord(sess, sym.address));
      }
      return typeof sym.value === 'boolean' ? (sym.value ? '1' : '0') : String(sym.value);
    }
    return tok;
  });

  const jsExpr = replaced
    .replace(/<>/g, '!=')
    .replace(/(?<![<>!])=(?!=)/g, '==');

  if (!/^[\d\s+\-*/%()&|!<>=.]+$/.test(jsExpr)) {
    return 0;
  }
  try {
    const val = Function(`"use strict"; return (${jsExpr});`)();
    return typeof val === 'boolean' ? (val ? 1 : 0) : Number(val) || 0;
  } catch {
    return 0;
  }
}

function executeStBlock(stCode: string, sess: SimulatorSession): void {
  const stripped = stCode.replace(/\(\*[\s\S]*?\*\)/g, '');
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stack: Array<{ active: boolean; matched: boolean }> = [];

  for (const rawLine of lines) {
    const upper = rawLine.toUpperCase();
    if (upper.startsWith('IF ') && upper.endsWith(' THEN')) {
      const parentActive = stack.every((s) => s.active);
      const condText = rawLine.slice(3, -5);
      const cond = parentActive ? Boolean(evalStExpression(condText, sess)) : false;
      stack.push({ active: parentActive && cond, matched: cond });
      continue;
    }
    if (upper.startsWith('ELSIF ') && upper.endsWith(' THEN')) {
      const top = stack[stack.length - 1];
      if (top) {
        const parentActive = stack.slice(0, -1).every((s) => s.active);
        const cond = parentActive && !top.matched ? Boolean(evalStExpression(rawLine.slice(6, -5), sess)) : false;
        top.active = cond;
        if (cond) top.matched = true;
      }
      continue;
    }
    if (upper === 'ELSE') {
      const top = stack[stack.length - 1];
      if (top) {
        const parentActive = stack.slice(0, -1).every((s) => s.active);
        top.active = parentActive && !top.matched;
        top.matched = true;
      }
      continue;
    }
    if (upper.startsWith('END_IF')) {
      stack.pop();
      continue;
    }
    if (!stack.every((s) => s.active)) continue;

    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+?);?\s*$/.exec(rawLine);
    if (assign) {
      const lhs = assign[1];
      const rhsVal = evalStExpression(assign[2], sess);
      if (/^(X|Y|M|S)\d+$/i.test(lhs)) {
        writeBit(sess, lhs, Boolean(rhsVal));
      } else {
        writeWord(sess, lhs, rhsVal);
      }
    }
  }
}

export function stepSimulator(sessionId: string, cycles = 1): SimulatorSession {
  const sess = getSession(sessionId);
  const count = Math.max(1, Math.min(10_000, cycles));
  const INPUT_OPS = new Set(['LD', 'LDI', 'LDP', 'LDF', 'AND', 'ANI', 'ANDP', 'ANDF', 'OR', 'ORI', 'ORP', 'ORF', 'LD=', 'LD<=', 'LD>', 'LD<', 'AND=', 'AND<=', 'AND>', 'AND<']);

  for (let c = 0; c < count; c++) {
    sess.scan_count += 1;
    sess.elapsed_ms += sess.scan_interval_ms;
    // Update special PLC clock bits
    sess.bits.set('M1000', true); // Always ON during RUN
    sess.bits.set('M1001', false);
    sess.bits.set('M1002', sess.scan_count === 1); // First scan pulse
    sess.bits.set('M1013', sess.scan_count % 2 === 1); // 1s clock toggle pulse

    const activeTaskPous = new Set(sess.tasks.filter((t) => t.active).map((t) => t.program));
    const trace: SimNetworkTrace[] = [];

    for (const pou of sess.pouPrograms) {
      if (activeTaskPous.size > 0 && !activeTaskPous.has(pou.name)) {
        continue;
      }
      if (pou.lang === '1') {
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
          const power = evalInputRung(sess, net.il);
          const outputsWritten: Record<string, boolean | number> = {};
          for (const [op, ops] of net.il) {
            if (!INPUT_OPS.has(op) && op !== 'END') {
              execOutputInstruction(sess, op, ops, power, outputsWritten);
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
        executeStBlock(pou.stCode, sess);
      }
    }

    sess.lastRungTrace = trace;
    // Snapshot prevBits for edge detection (LDP/LDF)
    const allBitKeys = new Set([...sess.bits.keys(), ...sess.forcedBits.keys(), ...sess.timers.keys(), ...sess.counters.keys()]);
    for (const key of allBitKeys) {
      sess.prevBits.set(key, readBit(sess, key));
    }

    // Record default watch sample
    const watchAddrs = sess.watchLists.get('default') ?? [];
    const sampleValues: Record<string, boolean | number> = {};
    for (const addr of watchAddrs) {
      sampleValues[addr] = /^(X|Y|M|S)\d+$/i.test(addr) ? readBit(sess, addr) : readWord(sess, addr);
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
  command: 'RUN' | 'STOP' | 'STEP' | 'RESET',
  cycles = 1,
) {
  const sess = getSession(sessionId);
  if (command === 'RUN') {
    sess.mode = 'RUN';
    stepSimulator(sessionId, Math.max(1, cycles));
  } else if (command === 'STOP') {
    sess.mode = 'STOP';
  } else if (command === 'STEP') {
    stepSimulator(sessionId, cycles);
  } else if (command === 'RESET') {
    sess.mode = 'STOP';
    sess.scan_count = 0;
    sess.elapsed_ms = 0;
    sess.bits.clear();
    sess.bits.set('M1000', true);
    sess.bits.set('M1002', true);
    sess.prevBits.clear();
    sess.words.clear();
    sess.timers.clear();
    sess.counters.clear();
    sess.forcedBits.clear();
    sess.forcedWords.clear();
    sess.lastRungTrace = [];
    sess.traceBuffer = [];
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
      const addr = normAddr(k);
      if (v === null) sess.forcedBits.delete(addr);
      else sess.forcedBits.set(addr, Boolean(v));
    }
  }
  if (options.force_words) {
    for (const [k, v] of Object.entries(options.force_words)) {
      const addr = normAddr(k);
      if (v === null) sess.forcedWords.delete(addr);
      else sess.forcedWords.set(addr, Math.trunc(Number(v)));
    }
  }
  if (options.bits) {
    for (const [k, v] of Object.entries(options.bits)) {
      sess.bits.set(normAddr(k), Boolean(v));
    }
  }
  if (options.words) {
    for (const [k, v] of Object.entries(options.words)) {
      writeWord(sess, k, Number(v));
    }
  }
  if (options.symbols) {
    for (const [name, val] of Object.entries(options.symbols)) {
      const sym = sess.symbols.get(name);
      if (!sym) throw new FileTransformError(`Unknown symbol ${JSON.stringify(name)}`);
      if (typeof val === 'boolean') writeBit(sess, name, val);
      else writeWord(sess, name, Number(val));
    }
  }
  return monitorSimulator(sessionId);
}

export function monitorSimulator(sessionId: string, addresses?: string[]) {
  const sess = getSession(sessionId);
  const queryValues: Record<string, unknown> = {};
  if (addresses && addresses.length > 0) {
    for (const addr of addresses) {
      const up = normAddr(addr);
      if (/^(X|Y|M|S)\d+$/.test(up)) {
        queryValues[up] = { value: readBit(sess, up), forced: sess.forcedBits.has(up) };
      } else if (/^T\d+$/.test(up)) {
        queryValues[up] = sess.timers.get(up) ?? { pv: 0, sv: 0, done: false };
      } else if (/^C\d+$/.test(up)) {
        queryValues[up] = sess.counters.get(up) ?? { pv: 0, sv: 0, done: false };
      } else if (/^D\d+$/.test(up)) {
        queryValues[up] = { value: readWord(sess, up), forced: sess.forcedWords.has(up) };
      } else if (sess.symbols.has(addr)) {
        const sym = sess.symbols.get(addr)!;
        queryValues[addr] = {
          address: sym.address,
          type: sym.type,
          value: sym.address
            ? /^(X|Y|M|S)\d+$/i.test(sym.address) ? readBit(sess, sym.address) : readWord(sess, sym.address)
            : sym.value,
        };
      }
    }
  }

  const activeBits = Object.fromEntries([...sess.bits.entries()].filter(([, v]) => v));
  const nonZeroWords = Object.fromEntries([...sess.words.entries()].filter(([, v]) => v !== 0));
  const symbolValues = Object.fromEntries(
    [...sess.symbols.entries()].map(([name, sym]) => [
      name,
      {
        address: sym.address,
        type: sym.type,
        value: sym.address
          ? /^(X|Y|M|S)\d+$/i.test(sym.address) ? readBit(sess, sym.address) : readWord(sess, sym.address)
          : sym.value,
      },
    ]),
  );

  return {
    success: true,
    execution_target: 'SOFT_PLC_SIMULATOR',
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
