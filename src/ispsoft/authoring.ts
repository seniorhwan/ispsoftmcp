import {
  IspContainer,
  buildAsV3010Container,
  buildEs2V8Container,
  decodeContainer,
  inspectContainer,
  ldNetworkMatches,
  ldNetworks,
  normalized,
  parseLdNetwork,
  parseLocalVariables,
  propertyValue,
  sections,
} from './containers.js';
import { ilToMpu } from './dvp.js';
import { API_NUM, CONTACT_AND, CONTACT_LD, CONTACT_OR, COIL, nv } from './il2mpu.js';
import { parseNodes, parseNetworks, netToIl } from './mpu2il.js';
import { FileTransformError, decodeCodepage, encodeCodepage } from './limits.js';

export const MODEL_PROFILES: Record<string, Record<string, unknown>> = {
  AS228T: { family: 'AS', project_model: 'AS228T', source_container: 'qualified v3010', languages: ['ST', 'LD'] },
  AS228P: { family: 'AS', project_model: 'AS228P', source_container: 'qualified v3010', languages: ['ST', 'LD'] },
  AS228R: { family: 'AS', project_model: 'AS228R', source_container: 'qualified v3010', languages: ['ST', 'LD'] },
  ES2: { family: 'DVP', project_model: 'ES2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  'ES2-E': { family: 'DVP', project_model: 'ES2-E', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  EH3: { family: 'DVP', project_model: 'EH3', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  SA2: { family: 'DVP', project_model: 'SA2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  SX2: { family: 'DVP', project_model: 'SX2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  SS2: { family: 'DVP', project_model: 'SS2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  EX2: { family: 'DVP', project_model: 'EX2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL'] },
  DVP12SE11R: { family: 'DVP', project_model: 'ES2', pou_exchange: 'MPU', languages: ['LD', 'IL'] },
  DVP12SE11T: { family: 'DVP', project_model: 'ES2', pou_exchange: 'MPU', languages: ['LD', 'IL'] },
};

export function resolveModel(model: string): { canonical: string | null; error: string | null } {
  if (typeof model !== 'string' || !model.trim()) {
    return { canonical: null, error: 'model must be a non-empty exact ISPSoft model name.' };
  }
  const key = model.trim().toUpperCase().replace(/[- /]/g, '');
  const aliases: Record<string, string> = {};
  for (const item of Object.keys(MODEL_PROFILES)) {
    aliases[item.replace(/[- /]/g, '')] = item;
  }
  aliases.DVP32ES2 = 'ES2';
  aliases.DVP32ES2T = 'ES2';
  const canonical = aliases[key] ?? null;
  if (!canonical) {
    return {
      canonical: null,
      error: `Model ${JSON.stringify(model)} has no qualified MCP profile. Supported profiles: ${Object.keys(MODEL_PROFILES).join(', ')}.`,
    };
  }
  return { canonical, error: null };
}

export function createBlankProjectBytes(options: {
  model: string;
  initialPouName?: string;
  language?: 'LD' | 'ST';
  codepage?: string;
}): { ispBytes: Buffer; iniBytes: Buffer; canonicalModel: string } {
  const { canonical, error } = resolveModel(options.model);
  if (error || !canonical) {
    throw new FileTransformError(error ?? 'Unsupported model');
  }
  const profile = MODEL_PROFILES[canonical];
  const projectModel = String(profile.project_model || canonical);
  const pouName = options.initialPouName?.trim() || 'Prog0';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(pouName)) {
    throw new FileTransformError('initial_pou_name must be an ASCII IEC identifier (1-64 chars)');
  }
  const lang = options.language === 'ST' ? 'ST' : 'LD';
  const cp = options.codepage?.trim() || '1252';
  const isAs = profile.family === 'AS';
  const nl = isAs ? '\r\n' : '\r\r\n';
  const ispVer = isAs ? '3.19' : '3.24';

  const pouBlock =
    lang === 'ST'
      ? [
          '<POU>',
          `P_Name=${pouName}`,
          'P_Lang=2',
          'P_type=0',
          'P_Active=TRUE',
          '<LOCAL_VAR>',
          '<VAR>',
          '</VAR>',
          '</LOCAL_VAR>',
          '<IL_ST_CODE>',
          '(* Initial ST program *)',
          'M0 := X0;',
          '</IL_ST_CODE>',
          '</POU>',
        ]
      : [
          '<POU>',
          `P_Name=${pouName}`,
          'P_Lang=1',
          'P_type=0',
          'P_Active=TRUE',
          '<LOCAL_VAR>',
          '<VAR>',
          '</VAR>',
          '</LOCAL_VAR>',
          '<NETWORK_START>',
          '<PROPERTIES_START>',
          'NET_ID=1',
          'NET_LABEL=',
          'NET_ACTIVE=TRUE',
          'NET_BOOKMARK=FALSE',
          'NET_MODIFY=TRUE',
          'NET_FOLD=FALSE',
          '(',
          '',
          '*)',
          '<PROPERTIES_END>',
          '<ROOTLINK_START>',
          '[LD_NODE]',
          'TYPE=1',
          'DEV_NAME=X0',
          '[END_LD_NODE]',
          '<ROOTLINK_END>',
          '<OUTLINK_START>',
          '[LD_NODE]',
          'TYPE=13',
          'DEV_NAME=Y0',
          '[END_LD_NODE]',
          '<OUTLINK_END>',
          '<NETWORK_END>',
          '</POU>',
        ];

  const lines = [
    '<PROJECT>',
    `Active_CodePage=${cp}`,
    `Prj_ISPVer=${ispVer}`,
    `Prj_DT=${projectModel}`,
    'Prj_C_SourceCodeLocked=FALSE',
    '</PROJECT>',
    '<TASK>',
    'T_ID=0',
    'T_Name=CyclicTask',
    'T_Type=0',
    'T_Interval=10',
    'T_Priority=1',
    'T_Active=TRUE',
    `T_PName=${pouName}`,
    '</TASK>',
    '<GLOBAL_VAR>',
    '<VAR>',
    '</VAR>',
    '</GLOBAL_VAR>',
    '[DEVICE_CMT_START]',
    '[DEVICE_CMT_END]',
    '<SYSTEM_VAR>',
    '[BIT_RANGE]',
    '<M>0-4095',
    '[STEP_RANGE]',
    '<S>0-1023',
    '[TIMER_RANGE]',
    '<T>0-255',
    '[COUNTER_RANGE]',
    '<C>0-255',
    '[DATA_RANGE]',
    '<D>0-9999',
    '</SYSTEM_VAR>',
    ...pouBlock,
  ];
  const source = lines.join(nl) + nl;
  const ispBytes = isAs ? buildAsV3010Container(source) : buildEs2V8Container(source);
  const iniBytes = Buffer.from(`[PRJ_DATA]\r\nDEVICE_TYPE=1\r\nMODEL=${projectModel}\r\n`, 'ascii');
  return { ispBytes, iniBytes, canonicalModel: projectModel };
}

