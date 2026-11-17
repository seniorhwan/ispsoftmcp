import path from 'node:path';
import { buildAsV3010Container, buildEs2V8Container, decodeContainer } from './containers.js';
import { ilToMpu } from './dvp.js';
import { FileTransformError, MAX_FILE_BYTES, computeContentHash, sha256 } from './limits.js';

export const DEFAULT_WORK_DIR = '/workspace';

const files = new Map<string, Buffer>();

export function normalizeVirtualPath(inputPath: string): string {
  const raw = (inputPath || '').trim();
  if (!raw) {
    throw new FileTransformError('Path must be non-empty');
  }
  const posix = raw.replace(/\\/g, '/');
  const resolved = posix.startsWith('/') ? path.posix.normalize(posix) : path.posix.normalize(`${DEFAULT_WORK_DIR}/${posix}`);
  if (resolved.includes('..')) {
    throw new FileTransformError('Invalid path traversal');
  }
  return resolved;
}

export function hasFile(filePath: string): boolean {
  return files.has(normalizeVirtualPath(filePath));
}

export function readFileBuffer(filePath: string): Buffer {
  const key = normalizeVirtualPath(filePath);
  const data = files.get(key);
  if (!data) {
    throw new FileTransformError(`File not found in workspace: ${key}`);
  }
  if (data.length > MAX_FILE_BYTES) {
    throw new FileTransformError('File exceeds size limit');
  }
  return Buffer.from(data);
}

export function writeFileBuffer(filePath: string, data: Buffer, allowOverwrite = false): string {
  if (data.length > MAX_FILE_BYTES) {
    throw new FileTransformError('Output exceeds size limit');
  }
  const key = normalizeVirtualPath(filePath);
  if (!allowOverwrite && files.has(key)) {
    throw new FileTransformError(`Output must be a new path; overwrites are not supported (${key})`);
  }
  files.set(key, Buffer.from(data));
  return key;
}

export function listAllFiles(prefix = ''): string[] {
  const normPrefix = prefix.trim() ? normalizeVirtualPath(prefix) : '';
  return [...files.keys()]
    .filter((k) => !normPrefix || k === normPrefix || k.startsWith(`${normPrefix}/`))
    .sort((a, b) => a.localeCompare(b));
}

