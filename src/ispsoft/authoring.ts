import {
  IspContainer,
  LocalVariableEntry,
  buildAsV3010Container,
  buildEs2V8Container,
  decodeContainer,
  escapeRegex,
  inspectContainer,
  ldNetworkMatches,
  ldNetworks,
  normalized,
  parseLdNetwork,
  parseLocalVariables,
  propertyValue,
  replaceLdPouNetworks,
  sections,
} from './containers.js';
import { ilToMpu, mpuToIl, parseIl } from './dvp.js';
import { API_NUM, CONTACT_AND, CONTACT_LD, CONTACT_OR, COIL, nv } from './il2mpu.js';
import { parseNetworks, netToIl } from './mpu2il.js';
import { FileTransformError, decodeCodepage, encodeCodepage } from './limits.js';
import { unpackPackage } from './packages.js';
import { ENTRY_NAME } from './mpuCodec.js';
import {
  readDataExchangeFromSource,
  readDeviceInitFromSource,
  readHwConfigFromSource,
  readRetainConfigFromSource,
  validateHwConfig,
  writeDataExchangeToSource,
  writeDeviceInitToSource,
  writeHwConfigToSource,
  writeRetainConfigToSource,
  type DataExchangeRow,
  type DeviceInitEntry,
  type HwConfigDocument,
  type RetainConfigDocument,
} from './hwConfig.js';
import {
  parseFbdFromPouBody,
  parseSfcFromPouBody,
  renderFbdAscii,
  renderSfcAscii,
  serializeFbdBody,
  serializeSfcBody,
  validateFbdDiagram,
  validateSfcChart,
  type FbdDiagram,
  type SfcChart,
} from './sfcFbd.js';

export type PouLanguage = 'LD' | 'ST' | 'IL' | 'SFC' | 'FBD';