export function createPouInSource(
  source: string,
  options: {
    pouName: string;
    language: 'LD' | 'ST' | 'IL';
    pouType?: 'PRG' | 'FB' | 'FC';
    code?: string;
    localVariables?: string;
    assignToTask?: boolean;
  },
  newline: string,
): string {
  const { pouName, language } = options;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(pouName)) {
    throw new FileTransformError('pou_name must be an ASCII IEC identifier (1-64 chars)');
  }
  const existing = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (existing) {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} already exists`);
  }
  const pType = options.pouType === 'FB' ? '1' : options.pouType === 'FC' ? '2' : '0';
  const pLang = language === 'ST' ? '2' : language === 'IL' ? '3' : '1';
  const localVarBody = options.localVariables?.trim()
    ? normalized(options.localVariables).replace(/\n/g, newline)
    : `<VAR>${newline}</VAR>`;

  let pouInnerLines: string[];
  if (language === 'LD') {
    const ilCode = options.code?.trim() || 'LD X0\nOUT Y0\n';
    const { data } = ilToMpu(ilCode, pouName, 'cp1252');
    const netText = decodeCodepage(data, 'latin1'); // unused directly; unpack below via sections
    void netText;
    // Build LD networks cleanly via buildPou-compatible strings:
    const networks = buildNetworksFromIl(ilCode, newline);
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      localVarBody,
      '</LOCAL_VAR>',
      ...networks,
      '</POU>',
    ];
  } else {
    const codeBody = normalized(options.code ?? (language === 'ST' ? '(* ST POU *)\n' : 'LD X0\nOUT Y0\n')).replace(
      /\n/g,
      newline,
    );
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      localVarBody,
      '</LOCAL_VAR>',
      '<IL_ST_CODE>',
      codeBody,
      '</IL_ST_CODE>',
      '</POU>',
    ];
  }

  let updated = source.trimEnd() + newline + pouInnerLines.join(newline) + newline;
  if (options.assignToTask && pType === '0') {
    const existingTasks = sections(updated, 'TASK');
    const maxId = existingTasks.reduce((max, t) => {
      const id = Number(propertyValue(t.inner, 'T_ID') ?? -1);
      return Number.isFinite(id) && id > max ? id : max;
    }, -1);
    const taskBlock = [
      '<TASK>',
      `T_ID=${maxId + 1}`,
      `T_Name=Task_${pouName}`,
      'T_Type=0',
      'T_Interval=10',
      `T_Priority=${maxId + 2}`,
      'T_Active=TRUE',
      `T_PName=${pouName}`,
      '</TASK>',
    ].join(newline);
    if (existingTasks.length > 0) {
      const lastTask = existingTasks[existingTasks.length - 1];
      updated = updated.slice(0, lastTask.end) + newline + taskBlock + updated.slice(lastTask.end);
    } else {
      const firstPou = sections(updated, 'POU')[0];
      if (firstPou) {
        updated = updated.slice(0, firstPou.start) + taskBlock + newline + updated.slice(firstPou.start);
      } else {
        updated = updated + taskBlock + newline;
      }
    }
  }
  return updated;
}

export function deleteOrRenamePouInSource(
  source: string,
  pouName: string,
  action: 'delete' | 'rename',
  newName?: string,
): string {
  const pous = sections(source, 'POU');
  const target = pous.find((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (!target) {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} not found`);
  }
  if (action === 'delete') {
    if (pous.length <= 1) {
      throw new FileTransformError('Cannot delete the only remaining POU in a project');
    }
    let updated = source.slice(0, target.start) + source.slice(target.end);
    // Remove associated TASK entries referencing the deleted POU
    const tasks = sections(updated, 'TASK').filter((t) => propertyValue(t.inner, 'T_PName')?.trim() === pouName);
    for (const t of tasks.reverse()) {
      updated = updated.slice(0, t.start) + updated.slice(t.end);
    }
    return updated.replace(/\n{3,}/g, '\n\n');
  }
  if (!newName || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(newName)) {
    throw new FileTransformError('new_name must be an ASCII IEC identifier (1-64 chars)');
  }
  if (pous.some((m) => propertyValue(m.inner, 'P_Name') === newName)) {
    throw new FileTransformError(`POU ${JSON.stringify(newName)} already exists`);
  }
  const newBody = target.inner.replace(/^P_Name=([^\r\n]*)/m, `P_Name=${newName}`);
  let updated = source.slice(0, target.innerStart) + newBody + source.slice(target.innerEnd);
  updated = updated.replace(
    new RegExp(`(^T_PName=)${pouName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\r*$)`, 'gm'),
    `$1${newName}$2`,
  );
  return updated;
}