export function artifactPath(stem: string, suffix: string): string {
  const cleanStem = stem.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${DEFAULT_WORK_DIR}/${cleanStem}-${stamp}${suffix}`;
  let idx = 1;
  while (files.has(candidate)) {
    candidate = `${DEFAULT_WORK_DIR}/${cleanStem}-${stamp}-${idx}${suffix}`;
    idx++;
  }
  return candidate;
}

export function writeProjectCandidateAndBackup(
  sourcePath: string,
  targetPath: string,
  originalBytes: Buffer,
  candidateBytes: Buffer,
): {
  target: string;
  backup: string;
  candidateCompanion: string | null;
} {
  const srcKey = normalizeVirtualPath(sourcePath);
  const tgtKey = normalizeVirtualPath(targetPath);
  if (srcKey === tgtKey) {
    throw new FileTransformError('Original input cannot be overwritten');
  }
  if (files.has(tgtKey)) {
    throw new FileTransformError(`Candidate target already exists: ${tgtKey}`);
  }
  const parsedTarget = path.posix.parse(tgtKey);
  const backupKey = path.posix.join(parsedTarget.dir, `${parsedTarget.name}.before${parsedTarget.ext}`);
  if (files.has(backupKey)) {
    throw new FileTransformError(`Backup target already exists: ${backupKey}`);
  }

  const companionSrc = srcKey.replace(/\.[^.]+$/, '.ini');
  const companionBytes = files.get(companionSrc);
  let candidateCompanion: string | null = null;
  if (companionBytes) {
    const compTarget = path.posix.join(parsedTarget.dir, `${parsedTarget.name}.ini`);
    const compBackup = path.posix.join(parsedTarget.dir, `${parsedTarget.name}.before.ini`);
    if (files.has(compTarget) || files.has(compBackup)) {
      throw new FileTransformError('Companion target or backup already exists');
    }
    files.set(compBackup, Buffer.from(companionBytes));
    files.set(compTarget, Buffer.from(companionBytes));
    candidateCompanion = compTarget;
  }

  files.set(backupKey, Buffer.from(originalBytes));
  files.set(tgtKey, Buffer.from(candidateBytes));

  return { target: tgtKey, backup: backupKey, candidateCompanion };
}

export function getFileMeta(filePath: string) {
  const buf = readFileBuffer(filePath);
  return {
    path: normalizeVirtualPath(filePath),
    bytes: buf.length,
    sha256: sha256(buf),
    content_hash: computeContentHash('file', buf),
  };
}

export function seedDefaultWorkspace(): void {
  if (files.size > 0) {
    return;
  }

  const sampleEs2LdIl = [
    'LD X0',
    'ANI X1',
    'OR M0',
    'OUT Y0',
    'LD Y0',
    'TMR T0 K50',
    'LD T0',
    'INC D10',
    'SET M10',
    'LD X2',
    'RST M10',
    'MOV K100 D20',
  ].join('\n');

  const { data: sampleMpu } = ilToMpu(sampleEs2LdIl, 'Prog0', 'cp1252');
  files.set('/workspace/sample_prog0.mpu', sampleMpu);

  // Extract generated LD networks from the sample MPU for the ES2 LD+ST sample project
  const sampleEs2Source = [
    '<PROJECT>',
    'Active_CodePage=1252',
    'Prj_ISPVer=3.24',
    'Prj_DT=ES2',
    'Prj_C_SourceCodeLocked=FALSE',
    '</PROJECT>',
    '<TASK>',
    'T_ID=0',
    'T_Name=CyclicTask',
    'T_Type=0',
    'T_Interval=10',
    'T_Priority=1',
    'T_Active=TRUE',
    'T_PName=Prog0',
    '</TASK>',
    '<TASK>',
    'T_ID=1',
    'T_Name=LogicTask',
    'T_Type=0',
    'T_Interval=20',
    'T_Priority=2',
    'T_Active=TRUE',
    'T_PName=CalcST',
    '</TASK>',
    '<GLOBAL_VAR>',
    '<VAR>',
    '{',
    'gCycleCounter : WORD :=  [@D10@] {VAR_GLOBAL}',
    '(*',
    'Global cycle counter incremented by timer T0',
    '*)',
    '}',
    '{',
    'gSetpoint : INT := 100 [@D20@] {VAR_GLOBAL}',
    '(*',
    'Process setpoint register',
    '*)',
    '}',
    '</VAR>',
    '</GLOBAL_VAR>',
    '[DEVICE_CMT_START]',
    'D10::Cycle counter',
    'D20::Target setpoint',
    'M0::Start latch',
    'M10::Timer done latch',
    'T0::5s dwell timer',
    'X0::Start pushbutton',
    'X1::Stop pushbutton NC',
    'X2::Reset pushbutton',
    'Y0::Main motor contactor',
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
    '<POU>',
    'P_Name=Prog0',
    'P_Lang=1',
    'P_type=0',
    'P_Active=TRUE',
    '<LOCAL_VAR>',
    '<VAR>',
    '{',
    'StartBtn : BOOL :=  [@X0@] {VAR}',
    '(*',
    'Panel start input',
    '*)',
    '}',
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
    '[LD_NODE]',
    'TYPE=2',
    'DEV_NAME=X1',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=1',
    'DEV_NAME=M0',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=6',
    'LNK_C=2',
    'LNK_L=1',
    '[END_LD_NODE]',
    '<ROOTLINK_END>',
    '<OUTLINK_START>',
    '[LD_NODE]',
    'TYPE=13',
    'DEV_NAME=Y0',
    '[END_LD_NODE]',
    '<OUTLINK_END>',
    '<NETWORK_END>',
    '<NETWORK_START>',
    '<PROPERTIES_START>',
    'NET_ID=2',
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
    'DEV_NAME=Y0',
    '[END_LD_NODE]',
    '<ROOTLINK_END>',
    '<OUTLINK_START>',
    '[LD_NODE]',
    '<VAR_NODE_S>',
    'VAR_NAME=T0',
    'VAR_NAME=50',
    '<VAR_NODE_E>',
    'TYPE=11',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=9',
    'SYMB=TMR',
    'DEV_NAME=',
    'API_NUM=257',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=12',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=7',
    '[END_LD_NODE]',
    '<OUTLINK_END>',
    '<NETWORK_END>',
    '<NETWORK_START>',
    '<PROPERTIES_START>',
    'NET_ID=3',
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
    'DEV_NAME=T0',
    '[END_LD_NODE]',
    '<ROOTLINK_END>',
    '<OUTLINK_START>',
    '[LD_NODE]',
    'TYPE=11',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=9',
    'SYMB=INC',
    'DEV_NAME=',
    'API_NUM=76',
    '[END_LD_NODE]',
    '[LD_NODE]',
    '<VAR_NODE_S>',
    'VAR_NAME=D10',
    '<VAR_NODE_E>',
    'TYPE=12',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=7',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=15',
    'DEV_NAME=M10',
    '[END_LD_NODE]',
    '[LD_NODE]',
    'TYPE=29',
    'LNK_C=2',
    'LNK_L=1',
    '[END_LD_NODE]',
    '<OUTLINK_END>',
    '<NETWORK_END>',
    '</POU>',
    '<POU>',
    'P_Name=CalcST',
    'P_Lang=2',
    'P_type=0',
    'P_Active=TRUE',
    '<LOCAL_VAR>',
    '<VAR>',
    '{',
    'ScaledOut : INT := 0 [@D100@] {VAR}',
    '(*',
    'Scaled output value',
    '*)',
    '}',
    '</VAR>',
    '</LOCAL_VAR>',
    '<IL_ST_CODE>',
    'IF M10 THEN',
    '    D100 := D10 * 2;',
    'ELSE',
    '    D100 := 0;',
    'END_IF;',
    '</IL_ST_CODE>',
    '</POU>',
  ].join('\r\r\n') + '\r\r\n';

  const es2Bytes = buildEs2V8Container(sampleEs2Source);
  decodeContainer(es2Bytes); // self-verify
  files.set('/workspace/sample_es2.isp', es2Bytes);
  files.set('/workspace/sample_es2.ini', Buffer.from('[PRJ_DATA]\r\nDEVICE_TYPE=1\r\nCOMM_DRIVER=ES2_SIM\r\nSTATION_ADDR=1\r\n', 'ascii'));

  const sampleAsSource = [
    '<PROJECT>',
    'Active_CodePage=1252',
    'Prj_ISPVer=3.19',
    'Prj_DT=AS228T',
    'Prj_C_SourceCodeLocked=FALSE',
    '</PROJECT>',
    '<TASK>',
    'T_ID=0',
    'T_Name=MainTask',
    'T_Type=0',
    'T_Interval=10',
    'T_Priority=1',
    'T_Active=TRUE',
    'T_PName=MainProgram',
    '</TASK>',
    '<POU>',
    'P_Name=MainProgram',
    'P_Lang=2',
    'P_type=0',
    'P_Active=TRUE',
    '<LOCAL_VAR>',
    'VAR',
    'Value : INT := 0;',
    'END_VAR',
    '</LOCAL_VAR>',
    '<IL_ST_CODE>',
    'Value := Value + 1;',
    '</IL_ST_CODE>',
    '</POU>',
  ].join('\r\n') + '\r\n';

  const asBytes = buildAsV3010Container(sampleAsSource);
  decodeContainer(asBytes); // self-verify
  files.set('/workspace/sample_as228t.isp', asBytes);
}