export const MODEL_PROFILES: Record<string, Record<string, unknown>> = {
  // AS Series
  AS218PX: { family: 'AS', project_model: 'AS218PX', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS218RX: { family: 'AS', project_model: 'AS218RX', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS218TX: { family: 'AS', project_model: 'AS218TX', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS228T: { family: 'AS', project_model: 'AS228T', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS228P: { family: 'AS', project_model: 'AS228P', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS228R: { family: 'AS', project_model: 'AS228R', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS300: { family: 'AS', project_model: 'AS300', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS320T: { family: 'AS', project_model: 'AS320T', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS320P: { family: 'AS', project_model: 'AS320P', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS332T: { family: 'AS', project_model: 'AS332T', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  AS332P: { family: 'AS', project_model: 'AS332P', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 29999, max_m: 8191 },
  // AH Series
  AHCPU500: { family: 'AH', project_model: 'AHCPU500', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 65535, max_m: 16383 },
  AHCPU510: { family: 'AH', project_model: 'AHCPU510', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 65535, max_m: 16383 },
  AHCPU520: { family: 'AH', project_model: 'AHCPU520', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 65535, max_m: 16383 },
  AHCPU530: { family: 'AH', project_model: 'AHCPU530', source_container: 'qualified v3010', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 65535, max_m: 16383 },
  // DVP Series
  ES2: { family: 'DVP', project_model: 'ES2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  'ES2-E': { family: 'DVP', project_model: 'ES2-E', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  ES3: { family: 'DVP', project_model: 'ES3', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 11999, max_m: 4095 },
  EX2: { family: 'DVP', project_model: 'EX2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  EX3: { family: 'DVP', project_model: 'EX3', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 11999, max_m: 4095 },
  EH3: { family: 'DVP', project_model: 'EH3', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 11999, max_m: 4095 },
  SA2: { family: 'DVP', project_model: 'SA2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  SX2: { family: 'DVP', project_model: 'SX2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  SS2: { family: 'DVP', project_model: 'SS2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 4999, max_m: 4095 },
  SE: { family: 'DVP', project_model: 'SE', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 11999, max_m: 4095 },
  SV2: { family: 'DVP', project_model: 'SV2', source_container: 'ISPSoft 3.24 v8 pointer/footer', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 11999, max_m: 4095 },
  DVP12SE11R: { family: 'DVP', project_model: 'ES2', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
  DVP12SE11T: { family: 'DVP', project_model: 'ES2', pou_exchange: 'MPU', languages: ['LD', 'ST', 'IL', 'SFC', 'FBD'], max_d: 9999, max_m: 4095 },
};

export function langCodeToName(code: string | null | undefined): PouLanguage {
  if (code === '2') return 'ST';
  if (code === '3') return 'IL';
  if (code === '4') return 'SFC';
  if (code === '5') return 'FBD';
  return 'LD';
}

export function langNameToCode(lang: PouLanguage): string {
  if (lang === 'ST') return '2';
  if (lang === 'IL') return '3';
  if (lang === 'SFC') return '4';
  if (lang === 'FBD') return '5';
  return '1';
}

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
  aliases.DVP16ES2 = 'ES2';
  aliases.DVP24ES2 = 'ES2';
  aliases.DVP32ES3 = 'ES3';
  aliases.DVP32EH3 = 'EH3';
  aliases.DVP28SV2 = 'SV2';
  aliases.DVP12SA2 = 'SA2';
  aliases.DVP20SX2 = 'SX2';
  aliases.DVP14SS2 = 'SS2';
  aliases.DVP12SE = 'SE';
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
  language?: PouLanguage;
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
  const lang: PouLanguage = options.language ?? 'LD';
  const cp = options.codepage?.trim() || '1252';
  const isAsOrAh = profile.family === 'AS' || profile.family === 'AH';
  const nl = isAsOrAh ? '\r\n' : '\r\r\n';
  const ispVer = isAsOrAh ? '3.19' : '3.24';
  const maxD = Number(profile.max_d ?? 9999);
  const maxM = Number(profile.max_m ?? 4095);

  let pouBlock: string[];
  if (lang === 'ST') {
    pouBlock = [
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
    ];
  } else if (lang === 'IL') {
    pouBlock = [
      '<POU>',
      `P_Name=${pouName}`,
      'P_Lang=3',
      'P_type=0',
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      '<VAR>',
      '</VAR>',
      '</LOCAL_VAR>',
      '<IL_ST_CODE>',
      'LD X0',
      'OUT Y0',
      'END',
      '</IL_ST_CODE>',
      '</POU>',
    ];
  } else if (lang === 'SFC') {
    const defaultChart: SfcChart = {
      steps: [{ name: 'Step0', initial: true, actions: [{ qualifier: 'N', code: 'Y0 := X0;' }] }],
      transitions: [],
    };
    pouBlock = [
      '<POU>',
      `P_Name=${pouName}`,
      'P_Lang=4',
      'P_type=0',
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      '<VAR>',
      '</VAR>',
      '</LOCAL_VAR>',
      serializeSfcBody(defaultChart, nl),
      '</POU>',
    ];
  } else if (lang === 'FBD') {
    const defaultFbd: FbdDiagram = {
      blocks: [{ id: 'B1', op: 'MOVE', inputs: { IN: 'X0' }, outputs: { OUT: 'Y0' } }],
    };
    pouBlock = [
      '<POU>',
      `P_Name=${pouName}`,
      'P_Lang=5',
      'P_type=0',
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      '<VAR>',
      '</VAR>',
      '</LOCAL_VAR>',
      serializeFbdBody(defaultFbd, nl),
      '</POU>',
    ];
  } else {
    pouBlock = [
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
  }

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
    `<M>0-${maxM}`,
    '[STEP_RANGE]',
    `<S>0-${isAsOrAh ? 2047 : 1023}`,
    '[TIMER_RANGE]',
    `<T>0-${isAsOrAh ? 511 : 255}`,
    '[COUNTER_RANGE]',
    `<C>0-${isAsOrAh ? 511 : 255}`,
    '[DATA_RANGE]',
    `<D>0-${maxD}`,
    '</SYSTEM_VAR>',
    ...pouBlock,
  ];
  const source = lines.join(nl) + nl;
  const ispBytes = isAsOrAh ? buildAsV3010Container(source) : buildEs2V8Container(source);
  const iniBytes = Buffer.from(`[PRJ_DATA]\r\nDEVICE_TYPE=1\r\nMODEL=${projectModel}\r\n`, 'ascii');
  return { ispBytes, iniBytes, canonicalModel: projectModel };
}

export function renderVarEntries(
  entries: LocalVariableEntry[],
  newline: string,
  iecStyle = false,
): string {
  if (iecStyle) {
    const byClass = new Map<string, LocalVariableEntry[]>();
    for (const e of entries) {
      const cls = e.class || 'VAR';
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls)!.push(e);
    }
    if (byClass.size === 0) return `VAR${newline}END_VAR`;
    const chunks: string[] = [];
    for (const [cls, list] of byClass.entries()) {
      chunks.push(cls);
      for (const e of list) {
        const at = e.address ? ` AT %${e.address}` : '';
        const initClean = e.initial_value.replace(/\[@[^\]]+@\]/g, '').trim();
        const initPart = initClean ? ` := ${initClean}` : '';
        const cmtPart = e.comment ? ` (* ${e.comment} *)` : '';
        chunks.push(`  ${e.identifier}${at} : ${e.type}${initPart};${cmtPart}`);
      }
      chunks.push('END_VAR');
    }
    return chunks.join(newline);
  }

  const blocks = entries.map((e) =>
    [
      '{',
      `${e.identifier} : ${e.type} := ${e.initial_value} {${e.class}}`,
      '(*',
      e.comment ?? '',
      '*)',
      '}',
    ].join(newline),
  );
  return ['<VAR>', ...blocks, '</VAR>'].join(newline);
}

export function applyVarMutations(
  rawSectionInner: string,
  options: {
    replaceText?: string;
    upsertVars?: Array<Record<string, unknown>>;
    deleteVars?: string[];
    defaultClass?: string;
  },
  newline: string,
): { nextInner: string; parsed: ReturnType<typeof parseLocalVariables> } {
  if (typeof options.replaceText === 'string' && !options.upsertVars && !options.deleteVars) {
    const nextInner = normalized(options.replaceText).replace(/\n/g, newline);
    return { nextInner, parsed: parseLocalVariables(nextInner) };
  }

  const existing = parseLocalVariables(rawSectionInner);
  const map = new Map<string, LocalVariableEntry>(existing.entries.map((e) => [e.identifier, e]));

  if (Array.isArray(options.deleteVars)) {
    for (const del of options.deleteVars) {
      const target = String(del).trim();
      for (const key of [...map.keys()]) {
        if (key.toUpperCase() === target.toUpperCase()) {
          map.delete(key);
        }
      }
    }
  }

  if (Array.isArray(options.upsertVars)) {
    for (const rawItem of options.upsertVars) {
      const name = String(rawItem.name ?? rawItem.identifier ?? '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new FileTransformError(`Invalid variable identifier: ${name}`);
      }
      const varType = String(rawItem.type ?? 'INT').trim();
      const addr = rawItem.address ? String(rawItem.address).trim().toUpperCase() : null;
      const init = rawItem.initial_value !== undefined && rawItem.initial_value !== null ? String(rawItem.initial_value) : '';
      const cls = String(rawItem.class ?? options.defaultClass ?? 'VAR').trim();
      const cmt = rawItem.comment ? String(rawItem.comment).trim() : null;
      const initialStr = `${init}${addr ? ` [@${addr}@]` : ''}`.trim();
      map.set(name, {
        identifier: name,
        type: varType,
        address: addr,
        class: cls,
        initial_value: initialStr,
        comment: cmt,
      });
    }
  }

  const isIec = existing.status === 'PARSED_IEC' && !/<VAR>/i.test(rawSectionInner);
  const nextInner = renderVarEntries([...map.values()], newline, isIec);
  return { nextInner, parsed: parseLocalVariables(nextInner) };
}

export function editGlobalVarsInSource(
  source: string,
  options: {
    replaceText?: string;
    upsertVars?: Array<Record<string, unknown>>;
    deleteVars?: string[];
  },
  newline: string,
): { updatedSource: string; parsed: ReturnType<typeof parseLocalVariables> } {
  const gSecs = sections(source, 'GLOBAL_VAR');
  const currentInner = gSecs[0]?.inner ?? `<VAR>${newline}</VAR>`;
  const { nextInner, parsed } = applyVarMutations(
    currentInner,
    { ...options, defaultClass: 'VAR_GLOBAL' },
    newline,
  );

  let updatedSource: string;
  if (gSecs.length >= 1) {
    updatedSource = source.slice(0, gSecs[0].innerStart) + nextInner + source.slice(gSecs[0].innerEnd);
  } else {
    const firstPou = sections(source, 'POU')[0];
    const block = `<GLOBAL_VAR>${newline}${nextInner}${newline}</GLOBAL_VAR>${newline}`;
    updatedSource = firstPou ? source.slice(0, firstPou.start) + block + source.slice(firstPou.start) : source + block;
  }
  return { updatedSource, parsed };
}

export function editLocalVarsInSource(
  source: string,
  pouName: string,
  options: {
    replaceText?: string;
    upsertVars?: Array<Record<string, unknown>>;
    deleteVars?: string[];
  },
  newline: string,
): { updatedSource: string; parsed: ReturnType<typeof parseLocalVariables> } {
  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const pouMatch = matches[0];
  const localSecs = sections(pouMatch.inner, 'LOCAL_VAR');
  if (localSecs.length !== 1) {
    throw new FileTransformError(`Expected one LOCAL_VAR section in POU ${JSON.stringify(pouName)}`);
  }
  const { nextInner, parsed } = applyVarMutations(
    localSecs[0].inner,
    { ...options, defaultClass: 'VAR' },
    newline,
  );
  if (/<\/?(?:POU|IL_ST_CODE|LOCAL_VAR)(?:>|\s)/i.test(nextInner)) {
    throw new FileTransformError('Variable text contains structural container delimiters');
  }
  const newPouInner =
    pouMatch.inner.slice(0, localSecs[0].innerStart) + nextInner + pouMatch.inner.slice(localSecs[0].innerEnd);
  const updatedSource = source.slice(0, pouMatch.innerStart) + newPouInner + source.slice(pouMatch.innerEnd);
  return { updatedSource, parsed };
}

export function createPouInSource(
  source: string,
  options: {
    pouName: string;
    language: PouLanguage;
    pouType?: 'PRG' | 'FB' | 'FC';
    returnType?: string;
    enEno?: boolean;
    code?: string;
    sfcChart?: SfcChart;
    fbdDiagram?: FbdDiagram;
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
  const pLang = langNameToCode(language);
  const localVarBody = options.localVariables?.trim()
    ? normalized(options.localVariables).replace(/\n/g, newline)
    : `<VAR>${newline}</VAR>`;
  const headerExtras: string[] = [];
  if (options.returnType) headerExtras.push(`P_Rtn_Type=${options.returnType.trim()}`);
  if (options.enEno !== undefined) headerExtras.push(`P_En_Eno=${options.enEno ? 'TRUE' : 'FALSE'}`);

  let pouInnerLines: string[];
  if (language === 'LD') {
    const ilCode = options.code?.trim() || 'LD X0\nOUT Y0\n';
    const networks = buildNetworksFromIl(ilCode, newline);
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      ...headerExtras,
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      localVarBody,
      '</LOCAL_VAR>',
      ...networks,
      '</POU>',
    ];
  } else if (language === 'SFC') {
    const chart: SfcChart = options.sfcChart ?? {
      steps: [{ name: 'Step0', initial: true, actions: [{ qualifier: 'N', code: 'Y0 := X0;' }] }],
      transitions: [],
    };
    const check = validateSfcChart(chart);
    if (!check.valid) {
      throw new FileTransformError(`Invalid SFC chart: ${check.errors.join('; ')}`);
    }
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      ...headerExtras,
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      localVarBody,
      '</LOCAL_VAR>',
      serializeSfcBody(chart, newline),
      '</POU>',
    ];
  } else if (language === 'FBD') {
    const diagram: FbdDiagram = options.fbdDiagram ?? {
      blocks: [{ id: 'B1', op: 'MOVE', inputs: { IN: 'X0' }, outputs: { OUT: 'Y0' } }],
    };
    const check = validateFbdDiagram(diagram);
    if (!check.valid) {
      throw new FileTransformError(`Invalid FBD diagram: ${check.errors.join('; ')}`);
    }
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      ...headerExtras,
      'P_Active=TRUE',
      '<LOCAL_VAR>',
      localVarBody,
      '</LOCAL_VAR>',
      serializeFbdBody(diagram, newline),
      '</POU>',
    ];
  } else {
    const codeBody = normalized(options.code ?? (language === 'ST' ? '(* ST POU *)\n' : 'LD X0\nOUT Y0\nEND\n')).replace(
      /\n/g,
      newline,
    );
    pouInnerLines = [
      '<POU>',
      `P_Name=${pouName}`,
      `P_Lang=${pLang}`,
      `P_type=${pType}`,
      ...headerExtras,
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
  return parsed.map((raw) => normalized(raw).replace(/\n/g, newline));
}

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

export function readDeviceComments(source: string): Record<string, string> {
  const comments: Record<string, string> = {};
  const match = /(?:<DEVICE_CMT_START>\r*\n|\[DEVICE_CMT_START\]\r*\n)([\s\S]*?)(?:<\/DEVICE_CMT_START>|\[DEVICE_CMT_END\])/i.exec(
    source,
  );
  if (!match) return comments;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes('::')) continue;
    const idx = line.indexOf('::');
    const addr = line.slice(0, idx).trim().toUpperCase();
    const text = line.slice(idx + 2).trim();
    if (addr) comments[addr] = text;
  }
  return comments;
}

export function writeDeviceCommentsInSource(
  source: string,
  updates: Record<string, string>,
  newline: string,
  replaceAll = false,
): { updatedSource: string; comments: Record<string, string> } {
  const re = /(<DEVICE_CMT_START>\r*\n|\[DEVICE_CMT_START\]\r*\n)([\s\S]*?)(<\/DEVICE_CMT_START>|\[DEVICE_CMT_END\])/i;
  const m = re.exec(source);
  const comments = replaceAll ? {} : readDeviceComments(source);
  for (const [k, v] of Object.entries(updates)) {
    const key = k.trim().toUpperCase();
    if (v === null || v === undefined || String(v).trim() === '') {
      delete comments[key];
    } else {
      comments[key] = String(v).trim();
    }
  }
  const body = Object.entries(comments)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([a, txt]) => `${a}::${txt}`)
    .join(newline);
  let updatedSource: string;
  if (m) {
    updatedSource = source.replace(re, `$1${body}${body ? newline : ''}$3`);
  } else {
    const firstPou = sections(source, 'POU')[0];
    const block = `[DEVICE_CMT_START]${newline}${body}${body ? newline : ''}[DEVICE_CMT_END]${newline}`;
    updatedSource = firstPou ? source.slice(0, firstPou.start) + block + source.slice(firstPou.start) : source + block;
  }
  return { updatedSource, comments };
}

export function readSystemVars(source: string): Array<{ area: string; start: number; end: number; capacity: number }> {
  const sysSec = sections(source, 'SYSTEM_VAR')[0];
  const parsedRanges: Array<{ area: string; start: number; end: number; capacity: number }> = [];
  if (sysSec) {
    for (const line of sysSec.inner.split(/\r?\n/)) {
      const m = /^\s*<([A-Z])>(\d+)-(\d+)\s*$/i.exec(line.trim());
      if (m) {
        const start = Number(m[2]);
        const end = Number(m[3]);
        parsedRanges.push({ area: m[1].toUpperCase(), start, end, capacity: end - start + 1 });
      }
    }
  }
  return parsedRanges;
}

export function writeSystemVarsInSource(
  source: string,
  ranges: Record<string, string>,
  newline: string,
): string {
  const sysSec = sections(source, 'SYSTEM_VAR')[0];
  let inner = sysSec?.inner ?? '';
  for (const [areaRaw, spanRaw] of Object.entries(ranges)) {
    const area = areaRaw.toUpperCase();
    const m = /^(\d+)-(\d+)$/.exec(String(spanRaw).trim());
    if (!m || Number(m[1]) > Number(m[2])) {
      throw new FileTransformError(`Invalid range for ${area}: ${spanRaw}`);
    }
    const lineRe = new RegExp(`^\\s*<${area}>\\d+-\\d+\\s*$`, 'im');
    if (lineRe.test(inner)) {
      inner = inner.replace(lineRe, `<${area}>${m[1]}-${m[2]}`);
    } else {
      inner = (inner ? inner.trimEnd() + newline : '') + `<${area}>${m[1]}-${m[2]}` + newline;
    }
  }
  if (sysSec) {
    return source.slice(0, sysSec.innerStart) + inner + source.slice(sysSec.innerEnd);
  }
  const firstPou = sections(source, 'POU')[0];
  const block = `<SYSTEM_VAR>${newline}${inner}</SYSTEM_VAR>${newline}`;
  return firstPou ? source.slice(0, firstPou.start) + block + source.slice(firstPou.start) : source + block;
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

  const renumbered = nets.map((blk, i) =>
    blk.replace(/^NET_ID=\d+/m, `NET_ID=${i + 1}`).replace(/^NetworkID=\d+/m, `NetworkID=${i + 1}`),
  );
  const joined = renumbered
    .map((item) => normalized(item.trim()).replace(/\n/g, newline))
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
  rungs: Array<{ index: number; net_id: string; active: boolean; bookmark: boolean; label: string; ascii: string; il: string[] }>;
} {
  const rawNets = ldNetworks(pouBody);
  const selected = networkIndex ? [rawNets[networkIndex - 1]].filter(Boolean) : rawNets;
  const startIdx = networkIndex ? networkIndex : 1;

  const rungs = selected.map((raw, offset) => {
    const idx = startIdx + offset;
    const parsed = parseLdNetwork(raw);
    const active = (parsed.properties.NET_ACTIVE ?? 'TRUE').toUpperCase() !== 'FALSE';
    const bookmark = (parsed.properties.NET_BOOKMARK ?? 'FALSE').toUpperCase() === 'TRUE';
    const label = parsed.properties.NET_LABEL ?? '';
    const netId = parsed.properties.NET_ID ?? parsed.properties.NetworkID ?? String(idx);

    const wrapped = `<NETWORK_START>\n${raw}\n<NETWORK_END>`;
    let ilStrings: string[] = [];
    try {
      const ilParsed = parseNetworks(wrapped);
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
    return { index: idx, net_id: netId, active, bookmark, label, ascii, il: ilStrings };
  });

  return { rungs };
}

const DEVICE_REF_RE = /(?<![A-Z0-9_])(X|Y|M|S|T|C|D|V|Z|R)\s*(\d+)(?:\.[0-9A-Fa-f]+)?(?![A-Z0-9_])/gi;
const WRITE_LAST_OPS = new Set([
  'OUT', 'SET', 'RST', 'MOV', 'DMOV', 'DADD', 'DSUB', 'DMUL', 'DDIV', 'ADD', 'SUB', 'MUL', 'DIV',
  'INC', 'DEC', 'DINC', 'DDEC', 'ALT', 'PLS', 'PLF', 'ANDW', 'ORW', 'XORW', 'NEG', 'SWAP', 'CMP', 'ZCP',
]);
const WRITE_FIRST_OPS = new Set(['TMR', 'CNT', 'DCNT']);
const WRITE_ALL_OPS = new Set(['ZRST', 'XCH']);

export function extractCrossRefsFromText(source: string) {
  const refs = new Map<string, { reads: number[]; writes: number[] }>();
  const lines = source.split(/\r?\n/);
  let inOutlink = false;
  let pendingOutNode = false;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const upper = line.toUpperCase().trim();
    if (upper.includes('<OUTLINK_START>')) inOutlink = true;
    if (upper.includes('</OUTLINK_END>') || upper.includes('<OUTLINK_END>')) {
      inOutlink = false;
      pendingOutNode = false;
    }
    if (inOutlink && /^TYPE=(13|15|16|12)\b/.test(upper)) {
      pendingOutNode = true;
    }
    if (inOutlink && upper.includes('[END_LD_NODE]')) {
      pendingOutNode = false;
    }

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
        pendingOutNode ||
        (inOutlink && upper.startsWith('DEV_NAME=') && !upper.includes('TYPE=11')) ||
        (isAssign && m.index !== undefined && m.index < isAssign.length) ||
        (WRITE_LAST_OPS.has(op) && idx === matches.length - 1) ||
        (WRITE_FIRST_OPS.has(op) && idx === 0) ||
        WRITE_ALL_OPS.has(op);
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

export function exportProjectBundle(source: string, containerInfo: ReturnType<typeof inspectContainer>, includeAscii = false) {
  const projSec = sections(source, 'PROJECT')[0];
  const properties: Record<string, string> = {};
  if (projSec) {
    for (const line of projSec.inner.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) properties[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  const tasks = readTasks(source);
  const systemVars = readSystemVars(source);
  const deviceComments = readDeviceComments(source);
  const duts = readDuts(source);
  const globalSec = sections(source, 'GLOBAL_VAR')[0];
  const globalVars = globalSec ? parseLocalVariables(globalSec.inner).entries : [];
  const hwConfig = readHwConfigFromSource(source);
  const retainConfig = readRetainConfigFromSource(source);
  const deviceInit = readDeviceInitFromSource(source);
  const dataExchange = readDataExchangeFromSource(source);

  const pous = sections(source, 'POU').map((m) => {
    const name = propertyValue(m.inner, 'P_Name') ?? 'Unknown';
    const langCode = propertyValue(m.inner, 'P_Lang') ?? '1';
    const pTypeCode = propertyValue(m.inner, 'P_type') ?? '0';
    const returnType = propertyValue(m.inner, 'P_Rtn_Type') ?? undefined;
    const active = (propertyValue(m.inner, 'P_Active') ?? 'TRUE').trim().toUpperCase() !== 'FALSE';
    const language = langCodeToName(langCode);
    const pouType = pTypeCode === '1' ? 'FB' : pTypeCode === '2' ? 'FC' : 'PRG';
    const lvSec = sections(m.inner, 'LOCAL_VAR')[0];
    const localVars = lvSec ? parseLocalVariables(lvSec.inner).entries : [];

    if (language === 'LD') {
      const rendered = renderLdAsciiForPou(m.inner);
      return {
        name,
        language,
        pou_type: pouType,
        ...(returnType ? { return_type: returnType } : {}),
        active,
        local_vars: localVars,
        networks: rendered.rungs.map((r) => ({
          index: r.index,
          net_id: r.net_id,
          active: r.active,
          bookmark: r.bookmark,
          label: r.label,
          il: r.il,
          ...(includeAscii ? { ascii: r.ascii } : {}),
        })),
      };
    }
    if (language === 'SFC') {
      const { chart } = parseSfcFromPouBody(m.inner);
      return {
        name,
        language,
        pou_type: pouType,
        active,
        local_vars: localVars,
        sfc: chart,
        ...(includeAscii && chart ? { ascii: renderSfcAscii(chart) } : {}),
      };
    }
    if (language === 'FBD') {
      const { diagram } = parseFbdFromPouBody(m.inner);
      return {
        name,
        language,
        pou_type: pouType,
        ...(returnType ? { return_type: returnType } : {}),
        active,
        local_vars: localVars,
        fbd: diagram,
        ...(includeAscii && diagram ? { ascii: renderFbdAscii(diagram) } : {}),
      };
    }
    const code = sections(m.inner, 'IL_ST_CODE')[0]?.inner ?? '';
    return {
      name,
      language,
      pou_type: pouType,
      ...(returnType ? { return_type: returnType } : {}),
      active,
      local_vars: localVars,
      code,
    };
  });

  return {
    model: containerInfo.project_model,
    layout: containerInfo.layout,
    encoding: containerInfo.encoding,
    properties,
    tasks,
    system_vars: systemVars,
    device_comments: deviceComments,
    global_vars: globalVars,
    duts,
    hw_config: hwConfig,
    retain_config: retainConfig,
    device_init: deviceInit,
    data_exchange: dataExchange,
    pous,
  };
}

export interface ProjectBundleInput {
  model: string;
  properties?: Record<string, string>;
  tasks?: TaskConfig[];
  system_vars?: Record<string, string> | Array<{ area: string; start: number; end: number }>;
  device_comments?: Record<string, string>;
  global_vars?: Array<Record<string, unknown>>;
  duts?: Array<{ name: string; content: string }>;
  hw_config?: HwConfigDocument;
  retain_config?: RetainConfigDocument;
  device_init?: DeviceInitEntry[];
  data_exchange?: DataExchangeRow[];
  pous: Array<{
    name: string;
    language: PouLanguage;
    pou_type?: 'PRG' | 'FB' | 'FC';
    return_type?: string;
    active?: boolean;
    local_vars?: Array<Record<string, unknown>>;
    code?: string;
    sfc?: SfcChart;
    fbd?: FbdDiagram;
    networks?: Array<{ il: string | string[]; active?: boolean; bookmark?: boolean; label?: string }>;
  }>;
}

export function buildProjectFromBundle(bundle: ProjectBundleInput): {
  ispBytes: Buffer;
  iniBytes: Buffer;
  canonicalModel: string;
} {
  if (!bundle.pous || !bundle.pous.length) {
    throw new FileTransformError('Bundle must include at least one POU');
  }
  const firstPou = bundle.pous[0];
  const { ispBytes: baseBytes, iniBytes, canonicalModel } = createBlankProjectBytes({
    model: bundle.model,
    initialPouName: firstPou.name,
    language: firstPou.language,
  });
  const container = decodeContainer(baseBytes);
  const nl = container.newline;
  let source = decodeCodepage(container.source, container.encoding);

  // Apply pou_type / return_type on the first POU (createBlankProjectBytes defaults to P_type=0)
  if (firstPou.pou_type && firstPou.pou_type !== 'PRG') {
    const firstPouSec = sections(source, 'POU')[0];
    if (firstPouSec) {
      const pTypeCode = firstPou.pou_type === 'FB' ? '1' : '2';
      let nextInner = firstPouSec.inner.replace(/^P_type=[^\r\n]*/m, `P_type=${pTypeCode}`);
      if (firstPou.return_type) {
        nextInner = /^P_Rtn_Type=/m.test(nextInner)
          ? nextInner.replace(/^P_Rtn_Type=[^\r\n]*/m, `P_Rtn_Type=${firstPou.return_type.trim()}`)
          : nextInner.replace(/^P_type=[^\r\n]*/m, `P_type=${pTypeCode}${nl}P_Rtn_Type=${firstPou.return_type.trim()}`);
      }
      source = source.slice(0, firstPouSec.innerStart) + nextInner + source.slice(firstPouSec.innerEnd);
    }
  }

  // Properties
  if (bundle.properties) {
    const projSec = sections(source, 'PROJECT')[0];
    if (projSec) {
      let projInner = projSec.inner;
      for (const [k, v] of Object.entries(bundle.properties)) {
        const re = new RegExp(`^${escapeRegex(k)}=[^\\r\\n]*`, 'm');
        projInner = re.test(projInner) ? projInner.replace(re, `${k}=${v}`) : projInner.trimEnd() + nl + `${k}=${v}` + nl;
      }
      source = source.slice(0, projSec.innerStart) + projInner + source.slice(projSec.innerEnd);
    }
  }

  // Create remaining POUs first so tasks can reference them
  for (let i = 1; i < bundle.pous.length; i++) {
    const p = bundle.pous[i];
    source = createPouInSource(
      source,
      {
        pouName: p.name,
        language: p.language,
        pouType: p.pou_type ?? 'PRG',
        returnType: p.return_type,
        code: p.code,
        sfcChart: p.sfc,
        fbdDiagram: p.fbd,
        assignToTask: false,
      },
      nl,
    );
  }

  // Populate every POU's networks/code, local_vars, active flag
  for (const p of bundle.pous) {
    if (p.language === 'LD' && Array.isArray(p.networks) && p.networks.length > 0) {
      const blocks: string[] = [];
      for (let idx = 0; idx < p.networks.length; idx++) {
        const netSpec = p.networks[idx];
        const ilText = Array.isArray(netSpec.il) ? netSpec.il.join('\n') : netSpec.il;
        const built = buildNetworksFromIl(ilText, nl);
        for (let b of built) {
          if (netSpec.active === false) {
            b = b.replace(/^NET_ACTIVE=[^\r\n]*/m, 'NET_ACTIVE=FALSE');
          }
          if (netSpec.bookmark) {
            b = b.replace(/^NET_BOOKMARK=[^\r\n]*/m, 'NET_BOOKMARK=TRUE');
          }
          if (netSpec.label) {
            b = b.replace(/^NET_LABEL=[^\r\n]*/m, `NET_LABEL=${netSpec.label.replace(/[\r\n]/g, ' ')}`);
          }
          blocks.push(b);
        }
      }
      const renumbered = blocks.map((b, i) => b.replace(/^NET_ID=\d+/m, `NET_ID=${i + 1}`));
      source = replaceLdPouNetworks(source, p.name, renumbered, nl);
    } else if (p.language === 'LD' && p.code) {
      const built = buildNetworksFromIl(p.code, nl);
      source = replaceLdPouNetworks(source, p.name, built, nl);
    } else if (p.language === 'SFC' && p.sfc) {
      source = patchSfcPouInSource(source, p.name, p.sfc, nl);
    } else if (p.language === 'FBD' && p.fbd) {
      source = patchFbdPouInSource(source, p.name, p.fbd, nl);
    } else if ((p.language === 'ST' || p.language === 'IL') && typeof p.code === 'string') {
      const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === p.name);
      if (pouMatch) {
        const stSec = sections(pouMatch.inner, 'IL_ST_CODE')[0];
        if (stSec) {
          const repCode = normalized(p.code).replace(/\n/g, nl);
          const newInner = pouMatch.inner.slice(0, stSec.innerStart) + repCode + pouMatch.inner.slice(stSec.innerEnd);
          source = source.slice(0, pouMatch.innerStart) + newInner + source.slice(pouMatch.innerEnd);
        }
      }
    }

    if (p.local_vars && p.local_vars.length > 0) {
      source = editLocalVarsInSource(source, p.name, { upsertVars: p.local_vars }, nl).updatedSource;
    }
    if (p.active === false) {
      const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === p.name);
      if (pouMatch) {
        const newInner = pouMatch.inner.replace(/^P_Active=[^\r\n]*/m, 'P_Active=FALSE');
        source = source.slice(0, pouMatch.innerStart) + newInner + source.slice(pouMatch.innerEnd);
      }
    }
  }

  // Global vars
  if (bundle.global_vars && bundle.global_vars.length > 0) {
    source = editGlobalVarsInSource(source, { upsertVars: bundle.global_vars }, nl).updatedSource;
  }

  // DUTs
  if (bundle.duts) {
    for (const d of bundle.duts) {
      source = upsertDutInSource(source, d.name, d.content, nl);
    }
  }

  // Device comments
  if (bundle.device_comments) {
    source = writeDeviceCommentsInSource(source, bundle.device_comments, nl, true).updatedSource;
  }

  // System vars
  if (bundle.system_vars) {
    const map: Record<string, string> = {};
    if (Array.isArray(bundle.system_vars)) {
      for (const r of bundle.system_vars) {
        map[r.area] = `${r.start}-${r.end}`;
      }
    } else {
      Object.assign(map, bundle.system_vars);
    }
    source = writeSystemVarsInSource(source, map, nl);
  }

  // HWCONFIG / Retain / DeviceInit / DataExchange
  if (bundle.hw_config) {
    source = writeHwConfigToSource(source, bundle.hw_config, nl);
  }
  if (bundle.retain_config) {
    source = writeRetainConfigToSource(source, bundle.retain_config, nl);
  }
  if (bundle.device_init) {
    source = writeDeviceInitToSource(source, bundle.device_init, nl);
  }
  if (bundle.data_exchange) {
    source = writeDataExchangeToSource(source, bundle.data_exchange, nl);
  }

  // Tasks
  if (bundle.tasks && bundle.tasks.length > 0) {
    source = replaceTasksInSource(source, bundle.tasks, nl);
  }

  const ispBytes = container.rebuild(encodeCodepage(source, container.encoding));
  return { ispBytes, iniBytes, canonicalModel };
}

export function searchProjectSource(
  source: string,
  query: string,
  options: { caseSensitive?: boolean; regex?: boolean; scope?: 'all' | 'code' | 'vars' | 'comments' } = {},
) {
  const q = query.trim();
  if (!q) throw new FileTransformError('query must be non-empty');
  const scope = options.scope ?? 'all';
  const flags = options.caseSensitive ? 'g' : 'gi';
  const pattern = options.regex ? new RegExp(q, flags) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const matches: Array<{ scope: string; pou?: string; location: string; text: string }> = [];

  if (scope === 'all' || scope === 'comments') {
    const cmts = readDeviceComments(source);
    for (const [dev, text] of Object.entries(cmts)) {
      if (pattern.test(dev) || pattern.test(text)) {
        pattern.lastIndex = 0;
        matches.push({ scope: 'DEVICE_COMMENT', location: dev, text: `${dev}::${text}` });
      }
    }
  }

  if (scope === 'all' || scope === 'vars') {
    const gSec = sections(source, 'GLOBAL_VAR')[0];
    if (gSec) {
      for (const e of parseLocalVariables(gSec.inner).entries) {
        const line = `${e.identifier} : ${e.type} (${e.address ?? 'unmapped'}) // ${e.comment ?? ''}`;
        if (pattern.test(line)) {
          pattern.lastIndex = 0;
          matches.push({ scope: 'GLOBAL_VAR', location: e.identifier, text: line });
        }
      }
    }
    for (const d of readDuts(source)) {
      if (pattern.test(d.name) || pattern.test(d.content)) {
        pattern.lastIndex = 0;
        matches.push({ scope: 'DUT', location: d.name, text: d.content });
      }
    }
  }

  for (const pou of sections(source, 'POU')) {
    const pouName = propertyValue(pou.inner, 'P_Name') ?? 'Unknown';
    const lang = propertyValue(pou.inner, 'P_Lang') ?? '1';
    if (scope === 'all' && pattern.test(pouName)) {
      pattern.lastIndex = 0;
      matches.push({ scope: 'POU_HEADER', pou: pouName, location: pouName, text: `POU ${pouName}` });
    }
    if (scope === 'all' || scope === 'vars') {
      const lv = sections(pou.inner, 'LOCAL_VAR')[0];
      if (lv) {
        for (const e of parseLocalVariables(lv.inner).entries) {
          const line = `${e.identifier} : ${e.type} (${e.address ?? 'unmapped'}) // ${e.comment ?? ''}`;
          if (pattern.test(line)) {
            pattern.lastIndex = 0;
            matches.push({ scope: 'LOCAL_VAR', pou: pouName, location: e.identifier, text: line });
          }
        }
      }
    }
    if (scope === 'all' || scope === 'code') {
      if (lang === '1') {
        const rendered = renderLdAsciiForPou(pou.inner);
        for (const r of rendered.rungs) {
          const ilText = r.il.join('\n');
          if (pattern.test(ilText) || (r.label && pattern.test(r.label))) {
            pattern.lastIndex = 0;
            matches.push({
              scope: 'LD_NETWORK',
              pou: pouName,
              location: `Network ${r.index}${r.label ? ` (${r.label})` : ''}`,
              text: ilText,
            });
          }
        }
      } else if (lang === '4') {
        const sfcRaw = sections(pou.inner, 'SFC_BODY')[0]?.inner ?? '';
        sfcRaw.split(/\r?\n/).forEach((line, idx) => {
          if (pattern.test(line)) {
            pattern.lastIndex = 0;
            matches.push({ scope: 'SFC_LINE', pou: pouName, location: `Line ${idx + 1}`, text: line.trim() });
          }
        });
      } else if (lang === '5') {
        const fbdRaw = sections(pou.inner, 'FBD_BODY')[0]?.inner ?? '';
        fbdRaw.split(/\r?\n/).forEach((line, idx) => {
          if (pattern.test(line)) {
            pattern.lastIndex = 0;
            matches.push({ scope: 'FBD_LINE', pou: pouName, location: `Line ${idx + 1}`, text: line.trim() });
          }
        });
      } else {
        const stCode = sections(pou.inner, 'IL_ST_CODE')[0]?.inner ?? '';
        stCode.split(/\r?\n/).forEach((line, idx) => {
          if (pattern.test(line)) {
            pattern.lastIndex = 0;
            matches.push({
              scope: lang === '3' ? 'IL_LINE' : 'ST_LINE',
              pou: pouName,
              location: `Line ${idx + 1}`,
              text: line.trim(),
            });
          }
        });
      }
    }
  }

  return {
    success: true,
    query: q,
    match_count: matches.length,
    matches: matches.slice(0, 100),
    truncated: matches.length > 100,
  };
}

export function staticCheckAndCompileProject(container: IspContainer) {
  const info = inspectContainer(container);
  const text = decodeCodepage(container.source, container.encoding);
  const errors: Array<{ scope: string; message: string }> = [];
  const warnings: Array<{ scope: string; message: string }> = [];

  const tasks = readTasks(text);
  const pous = sections(text, 'POU');
  const pouMap = new Map<string, { lang: string; pouType: string; body: string }>();

  for (const m of pous) {
    const name = propertyValue(m.inner, 'P_Name') ?? '';
    const lang = propertyValue(m.inner, 'P_Lang') ?? '';
    const pouType = propertyValue(m.inner, 'P_type') ?? '0';
    if (!name) {
      errors.push({ scope: 'POU', message: 'POU missing P_Name' });
      continue;
    }
    if (pouMap.has(name)) {
      errors.push({ scope: `POU:${name}`, message: `Duplicate POU name ${name}` });
    }
    pouMap.set(name, { lang, pouType, body: m.inner });
  }

  for (const t of tasks) {
    if (!pouMap.has(t.program)) {
      errors.push({ scope: `TASK:${t.name}`, message: `Task references missing POU ${t.program}` });
    }
  }
  if (tasks.length === 0) {
    warnings.push({ scope: 'TASK', message: 'No TASK entries found; POUs will not be cyclically scheduled.' });
  }

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

  const coilWrites = new Map<string, string[]>();
  const setRstWrites = new Map<string, string[]>();
  let totalNetworks = 0;
  let totalInstructions = 0;

  for (const [name, { lang, body }] of pouMap.entries()) {
    const localVars = sections(body, 'LOCAL_VAR');
    if (localVars.length > 0) {
      const parsedVars = parseLocalVariables(localVars[0].inner);
      if (parsedVars.errors.length && localVars[0].inner.trim() && !/^\s*<VAR>\s*<\/VAR>\s*$/i.test(localVars[0].inner)) {
        if (!/^\s*VAR[\s\S]*\bEND_VAR\s*$/i.test(localVars[0].inner.trim())) {
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
      const labels = new Set<string>();
      for (const rawNet of nets) {
        const pn = parseLdNetwork(rawNet);
        const lbl = (pn.properties.NET_LABEL ?? '').trim();
        if (lbl) labels.add(lbl.toUpperCase());
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
          } else if ((node.fields.TYPE === '15' || node.fields.TYPE === '16') && node.fields.DEV_NAME) {
            const dev = node.fields.DEV_NAME.toUpperCase();
            if (!setRstWrites.has(dev)) setRstWrites.set(dev, []);
            setRstWrites.get(dev)!.push(`${name}:Net${netNum}`);
          }
        }
        try {
          const ilNets = parseNetworks(`<NETWORK_START>\n${rawNet}\n<NETWORK_END>`);
          if (ilNets.length === 1) {
            const ins = netToIl(ilNets[0]);
            totalInstructions += ins.length;
            for (const [opCode, ops] of ins) {
              if (opCode === 'CJ' && ops[0] && !labels.has(ops[0].toUpperCase())) {
                errors.push({ scope: `POU:${name}:Net${netNum}`, message: `CJ target label ${ops[0]} not found in POU ${name}` });
              }
              if (opCode === 'CALL' && ops[0] && !labels.has(ops[0].toUpperCase()) && !pouMap.has(ops[0])) {
                errors.push({ scope: `POU:${name}:Net${netNum}`, message: `CALL target ${ops[0]} not found as NET_LABEL or POU` });
              }
              for (const op of ops) {
                const dm = /^(X|Y|M|S|T|C|D)(\d+)(?:\.[0-9A-Fa-f]+)?$/i.exec(op);
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
      const openComments = (code.match(/\(\*/g) ?? []).length;
      const closeComments = (code.match(/\*\)/g) ?? []).length;
      if (openComments !== closeComments) {
        errors.push({ scope: `POU:${name}`, message: `Unclosed ST block comment (* ... *) (${openComments} vs ${closeComments})` });
      }
      const cleanCode = code.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\r\n]*/g, '');
      const lines = cleanCode.split(/\r?\n/).filter((l) => l.trim());
      totalInstructions += lines.length;
      const checkPair = (openRe: RegExp, closeRe: RegExp, label: string) => {
        const o = (cleanCode.match(openRe) ?? []).length;
        const c = (cleanCode.match(closeRe) ?? []).length;
        if (o !== c) errors.push({ scope: `POU:${name}`, message: `Unbalanced ${label} blocks (${o} vs ${c})` });
      };
      checkPair(/\bIF\b/gi, /\bEND_IF\b/gi, 'IF/END_IF');
      checkPair(/\bFOR\b/gi, /\bEND_FOR\b/gi, 'FOR/END_FOR');
      checkPair(/\bWHILE\b/gi, /\bEND_WHILE\b/gi, 'WHILE/END_WHILE');
      checkPair(/\bCASE\b/gi, /\bEND_CASE\b/gi, 'CASE/END_CASE');
      checkPair(/\bREPEAT\b/gi, /\bEND_REPEAT\b/gi, 'REPEAT/END_REPEAT');
    } else if (lang === '3') {
      const code = sections(body, 'IL_ST_CODE')[0]?.inner ?? '';
      try {
        const ins = parseIl(code);
        totalInstructions += ins.length;
        for (const [opCode, ops] of ins) {
          if (opCode === 'OUT' && ops[0]) {
            const dev = ops[0].toUpperCase();
            if (!coilWrites.has(dev)) coilWrites.set(dev, []);
            coilWrites.get(dev)!.push(`${name}:IL`);
          } else if ((opCode === 'SET' || opCode === 'RST') && ops[0]) {
            const dev = ops[0].toUpperCase();
            if (!setRstWrites.has(dev)) setRstWrites.set(dev, []);
            setRstWrites.get(dev)!.push(`${name}:IL`);
          }
        }
      } catch (e) {
        errors.push({ scope: `POU:${name}`, message: e instanceof Error ? e.message : String(e) });
      }
    } else if (lang === '4') {
      const { chart, error } = parseSfcFromPouBody(body);
      if (error || !chart) {
        errors.push({ scope: `POU:${name}`, message: error ?? 'Missing SFC_BODY section' });
      } else {
        totalInstructions += chart.steps.length + chart.transitions.length;
        const res = validateSfcChart(chart);
        for (const err of res.errors) errors.push({ scope: `POU:${name}:SFC`, message: err });
        for (const warn of res.warnings) warnings.push({ scope: `POU:${name}:SFC`, message: warn });
      }
    } else if (lang === '5') {
      const { diagram, error } = parseFbdFromPouBody(body);
      if (error || !diagram) {
        errors.push({ scope: `POU:${name}`, message: error ?? 'Missing FBD_BODY section' });
      } else {
        totalInstructions += diagram.blocks.length;
        const res = validateFbdDiagram(diagram);
        for (const err of res.errors) errors.push({ scope: `POU:${name}:FBD`, message: err });
        for (const warn of res.warnings) warnings.push({ scope: `POU:${name}:FBD`, message: warn });
      }
    }
  }

  // Validate HWCONFIG if present
  if (sections(text, 'HWCONFIG').length > 0) {
    const hw = readHwConfigFromSource(text);
    for (const err of validateHwConfig(hw)) {
      errors.push({ scope: 'HWCONFIG', message: err });
    }
  }

  for (const [dev, locs] of coilWrites.entries()) {
    if (locs.length > 1) {
      warnings.push({
        scope: 'DOUBLE_COIL',
        message: `Double-coil output OUT ${dev} appears in multiple networks: ${locs.join(', ')}`,
      });
    }
    if (setRstWrites.has(dev)) {
      warnings.push({
        scope: 'COIL_CONFLICT',
        message: `Bit ${dev} mixes OUT (${locs.join(', ')}) with SET/RST (${setRstWrites.get(dev)!.join(', ')})`,
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

export function auditProjectDeep(container: IspContainer) {
  const staticCheck = staticCheckAndCompileProject(container);
  const text = decodeCodepage(container.source, container.encoding);
  const tasks = readTasks(text);
  const scheduledPrograms = new Set(tasks.filter((t) => t.active).map((t) => t.program));

  const codeParts: string[] = [];
  const inactivePous: string[] = [];
  const unscheduledPrgs: string[] = [];
  const disabledRungs: Array<{ pou: string; network_index: number }> = [];
  const declaredSymbols: Array<{ scope: string; identifier: string; address: string | null }> = [];

  const gSec = sections(text, 'GLOBAL_VAR')[0];
  if (gSec) {
    for (const e of parseLocalVariables(gSec.inner).entries) {
      declaredSymbols.push({ scope: 'GLOBAL', identifier: e.identifier, address: e.address });
    }
  }

  for (const pou of sections(text, 'POU')) {
    const name = propertyValue(pou.inner, 'P_Name') ?? 'Unknown';
    const lang = propertyValue(pou.inner, 'P_Lang') ?? '1';
    const pType = propertyValue(pou.inner, 'P_type') ?? '0';
    const active = (propertyValue(pou.inner, 'P_Active') ?? 'TRUE').trim().toUpperCase() !== 'FALSE';
    if (!active) inactivePous.push(name);
    if (pType === '0' && !scheduledPrograms.has(name)) unscheduledPrgs.push(name);

    const lv = sections(pou.inner, 'LOCAL_VAR')[0];
    if (lv) {
      for (const e of parseLocalVariables(lv.inner).entries) {
        declaredSymbols.push({ scope: `POU:${name}`, identifier: e.identifier, address: e.address });
      }
    }

    if (lang === '1') {
      ldNetworks(pou.inner).forEach((raw, idx) => {
        const pn = parseLdNetwork(raw);
        if ((pn.properties.NET_ACTIVE ?? 'TRUE').toUpperCase() === 'FALSE') {
          disabledRungs.push({ pou: name, network_index: idx + 1 });
        }
        codeParts.push(raw);
      });
    } else if (lang === '4') {
      codeParts.push(sections(pou.inner, 'SFC_BODY')[0]?.inner ?? '');
    } else if (lang === '5') {
      codeParts.push(sections(pou.inner, 'FBD_BODY')[0]?.inner ?? '');
    } else {
      codeParts.push(sections(pou.inner, 'IL_ST_CODE')[0]?.inner ?? '');
    }
  }

  const combinedCode = codeParts.join('\n');
  const refs = extractCrossRefsFromText(combinedCode);
  const floatingContacts = refs
    .filter((r) => r.read_count > 0 && r.write_count === 0 && !/^(X\d+|M10\d\d)$/.test(r.address))
    .map((r) => r.address);
  const deadWrites = refs
    .filter((r) => r.write_count > 0 && r.read_count === 0 && !/^Y\d+$/.test(r.address))
    .map((r) => r.address);

  const unusedSymbols = declaredSymbols.filter((sym) => {
    const idRe = new RegExp(`(?<![A-Za-z0-9_])${sym.identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    const usedById = idRe.test(combinedCode);
    const usedByAddr = sym.address ? refs.some((r) => r.address === sym.address) : false;
    return !usedById && !usedByAddr;
  });

  return {
    ...staticCheck,
    findings: {
      inactive_pous: inactivePous,
      unscheduled_prgs: unscheduledPrgs,
      disabled_rungs: disabledRungs,
      floating_undriven_devices: floatingContacts,
      dead_unread_outputs: deadWrites,
      unused_symbols: unusedSymbols,
    },
    engineering_health:
      staticCheck.error_count > 0
        ? 'ERRORS_FOUND'
        : staticCheck.warning_count > 0 || unscheduledPrgs.length > 0 || floatingContacts.length > 0
          ? 'WARNINGS_PRESENT'
          : 'CLEAN',
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

export function patchIlPouInSource(source: string, pouName: string, ilCode: string, newline = '\r\n'): string {
  // Validate IL syntax first
  parseIl(ilCode);
  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const match = matches[0];
  if (propertyValue(match.inner, 'P_Lang') !== '3') {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} is not an IL POU (P_Lang=3)`);
  }
  const codeSecs = sections(match.inner, 'IL_ST_CODE');
  const rep = normalized(ilCode).replace(/\n/g, newline);
  let newBody: string;
  if (codeSecs.length === 1) {
    newBody = match.inner.slice(0, codeSecs[0].innerStart) + rep + match.inner.slice(codeSecs[0].innerEnd);
  } else {
    newBody = match.inner.trimEnd() + newline + `<IL_ST_CODE>${newline}${rep}${newline}</IL_ST_CODE>${newline}`;
  }
  return source.slice(0, match.innerStart) + newBody + source.slice(match.innerEnd);
}

export function patchSfcPouInSource(source: string, pouName: string, chart: SfcChart, newline = '\r\n'): string {
  const check = validateSfcChart(chart);
  if (!check.valid) {
    throw new FileTransformError(`Invalid SFC chart: ${check.errors.join('; ')}`);
  }
  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const match = matches[0];
  if (propertyValue(match.inner, 'P_Lang') !== '4') {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} is not an SFC POU (P_Lang=4)`);
  }
  const block = serializeSfcBody(chart, newline);
  const sfcSecs = sections(match.inner, 'SFC_BODY');
  const newBody =
    sfcSecs.length >= 1
      ? match.inner.slice(0, sfcSecs[0].start) + block + match.inner.slice(sfcSecs[0].end)
      : match.inner.trimEnd() + newline + block + newline;
  return source.slice(0, match.innerStart) + newBody + source.slice(match.innerEnd);
}

export function patchFbdPouInSource(source: string, pouName: string, diagram: FbdDiagram, newline = '\r\n'): string {
  const check = validateFbdDiagram(diagram);
  if (!check.valid) {
    throw new FileTransformError(`Invalid FBD diagram: ${check.errors.join('; ')}`);
  }
  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const match = matches[0];
  if (propertyValue(match.inner, 'P_Lang') !== '5') {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} is not an FBD POU (P_Lang=5)`);
  }
  const block = serializeFbdBody(diagram, newline);
  const fbdSecs = sections(match.inner, 'FBD_BODY');
  const newBody =
    fbdSecs.length >= 1
      ? match.inner.slice(0, fbdSecs[0].start) + block + match.inner.slice(fbdSecs[0].end)
      : match.inner.trimEnd() + newline + block + newline;
  return source.slice(0, match.innerStart) + newBody + source.slice(match.innerEnd);
}

export function importMpuIntoProjectSource(
  source: string,
  mpuBytes: Buffer,
  options: { pouName?: string; overwrite?: boolean; assignToTask?: boolean; newline?: string } = {},
): { updatedSource: string; pouName: string; networkCount: number } {
  const nl = options.newline ?? '\r\n';
  const { members } = unpackPackage(mpuBytes);
  if (!members[ENTRY_NAME]) {
    throw new FileTransformError('MPU archive does not contain Unzipped.src');
  }
  const mpuSrc = decodeCodepage(members[ENTRY_NAME], 'cp1252');
  const pouMatch = sections(mpuSrc, 'POU')[0];
  if (!pouMatch) {
    throw new FileTransformError('MPU archive does not contain a <POU> section');
  }
  const originalName = propertyValue(pouMatch.inner, 'P_Name') ?? 'ImportedPou';
  const targetName = (options.pouName ?? originalName).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(targetName)) {
    throw new FileTransformError('Target POU name must be an ASCII IEC identifier');
  }
  const nets = ldNetworkMatches(pouMatch.inner).map((m) => m.full);
  if (!nets.length) {
    throw new FileTransformError('MPU POU contains zero LD networks');
  }
  const existing = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === targetName);
  let updatedSource = source;
  if (existing) {
    if (!options.overwrite) {
      throw new FileTransformError(`POU ${JSON.stringify(targetName)} already exists; set overwrite=true to replace.`);
    }
    updatedSource = replaceLdPouNetworks(updatedSource, targetName, nets, nl);
  } else {
    const ilRes = mpuToIl(mpuBytes);
    updatedSource = createPouInSource(
      updatedSource,
      {
        pouName: targetName,
        language: 'LD',
        pouType: 'PRG',
        code: ilRes.il,
        assignToTask: options.assignToTask ?? false,
      },
      nl,
    );
  }
  return { updatedSource, pouName: targetName, networkCount: nets.length };
}

export function exportLdPouToMpuBytes(source: string, pouName: string): { mpuBytes: Buffer; il: string; networkCount: number } {
  const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (!pouMatch) {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} not found`);
  }
  if (propertyValue(pouMatch.inner, 'P_Lang') !== '1') {
    throw new FileTransformError(`POU ${JSON.stringify(pouName)} is not a Ladder Diagram POU (P_Lang=1)`);
  }
  const rendered = renderLdAsciiForPou(pouMatch.inner);
  const ilLines: string[] = [];
  for (const r of rendered.rungs) {
    if (r.label) ilLines.push(`${r.label}:`);
    ilLines.push(...r.il);
  }
  const il = `${ilLines.join('\n')}\nEND\n`;
  const { data, detail } = ilToMpu(il, pouName, 'cp1252');
  return { mpuBytes: data, il, networkCount: detail.network_count };
}

export function migrateProjectModel(
  source: string,
  targetModel: string,
): {
  ispBytes: Buffer;
  iniBytes: Buffer;
  sourceModel: string;
  targetModel: string;
  sourceFamily: string;
  targetFamily: string;
  migrationNotes: string[];
  warnings: string[];
} {
  const { canonical, error } = resolveModel(targetModel);
  if (error || !canonical) {
    throw new FileTransformError(error ?? 'Unsupported target model');
  }
  const targetProfile = MODEL_PROFILES[canonical];
  const targetProjectModel = String(targetProfile.project_model || canonical);
  const targetFamily = String(targetProfile.family);
  const sourceModel = propertyValue(source, 'Prj_DT') ?? 'ES2';
  const sourceRes = resolveModel(sourceModel);
  const sourceFamily = sourceRes.canonical ? String(MODEL_PROFILES[sourceRes.canonical].family) : 'DVP';

  const isTargetAsOrAh = targetFamily === 'AS' || targetFamily === 'AH';
  const nl = isTargetAsOrAh ? '\r\n' : '\r\r\n';
  const migrationNotes: string[] = [];
  const warnings: string[] = [];

  let updated = normalized(source).replace(/\n/g, nl);
  updated = updated.replace(/^Prj_DT=[^\r\n]*/m, `Prj_DT=${targetProjectModel}`);
  updated = updated.replace(/^Prj_ISPVer=[^\r\n]*/m, `Prj_ISPVer=${isTargetAsOrAh ? '3.19' : '3.24'}`);

  const maxD = Number(targetProfile.max_d ?? 9999);
  const maxM = Number(targetProfile.max_m ?? 4095);
  updated = writeSystemVarsInSource(
    updated,
    {
      M: `0-${maxM}`,
      S: `0-${isTargetAsOrAh ? 2047 : 1023}`,
      T: `0-${isTargetAsOrAh ? 511 : 255}`,
      C: `0-${isTargetAsOrAh ? 511 : 255}`,
      D: `0-${maxD}`,
    },
    nl,
  );
  migrationNotes.push(`Updated Prj_DT from ${sourceModel} to ${targetProjectModel} and resized SYSTEM_VAR ranges (D0-D${maxD}, M0-M${maxM}).`);

  if (sourceFamily === 'DVP' && isTargetAsOrAh) {
    // Report DVP special relays that map to AS SM*/SR* equivalents
    const dvpSpecials: Array<[RegExp, string]> = [
      [/\bM1000\b/g, 'SM400 (Always ON)'],
      [/\bM1001\b/g, 'SM401 (Always OFF)'],
      [/\bM1002\b/g, 'SM402 (First scan pulse)'],
      [/\bM1012\b/g, 'SM410 (100ms clock)'],
      [/\bM1013\b/g, 'SM412 (1s clock)'],
      [/\bD1010\b/g, 'SR410 (Scan time)'],
    ];
    for (const [re, replacement] of dvpSpecials) {
      if (re.test(source)) {
        warnings.push(`Cross-family DVP->${targetFamily}: project uses ${re.source.replace(/\\b/g, '')}; review mapping to ${replacement}.`);
      }
    }
    warnings.push('DVP octal X/Y addresses (e.g. X10/Y20) use slot.bit notation (X0.0/Y0.0) on AS/AH CPUs; verify I/O assignments in HWCONFIG.');
  } else if ((sourceFamily === 'AS' || sourceFamily === 'AH') && targetFamily === 'DVP') {
    if (/\bSM\d+\b|\bSR\d+\b/i.test(source)) {
      warnings.push('Cross-family AS/AH->DVP: SM/SR special devices must be mapped back to DVP M1000+/D1000+ equivalents.');
    }
  }

  const ispBytes = isTargetAsOrAh ? buildAsV3010Container(updated) : buildEs2V8Container(updated);
  const iniBytes = Buffer.from(`[PRJ_DATA]\r\nDEVICE_TYPE=1\r\nMODEL=${targetProjectModel}\r\n`, 'ascii');
  return {
    ispBytes,
    iniBytes,
    sourceModel,
    targetModel: targetProjectModel,
    sourceFamily,
    targetFamily,
    migrationNotes,
    warnings,
  };
}

export { API_NUM, CONTACT_AND, CONTACT_LD, CONTACT_OR, COIL, nv };