export function buildNetworksFromIl(ilProgram: string, newline: string): string[] {
  const { data } = ilToMpu(ilProgram, 'TempPou', 'cp1252');
  const parsed = parseNetworksFromMpuBytes(data);
  return parsed.map((raw) => raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, newline));
}

import { unpackPackage } from './packages.js';
import { ENTRY_NAME } from './mpuCodec.js';

function parseNetworksFromMpuBytes(mpuBytes: Buffer): string[] {
  const { members } = unpackPackage(mpuBytes);
  const src = decodeCodepage(members[ENTRY_NAME], 'cp1252');
  return [...src.matchAll(/<NETWORK_START>\r*\n[\s\S]*?\r*\n<NETWORK_END>/gi)].map((m) => m[0]);
}

export interface TaskConfig {
  id: number;
  name: string;
  type: number;
  interval_ms: number;
  priority: number;
  active: boolean;
  program: string;
}

export function readTasks(source: string): TaskConfig[] {
  return sections(source, 'TASK').map((m) => {
    const b = m.inner;
    return {
      id: Number(propertyValue(b, 'T_ID') ?? 0),
      name: (propertyValue(b, 'T_Name') ?? '').trim(),
      type: Number(propertyValue(b, 'T_Type') ?? 0),
      interval_ms: Number(propertyValue(b, 'T_Interval') ?? 10),
      priority: Number(propertyValue(b, 'T_Priority') ?? 1),
      active: (propertyValue(b, 'T_Active') ?? 'TRUE').trim().toUpperCase() === 'TRUE',
      program: (propertyValue(b, 'T_PName') ?? '').trim(),
    };
  });
}

