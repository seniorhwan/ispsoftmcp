import {
  FileTransformError,
  MAX_SOURCE_BYTES,
  crc32,
  decodeCodepage,
  deflateRawBest,
  encodeCodepage,
  inflateRawBounded,
} from './limits.js';

export type ContainerLayout = 'ispsoft-3.24-v8' | 'as-v3010' | 'legacy';

export class IspContainer {
  constructor(
    public readonly data: Buffer,
    public readonly offset: number,
    public readonly source: Buffer,
    public readonly encoding: string,
    public readonly newline: string,
    public readonly layout: ContainerLayout = 'legacy',
    public readonly trailerOffset: number | null = null,
  ) {}

  rebuild(newSource: Buffer): Buffer {
    if (newSource.length > MAX_SOURCE_BYTES) {
      throw new FileTransformError('Source exceeds size limit');
    }
    decodeCodepage(newSource, this.encoding);
    const payload = deflateRawBest(newSource);
    const header = Buffer.from(this.data.subarray(0, this.offset));
    header.writeUInt32LE(crc32(newSource), this.offset - 4);
    header.writeUInt32LE(newSource.length >>> 0, 0x7c);
    header.writeUInt32LE((payload.length + 6) >>> 0, 0x94);
    let trailer = Buffer.alloc(0);
    if (this.layout === 'ispsoft-3.24-v8') {
      const end = this.offset + payload.length;
      header.writeUInt32LE(end >>> 0, 0x58);
      if (this.trailerOffset === null) {
        throw new FileTransformError('Missing ISPSoft 3.24 trailer boundary');
      }
      trailer = Buffer.from(this.data.subarray(this.trailerOffset));
    } else if (this.offset === 0xac) {
      header.writeUInt32LE((this.offset + payload.length) >>> 0, 0x58);
    }
    const result = Buffer.concat([header, payload, trailer]);
    const check = decodeContainer(result);
    if (!check.source.equals(newSource)) {
      throw new FileTransformError('Container round-trip check failed');
    }
    return result;
  }
}

export function normalizeForEditor(text: string): string {
  return text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
}

