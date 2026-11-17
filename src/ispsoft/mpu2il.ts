import type { Instruction } from './il2mpu.js';

const TYPE_CONTACT: Record<number, string> = { 1: 'open', 2: 'nc', 3: 'pulse', 4: 'fall' };
const LD_MN: Record<string, string> = { open: 'LD', nc: 'LDI', pulse: 'LDP', fall: 'LDF' };
const AND_MN: Record<string, string> = { open: 'AND', nc: 'ANI', pulse: 'ANDP', fall: 'ANDF' };
const OR_MN: Record<string, string> = { open: 'OR', nc: 'ORI', pulse: 'ORP', fall: 'ORF' };
const COIL_MN: Record<number, string> = { 13: 'OUT', 15: 'SET', 16: 'RST' };

export interface ParsedLdNode {
  type: number;
  dev: string | null;
  symb: string | null;
  api: string | null;
  vars: string[];
  lnk: [number, number] | null;
}

export interface ParsedNetwork {
  id: number;
  root: ParsedLdNode[];
  out: ParsedLdNode[];
}

export function parseNodes(seg: string): ParsedLdNode[] {
  const nodes: ParsedLdNode[] = [];
  const re = /\[LD_NODE\](.*?)\r*\n\[END_LD_NODE\]/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(seg)) !== null) {
    const blk = match[1];
    const t = /TYPE=(\d+)/.exec(blk);
    const devMatch = /DEV_NAME=([^\r\n]*)/.exec(blk);
    const symbMatch = /SYMB=([^\r\n]*)/.exec(blk);
    const apiMatch = /API_NUM=(-?\d+)/.exec(blk);
    const vars: string[] = [];
    const varRe = /VAR_NAME=([^\r\n]*)/g;
    let vm: RegExpExecArray | null;
    while ((vm = varRe.exec(blk)) !== null) {
      vars.push(vm[1]);
    }
    const lnkMatch = /LNK_C=(\d+)\r*\nLNK_L=(\d+)/.exec(blk);
    nodes.push({
      type: t ? parseInt(t[1], 10) : -1,
      dev: devMatch ? devMatch[1] : null,
      symb: symbMatch ? symbMatch[1] : null,
      api: apiMatch ? apiMatch[1] : null,
      vars,
      lnk: lnkMatch ? [parseInt(lnkMatch[1], 10), parseInt(lnkMatch[2], 10)] : null,
    });
  }
  return nodes;
}

export function parseNetworks(text: string): ParsedNetwork[] {
  const nets: ParsedNetwork[] = [];
  const re = /<NETWORK_START>(.*?)<NETWORK_END>/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const blk = match[1];
    const nid = /NET_ID=(\d+)/.exec(blk);
    const root = /<ROOTLINK_START>(.*?)<ROOTLINK_END>/s.exec(blk);
    const out = /<OUTLINK_START>(.*?)<OUTLINK_END>/s.exec(blk);
    nets.push({
      id: nid ? parseInt(nid[1], 10) : -1,
      root: parseNodes(root ? root[1] : ''),
      out: parseNodes(out ? out[1] : ''),
    });
  }
  return nets;
}

function asK(v: string): string {
  return /^-?\d+$/.test(v || '') ? `K${v}` : v;
}

export function netToIl(net: ParsedNetwork): Instruction[] {
  const { root, out } = net;
  const lines: Instruction[] = [];

  let orN = 0;
  let body = root;
  if (root.length > 0 && root[root.length - 1].type === 6 && root[root.length - 1].lnk) {
    orN = root[root.length - 1].lnk![1];
    body = root.slice(0, -1);
  }
  const orIdx = new Set<number>();
  if (orN > 0) {
    for (let k = Math.max(0, body.length - orN); k < body.length; k++) {
      orIdx.add(k);
    }
  }

  let first = true;
  let i = 0;
  while (i < body.length) {
    const nd = body[i];
    if (nd.type in TYPE_CONTACT) {
      const kind = TYPE_CONTACT[nd.type];
      const mn = orIdx.has(i) ? OR_MN[kind] : first ? LD_MN[kind] : AND_MN[kind];
      lines.push([mn, [nd.dev ?? '']]);
      first = false;
    } else if (nd.type === 11) {
      const nxt = i + 1 < body.length ? body[i + 1] : null;
      const ops = nd.vars.map(asK);
      if (nxt && nxt.type === 9) {
        let j = i + 2;
        while (j < body.length && body[j].type !== 12) {
          j++;
        }
        if (j < body.length) {
          ops.push(...body[j].vars.map(asK));
        }
        lines.push([nxt.symb ?? '', ops]);
        i = j;
      } else if (nxt && nxt.type === 10) {
        const mn = (first ? 'LD' : 'AND') + (nxt.symb ?? '');
        let j = i + 2;
        while (j < body.length && body[j].type !== 12) {
          j++;
        }
        if (j < body.length) {
          ops.push(...body[j].vars.map(asK));
        }
        lines.push([mn, ops]);
        first = false;
        i = j;
      }
    }
    i++;
  }

  i = 0;
  while (i < out.length) {
    const nd = out[i];
    if (nd.type in COIL_MN) {
      lines.push([COIL_MN[nd.type], [nd.dev ?? '']]);
    } else if (nd.type === 11) {
      const nxt = i + 1 < out.length ? out[i + 1] : null;
      const ops = nd.vars.map(asK);
      if (nxt && nxt.type === 9) {
        let j = i + 2;
        while (j < out.length && out[j].type !== 12) {
          j++;
        }
        if (j < out.length) {
          ops.push(...out[j].vars.map(asK));
        }
        lines.push([nxt.symb ?? '', ops]);
        i = j;
      }
    }
    i++;
  }
  return lines;
}