export function replaceTasksInSource(source: string, tasks: TaskConfig[], newline: string): string {
  if (!tasks.length) {
    throw new FileTransformError('At least one TASK entry is required');
  }
  const pouNames = new Set(sections(source, 'POU').map((m) => propertyValue(m.inner, 'P_Name')));
  for (const t of tasks) {
    if (!pouNames.has(t.program)) {
      throw new FileTransformError(`Task ${JSON.stringify(t.name)} references unknown POU ${JSON.stringify(t.program)}`);
    }
  }
  const rendered = tasks
    .map((t) =>
      [
        '<TASK>',
        `T_ID=${t.id}`,
        `T_Name=${t.name || `Task_${t.id}`}`,
        `T_Type=${t.type ?? 0}`,
        `T_Interval=${t.interval_ms ?? 10}`,
        `T_Priority=${t.priority ?? 1}`,
        `T_Active=${t.active ? 'TRUE' : 'FALSE'}`,
        `T_PName=${t.program}`,
        '</TASK>',
      ].join(newline),
    )
    .join(newline);

  const existing = sections(source, 'TASK');
  if (existing.length > 0) {
    const insertAt = existing[0].start;
    let stripped = source;
    for (let i = existing.length - 1; i >= 0; i--) {
      const t = existing[i];
      stripped = stripped.slice(0, t.start) + stripped.slice(t.end);
    }
    return stripped.slice(0, insertAt) + rendered + stripped.slice(insertAt);
  }
  const firstPou = sections(source, 'POU')[0];
  if (firstPou) {
    return source.slice(0, firstPou.start) + rendered + newline + source.slice(firstPou.start);
  }
  return source + newline + rendered + newline;
}

export interface DutRecord {
  index: number;
  name: string;
  content: string;
}

const DUT_NL = 'PLCnnnnnnnewLineAndSubstitudeeeeeeePLC';

export function readDuts(source: string): DutRecord[] {
  return sections(source, 'DUT_NODE').map((m, index) => {
    const name = propertyValue(m.inner, 'DutName') ?? `DUT_${index}`;
    const raw = propertyValue(m.inner, 'DutContent') ?? '';
    return {
      index,
      name,
      content: raw.split(DUT_NL).join('\n'),
    };
  });
}

export function upsertDutInSource(source: string, name: string, content: string, newline: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new FileTransformError('DUT name must be an ASCII IEC identifier');
  }
  const encoded = normalized(content).replace(/\n/g, DUT_NL);
  const existing = sections(source, 'DUT_NODE').find((m) => propertyValue(m.inner, 'DutName') === name);
  if (existing) {
    const updatedInner = existing.inner.replace(/^DutContent=([^\r\n]*)/m, `DutContent=${encoded}`);
    return source.slice(0, existing.innerStart) + updatedInner + source.slice(existing.innerEnd);
  }
  const block = ['<DUT_NODE>', `DutName=${name}`, `DutContent=${encoded}`, '</DUT_NODE>'].join(newline);
  const firstPou = sections(source, 'POU')[0];
  if (firstPou) {
    return source.slice(0, firstPou.start) + block + newline + source.slice(firstPou.start);
  }
  return source + newline + block + newline;
}

export function deleteDutInSource(source: string, name: string): string {
  const existing = sections(source, 'DUT_NODE').find((m) => propertyValue(m.inner, 'DutName') === name);
  if (!existing) {
    throw new FileTransformError(`DUT ${JSON.stringify(name)} not found`);
  }
  return source.slice(0, existing.start) + source.slice(existing.end);
}

