import { sections } from './containers.js';
import type { Instruction } from './il2mpu.js';

export type SfcActionQualifier = 'N' | 'S' | 'R' | 'P' | 'P1' | 'P0' | 'L' | 'D';

export interface SfcAction {
  qualifier: SfcActionQualifier;
  name?: string;
  time_ms?: number;
  code: string;
}

export interface SfcStep {
  name: string;
  initial?: boolean;
  actions: SfcAction[];
  comment?: string;
}

export interface SfcTransition {
  name: string;
  from: string[]; // supports simultaneous convergence (>1 step)
  to: string[];   // supports simultaneous divergence (>1 step)
  condition: string; // ST boolean expression (may use StepName.T, StepName.X, X0, M0, D0 > 10)
  priority?: number;
}

export interface SfcChart {
  steps: SfcStep[];
  transitions: SfcTransition[];
}

export function parseSfcFromPouBody(pouBody: string): { chart: SfcChart | null; error?: string } {
  const secs = sections(pouBody, 'SFC_BODY');
  if (!secs.length) return { chart: null };
  try {
    const parsed = JSON.parse(secs[0].inner.trim()) as SfcChart;
    if (!parsed || !Array.isArray(parsed.steps) || !Array.isArray(parsed.transitions)) {
      return { chart: null, error: 'SFC_BODY must contain steps[] and transitions[]' };
    }
    return { chart: parsed };
  } catch (e) {
    return { chart: null, error: `Invalid SFC_BODY JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function serializeSfcBody(chart: SfcChart, newline = '\r\n'): string {
  const body = JSON.stringify(chart, null, 2).replace(/\n/g, newline);
  return `<SFC_BODY>${newline}${body}${newline}</SFC_BODY>`;
}

export function validateSfcChart(chart: SfcChart): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validQualifiers = new Set<SfcActionQualifier>(['N', 'S', 'R', 'P', 'P1', 'P0', 'L', 'D']);

  if (!chart || !Array.isArray(chart.steps) || !chart.steps.length) {
    errors.push('SFC chart must contain at least one step.');
    return { valid: false, errors, warnings };
  }
  const transitions = Array.isArray(chart.transitions) ? chart.transitions : [];

  const stepNames = new Set<string>();
  const initialSteps: string[] = [];

  for (const step of chart.steps) {
    if (!step.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.name)) {
      errors.push(`Invalid SFC step name: ${JSON.stringify(step.name)}`);
    } else if (stepNames.has(step.name)) {
      errors.push(`Duplicate SFC step name: ${step.name}`);
    } else {
      stepNames.add(step.name);
    }
    if (step.initial) initialSteps.push(step.name);

    for (const act of step.actions ?? []) {
      if (!validQualifiers.has(act.qualifier)) {
        errors.push(`Step ${step.name} has invalid action qualifier: ${String(act.qualifier)}`);
      }
      if ((act.qualifier === 'L' || act.qualifier === 'D') && (typeof act.time_ms !== 'number' || act.time_ms < 0)) {
        errors.push(`Step ${step.name} action with qualifier ${act.qualifier} requires non-negative time_ms.`);
      }
      if (!act.code || !act.code.trim()) {
        warnings.push(`Step ${step.name} has an action with empty ST code.`);
      }
    }
  }

  if (initialSteps.length === 0) {
    errors.push('SFC chart requires at least one initial step (initial: true).');
  }

  const outgoing = new Map<string, string[]>();
  const transNames = new Set<string>();

  for (const tr of transitions) {
    if (!tr.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tr.name)) {
      errors.push(`Invalid SFC transition name: ${JSON.stringify(tr.name)}`);
    } else if (transNames.has(tr.name)) {
      errors.push(`Duplicate SFC transition name: ${tr.name}`);
    } else {
      transNames.add(tr.name);
    }
    if (!Array.isArray(tr.from) || tr.from.length === 0) {
      errors.push(`Transition ${tr.name} must specify at least one 'from' step.`);
    }
    if (!Array.isArray(tr.to) || tr.to.length === 0) {
      errors.push(`Transition ${tr.name} must specify at least one 'to' step.`);
    }
    if (!tr.condition || !tr.condition.trim()) {
      errors.push(`Transition ${tr.name} must specify a boolean condition expression.`);
    }
    for (const f of tr.from ?? []) {
      if (!stepNames.has(f)) errors.push(`Transition ${tr.name} references unknown 'from' step ${f}.`);
      const list = outgoing.get(f) ?? [];
      list.push(...(tr.to ?? []));
      outgoing.set(f, list);
    }
    for (const t of tr.to ?? []) {
      if (!stepNames.has(t)) errors.push(`Transition ${tr.name} references unknown 'to' step ${t}.`);
    }
  }

  // Reachability BFS from initial steps
  const visited = new Set<string>(initialSteps);
  const queue = [...initialSteps];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of outgoing.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  for (const name of stepNames) {
    if (!visited.has(name)) {
      warnings.push(`Step ${name} is unreachable from initial step(s).`);
    }
    if ((outgoing.get(name)?.length ?? 0) === 0 && chart.steps.length > 1) {
      warnings.push(`Step ${name} has no outgoing transitions (terminal dead-end).`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function renderSfcAscii(chart: SfcChart): string {
  const lines: string[] = [];
  for (const step of chart.steps) {
    const box = step.initial ? `[[ ${step.name} (INIT) ]]` : `[ ${step.name} ]`;
    const acts = (step.actions ?? []).map((a) => {
      const t = a.time_ms !== undefined ? `(${a.time_ms}ms)` : '';
      return `[${a.qualifier}${t}: ${a.code.replace(/\s+/g, ' ').trim()}]`;
    });
    lines.push(acts.length ? `${box} -- ${acts.join(' ')}` : box);
    const outs = chart.transitions.filter((tr) => tr.from.includes(step.name));
    for (const tr of outs) {
      const fromTag = tr.from.length > 1 ? `(${tr.from.join(' & ')})` : step.name;
      const toTag = tr.to.length > 1 ? `(${tr.to.join(' || ')})` : tr.to[0];
      lines.push(`   |-- ${tr.name}: IF (${tr.condition}) [${fromTag} -> ${toTag}]`);
    }
  }
  return lines.join('\n');
}

// =============================================================================
// FBD / CFC (Function Block Diagram, P_Lang=5)
// =============================================================================

export interface FbdBlock {
  id: string;
  op: string; // e.g., AND, OR, NOT, XOR, ADD, SUB, MUL, DIV, MOD, GT, GE, LT, LE, EQ, NE, SEL, MUX, MOVE, TON, TOF, TP, CTU, CTD, R_TRIG, F_TRIG, SR, RS, PID_FB, SCALE, ABS, MIN, MAX, LIMIT, or user FB/FC name
  instance?: string; // instance name for stateful FBs (TON, CTU, user FB)
  inputs: Record<string, string>; // pinName -> literal, device/var name, or "blockId.outPin"
  outputs?: Record<string, string>; // outPin -> destination device/var name (default output pin is "OUT" or "Q")
  comment?: string;
}

export interface FbdDiagram {
  blocks: FbdBlock[];
}

export function parseFbdFromPouBody(pouBody: string): { diagram: FbdDiagram | null; error?: string } {
  const secs = sections(pouBody, 'FBD_BODY');
  if (!secs.length) return { diagram: null };
  try {
    const parsed = JSON.parse(secs[0].inner.trim()) as FbdDiagram;
    if (!parsed || !Array.isArray(parsed.blocks)) {
      return { diagram: null, error: 'FBD_BODY must contain blocks[]' };
    }
    return { diagram: parsed };
  } catch (e) {
    return { diagram: null, error: `Invalid FBD_BODY JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function serializeFbdBody(diagram: FbdDiagram, newline = '\r\n'): string {
  const body = JSON.stringify(diagram, null, 2).replace(/\n/g, newline);
  return `<FBD_BODY>${newline}${body}${newline}</FBD_BODY>`;
}

export function topologicalSortFbd(diagram: FbdDiagram): { order: FbdBlock[]; cycles: string[] } {
  const byId = new Map<string, FbdBlock>();
  for (const b of diagram.blocks) byId.set(b.id, b);

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const b of diagram.blocks) {
    inDegree.set(b.id, 0);
    adj.set(b.id, []);
  }

  for (const b of diagram.blocks) {
    const deps = new Set<string>();
    for (const rawSrc of Object.values(b.inputs ?? {})) {
      const src = typeof rawSrc === 'string' ? rawSrc : String(rawSrc ?? '');
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$/.exec(src.trim());
      if (m && byId.has(m[1]) && m[1] !== b.id) {
        deps.add(m[1]);
      }
    }
    for (const dep of deps) {
      adj.get(dep)!.push(b.id);
      inDegree.set(b.id, (inDegree.get(b.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const b of diagram.blocks) {
    if ((inDegree.get(b.id) ?? 0) === 0) queue.push(b.id);
  }

  const order: FbdBlock[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const nxt of adj.get(id) ?? []) {
      const deg = (inDegree.get(nxt) ?? 1) - 1;
      inDegree.set(nxt, deg);
      if (deg === 0) queue.push(nxt);
    }
  }

  const cycles: string[] = [];
  if (order.length < diagram.blocks.length) {
    const orderedIds = new Set(order.map((b) => b.id));
    for (const b of diagram.blocks) {
      if (!orderedIds.has(b.id)) {
        cycles.push(b.id);
        order.push(b); // still include in fallback evaluation order (feedback loop)
      }
    }
  }

  return { order, cycles };
}

export function validateFbdDiagram(diagram: FbdDiagram): { valid: boolean; errors: string[]; warnings: string[]; execution_order: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  if (!diagram || !Array.isArray(diagram.blocks)) {
    errors.push('FBD diagram must contain a blocks array.');
    return { valid: false, errors, warnings, execution_order: [] };
  }

  if (!diagram.blocks.length) {
    warnings.push('FBD diagram contains no blocks.');
  }

  for (const b of diagram.blocks) {
    if (!b.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.id)) {
      errors.push(`Invalid FBD block id: ${JSON.stringify(b.id)}`);
    } else if (ids.has(b.id)) {
      errors.push(`Duplicate FBD block id: ${b.id}`);
    } else {
      ids.add(b.id);
    }
    if (!b.op || !b.op.trim()) {
      errors.push(`Block ${b.id} is missing 'op'.`);
    }
  }

  const { order, cycles } = topologicalSortFbd(diagram);
  if (cycles.length) {
    warnings.push(`Feedback cycle detected involving block(s): ${cycles.join(', ')} (evaluated with previous-scan value).`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    execution_order: order.map((b) => b.id),
  };
}

export function renderFbdAscii(diagram: FbdDiagram): string {
  const { order } = topologicalSortFbd(diagram);
  return order
    .map((b, idx) => {
      const ins = Object.entries(b.inputs ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const outs = Object.entries(b.outputs ?? {})
        .map(([k, v]) => `${k}->${v}`)
        .join(', ');
      const inst = b.instance ? `:${b.instance}` : '';
      return `(${idx + 1}) [${b.id}: ${b.op}${inst}] IN(${ins}) => OUT(${outs || b.id + '.OUT'})`;
    })
    .join('\n');
}

// =============================================================================
// Deterministic IL/LD <-> ST Transpiler
// =============================================================================

function fmtOperandForSt(op: string): string {
  const s = op.trim();
  if (/^[Kk]-?\d+$/.test(s)) return s.slice(1);
  if (/^[Hh][0-9A-Fa-f]+$/.test(s)) return `16#${s.slice(1).toUpperCase()}`;
  return s;
}

export function convertIlInstructionsToSt(instructions: Instruction[]): { st: string; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const stack: string[] = [];
  let branchStack: string[] = [];
  let curExpr: string | null = null;
  let hasOutput = false;

  const pushExpr = (expr: string) => {
    if (curExpr !== null) stack.push(curExpr);
    curExpr = expr;
  };

  const resetIfNeeded = () => {
    if (hasOutput) {
      curExpr = null;
      stack.length = 0;
      branchStack = [];
      hasOutput = false;
    }
  };

  for (const [rawMn, ops] of instructions) {
    const mn = rawMn.toUpperCase();
    if (mn === 'END' || mn === 'NOP') continue;
    if (mn === 'LABEL') {
      lines.push(`(* Label ${ops[0]} *)`);
      continue;
    }

    if (mn === 'LD' || mn === 'LDP' || mn === 'LDF') {
      resetIfNeeded();
      const expr = mn === 'LD' ? ops[0] : `${mn}(${ops[0]})`;
      pushExpr(expr);
      continue;
    }
    if (mn === 'LDI') {
      resetIfNeeded();
      pushExpr(`NOT ${ops[0]}`);
      continue;
    }
    if (mn === 'AND' || mn === 'ANDP' || mn === 'ANDF') {
      const rhs = mn === 'AND' ? ops[0] : `${mn}(${ops[0]})`;
      curExpr = curExpr ? `(${curExpr} AND ${rhs})` : rhs;
      continue;
    }
    if (mn === 'ANI') {
      curExpr = curExpr ? `(${curExpr} AND NOT ${ops[0]})` : `NOT ${ops[0]}`;
      continue;
    }
    if (mn === 'OR' || mn === 'ORP' || mn === 'ORF') {
      const rhs = mn === 'OR' ? ops[0] : `${mn}(${ops[0]})`;
      curExpr = curExpr ? `(${curExpr} OR ${rhs})` : rhs;
      continue;
    }
    if (mn === 'ORI') {
      curExpr = curExpr ? `(${curExpr} OR NOT ${ops[0]})` : `NOT ${ops[0]}`;
      continue;
    }
    if (mn === 'ANB') {
      const prev = stack.pop() ?? 'TRUE';
      curExpr = `(${prev} AND ${curExpr ?? 'TRUE'})`;
      continue;
    }
    if (mn === 'ORB') {
      const prev = stack.pop() ?? 'FALSE';
      curExpr = `(${prev} OR ${curExpr ?? 'FALSE'})`;
      continue;
    }
    if (mn === 'INV') {
      curExpr = `NOT (${curExpr ?? 'FALSE'})`;
      continue;
    }
    if (mn === 'MPS') {
      branchStack.push(curExpr ?? 'TRUE');
      continue;
    }
    if (mn === 'MRD') {
      curExpr = branchStack[branchStack.length - 1] ?? curExpr;
      continue;
    }
    if (mn === 'MPP') {
      curExpr = branchStack.pop() ?? curExpr;
      continue;
    }

    const cmpMatch = /^(D?)(LD|AND|OR)(=|<>|>=|<=|>|<)$/.exec(mn);
    if (cmpMatch) {
      const mode = cmpMatch[2];
      const opSym = cmpMatch[3];
      const expr = `(${fmtOperandForSt(ops[0])} ${opSym} ${fmtOperandForSt(ops[1])})`;
      if (mode === 'LD') {
        resetIfNeeded();
        pushExpr(expr);
      } else if (mode === 'AND') {
        curExpr = curExpr ? `(${curExpr} AND ${expr})` : expr;
      } else {
        curExpr = curExpr ? `(${curExpr} OR ${expr})` : expr;
      }
      continue;
    }

    hasOutput = true;
    const cond = curExpr ?? 'TRUE';
    const wrapIf = (stmt: string) => {
      if (cond === 'TRUE' || cond === 'M1000') {
        lines.push(stmt);
      } else {
        lines.push(`IF ${cond} THEN`);
        lines.push(`  ${stmt}`);
        lines.push('END_IF;');
      }
    };

    if (mn === 'OUT') {
      lines.push(`${ops[0]} := ${cond};`);
    } else if (mn === 'SET') {
      wrapIf(`${ops[0]} := TRUE;`);
    } else if (mn === 'RST') {
      wrapIf(`${ops[0]} := 0;`);
    } else if (mn === 'MOV' || mn === 'DMOV' || mn === 'MOVP' || mn === 'DMOVP') {
      wrapIf(`${ops[1]} := ${fmtOperandForSt(ops[0])};`);
    } else if (mn === 'ADD' || mn === 'DADD' || mn === 'ADDP' || mn === 'DADDP') {
      wrapIf(`${ops[2]} := ${fmtOperandForSt(ops[0])} + ${fmtOperandForSt(ops[1])};`);
    } else if (mn === 'SUB' || mn === 'DSUB' || mn === 'SUBP' || mn === 'DSUBP') {
      wrapIf(`${ops[2]} := ${fmtOperandForSt(ops[0])} - ${fmtOperandForSt(ops[1])};`);
    } else if (mn === 'MUL' || mn === 'DMUL' || mn === 'MULP') {
      wrapIf(`${ops[2]} := ${fmtOperandForSt(ops[0])} * ${fmtOperandForSt(ops[1])};`);
    } else if (mn === 'DIV' || mn === 'DDIV' || mn === 'DIVP') {
      wrapIf(`${ops[2]} := ${fmtOperandForSt(ops[0])} / ${fmtOperandForSt(ops[1])};`);
    } else if (mn === 'INC' || mn === 'DINC' || mn === 'INCP') {
      wrapIf(`${ops[0]} := ${ops[0]} + 1;`);
    } else if (mn === 'DEC' || mn === 'DDEC' || mn === 'DECP') {
      wrapIf(`${ops[0]} := ${ops[0]} - 1;`);
    } else if (mn === 'TMR') {
      wrapIf(`TMR(${ops[0]}, ${fmtOperandForSt(ops[1])});`);
    } else if (mn === 'CNT' || mn === 'DCNT') {
      wrapIf(`${mn}(${ops[0]}, ${fmtOperandForSt(ops[1])});`);
    } else {
      wrapIf(`${mn}(${ops.map(fmtOperandForSt).join(', ')});`);
      warnings.push(`Instruction ${mn} converted as function call syntax in ST.`);
    }
  }

  return { st: lines.join('\n') + (lines.length ? '\n' : ''), warnings };
}

export function convertSimpleStToIl(stCode: string): { il: string; warnings: string[] } {
  const ilLines: string[] = [];
  const warnings: string[] = [];
  const cleaned = stCode.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\r\n]*/g, '');
  const stmts = cleaned
    .split(/;/)
    .map((s) => s.trim())
    .filter(Boolean);

  const emitCondition = (cond: string): string[] => {
    const trimmed = cond.trim().replace(/^\((.*)\)$/, '$1').trim();
    const cmp = /^([A-Za-z0-9_]+)\s*(=|<>|>=|<=|>|<)\s*(-?[A-Za-z0-9_]+)$/.exec(trimmed);
    if (cmp) {
      const a = /^-?\d+$/.test(cmp[1]) ? `K${cmp[1]}` : cmp[1];
      const b = /^-?\d+$/.test(cmp[3]) ? `K${cmp[3]}` : cmp[3];
      return [`LD${cmp[2]} ${a} ${b}`];
    }
    const parts = trimmed.split(/\s+AND\s+/i);
    const out: string[] = [];
    parts.forEach((p, i) => {
      const neg = /^NOT\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(p.trim());
      if (neg) {
        out.push(`${i === 0 ? 'LDI' : 'ANI'} ${neg[1]}`);
      } else {
        out.push(`${i === 0 ? 'LD' : 'AND'} ${p.trim()}`);
      }
    });
    return out;
  };

  const toK = (tok: string) => (/^-?\d+$/.test(tok.trim()) ? `K${tok.trim()}` : tok.trim());

  const emitAssign = (lhs: string, rhs: string, prefixCond: string[] | null) => {
    const r = rhs.trim();
    if (/^(TRUE|1)$/i.test(r) && prefixCond) {
      ilLines.push(...prefixCond, `SET ${lhs}`);
      return;
    }
    if (/^(FALSE|0)$/i.test(r) && prefixCond && /^[XYMS]\d+$/i.test(lhs)) {
      ilLines.push(...prefixCond, `RST ${lhs}`);
      return;
    }
    const bin = /^([A-Za-z0-9_-]+)\s*(\+|-|\*|\/)\s*([A-Za-z0-9_-]+)$/.exec(r);
    if (bin) {
      const opMap: Record<string, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV' };
      ilLines.push(...(prefixCond ?? ['LD M1000']), `${opMap[bin[2]]} ${toK(bin[1])} ${toK(bin[3])} ${lhs}`);
      return;
    }
    if (!prefixCond && /^[XYM]\d+$/i.test(lhs)) {
      ilLines.push(...emitCondition(r), `OUT ${lhs}`);
      return;
    }
    ilLines.push(...(prefixCond ?? ['LD M1000']), `MOV ${toK(r)} ${lhs}`);
  };

  let activeCond: string[] | null = null;
  for (const raw of stmts) {
    let stmt = raw.trim();
    if (/^END_IF$/i.test(stmt)) {
      activeCond = null;
      continue;
    }
    const ifMatch = /^IF\s+([\s\S]+?)\s+THEN\s+([\s\S]+)$/i.exec(stmt);
    if (ifMatch) {
      activeCond = emitCondition(ifMatch[1]);
      stmt = ifMatch[2].trim();
    }
    const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+)$/.exec(stmt);
    if (assignMatch) {
      emitAssign(assignMatch[1], assignMatch[2], activeCond);
      continue;
    }
    warnings.push(`Skipped complex ST statement during IL conversion: ${stmt.slice(0, 60)}`);
  }

  ilLines.push('END');
  return { il: ilLines.join('\n') + '\n', warnings };
}

// =============================================================================
// Device Usage Map & Auto-Allocator
// =============================================================================

export interface DeviceUsageSummary {
  area: string;
  used_devices: string[];
  used_count: number;
  max_address: number;
  min_address: number | null;
  highest_used: number | null;
  next_free: string | null;
}

export function analyzeDeviceUsageFromTexts(
  texts: string[],
  limits: Record<string, number>,
  isOctalXY = true,
): Record<string, DeviceUsageSummary> {
  const areas = ['X', 'Y', 'M', 'S', 'T', 'C', 'D'];
  const usedByArea: Record<string, Set<number>> = {};
  for (const a of areas) usedByArea[a] = new Set<number>();

  const devRe = /\b([XYMSTCD])(\d+)\b/gi;
  for (const txt of texts) {
    devRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = devRe.exec(txt)) !== null) {
      const area = m[1].toUpperCase();
      const rawNum = m[2];
      let num: number;
      if ((area === 'X' || area === 'Y') && isOctalXY) {
        if (!/^[0-7]+$/.test(rawNum)) continue;
        num = parseInt(rawNum, 8);
      } else {
        num = parseInt(rawNum, 10);
      }
      const maxLim = limits[area] ?? 9999;
      if (num >= 0 && num <= maxLim) {
        usedByArea[area].add(num);
      }
    }
  }

  const result: Record<string, DeviceUsageSummary> = {};
  for (const area of areas) {
    const nums = [...usedByArea[area]].sort((a, b) => a - b);
    const maxLim = limits[area] ?? 9999;
    const fmt = (n: number) => ((area === 'X' || area === 'Y') && isOctalXY ? `${area}${n.toString(8)}` : `${area}${n}`);
    let nextFree: string | null = null;
    for (let n = 0; n <= maxLim; n++) {
      if (!usedByArea[area].has(n)) {
        nextFree = fmt(n);
        break;
      }
    }
    result[area] = {
      area,
      used_devices: nums.map(fmt),
      used_count: nums.length,
      max_address: maxLim,
      min_address: nums.length ? nums[0] : null,
      highest_used: nums.length ? nums[nums.length - 1] : null,
      next_free: nextFree,
    };
  }
  return result;
}

export function allocateFreeDevices(
  usage: Record<string, DeviceUsageSummary>,
  area: 'X' | 'Y' | 'M' | 'S' | 'T' | 'C' | 'D',
  count: number,
  options: { start_from?: number; contiguous?: boolean; is_octal_xy?: boolean } = {},
): string[] {
  const summary = usage[area];
  if (!summary) return [];
  const isOctal = (area === 'X' || area === 'Y') && (options.is_octal_xy ?? true);
  const usedSet = new Set<string>(summary.used_devices.map((d) => d.toUpperCase()));
  const fmt = (n: number) => (isOctal ? `${area}${n.toString(8)}` : `${area}${n}`);
  const start = Math.max(0, options.start_from ?? 0);
  const maxLim = summary.max_address;
  const want = Math.max(1, Math.min(256, count));

  if (options.contiguous) {
    let runStart = -1;
    let runLen = 0;
    for (let n = start; n <= maxLim; n++) {
      const addr = fmt(n);
      if (!usedSet.has(addr)) {
        if (runLen === 0) runStart = n;
        runLen++;
        if (runLen === want) {
          return Array.from({ length: want }, (_, i) => fmt(runStart + i));
        }
      } else {
        runLen = 0;
      }
    }
    return [];
  }

  const allocated: string[] = [];
  for (let n = start; n <= maxLim && allocated.length < want; n++) {
    const addr = fmt(n);
    if (!usedSet.has(addr)) allocated.push(addr);
  }
  return allocated;
}
