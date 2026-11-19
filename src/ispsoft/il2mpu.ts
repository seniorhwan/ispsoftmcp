export const CRLF = '\r\n';

export const API_NUM: Record<string, number> = {
  // Comparison & data transfer
  CMP: 10, DCMP: 10, CMPP: 10, DCMPP: 10,
  ZCP: 11, DZCP: 11, ZCPP: 11, DZCPP: 11,
  MOV: 28, MOVP: 28,
  DMOV: 29, DMOVP: 29,
  BMOV: 30, BMOVP: 30,
  FMOV: 31, DFMOV: 31, FMOVP: 31,
  ANDW: 34, DANDW: 34, ANDWP: 34,
  ORW: 35, DORW: 35, ORWP: 35,
  XORW: 36, DXORW: 36, XORWP: 36,
  NEG: 38, DNEG: 38, NEGP: 38,
  SWAP: 39, SWAPP: 39,
  XCH: 40, DXCH: 40, XCHP: 40,
  // Arithmetic
  ADD: 60, ADDP: 60,
  DADD: 62, DADDP: 62,
  SUB: 64, SUBP: 64,
  DSUB: 66, DSUBP: 66,
  MUL: 68, MULP: 68,
  DMUL: 70, DMULP: 70,
  DIV: 72, DIVP: 72,
  DDIV: 74, DDIVP: 74,
  INC: 76, INCP: 76,
  DEC: 77, DECP: 77,
  DINC: 78, DINCP: 78,
  DDEC: 79, DDECP: 79,
  SQR: 48, DSQR: 48, SQRP: 48,
  // Bitwise, shift, rotate, decode/encode
  ROR: 30, DROR: 30, RORP: 30,
  ROL: 31, DROL: 31, ROLP: 31,
  SHR: 32, DSHR: 32, SHRP: 32,
  SHL: 33, DSHL: 33, SHLP: 33,
  SFTR: 34, SFTRP: 34,
  SFTL: 35, SFTLP: 35,
  DECO: 41, DECOP: 41,
  ENCO: 42, ENCOP: 42,
  SUM: 43, DSUM: 43, SUMP: 43,
  BON: 44, DBON: 44, BONP: 44,
  // Data processing & scaling
  MEAN: 45, DMEAN: 45, MEANP: 45,
  SORT: 69,
  SCL: 256, SCLP: 256, DSCL: 256,
  // Conversions & floating point
  BCD: 18, DBCD: 18, BCDP: 18,
  BIN: 19, DBIN: 19, BINP: 19,
  FLT: 49, DFLT: 49, FLTP: 49,
  INT: 129, DINT: 129, INTP: 129,
  ECMP: 110, DECMP: 110, ECMPP: 110,
  EZCP: 111, DEZCP: 111, EZCPP: 111,
  EADD: 120, DEADD: 120, EADDP: 120,
  ESUB: 121, DESUB: 121, ESUBP: 121,
  EMUL: 122, DEMUL: 122, EMULP: 122,
  EDIV: 123, DEDIV: 123, EDIVP: 123,
  ESQR: 127, DESQR: 127, ESQRP: 127,
  // Special modules & PID
  FROM: 78, DFROM: 78, FROMP: 78,
  TO: 79, DTO: 79, TOP: 79,
  PID: 88,
  // Communication
  MODRD: 100,
  MODWR: 101,
  MODRW: 150,
  // High-speed & motion
  SPD: 56, DSPD: 56,
  PLSY: 57, DPLSY: 170,
  PWM: 58,
  PLSR: 59, DPLSR: 59,
  ZRN: 156, DZRN: 156,
  DDRVI: 158, DRVI: 158,
  DDRVA: 159, DRVA: 159,
  // RTC clock
  TCMP: 160,
  TZCP: 161,
  TRD: 166, TRDP: 166,
  TWR: 167, TWRP: 167,
  // Convenience & timers/counters/flow
  ALT: 98, ALTP: 98,
  ZRST: 130, ZRSTP: 130,
  TMR: 257,
  CNT: 258,
  DCNT: 259,
  PLS: 260,
  PLF: 261,
  STL: 264,
  RET: 265,
  MC: 266,
  MCR: 267,
  CJ: 268, CJP: 268,
  CALL: 269, CALLP: 269,
  SRET: 270,
  FEND: 271,
  WDT: 272, WDTP: 272,
  FOR: 8,
  NEXT: 9,
  EI: 4,
  DI: 5,
  IRET: 3,
  NOP: 273,
};