export function editLdRungsInSource(
  source: string,
  pouName: string,
  operations: Array<{
    op: 'insert' | 'append' | 'replace' | 'delete' | 'set_active' | 'set_bookmark' | 'set_label' | 'move';
    network_index?: number;
    to_index?: number;
    il_program?: string;
    active?: boolean;
    bookmark?: boolean;
    label?: string;
  }>,
  newline: string,
): { updatedSource: string; networkCount: number } {
  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const pouMatch = matches[0];
  const pouBody = pouMatch.inner;
  if (propertyValue(pouBody, 'P_Lang') !== '1') {
    throw new FileTransformError('Target POU is not a Ladder Diagram POU');
  }

  const netMatches = ldNetworkMatches(pouBody);
  const nets = netMatches.map((m) => m.full);

  for (const step of operations) {
    if (step.op === 'append') {
      if (!step.il_program) throw new FileTransformError('append requires il_program');
      nets.push(...buildNetworksFromIl(step.il_program, newline));
    } else if (step.op === 'insert') {
      if (!step.il_program) throw new FileTransformError('insert requires il_program');
      const idx = Math.max(0, Math.min(nets.length, (step.network_index ?? 1) - 1));
      nets.splice(idx, 0, ...buildNetworksFromIl(step.il_program, newline));
    } else if (step.op === 'replace') {
      if (!step.il_program) throw new FileTransformError('replace requires il_program');
      const idx = (step.network_index ?? 0) - 1;
      if (idx < 0 || idx >= nets.length) throw new FileTransformError(`network_index ${step.network_index} out of range`);
      nets.splice(idx, 1, ...buildNetworksFromIl(step.il_program, newline));
    } else if (step.op === 'delete') {
      const idx = (step.network_index ?? 0) - 1;
      if (idx < 0 || idx >= nets.length) throw new FileTransformError(`network_index ${step.network_index} out of range`);
      if (nets.length <= 1) throw new FileTransformError('Cannot delete the last remaining network in an LD POU');
      nets.splice(idx, 1);
    } else if (step.op === 'move') {
      const from = (step.network_index ?? 0) - 1;
      const to = (step.to_index ?? 0) - 1;
      if (from < 0 || from >= nets.length || to < 0 || to >= nets.length) {
        throw new FileTransformError('move indices out of range');
      }
      const [moved] = nets.splice(from, 1);
      nets.splice(to, 0, moved);
    } else if (step.op === 'set_active' || step.op === 'set_bookmark' || step.op === 'set_label') {
      const idx = (step.network_index ?? 0) - 1;
      if (idx < 0 || idx >= nets.length) throw new FileTransformError(`network_index ${step.network_index} out of range`);
      let blk = nets[idx];
      if (step.op === 'set_active') {
        const val = step.active === false ? 'FALSE' : 'TRUE';
        blk = /^NET_ACTIVE=/m.test(blk)
          ? blk.replace(/^NET_ACTIVE=[^\r\n]*/m, `NET_ACTIVE=${val}`)
          : blk.replace(/<PROPERTIES_START>\r*\n/, `<PROPERTIES_START>${newline}NET_ACTIVE=${val}${newline}`);
      } else if (step.op === 'set_bookmark') {
        const val = step.bookmark ? 'TRUE' : 'FALSE';
        blk = /^NET_BOOKMARK=/m.test(blk)
          ? blk.replace(/^NET_BOOKMARK=[^\r\n]*/m, `NET_BOOKMARK=${val}`)
          : blk.replace(/<PROPERTIES_START>\r*\n/, `<PROPERTIES_START>${newline}NET_BOOKMARK=${val}${newline}`);
      } else if (step.op === 'set_label') {
        const label = (step.label ?? '').replace(/[\r\n]/g, ' ');
        blk = /^NET_LABEL=/m.test(blk)
          ? blk.replace(/^NET_LABEL=[^\r\n]*/m, `NET_LABEL=${label}`)
          : blk.replace(/<PROPERTIES_START>\r*\n/, `<PROPERTIES_START>${newline}NET_LABEL=${label}${newline}`);
      }
      nets[idx] = blk;
    } else {
      throw new FileTransformError(`Unsupported rung operation: ${String((step as { op: string }).op)}`);
    }
  }

  // Renumber NET_ID sequentially
  const renumbered = nets.map((blk, i) =>
    blk.replace(/^NET_ID=\d+/m, `NET_ID=${i + 1}`).replace(/^NetworkID=\d+/m, `NetworkID=${i + 1}`),
  );
  const joined = renumbered
    .map((item) => item.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, newline))
    .join(newline + newline);

  let updatedPou: string;
  if (netMatches.length > 0) {
    updatedPou = pouBody.slice(0, netMatches[0].start) + joined + pouBody.slice(netMatches[netMatches.length - 1].end);
  } else {
    updatedPou = pouBody + newline + joined + newline;
  }
  const updatedSource = source.slice(0, pouMatch.innerStart) + updatedPou + source.slice(pouMatch.innerEnd);
  return { updatedSource, networkCount: renumbered.length };
}

