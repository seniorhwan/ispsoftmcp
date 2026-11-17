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
  label?: string | null;
  root: ParsedLdNode[];
  out: ParsedLdNode[];
  metaIl?: string | null;
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
    const lbl = /^NET_LABEL=([^\r\n]*)/m.exec(blk);
    const root = /<ROOTLINK_START>(.*?)<ROOTLINK_END>/s.exec(blk);
    const out = /<OUTLINK_START>(.*?)<OUTLINK_END>/s.exec(blk);
    const meta = /^META_IL=([^\r\n]*)/m.exec(blk);
    nets.push({
      id: nid ? parseInt(nid[1], 10) : -1,
      label: lbl ? lbl[1].trim() || null : null,
      root: parseNodes(root ? root[1] : ''),
      out: parseNodes(out ? out[1] : ''),
      metaIl: meta ? meta[1].trim() : null,
    });
  }
  return nets;
}

function asK(v: string): string {
  return /^-?\d+$/.test(v || '') ? `K${v}` : v;
}

export function netToIl(net: ParsedNetwork): Instruction[] {
  const { root, out, metaIl } = net;
  const lines: Instruction[] = [];

  if (metaIl) {
    const isFull = metaIl.startsWith('FULL:');
    const rawMeta = isFull ? metaIl.slice(5) : metaIl;
    for (const part of rawMeta.split(';')) {
      const pieces = part.split(',').filter(Boolean);
      if (pieces.length) {
        lines.push([pieces[0], pieces.slice(1)]);
      }
    }
    if (isFull) {
      return lines;
    }
  } else {
    // Support both inline and trailing TYPE=6 OR-link markers
    const orIndices = new Set<number>();
    const skipIndices = new Set<number>();
    const contactPositions: number[] = [];

    for (let idx = 0; idx < root.length; idx++) {
      const nd = root[idx];
      if (nd.type in TYPE_CONTACT) {
        contactPositions.push(idx);
      } else if (nd.type === 6 && nd.lnk) {
        skipIndices.add(idx);
        const orCount = nd.lnk[1];
        for (let k = 0; k < orCount && k < contactPositions.length; k++) {
          orIndices.add(contactPositions[contactPositions.length - 1 - k]);
        }
      }
    }

    let first = true;
    let i = 0;
    while (i < root.length) {
      if (skipIndices.has(i)) {
        i++;
        continue;
      }
      const nd = root[i];
      if (nd.type in TYPE_CONTACT) {
        const kind = TYPE_CONTACT[nd.type];
        const mn = orIndices.has(i) ? OR_MN[kind] : first ? LD_MN[kind] : AND_MN[kind];
        lines.push([mn, [nd.dev ?? '']]);
        first = false;
      } else if (nd.type === 11) {
        const nxt = i + 1 < root.length ? root[i + 1] : null;
        const ops = nd.vars.map(asK);
        if (nxt && nxt.type === 9) {
          let j = i + 2;
          while (j < root.length && root[j].type !== 12) {
            j++;
          }
          if (j < root.length) {
            ops.push(...root[j].vars.map(asK));
          }
          lines.push([nxt.symb ?? '', ops]);
          i = j;
        } else if (nxt && nxt.type === 10) {
          const mn = (first ? 'LD' : 'AND') + (nxt.symb ?? '');
          let j = i + 2;
          while (j < root.length && root[j].type !== 12) {
            j++;
          }
          if (j < root.length) {
            ops.push(...root[j].vars.map(asK));
          }
          lines.push([mn, ops]);
          first = false;
          i = j;
        }
      }
      i++;
    }
  }

  let i = 0;
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