export const OP_SPLIT: Record<string, [number, number]> = {
  CMP: [2, 1], DCMP: [2, 1], CMPP: [2, 1], DCMPP: [2, 1],
  ZCP: [3, 1], DZCP: [3, 1], ZCPP: [3, 1], DZCPP: [3, 1],
  MOV: [1, 1], MOVP: [1, 1],
  DMOV: [1, 1], DMOVP: [1, 1],
  BMOV: [2, 1], BMOVP: [2, 1],
  FMOV: [2, 1], DFMOV: [2, 1], FMOVP: [2, 1],
  ANDW: [2, 1], DANDW: [2, 1], ANDWP: [2, 1],
  ORW: [2, 1], DORW: [2, 1], ORWP: [2, 1],
  XORW: [2, 1], DXORW: [2, 1], XORWP: [2, 1],
  NEG: [0, 1], DNEG: [0, 1], NEGP: [0, 1],
  SWAP: [0, 1], SWAPP: [0, 1],
  XCH: [0, 2], DXCH: [0, 2], XCHP: [0, 2],
  ADD: [2, 1], ADDP: [2, 1],
  DADD: [2, 1], DADDP: [2, 1],
  SUB: [2, 1], SUBP: [2, 1],
  DSUB: [2, 1], DSUBP: [2, 1],
  MUL: [2, 1], MULP: [2, 1],
  DMUL: [2, 1], DMULP: [2, 1],
  DIV: [2, 1], DIVP: [2, 1],
  DDIV: [2, 1], DDIVP: [2, 1],
  INC: [0, 1], INCP: [0, 1],
  DEC: [0, 1], DECP: [0, 1],
  DINC: [0, 1], DINCP: [0, 1],
  DDEC: [0, 1], DDECP: [0, 1],
  SQR: [1, 1], DSQR: [1, 1], SQRP: [1, 1],
  ROR: [1, 1], DROR: [1, 1], RORP: [1, 1],
  ROL: [1, 1], DROL: [1, 1], ROLP: [1, 1],
  SHR: [1, 1], DSHR: [1, 1], SHRP: [1, 1],
  SHL: [1, 1], DSHL: [1, 1], SHLP: [1, 1],
  SFTR: [3, 1], SFTRP: [3, 1],
  SFTL: [3, 1], SFTLP: [3, 1],
  DECO: [2, 1], DECOP: [2, 1],
  ENCO: [2, 1], ENCOP: [2, 1],
  SUM: [1, 1], DSUM: [1, 1], SUMP: [1, 1],
  BON: [2, 1], DBON: [2, 1], BONP: [2, 1],
  MEAN: [2, 1], DMEAN: [2, 1], MEANP: [2, 1],
  SORT: [4, 1],
  SCL: [2, 1], SCLP: [2, 1], DSCL: [2, 1],
  BCD: [1, 1], DBCD: [1, 1], BCDP: [1, 1],
  BIN: [1, 1], DBIN: [1, 1], BINP: [1, 1],
  FLT: [1, 1], DFLT: [1, 1], FLTP: [1, 1],
  INT: [1, 1], DINT: [1, 1], INTP: [1, 1],
  ECMP: [2, 1], DECMP: [2, 1], ECMPP: [2, 1],
  EZCP: [3, 1], DEZCP: [3, 1], EZCPP: [3, 1],
  EADD: [2, 1], DEADD: [2, 1], EADDP: [2, 1],
  ESUB: [2, 1], DESUB: [2, 1], ESUBP: [2, 1],
  EMUL: [2, 1], DEMUL: [2, 1], EMULP: [2, 1],
  EDIV: [2, 1], DEDIV: [2, 1], EDIVP: [2, 1],
  ESQR: [1, 1], DESQR: [1, 1], ESQRP: [1, 1],
  FROM: [3, 1], DFROM: [3, 1], FROMP: [3, 1],
  TO: [3, 1], DTO: [3, 1], TOP: [3, 1],
  PID: [3, 1],
  MODRD: [3, 0],
  MODWR: [3, 0],
  MODRW: [4, 1],
  SPD: [2, 1], DSPD: [2, 1],
  PLSY: [2, 1], DPLSY: [2, 1],
  PWM: [2, 1],
  PLSR: [3, 1], DPLSR: [3, 1],
  ZRN: [3, 1], DZRN: [3, 1],
  DDRVI: [2, 2], DRVI: [2, 2],
  DDRVA: [2, 2], DRVA: [2, 2],
  TCMP: [4, 1],
  TZCP: [3, 1],
  TRD: [0, 1], TRDP: [0, 1],
  TWR: [1, 0], TWRP: [1, 0],
  ALT: [0, 1], ALTP: [0, 1],
  ZRST: [2, 0], ZRSTP: [2, 0],
  TMR: [2, 0],
  CNT: [2, 0],
  DCNT: [2, 0],
  PLS: [0, 1],
  PLF: [0, 1],
  STL: [1, 0],
  RET: [0, 0],
  MC: [2, 0],
  MCR: [1, 0],
  CJ: [1, 0], CJP: [1, 0],
  CALL: [1, 0], CALLP: [1, 0],
  SRET: [0, 0],
  FEND: [0, 0],
  WDT: [0, 0], WDTP: [0, 0],
  FOR: [1, 0],
  NEXT: [0, 0],
  EI: [0, 0],
  DI: [0, 0],
  IRET: [0, 0],
  NOP: [0, 0],
};