export function renderLdAsciiForPou(pouBody: string, networkIndex?: number): {
  rungs: Array<{ index: number; net_id: string; active: boolean; label: string; ascii: string; il: string[] }>;
} {
  const rawNets = ldNetworks(pouBody);
  const selected = networkIndex ? [rawNets[networkIndex - 1]].filter(Boolean) : rawNets;
  const startIdx = networkIndex ? networkIndex : 1;

  const rungs = selected.map((raw, offset) => {
    const idx = startIdx + offset;
    const parsed = parseLdNetwork(raw);
    const active = (parsed.properties.NET_ACTIVE ?? 'TRUE').toUpperCase() !== 'FALSE';
    const label = parsed.properties.NET_LABEL ?? '';
    const netId = parsed.properties.NET_ID ?? parsed.properties.NetworkID ?? String(idx);

    const wrapped = `<NETWORK_START>\n${raw}\n<NETWORK_END>`;
    const ilParsed = parseNetworks(wrapped);
    let ilStrings: string[] = [];
    try {
      if (ilParsed.length === 1) {
        ilStrings = netToIl(ilParsed[0]).map(([op, ops]) => (ops.length ? `${op} ${ops.join(', ')}` : op));
      }
    } catch {
      ilStrings = ['(complex/unparsed LD network)'];
    }

    const roots = parsed.root_nodes.map((n) => {
      const t = Number(n.fields.TYPE ?? -1);
      if (t === 1) return `[ ${n.fields.DEV_NAME ?? '?'} ]`;
      if (t === 2) return `[/${n.fields.DEV_NAME ?? '?'}]`;
      if (t === 3) return `[↑${n.fields.DEV_NAME ?? '?'}]`;
      if (t === 4) return `[↓${n.fields.DEV_NAME ?? '?'}]`;
      if (t === 6) return `(OR:${n.fields.LNK_L ?? '?'})`;
      if (t === 10) return `[${n.fields.SYMB ?? '?'}]`;
      if (t === 11) {
        const vars = [...n.raw_text.matchAll(/VAR_NAME=([^\r\n]*)/g)].map((m) => m[1]);
        return vars.length ? `(${vars.join(',')})` : '';
      }
      return '';
    }).filter(Boolean);

    const outs = parsed.outlink_nodes.map((n) => {
      const t = Number(n.fields.TYPE ?? -1);
      if (t === 13) return `( ${n.fields.DEV_NAME ?? '?'} )`;
      if (t === 15) return `(SET ${n.fields.DEV_NAME ?? '?'})`;
      if (t === 16) return `(RST ${n.fields.DEV_NAME ?? '?'})`;
      if (t === 9) return `[${n.fields.SYMB ?? '?'}]`;
      if (t === 11 || t === 12) {
        const vars = [...n.raw_text.matchAll(/VAR_NAME=([^\r\n]*)/g)].map((m) => m[1]);
        return vars.length ? `(${vars.join(',')})` : '';
      }
      return '';
    }).filter(Boolean);

    const left = roots.length ? roots.join('---') : '---';
    const right = outs.length ? outs.join(' ') : '(none)';
    const header = `Network ${idx} (ID=${netId}${active ? '' : ', DISABLED'}${label ? `, LABEL=${label}` : ''})`;
    const ascii = `${header}\n|---${left}------------${right}---|`;
    return { index: idx, net_id: netId, active, label, ascii, il: ilStrings };
  });

  return { rungs };
}

const DEVICE_REF_RE = /(?<![A-Z0-9_])(X|Y|M|S|T|C|D|V|Z|R)\s*(\d+)(?![A-Z0-9_])/gi;
const WRITE_OPS = new Set(['OUT', 'SET', 'RST', 'MOV', 'DMOV', 'DADD', 'DSUB', 'DMUL', 'ADD', 'SUB', 'MUL', 'DIV', 'INC', 'DEC', 'ZRST', 'ALT', 'PLS', 'PLF']);

export function extractCrossRefsFromText(source: string) {
  const refs = new Map<string, { reads: number[]; writes: number[] }>();
  const lines = source.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const upper = line.toUpperCase();
    const isAssign = line.includes(':=') ? line.split(':=', 1)[0] : '';
    const opMatch = /^\s*([A-Z_=<>]+)/.exec(upper);
    const op = opMatch ? opMatch[1] : '';
    const matches = [...line.matchAll(DEVICE_REF_RE)];
    matches.forEach((m, idx) => {
      const dev = `${m[1].toUpperCase()}${m[2]}`;
      if (!refs.has(dev)) {
        refs.set(dev, { reads: [], writes: [] });
      }
      const entry = refs.get(dev)!;
      const isWrite =
        (isAssign && m.index !== undefined && m.index < isAssign.length) ||
        (WRITE_OPS.has(op) && idx === matches.length - 1);
      (isWrite ? entry.writes : entry.reads).push(lineNo);
    });
  });

  return [...refs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([address, data]) => ({
      address,
      reads: data.reads,
      writes: data.writes,
      read_count: data.reads.length,
      write_count: data.writes.length,
    }));
}

