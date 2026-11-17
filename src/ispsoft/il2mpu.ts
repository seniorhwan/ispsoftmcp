export const CRLF = '\r\n';

export const API_NUM: Record<string, number> = {
  MOV: 28,
  DMOV: 29,
  BMOV: 30,
  FMOV: 31,
  ADD: 60,
  DADD: 62,
  SUB: 64,
  DSUB: 66,
  MUL: 68,
  DMUL: 70,
  DIV: 72,
  DDIV: 74,
  INC: 76,
  DEC: 77,
  DINC: 78,
  DDEC: 79,
  ALT: 98,
  ZRST: 130,
  DPLSY: 170,
  TMR: 257,
  CNT: 258,
  DCNT: 259,
  PLS: 260,
  PLF: 261,
  STL: 264,
  RET: 265,
  MC: 266,
  MCR: 267,
  CJ: 268,
  CALL: 269,
  SRET: 270,
  FEND: 271,
  WDT: 272,
};

export const OP_SPLIT: Record<string, [number, number]> = {
  MOV: [1, 1],
  DMOV: [1, 1],
  BMOV: [2, 1],
  FMOV: [2, 1],
  ADD: [2, 1],
  DADD: [2, 1],
  SUB: [2, 1],
  DSUB: [2, 1],
  MUL: [2, 1],
  DMUL: [2, 1],
  DIV: [2, 1],
  DDIV: [2, 1],
  INC: [0, 1],
  DEC: [0, 1],
  DINC: [0, 1],
  DDEC: [0, 1],
  ALT: [0, 1],
  ZRST: [2, 0],
  TMR: [2, 0],
  CNT: [2, 0],
  DCNT: [2, 0],
  PLS: [0, 1],
  PLF: [0, 1],
  DPLSY: [2, 1],
  STL: [1, 0],
  RET: [0, 0],
  MC: [2, 0],
  MCR: [1, 0],
  CJ: [1, 0],
  CALL: [1, 0],
  SRET: [0, 0],
  FEND: [0, 0],
  WDT: [0, 0],
};

export const CONTACT_LD: Record<string, number> = { LD: 1, LDI: 2, LDP: 3, LDF: 4 };
export const CONTACT_AND: Record<string, number> = { AND: 1, ANI: 2, ANDP: 3, ANDF: 4 };
export const CONTACT_OR: Record<string, number> = { OR: 1, ORI: 2, ORP: 3, ORF: 4 };
export const CMP_SYMB: Record<string, string> = {
  'LD=': '=',
  'LD<=': '<=',
  'LD>': '>',
  'LD<': '<',
  'AND=': '=',
  'AND<=': '<=',
  'AND>': '>',
  'AND<': '<',
};
export const COIL: Record<string, number> = { OUT: 13, SET: 15, RST: 16 };
export const T_LNK_OR = 6;
export const T_LNK_OUT = 29;

export const STARTERS = new Set([
  ...Object.keys(CONTACT_LD),
  ...Object.keys(CMP_SYMB).filter((k) => k.startsWith('LD')),
]);
export const SEQ_CMPS = new Set(['AND=', 'AND<=', 'AND>', 'AND<']);

export type Instruction = [string, string[]];

export interface IlNet {
  in: Instruction[];
  out: Instruction[];
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

  const flush = () => {
    if (curIn.length || curOut.length) {
      nets.push({ in: curIn, out: curOut });
    }
    curIn = [];
    curOut = [];
  };

  for (const [mn, ops] of ins) {
    if (mn === 'STL' || mn === 'RET') {
      flush();
      nets.push({ in: [], out: [[mn, ops]] });
      continue;
    }
    if (mn === 'END') {
      continue;
    }
    if (STARTERS.has(mn)) {
      flush();
      curIn = [[mn, ops]];
    } else if (mn in CONTACT_AND || mn in CONTACT_OR || SEQ_CMPS.has(mn)) {
      if (curOut.length) {
        const prev = [...curIn];
        flush();
        curIn = [...prev, [mn, ops]];
      } else {
        curIn.push([mn, ops]);
      }
    } else {
      curOut.push([mn, ops]);
    }
  }
  flush();
  return nets;
}

export function buildNet(nid: number, net: IlNet): string[] {
  const root: string[] = [];
  const out: string[] = [];
  let nOr = 0;
  let nOut = 0;

  for (const [mn, ops] of net.in) {
    if (mn in CONTACT_LD) {
      root.push(...buildNode(CONTACT_LD[mn], ops[0]));
    } else if (mn in CONTACT_AND) {
      root.push(...buildNode(CONTACT_AND[mn], ops[0]));
    } else if (mn in CONTACT_OR) {
      root.push(...buildNode(CONTACT_OR[mn], ops[0]));
      nOr += 1;
    } else if (mn in CMP_SYMB) {
      root.push(...cmpNode(CMP_SYMB[mn], ops));
    } else {
      throw new Error(`Unhandled input instruction: ${mn} ${ops.join(' ')}`);
    }
  }

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

  if (nOr) {
    root.push(...buildNode(T_LNK_OR, null, [nOr + 1, nOr]));
  }
  if (nOut > 1) {
    out.push(...buildNode(T_LNK_OUT, null, [nOut, nOut - 1]));
  }

  return [
    '<NETWORK_START>',
    '<PROPERTIES_START>',
    `NET_ID=${nid}`,
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