export function normalized(text: string): string {
  return normalizeForEditor(text.replace(/\r\r\n/g, '\n'));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SectionMatch {
  full: string;
  inner: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

export function sections(text: string, tag: string): SectionMatch[] {
  const re = new RegExp(`<${escapeRegex(tag)}>\\r*\\n([\\s\\S]*?)</${escapeRegex(tag)}>`, 'g');
  const results: SectionMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const openEnd = match[0].indexOf('\n') + 1;
    const innerStart = match.index + openEnd;
    const innerEnd = innerStart + match[1].length;
    results.push({
      full: match[0],
      inner: match[1],
      start: match.index,
      end: match.index + match[0].length,
      innerStart,
      innerEnd,
    });
  }
  return results;
}

export function propertyValue(body: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegex(key)}=([^\\r\\n]*)`, 'm');
  const match = re.exec(body);
  return match ? match[1] : null;
}

export function ldNetworkMatches(text: string): SectionMatch[] {
  const re = /<NETWORK_START>\r*\n([\s\S]*?)\r*\n<NETWORK_END>/gi;
  const results: SectionMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const innerOffset = match[0].indexOf(match[1]);
    results.push({
      full: match[0],
      inner: match[1],
      start: match.index,
      end: match.index + match[0].length,
      innerStart: match.index + innerOffset,
      innerEnd: match.index + innerOffset + match[1].length,
    });
  }
  return results;
}

export function ldNetworks(text: string): string[] {
  return ldNetworkMatches(text).map((m) => m.inner);
}

export function decodeContainer(data: Buffer): IspContainer {
  if (data.length <= 0xaa) {
    throw new FileTransformError('Truncated ISP container');
  }
  const fileVersion = data.readUInt32LE(0x0c);
  const formatVersion = data.readUInt32LE(0x10);
  const compiledSize = data.readUInt32LE(0x9c);
  let layout: ContainerLayout = 'legacy';
  let trailerOffset: number | null = null;
  let offset = 0;
  let source: Buffer = Buffer.alloc(0);

  if (fileVersion === 1020 && formatVersion === 8) {
    const payloadHeader = data.readUInt32LE(0x98);
    const payloadEnd = data.readUInt32LE(0x58);
    if (
      payloadHeader < 0xa4 ||
      payloadHeader + 6 > payloadEnd ||
      payloadEnd > data.length ||
      payloadEnd - payloadHeader !== data.readUInt32LE(0x94) ||
      data.readUInt16LE(payloadHeader) !== 8
    ) {
      throw new FileTransformError('Unsupported ISPSoft 3.24 pointer/footer layout');
    }
    offset = payloadHeader + 6;
    const inflated = inflateRawBounded(data.subarray(offset, payloadEnd));
    source = inflated.raw;
    if (data.readUInt32LE(offset - 4) !== crc32(source)) {
      throw new FileTransformError('Source CRC mismatch');
    }
    layout = 'ispsoft-3.24-v8';
    trailerOffset = payloadEnd;
  } else if (fileVersion === 1020 && formatVersion === 3010 && compiledSize > 0) {
    const payloadStart = data.readUInt32LE(0x98);
    if (
      payloadStart !== 0xa4 + compiledSize ||
      !(payloadStart > 0xa4 && payloadStart <= data.length - 7) ||
      data.readUInt16LE(payloadStart) !== 8
    ) {
      throw new FileTransformError('Unsupported ISP variant; expected 0xAA/0xAC or explicit AS v3010 source pointer');
    }
    offset = payloadStart + 6;
    const payloadSize = data.readUInt32LE(0x94);
    if (payloadSize !== data.length - (offset - 6)) {
      throw new FileTransformError('Container payload length mismatch');
    }
    const inflated = inflateRawBounded(data.subarray(offset));
    source = inflated.raw;
    if (data.readUInt32LE(offset - 4) !== crc32(source)) {
      throw new FileTransformError('Source CRC mismatch');
    }
    layout = 'as-v3010';
  } else {
    const candidate = [0xaa, 0xac].find((o) => data.length > o && data.readUInt16LE(o - 6) === 8);
    if (candidate === undefined) {
      throw new FileTransformError('Unsupported ISP variant; recognized stream offsets: 0xAA/0xAC');
    }
    offset = candidate;
    const payloadSize = data.readUInt32LE(0x94);
    if (payloadSize != data.length - (offset - 6)) {
      throw new FileTransformError('Container payload length mismatch');
    }
    const inflated = inflateRawBounded(data.subarray(offset));
    source = inflated.raw;
    if (data.readUInt32LE(offset - 4) !== crc32(source)) {
      throw new FileTransformError('Source CRC mismatch');
    }
  }

  const declaredSize = data.readUInt32LE(0x7c);
  if (declaredSize !== 0 && declaredSize !== source.length) {
    throw new FileTransformError('Source length mismatch');
  }
  if (!source.subarray(0, 9).equals(Buffer.from('<PROJECT>', 'ascii'))) {
    throw new FileTransformError('Not an unprotected ISP project source');
  }
  for (const pos of [0x0c, 0x10]) {
    const val = data.readUInt32LE(pos);
    if (val < 1 || val > 100_000) {
      throw new FileTransformError('Header is locked or unsupported; use an explicitly selected clean backup');
    }
  }

  const probe = source.subarray(0, Math.min(4096, source.length)).toString('latin1');
  const codepageMatch = /^Active_CodePage=(\d+)\r*$/m.exec(probe);
  const encoding = `cp${codepageMatch ? codepageMatch[1] : '1252'}`;
  const text = decodeCodepage(source, encoding);

  if (/^Prj_C_SourceCodeLocked=TRUE\r*$/im.test(text)) {
    throw new FileTransformError('Protected source is unsupported');
  }
  if (layout === 'ispsoft-3.24-v8') {
    const model = propertyValue(text, 'Prj_DT');
    const dvpModels = [
      'ES2', 'ES2-E', 'ES3', 'EX2', 'EX3', 'EH3', 'SA2', 'SX2', 'SS2', 'SE', 'SV2',
      'DVP12SE11R', 'DVP12SE11T',
    ];
    if (!model || !dvpModels.includes(model)) {
      throw new FileTransformError(`ISPSoft 3.24 pointer/footer layout is not qualified for project series ${JSON.stringify(model)}`);
    }
  } else if (offset !== 0xaa && offset !== 0xac) {
    const model = propertyValue(text, 'Prj_DT');
    const asAhModels = [
      'AS218PX', 'AS218RX', 'AS218TX',
      'AS228T', 'AS228P', 'AS228R',
      'AS300', 'AS320T', 'AS320P', 'AS332T', 'AS332P',
      'AHCPU500', 'AHCPU510', 'AHCPU520', 'AHCPU530',
    ];
    if (!model || !asAhModels.includes(model)) {
      throw new FileTransformError(`AS/AH v3010 pointer layout is not qualified for project series ${JSON.stringify(model)}`);
    }
  }

  const newline = source.includes('\r\r\n') ? '\r\r\n' : source.includes('\r\n') ? '\r\n' : '\n';
  return new IspContainer(data, offset, source, encoding, newline, layout, trailerOffset);
}

export function inspectContainer(container: IspContainer) {
  const text = decodeCodepage(container.source, container.encoding);
  return {
    stream_offset: container.offset,
    layout: container.layout,
    source_bytes: container.source.length,
    encoding: container.encoding,
    project_model: propertyValue(text, 'Prj_DT'),
    pous: sections(text, 'POU').map((m) => ({
      name: propertyValue(m.inner, 'P_Name'),
      language: propertyValue(m.inner, 'P_Lang'),
      pou_type: propertyValue(m.inner, 'P_type'),
    })),
  };
}

export interface ParsedLdNodeRecord {
  fields: Record<string, string>;
  raw_text: string;
}

export interface ParsedLdNetwork {
  properties: Record<string, string>;
  root_nodes: ParsedLdNodeRecord[];
  outlink_nodes: ParsedLdNodeRecord[];
  root_section_raw: string;
  outlink_section_raw: string;
}

export function parseLdNetwork(networkText: string): ParsedLdNetwork {
  const markerRegion = (start: string, end: string): string => {
    const re = new RegExp(`<${start}>\\r*\\n([\\s\\S]*?)\\r*\\n<${end}>`, 'i');
    const m = re.exec(networkText);
    return m ? m[1] : '';
  };

  const fields = (block: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      const eq = line.indexOf('=');
      if (eq !== -1) {
        result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return result;
  };

  const nodes = (section: string): ParsedLdNodeRecord[] => {
    const result: ParsedLdNodeRecord[] = [];
    const re = /\[LD_NODE\]\r*\n([\s\S]*?)\r*\n\[END_LD_NODE\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) {
      result.push({ fields: fields(m[1]), raw_text: m[1] });
    }
    return result;
  };

  const properties = markerRegion('PROPERTIES_START', 'PROPERTIES_END');
  const roots = markerRegion('ROOTLINK_START', 'ROOTLINK_END');
  const outlinks = markerRegion('OUTLINK_START', 'OUTLINK_END');
  return {
    properties: fields(properties),
    root_nodes: nodes(roots),
    outlink_nodes: nodes(outlinks),
    root_section_raw: roots,
    outlink_section_raw: outlinks,
  };
}

export function validateLdNetwork(networkText: string): string[] {
  const errors: string[] = [];
  if (typeof networkText !== 'string' || !networkText.trim()) {
    return ['replacement network must be non-empty text'];
  }
  const size = Buffer.byteLength(networkText, 'utf-8');
  if (size > 1_000_000) {
    return ['replacement network exceeds 1 MB'];
  }
  if (/<\/?NETWORK_(?:START|END)>/i.test(networkText)) {
    errors.push('replacement must contain a network body only, without NETWORK_START/NETWORK_END wrappers');
  }
  const requiredPairs: [string, string][] = [
    ['PROPERTIES_START', 'PROPERTIES_END'],
    ['ROOTLINK_START', 'ROOTLINK_END'],
    ['OUTLINK_START', 'OUTLINK_END'],
  ];
  const positions: number[] = [];
  for (const [start, end] of requiredPairs) {
    const starts = [...networkText.matchAll(new RegExp(`<${start}>`, 'gi'))];
    const ends = [...networkText.matchAll(new RegExp(`<${end}>`, 'gi'))];
    if (starts.length !== 1 || ends.length !== 1) {
      errors.push(`expected exactly one ${start}/${end} marker pair`);
    } else if ((starts[0].index ?? 0) >= (ends[0].index ?? 0)) {
      errors.push(`${start} must precede ${end}`);
    } else {
      positions.push(starts[0].index ?? 0, ends[0].index ?? 0);
    }
  }
  if (positions.length === 6) {
    const sorted = [...positions].sort((a, b) => a - b);
    if (positions.some((v, idx) => v !== sorted[idx])) {
      errors.push('network sections must be ordered PROPERTIES, ROOTLINK, then OUTLINK');
    }
  }
  const opens = (networkText.match(/\[LD_NODE\]/gi) ?? []).length;
  const closes = (networkText.match(/\[END_LD_NODE\]/gi) ?? []).length;
  if (opens !== closes) {
    errors.push('LD_NODE and END_LD_NODE records are unbalanced');
  }
  const parsed = parseLdNetwork(networkText);
  const parsedNodes = [...parsed.root_nodes, ...parsed.outlink_nodes];
  if (parsedNodes.length !== opens) {
    errors.push('every LD_NODE record must be fully contained in ROOTLINK or OUTLINK');
  }
  parsedNodes.forEach((node, index) => {
    if (!node.fields.TYPE) {
      errors.push(`LD_NODE record ${index + 1} is missing TYPE`);
    }
  });
  return errors;
}

export function replaceLdPouNetworks(
  source: string,
  pouName: string,
  replacementNetworks: string[],
  newline = '\r\n',
): string {
  if (!replacementNetworks.length) {
    throw new FileTransformError('An LD program must contain at least one network.');
  }
  if (replacementNetworks.some((n) => typeof n !== 'string')) {
    throw new FileTransformError('Every replacement LD network must be text.');
  }
  if (
    replacementNetworks.some(
      (n) => !/^<NETWORK_START>\r*\n[\s\S]*?\r*\n<NETWORK_END>$/i.test(n.trim()),
    )
  ) {
    throw new FileTransformError('Each replacement must be one complete network block.');
  }
  const totalBytes = replacementNetworks.reduce((acc, n) => acc + Buffer.byteLength(n, 'utf-8'), 0);
  if (totalBytes > 4_000_000) {
    throw new FileTransformError('Replacement LD program exceeds 4 MB.');
  }

  const matches = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}.`);
  }
  const pouMatch = matches[0];
  const pouBody = pouMatch.inner;
  if (propertyValue(pouBody, 'P_Lang') !== '1') {
    throw new FileTransformError('The named POU is not a Ladder Diagram POU.');
  }
  const oldNetworks = ldNetworkMatches(pouBody);
  for (const item of replacementNetworks) {
    const bodyMatch = /^<NETWORK_START>\r*\n([\s\S]*?)\r*\n<NETWORK_END>$/i.exec(item.trim());
    if (!bodyMatch) {
      throw new FileTransformError('Malformed replacement network block.');
    }
    const errs = validateLdNetwork(bodyMatch[1]);
    if (errs.length) {
      throw new FileTransformError(`Invalid generated LD network: ${errs.join('; ')}`);
    }
  }
  const blocks = replacementNetworks
    .map((item) => normalized(item.trim()).replace(/\n/g, newline))
    .join(newline + newline);

  let updatedPou: string;
  if (oldNetworks.length > 0) {
    updatedPou =
      pouBody.slice(0, oldNetworks[0].start) +
      blocks +
      pouBody.slice(oldNetworks[oldNetworks.length - 1].end);
  } else {
    updatedPou = pouBody.trimEnd() + newline + blocks + newline;
  }

  const updatedSource =
    source.slice(0, pouMatch.innerStart) + updatedPou + source.slice(pouMatch.innerEnd);

  const readback = ldNetworkMatches(updatedPou).map((m) => m.full);
  if (readback.length !== replacementNetworks.length) {
    throw new FileTransformError('LD network replacement readback count does not match.');
  }
  for (let i = 0; i < readback.length; i++) {
    if (normalized(readback[i]) !== normalized(replacementNetworks[i].trim())) {
      throw new FileTransformError('LD network replacement readback differs from the requested program.');
    }
  }
  return updatedSource;
}