export function staticCheckAndCompileProject(container: IspContainer) {
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const errors: Array<{ scope: string; message: string }> = [];
  const warnings: Array<{ scope: string; message: string }> = [];

  const tasks = readTasks(text);
  const pous = sections(text, 'POU');
  const pouMap = new Map<string, { lang: string; body: string }>();

  for (const m of pous) {
    const name = propertyValue(m.inner, 'P_Name') ?? '';
    const lang = propertyValue(m.inner, 'P_Lang') ?? '';
    if (!name) {
      errors.push({ scope: 'POU', message: 'POU missing P_Name' });
      continue;
    }
    if (pouMap.has(name)) {
      errors.push({ scope: `POU:${name}`, message: `Duplicate POU name ${name}` });
    }
    pouMap.set(name, { lang, body: m.inner });
  }

  for (const t of tasks) {
    if (!pouMap.has(t.program)) {
      errors.push({ scope: `TASK:${t.name}`, message: `Task references missing POU ${t.program}` });
    }
  }
  if (tasks.length === 0) {
    warnings.push({ scope: 'TASK', message: 'No TASK entries found; POUs will not be cyclically scheduled.' });
  }

  // Device range limits from SYSTEM_VAR
  const sysVars = sections(text, 'SYSTEM_VAR');
  const areaRanges = new Map<string, { min: number; max: number }>();
  if (sysVars.length === 1) {
    for (const line of sysVars[0].inner.split(/\r?\n/)) {
      const m = /^\s*<([A-Z])>(\d+)-(\d+)\s*$/i.exec(line.trim());
      if (m) {
        areaRanges.set(m[1].toUpperCase(), { min: Number(m[2]), max: Number(m[3]) });
      }
    }
  }

  // Double-coil detection across all LD POUs
  const coilWrites = new Map<string, string[]>();
  let totalNetworks = 0;
  let totalInstructions = 0;

  for (const [name, { lang, body }] of pouMap.entries()) {
    const localVars = sections(body, 'LOCAL_VAR');
    if (localVars.length > 0) {
      const parsedVars = parseLocalVariables(localVars[0].inner);
      if (parsedVars.errors.length && localVars[0].inner.trim() && !/^\s*<VAR>\s*<\/VAR>\s*$/i.test(localVars[0].inner)) {
        // Only warn if non-empty unstructured IEC VAR block
        if (!/^\s*VAR\b[\s\S]*\bEND_VAR\s*$/i.test(localVars[0].inner.trim())) {
          warnings.push({ scope: `POU:${name}`, message: `LOCAL_VAR contains unparsed rows (${parsedVars.errors[0]})` });
        }
      }
    }

    if (lang === '1') {
      const nets = ldNetworks(body);
      totalNetworks += nets.length;
      if (nets.length === 0) {
        warnings.push({ scope: `POU:${name}`, message: 'LD POU contains zero networks' });
      }
      nets.forEach((rawNet, i) => {
        const netNum = i + 1;
        const netErrors = validateLdBodyErrors(rawNet);
        for (const err of netErrors) {
          errors.push({ scope: `POU:${name}:Net${netNum}`, message: err });
        }
        const parsedNet = parseLdNetwork(rawNet);
        for (const node of parsedNet.outlink_nodes) {
          if (node.fields.TYPE === '13' && node.fields.DEV_NAME) {
            const dev = node.fields.DEV_NAME.toUpperCase();
            if (!coilWrites.has(dev)) coilWrites.set(dev, []);
            coilWrites.get(dev)!.push(`${name}:Net${netNum}`);
          }
        }
        try {
          const ilNets = parseNetworks(`<NETWORK_START>\n${rawNet}\n<NETWORK_END>`);
          if (ilNets.length === 1) {
            const ins = netToIl(ilNets[0]);
            totalInstructions += ins.length;
            for (const [, ops] of ins) {
              for (const op of ops) {
                const dm = /^(X|Y|M|S|T|C|D)(\d+)$/i.exec(op);
                if (dm) {
                  const area = dm[1].toUpperCase();
                  const num = area === 'X' || area === 'Y' ? parseInt(dm[2], 8) : parseInt(dm[2], 10);
                  if ((area === 'X' || area === 'Y') && !/^[0-7]+$/.test(dm[2])) {
                    errors.push({ scope: `POU:${name}:Net${netNum}`, message: `Invalid octal address ${op}` });
                  }
                  const range = areaRanges.get(area);
                  if (range && (num < range.min || num > range.max)) {
                    errors.push({
                      scope: `POU:${name}:Net${netNum}`,
                      message: `Device ${op} exceeds configured SYSTEM_VAR range ${range.min}-${range.max}`,
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Complex node layout
        }
      });
    } else if (lang === '2') {
      const code = sections(body, 'IL_ST_CODE')[0]?.inner ?? '';
      const lines = code.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('(*'));
      totalInstructions += lines.length;
      // Basic ST balanced block check
      const ifCount = (code.match(/\bIF\b/gi) ?? []).length;
      const endIfCount = (code.match(/\bEND_IF\b/gi) ?? []).length;
      if (ifCount !== endIfCount) {
        errors.push({ scope: `POU:${name}`, message: `Unbalanced IF/END_IF blocks (${ifCount} IF vs ${endIfCount} END_IF)` });
      }
      const forCount = (code.match(/\bFOR\b/gi) ?? []).length;
      const endForCount = (code.match(/\bEND_FOR\b/gi) ?? []).length;
      if (forCount !== endForCount) {
        errors.push({ scope: `POU:${name}`, message: `Unbalanced FOR/END_FOR blocks (${forCount} FOR vs ${endForCount} END_FOR)` });
      }
    }
  }

  for (const [dev, locs] of coilWrites.entries()) {
    if (locs.length > 1) {
      warnings.push({
        scope: 'DOUBLE_COIL',
        message: `Double-coil output OUT ${dev} appears in multiple networks: ${locs.join(', ')}`,
      });
    }
  }

  return {
    success: errors.length === 0,
    compile_status: errors.length === 0 ? 'STATIC_CHECK_PASSED' : 'STATIC_CHECK_FAILED',
    compile_mode: 'offline_iec_dvp_static_analyzer',
    model: info.project_model,
    pou_count: pous.length,
    task_count: tasks.length,
    total_networks: totalNetworks,
    total_instructions: totalInstructions,
    error_count: errors.length,
    warning_count: warnings.length,
    errors,
    warnings,
    note: 'Comprehensive offline IEC/DVP static check and memory-range verification (non-vendor binary compilation).',
  };
}

function validateLdBodyErrors(body: string): string[] {
  const errors: string[] = [];
  if (!/<PROPERTIES_START>/i.test(body) || !/<PROPERTIES_END>/i.test(body)) errors.push('Missing PROPERTIES block');
  if (!/<ROOTLINK_START>/i.test(body) || !/<ROOTLINK_END>/i.test(body)) errors.push('Missing ROOTLINK block');
  if (!/<OUTLINK_START>/i.test(body) || !/<OUTLINK_END>/i.test(body)) errors.push('Missing OUTLINK block');
  const opens = (body.match(/\[LD_NODE\]/gi) ?? []).length;
  const closes = (body.match(/\[END_LD_NODE\]/gi) ?? []).length;
  if (opens !== closes) errors.push('Unbalanced LD_NODE/END_LD_NODE');
  return errors;
}

export function diffProjectsSource(sourceA: string, sourceB: string) {
  const pousA = new Map(sections(sourceA, 'POU').map((m) => [propertyValue(m.inner, 'P_Name') ?? '', m.inner]));
  const pousB = new Map(sections(sourceB, 'POU').map((m) => [propertyValue(m.inner, 'P_Name') ?? '', m.inner]));

  const addedPous = [...pousB.keys()].filter((k) => !pousA.has(k));
  const removedPous = [...pousA.keys()].filter((k) => !pousB.has(k));
  const modifiedPous: Array<{ name: string; networks_before: number; networks_after: number; st_changed: boolean; vars_changed: boolean }> = [];

  for (const [name, bodyA] of pousA.entries()) {
    const bodyB = pousB.get(name);
    if (!bodyB) continue;
    if (normalized(bodyA) !== normalized(bodyB)) {
      const netsA = ldNetworks(bodyA).length;
      const netsB = ldNetworks(bodyB).length;
      const stA = normalized(sections(bodyA, 'IL_ST_CODE')[0]?.inner ?? '');
      const stB = normalized(sections(bodyB, 'IL_ST_CODE')[0]?.inner ?? '');
      const varA = normalized(sections(bodyA, 'LOCAL_VAR')[0]?.inner ?? '');
      const varB = normalized(sections(bodyB, 'LOCAL_VAR')[0]?.inner ?? '');
      modifiedPous.push({
        name,
        networks_before: netsA,
        networks_after: netsB,
        st_changed: stA !== stB,
        vars_changed: varA !== varB,
      });
    }
  }

  return {
    model_before: propertyValue(sourceA, 'Prj_DT'),
    model_after: propertyValue(sourceB, 'Prj_DT'),
    tasks_before: readTasks(sourceA),
    tasks_after: readTasks(sourceB),
    added_pous: addedPous,
    removed_pous: removedPous,
    modified_pous: modifiedPous,
    identical: normalized(sourceA) === normalized(sourceB),
  };
}

// Keep unused reference silenced cleanly
export { API_NUM, CONTACT_AND, CONTACT_LD, CONTACT_OR, COIL, nv };