export const CONTACT_LD: Record<string, number> = { LD: 1, LDI: 2, LDP: 3, LDF: 4 };
export const CONTACT_AND: Record<string, number> = { AND: 1, ANI: 2, ANDP: 3, ANDF: 4 };
export const CONTACT_OR: Record<string, number> = { OR: 1, ORI: 2, ORP: 3, ORF: 4 };
export const STACK_OPS = new Set(['ANB', 'ORB', 'MPS', 'MRD', 'MPP', 'INV']);
export const CMP_SYMB: Record<string, string> = {
  'LD=': '=', 'LD<>': '<>', 'LD<=': '<=', 'LD>=': '>=', 'LD>': '>', 'LD<': '<',
  'AND=': '=', 'AND<>': '<>', 'AND<=': '<=', 'AND>=': '>=', 'AND>': '>', 'AND<': '<',
  'OR=': '=', 'OR<>': '<>', 'OR<=': '<=', 'OR>=': '>=', 'OR>': '>', 'OR<': '<',
  'DLD=': 'D=', 'DLD<>': 'D<>', 'DLD<=': 'D<=', 'DLD>=': 'D>=', 'DLD>': 'D>', 'DLD<': 'D<',
  'DAND=': 'D=', 'DAND<>': 'D<>', 'DAND<=': 'D<=', 'DAND>=': 'D>=', 'DAND>': 'D>', 'DAND<': 'D<',
  'DOR=': 'D=', 'DOR<>': 'D<>', 'DOR<=': 'D<=', 'DOR>=': 'D>=', 'DOR>': 'D>', 'DOR<': 'D<',
};
export const COIL: Record<string, number> = { OUT: 13, SET: 15, RST: 16 };
export const T_LNK_OR = 6;
export const T_LNK_OUT = 29;

export const STARTERS = new Set([
  ...Object.keys(CONTACT_LD),
  ...Object.keys(CMP_SYMB).filter((k) => k.startsWith('LD') || k.startsWith('DLD')),
]);
export const SEQ_CMPS = new Set(
  Object.keys(CMP_SYMB).filter((k) => k.startsWith('AND') || k.startsWith('OR') || k.startsWith('DAND') || k.startsWith('DOR')),
);

export type Instruction = [string, string[]];

export interface IlNet {
  in: Instruction[];
  out: Instruction[];
  hasStackOps?: boolean;
  seq?: Instruction[];
  label?: string;
}

export function nv(v: string): string {
  const s = String(v).trim();
  if ((s.startsWith('K') || s.startsWith('k')) && /^-?\d+$/.test(s.slice(1))) {
    return s.slice(1);
  }
  return s;
}

function buildNode(t: number, varArg?: string | string[] | null, lnk?: [number, number] | null): string[] {
  const lines = ['[LD_NODE]', `TYPE=${t}`];
  if (varArg !== undefined && varArg !== null) {
    if (Array.isArray(varArg)) {
      lines.push('<VAR_NODE_S>', ...varArg.map((v) => `VAR_NAME=${nv(v)}`), '<VAR_NODE_E>');
    } else {
      lines.push(`DEV_NAME=${nv(varArg)}`);
    }
  }
  if (lnk) {
    lines.push(`LNK_C=${lnk[0]}`, `LNK_L=${lnk[1]}`);
  }
  lines.push('[END_LD_NODE]');
  return lines;
}

function apiNode(symb: string, ops: string[]): string[] {
  const [ns, nd] = OP_SPLIT[symb];
  const sOps = ops.slice(0, ns);
  const dOps = ops.slice(ns, ns + nd);
  return [
    ...buildNode(11, sOps.length ? sOps : null),
    '[LD_NODE]',
    'TYPE=9',
    `SYMB=${symb}`,
    'DEV_NAME=',
    `API_NUM=${API_NUM[symb]}`,
    '[END_LD_NODE]',
    ...buildNode(12, dOps.length ? dOps : null),
    ...buildNode(7),
  ];
}

