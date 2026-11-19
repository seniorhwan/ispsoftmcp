import * as il2mpu from './il2mpu.js';
import * as mpu2il from './mpu2il.js';
import * as mpuCodec from './mpuCodec.js';
import * as packages from './packages.js';
import { FileTransformError, decodeCodepage, encodeCodepage } from './limits.js';

export function parseIl(text: string): il2mpu.Instruction[] {
  const instructions: il2mpu.Instruction[] = [];
  const contacts = new Set([
    ...Object.keys(il2mpu.CONTACT_LD),
    ...Object.keys(il2mpu.CONTACT_AND),
    ...Object.keys(il2mpu.CONTACT_OR),
  ]);
  const arity: Record<string, number> = {};
  for (const op of [...contacts, ...Object.keys(il2mpu.COIL)]) {
    arity[op] = 1;
  }
  for (const op of Object.keys(il2mpu.CMP_SYMB)) {
    arity[op] = 2;
  }
  for (const [op, split] of Object.entries(il2mpu.OP_SPLIT)) {
    arity[op] = split[0] + split[1];
  }
  for (const op of il2mpu.STACK_OPS) {
    arity[op] = 0;
  }
  arity.END = 0;

  let ended = false;
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const number = idx + 1;
    const line = lines[idx].trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
      continue;
    }
    const labelMatch = /^(?:([A-Za-z_][A-Za-z0-9_]*):|(P\d+))$/i.exec(line);
    if (labelMatch) {
      if (ended) {
        throw new FileTransformError('Instructions after END would be discarded');
      }
      const lbl = labelMatch[1] ?? labelMatch[2];
      instructions.push(['LABEL', [lbl]]);
      continue;
    }
    const pieces = line.split(/[,\s]+/).filter(Boolean);
    const op = pieces[0].toUpperCase();
    const operands = pieces.slice(1);
    if (!(op in arity) || operands.length !== arity[op] || operands.some((p) => !p)) {
      throw new FileTransformError(`Unsupported opcode or operand count on IL line ${number}: ${op}`);
    }
    if (ended) {
      throw new FileTransformError('Instructions after END would be discarded');
    }
    if (operands.some((p) => !/^(?:[A-Za-z_][A-Za-z_0-9.]*|-?\d+(?:\.\d+)?|[Kk]-?\d+|[Hh][0-9A-Fa-f]+|[Ff]-?\d+(?:\.\d+)?)$/.test(p))) {
      throw new FileTransformError(`Unsupported operand syntax on IL line ${number}`);
    }
    ended = op === 'END';
    instructions.push([op, operands]);
  }

  if (instructions.length === 0 || instructions.every(([op]) => op === 'END' || op === 'LABEL')) {
    throw new FileTransformError('No executable IL instructions');
  }

  let nets: il2mpu.IlNet[];
  try {
    nets = il2mpu.splitNets(instructions);
  } catch (e) {
    throw new FileTransformError(e instanceof Error ? e.message : String(e));
  }
  for (const net of nets) {
    if (net.out.length === 0) {
      throw new FileTransformError('Network without an output is unsupported');
    }
  }
  return instructions;
}

export function ilToMpu(
  text: string,
  pouName: string,
  encoding = 'cp1252',
): {
  data: Buffer;
  detail: { network_count: number; pou_name: string; encoding: string; warnings: string[] };
} {
  if (!/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(pouName)) {
    throw new FileTransformError('POU name must be an ASCII IEC identifier (maximum 64 characters)');
  }
  const instructions = parseIl(text);
  const nets = il2mpu.splitNets(instructions);
  const source = encodeCodepage(il2mpu.buildPou(nets, pouName), encoding);
  const prefix = mpuCodec.prefillPrefix(0);
  const data = packages.packPackage(prefix, { [mpuCodec.ENTRY_NAME]: source });
  return {
    data,
    detail: {
      network_count: nets.length,
      pou_name: pouName,
      encoding,
      warnings: [
        'POU package only; CPU configuration, task assignment and vendor compilation are required.',
        'END is omitted because ISPSoft adds it; output branches may become separate networks.',
      ],
    },
  };
}

function canonicalNetwork(network: mpu2il.ParsedNetwork): string {
  const mapNodes = (nodes: mpu2il.ParsedLdNode[]) =>
    nodes.map((n) => [n.type, n.dev, n.symb, n.api, n.vars, n.lnk]);
  return JSON.stringify([mapNodes(network.root), mapNodes(network.out), network.metaIl ?? null, network.label ?? null]);
}

export function mpuToIl(
  data: Buffer,
  encoding = 'cp1252',
): {
  il: string;
  detail: { network_count: number; encoding: string; warnings: string[] };
} {
  const { members } = packages.unpackPackage(data);
  const keys = Object.keys(members);
  if (keys.length !== 1 || keys[0] !== mpuCodec.ENTRY_NAME) {
    throw new FileTransformError('Expected a single Unzipped.src member');
  }
  const source = decodeCodepage(members[mpuCodec.ENTRY_NAME], encoding);
  const pouOpens = source.match(/<POU>/g)?.length ?? 0;
  const pouCloses = source.match(/<\/POU>/g)?.length ?? 0;
  if (pouOpens !== 1 || pouCloses !== 1) {
    throw new FileTransformError('Expected exactly one POU in the package');
  }
  if (/^P_Security=([^\r\n]+)/m.test(source)) {
    throw new FileTransformError('Protected POU is unsupported');
  }
  if (/^NET_ACTIVE=(?!TRUE\r*(?:\n|$))/m.test(source)) {
    throw new FileTransformError('Inactive or unknown network state cannot be represented in flat IL');
  }
  const nets = mpu2il.parseNetworks(source);
  const netStarts = source.match(/<NETWORK_START>/g)?.length ?? 0;
  const netEnds = source.match(/<NETWORK_END>/g)?.length ?? 0;
  if (nets.length === 0 || netStarts !== nets.length || netEnds !== nets.length) {
    throw new FileTransformError('Missing or malformed Ladder networks');
  }
  const ldNodeCount = source.match(/\[LD_NODE\]/g)?.length ?? 0;
  const parsedNodeCount = nets.reduce((acc, n) => acc + n.root.length + n.out.length, 0);
  if (ldNodeCount !== parsedNodeCount) {
    throw new FileTransformError('Malformed or unparsed Ladder nodes');
  }

  const lines: string[] = [];
  for (const net of nets) {
    const values = mpu2il.netToIl(net);
    const prefix = net.label ? `${net.label}:\n` : '';
    const text = prefix + values.map(([op, ops]) => [op, ...ops].join(',')).join('\n');
    const parsed = parseIl(text);
    const rebuilt = mpu2il.parseNetworks(il2mpu.buildPou(il2mpu.splitNets(parsed)));
    if (rebuilt.length !== 1 || canonicalNetwork(rebuilt[0]) !== canonicalNetwork(net)) {
      throw new FileTransformError('Network contains unsupported layout; conversion would lose nodes');
    }
    if (net.label) {
      lines.push(`${net.label}:`);
    }
    for (const [op, ops] of values) {
      lines.push([op, ...ops].join(','));
    }
  }
  return {
    il: `${lines.join('\n')}\n`,
    detail: {
      network_count: nets.length,
      encoding,
      warnings: ['Flattened instruction listing; comments, variables and project metadata are not represented in IL.'],
    },
  };
}