export interface LocalVariableEntry {
  identifier: string;
  type: string;
  address: string | null;
  class: string;
  initial_value: string;
  comment: string | null;
}

export function parseLocalVariables(sectionText: string): {
  status: string;
  entries: LocalVariableEntry[];
  errors: string[];
  raw: string;
} {
  if (typeof sectionText !== 'string') {
    return { status: 'UNPARSED', entries: [], errors: ['section is not text'], raw: '' };
  }
  const wrappers = sections(sectionText, 'VAR');
  if (wrappers.length !== 1) {
    // Fallback: parse standard IEC 61131-3 VAR ... END_VAR blocks (e.g., AS-series projects)
    const iecEntries: LocalVariableEntry[] = [];
    const iecErrors: string[] = [];
    const iecBlockRe = /^\s*(VAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL)?)\b([\s\S]*?)\bEND_VAR\s*$/gim;
    let varMatch: RegExpExecArray | null;
    while ((varMatch = iecBlockRe.exec(sectionText)) !== null) {
      const varClass = varMatch[1].toUpperCase();
      for (const rawLine of varMatch[2].split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('(*') || line.startsWith('//')) continue;
        const decl = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:AT\s+%?[A-Za-z0-9_.]+)?\s*:\s*([^:;]+?)(?:\s*:=\s*([^;]+?))?\s*;\s*(?:\(\*(.*?)\*\))?$/i.exec(line);
        if (!decl) {
          iecErrors.push(`unrecognized IEC VAR declaration: ${line}`);
          continue;
        }
        const atMatch = /\bAT\s+%?([A-Za-z][A-Za-z0-9]*\d+)\b/i.exec(line);
        iecEntries.push({
          identifier: decl[1],
          type: decl[2].trim(),
          address: atMatch ? atMatch[1].toUpperCase() : null,
          class: varClass,
          initial_value: (decl[3] ?? '').trim(),
          comment: decl[4] ? decl[4].trim() : null,
        });
      }
    }
    if (iecEntries.length > 0 || iecErrors.length > 0) {
      return {
        status: iecErrors.length === 0 ? 'PARSED_IEC' : iecEntries.length ? 'PARTIAL' : 'UNPARSED',
        entries: iecEntries,
        errors: iecErrors,
        raw: sectionText,
      };
    }
    return {
      status: 'UNPARSED',
      entries: [],
      errors: [`expected one VAR wrapper; found ${wrappers.length}`],
      raw: sectionText,
    };
  }
  const body = wrappers[0].inner;
  const blocks: string[] = [];
  let current: string[] | null = null;
  const errors: string[] = [];
  const lines = body.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1;
    const line = lines[idx];
    const token = line.trim();
    if (token === '{') {
      if (current !== null) {
        errors.push(`nested record opening at line ${lineNumber}`);
      } else {
        current = [];
      }
    } else if (token === '}') {
      if (current === null) {
        errors.push(`unmatched record closing at line ${lineNumber}`);
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
    } else if (current !== null) {
      current.push(line);
    } else if (token) {
      errors.push(`text outside a symbol record at line ${lineNumber}`);
    }
  }
  if (current !== null) {
    errors.push('unterminated symbol record');
  }

  const entries: LocalVariableEntry[] = [];
  const declarationRe =
    /^\s*(?<identifier>[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?<type>.+?)\s*:=\s*(?<initial>.*?)\s+\{(?<class>[A-Za-z_][A-Za-z0-9_]*)\}\s*$/;

  blocks.forEach((block, idx) => {
    const nonEmpty = block.split(/\r?\n/).filter((l) => l.trim());
    const decl = nonEmpty.length ? declarationRe.exec(nonEmpty[0]) : null;
    if (!decl || !decl.groups) {
      errors.push(`symbol record ${idx + 1} has an unrecognized declaration`);
      return;
    }
    const initial = decl.groups.initial.trim();
    const addrMatch = /\[@([A-Za-z][A-Za-z0-9]*\d+)@\]/.exec(initial);
    const commentMatch = /\(\*([\s\S]*?)\*\)/.exec(block);
    entries.push({
      identifier: decl.groups.identifier,
      type: decl.groups.type.trim(),
      address: addrMatch ? addrMatch[1].toUpperCase() : null,
      class: decl.groups.class,
      initial_value: initial,
      comment: commentMatch ? commentMatch[1].trim() : null,
    });
  });

  if (!blocks.length && !errors.length) {
    errors.push('VAR wrapper contains no recognized symbol records');
  }
  const status = !errors.length ? 'PARSED_LIMITED' : entries.length ? 'PARTIAL' : 'UNPARSED';
  return { status, entries, errors, raw: sectionText };
}