function cmpNode(symb: string, ops: string[]): string[] {
  return [
    ...buildNode(11, [...ops]),
    '[LD_NODE]',
    'TYPE=10',
    `SYMB=${symb}`,
    'DEV_NAME=',
    'API_NUM=-1',
    '[END_LD_NODE]',
    ...buildNode(12),
    ...buildNode(7),
  ];
}

export function splitNets(ins: Instruction[]): IlNet[] {
  const nets: IlNet[] = [];
  let curIn: Instruction[] = [];
  let curOut: Instruction[] = [];
  let curSeq: Instruction[] = [];
  let stackDepth = 0;
  let branchDepth = 0;
  let hasStackOps = false;
  let interleavedBranch = false;
  let pendingLabel: string | undefined;

  const flush = () => {
    if (curIn.length || curOut.length) {
      nets.push({
        in: curIn,
        out: curOut,
        hasStackOps,
        seq: interleavedBranch ? curSeq : undefined,
        ...(pendingLabel ? { label: pendingLabel } : {}),
      });
      pendingLabel = undefined;
    }
    curIn = [];
    curOut = [];
    curSeq = [];
    stackDepth = 0;
    branchDepth = 0;
    hasStackOps = false;
    interleavedBranch = false;
  };

  for (let idx = 0; idx < ins.length; idx++) {
    const [mn, ops] = ins[idx];
    if (mn === 'LABEL') {
      flush();
      pendingLabel = ops[0];
      continue;
    }
    if (
      mn === 'STL' ||
      mn === 'RET' ||
      mn === 'FEND' ||
      mn === 'SRET' ||
      mn === 'IRET' ||
      mn === 'FOR' ||
      mn === 'NEXT' ||
      mn === 'EI' ||
      mn === 'DI' ||
      mn === 'NOP'
    ) {
      flush();
      nets.push({ in: [], out: [[mn, ops]], ...(pendingLabel ? { label: pendingLabel } : {}) });
      pendingLabel = undefined;
      continue;
    }
    if (mn === 'END') {
      continue;
    }
    if (STACK_OPS.has(mn)) {
      hasStackOps = true;
      curSeq.push([mn, ops]);
      if (mn === 'ANB' || mn === 'ORB') {
        stackDepth = Math.max(1, stackDepth - 1);
      } else if (mn === 'MPS') {
        branchDepth += 1;
        interleavedBranch = true;
      } else if (mn === 'MPP') {
        branchDepth = Math.max(0, branchDepth - 1);
      }
      if (curOut.length === 0) {
        curIn.push([mn, ops]);
      }
      continue;
    }
    if (STARTERS.has(mn)) {
      if (curIn.length > 0 && curOut.length === 0) {
        let pendingPushes = 1;
        let isSubBranch = false;
        for (let k = idx + 1; k < ins.length; k++) {
          const [kMn] = ins[k];
          if (kMn === 'ANB' || kMn === 'ORB') {
            pendingPushes -= 1;
            if (pendingPushes === 0) {
              isSubBranch = true;
              break;
            }
          } else if (STARTERS.has(kMn)) {
            pendingPushes += 1;
          } else if (!(kMn in CONTACT_AND || kMn in CONTACT_OR || SEQ_CMPS.has(kMn) || STACK_OPS.has(kMn))) {
            break;
          }
        }
        if (isSubBranch) {
          stackDepth += 1;
          hasStackOps = true;
          curIn.push([mn, ops]);
          curSeq.push([mn, ops]);
          continue;
        }
      }
      flush();
      stackDepth = 1;
      curIn = [[mn, ops]];
      curSeq = [[mn, ops]];
    } else if (mn in CONTACT_AND || mn in CONTACT_OR || SEQ_CMPS.has(mn)) {
      if (branchDepth > 0 || (interleavedBranch && curOut.length > 0)) {
        interleavedBranch = true;
        curSeq.push([mn, ops]);
      } else if (curOut.length) {
        const prev = [...curIn];
        flush();
        curIn = [...prev, [mn, ops]];
        curSeq = [...curIn];
      } else {
        curIn.push([mn, ops]);
        curSeq.push([mn, ops]);
      }
    } else {
      curOut.push([mn, ops]);
      curSeq.push([mn, ops]);
    }
  }
  flush();
  if (pendingLabel) {
    throw new Error(`Label ${pendingLabel} has no following network`);
  }
  return nets;
}