export function patchSt(
  container: IspContainer,
  pouName: string,
  code: string | null,
  variables: string | null,
): Buffer {
  if (code === null && variables === null) {
    throw new FileTransformError('Provide code and/or variables');
  }
  const text = decodeCodepage(container.source, container.encoding);
  const matches = sections(text, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
  if (matches.length !== 1) {
    throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${matches.length}`);
  }
  const match = matches[0];
  let body = match.inner;
  const pairs: Array<[string, string | null]> = [
    ['IL_ST_CODE', code],
    ['LOCAL_VAR', variables],
  ];
  for (const [tag, content] of pairs) {
    if (content === null) {
      continue;
    }
    const inner = sections(body, tag);
    if (inner.length !== 1) {
      throw new FileTransformError(`Expected exactly one ${tag}; this POU layout is unsupported`);
    }
    if (/<\/?(?:POU|IL_ST_CODE|LOCAL_VAR)(?:>|\s)/i.test(content)) {
      throw new FileTransformError('Replacement contains structural container delimiters');
    }
    const replacement = normalized(content).replace(/\n/g, container.newline);
    body = body.slice(0, inner[0].innerStart) + replacement + body.slice(inner[0].innerEnd);
  }
  const result = text.slice(0, match.innerStart) + body + text.slice(match.innerEnd);
  return container.rebuild(encodeCodepage(result, container.encoding));
}

export function buildEs2V8Container(source: string, trailer: Buffer = Buffer.from('ISPSOFT-MCP-TRAILER')): Buffer {
  const raw = encodeCodepage(source, 'cp1252');
  const compressed = deflateRawBest(raw);
  const pointer = 0xa4;
  const end = pointer + 6 + compressed.length;
  const header = Buffer.alloc(pointer, 0);
  header.writeUInt32LE(1020, 0x0c);
  header.writeUInt32LE(8, 0x10);
  header.writeUInt32LE(end >>> 0, 0x58);
  header.writeUInt32LE(raw.length >>> 0, 0x7c);
  header.writeUInt32LE((end - pointer) >>> 0, 0x94);
  header.writeUInt32LE(pointer >>> 0, 0x98);
  const frame = Buffer.alloc(6);
  frame.writeUInt16LE(8, 0);
  frame.writeUInt32LE(crc32(raw), 2);
  return Buffer.concat([header, frame, compressed, trailer]);
}

export function buildAsV3010Container(source: string, prefix: Buffer = Buffer.from('COMPILED_PREFIX')): Buffer {
  const raw = encodeCodepage(source, 'cp1252');
  const compressed = deflateRawBest(raw);
  const header = Buffer.alloc(0xa4, 0);
  header.writeUInt32LE(1020, 0x0c);
  header.writeUInt32LE(3010, 0x10);
  header.writeUInt32LE(raw.length >>> 0, 0x7c);
  header.writeUInt32LE((compressed.length + 6) >>> 0, 0x94);
  header.writeUInt32LE((header.length + prefix.length) >>> 0, 0x98);
  header.writeUInt32LE(prefix.length >>> 0, 0x9c);
  const frame = Buffer.alloc(6);
  frame.writeUInt16LE(8, 0);
  frame.writeUInt32LE(crc32(raw), 2);
  return Buffer.concat([header, prefix, frame, compressed]);
}