export function buildNet(nid: number, net: IlNet): string[] {
  const root: string[] = [];
  const out: string[] = [];
  let nOut = 0;

  let seriesCols = 0;
  let pendingOr = 0;

  const flushOr = () => {
    if (pendingOr > 0) {
      root.push(...buildNode(T_LNK_OR, null, [Math.max(1, seriesCols), pendingOr]));
      pendingOr = 0;
    }
  };

  let rawIlComment = '';
  const hasOrOr32Cmp = net.in.some(([m]) => /^(OR|DLD|DAND|DOR)(=|<>|<=|>=|>|<)$/.test(m));
  if (net.seq && net.hasStackOps) {
    rawIlComment = `META_IL=FULL:${net.seq.map(([m, o]) => [m, ...o].join(',')).join(';')}`;
  } else if (net.hasStackOps || hasOrOr32Cmp) {
    rawIlComment = `META_IL=${net.in.map(([m, o]) => [m, ...o].join(',')).join(';')}`;
  }

  for (const [mn, ops] of net.in) {
    if (STACK_OPS.has(mn)) {
      continue;
    }
    if (mn in CONTACT_LD) {
      flushOr();
      root.push(...buildNode(CONTACT_LD[mn], ops[0]));
      seriesCols = 1;
    } else if (mn in CONTACT_AND) {
      flushOr();
      root.push(...buildNode(CONTACT_AND[mn], ops[0]));
      seriesCols += 1;
    } else if (mn in CONTACT_OR) {
      root.push(...buildNode(CONTACT_OR[mn], ops[0]));
      pendingOr += 1;
    } else if (mn in CMP_SYMB) {
      flushOr();
      root.push(...cmpNode(CMP_SYMB[mn], ops));
      seriesCols += 1;
    } else {
      throw new Error(`Unhandled input instruction: ${mn} ${ops.join(' ')}`);
    }
  }
  flushOr();

  for (const [mn, ops] of net.out) {
    if (mn in COIL) {
      out.push(...buildNode(COIL[mn], ops[0]));
      nOut += 1;
    } else if (mn in API_NUM) {
      out.push(...apiNode(mn, ops));
      nOut += 1;
    } else {
      throw new Error(`Unhandled output instruction: ${mn} ${ops.join(' ')}`);
    }
  }

  if (nOut > 1) {
    out.push(...buildNode(T_LNK_OUT, null, [nOut, nOut - 1]));
  }

  return [
    '<NETWORK_START>',
    '<PROPERTIES_START>',
    `NET_ID=${nid}`,
    `NET_LABEL=${net.label ?? ''}`,
    'NET_ACTIVE=TRUE',
    'NET_BOOKMARK=FALSE',
    'NET_MODIFY=TRUE',
    'NET_FOLD=FALSE',
    '(',
    rawIlComment,
    '*)',
    '<PROPERTIES_END>',
    '<ROOTLINK_START>',
    ...root,
    '<ROOTLINK_END>',
    '<OUTLINK_START>',
    ...out,
    '<OUTLINK_END>',
    '<NETWORK_END>',
  ];
}

export function buildPou(nets: IlNet[], pouName = 'Prog0'): string {
  const head = [
    '<GroupPOUFolder>',
    '<ProgramFolder>',
    '<FolderContent>',
    'ContentType=0',
    `ContentName=${pouName} [PRG,LD]`,
    `ContentPath=Program/${pouName} [PRG,LD]`,
    '</FolderContent>',
    '</ProgramFolder>',
    '</GroupPOUFolder>',
    '<POU>',
    `P_Name=${pouName}`,
    'P_En_Eno=TRUE',
    'P_Last_Chg=',
    'P_type=0',
    'P_Rtn_Type=',
    'P_Lang=1',
    'P_Step=0',
    'P_Version=1.00',
    'P_DeltaFB=FALSE',
    'P_Security=',
    'P_Active=TRUE',
    'P_Priority=9999',
    'P_DFBName=',
    '(',
    '',
    '*)',
    '<LOCAL_VAR>',
    '</LOCAL_VAR>',
    '<VAR_EXTERN>',
    '</VAR_EXTERN>',
    '<VAR_EXTERN_C>',
    '</VAR_EXTERN_C>',
  ];
  const body: string[] = [];
  for (let i = 0; i < nets.length; i++) {
    body.push(...buildNet(i + 1, nets[i]));
  }
  return [...head, ...body, '</POU>'].join(CRLF) + CRLF;
}
