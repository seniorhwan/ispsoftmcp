import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_MEMBERS = 512;
export const MAX_ITEM_CHARS = 60_000;
export const MAX_RESPONSE_CHARS = 180_000;

export class FileTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileTransformError';
  }
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function computeContentHash(formatPrefix: string, content: string | Buffer): string {
  const raw = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const digest = sha256(raw);
  const prefix = formatPrefix.trim().replace(/:+$/, '');
  if (!prefix) {
    return `sha256:${digest}`;
  }
  if (prefix.endsWith('sha256')) {
    return `${prefix}:${digest}`;
  }
  return `${prefix}:sha256:${digest}`;
}

export function crc32(data: Buffer): number {
  return zlib.crc32(data) >>> 0;
}

export function inflateRawBounded(data: Buffer): { raw: Buffer; consumed: number } {
  try {
    const raw = zlib.inflateRawSync(data, { maxOutputLength: MAX_SOURCE_BYTES + 1 });
    if (raw.length > MAX_SOURCE_BYTES) {
      throw new FileTransformError('Decompressed source exceeds size limit');
    }
    return { raw, consumed: data.length };
  } catch (err) {
    if (err instanceof FileTransformError) {
      throw err;
    }
    throw new FileTransformError('Invalid or truncated raw DEFLATE stream');
  }
}

export function deflateRawBest(data: Buffer): Buffer {
  return zlib.deflateRawSync(data, { level: 9 });
}

export function safeMember(name: string): string {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':')) {
    throw new FileTransformError(`Unsafe member path: ${JSON.stringify(name)}`);
  }
  const parts = name.split('/');
  if (name.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new FileTransformError(`Unsafe member path: ${JSON.stringify(name)}`);
  }
  for (const part of parts) {
    if (part.endsWith(' ') || part.endsWith('.') || [...part].some((c) => c.charCodeAt(0) < 32)) {
      throw new FileTransformError('Unsafe Windows file name');
    }
    const stem = part.split('.')[0].toUpperCase();
    if (
      new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']).has(stem) ||
      (stem.length === 4 && (stem.startsWith('COM') || stem.startsWith('LPT')) && '123456789¹²³'.includes(stem[3]))
    ) {
      throw new FileTransformError('Reserved Windows file name');
    }
  }
  return path.posix.normalize(name);
}

const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

export function decodeCodepage(data: Buffer, encoding: string): string {
  const norm = encoding.toLowerCase().replace(/^cp/, 'windows-');
  try {
    const decoder = new TextDecoder(norm === 'windows-936' ? 'gbk' : norm, { fatal: true });
    return decoder.decode(data);
  } catch {
    if (norm === 'latin-1' || norm === 'latin1' || norm === 'iso-8859-1') {
      return data.toString('latin1');
    }
    if (norm === 'utf-8' || norm === 'utf8') {
      return data.toString('utf-8');
    }
    throw new FileTransformError(`Invalid source encoding: ${encoding}`);
  }
}

export function encodeCodepage(text: string, encoding: string): Buffer {
  const norm = encoding.toLowerCase();
  if (norm === 'utf-8' || norm === 'utf8') {
    return Buffer.from(text, 'utf-8');
  }
  if (norm === 'latin-1' || norm === 'latin1' || norm === 'iso-8859-1') {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0xff) {
        throw new FileTransformError(`Character U+${code.toString(16)} unsupported by ${encoding}`);
      }
      bytes[i] = code;
    }
    return Buffer.from(bytes);
  }
  if (norm === 'cp1252' || norm === 'windows-1252') {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
        bytes[i] = code;
      } else if (CP1252_EXTRA[code] !== undefined) {
        bytes[i] = CP1252_EXTRA[code];
      } else {
        throw new FileTransformError(`Character U+${code.toString(16)} unsupported by ${encoding}`);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(text, 'latin1');
}

export function enforceValueBudget(
  text: string,
  name = 'payload',
  maxChars = MAX_ITEM_CHARS,
  narrowingHint = '',
): Record<string, unknown> | string {
  if (text.length <= maxChars) {
    return text;
  }
  return {
    _omitted: true,
    field: name,
    character_count: text.length,
    budget_limit: maxChars,
    reason: `Value for '${name}' (${text.length} chars) exceeds item budget (${maxChars} chars). Whole value omitted to preserve client token window.`,
    narrowing_guidance: narrowingHint || `Query individual sections or elements of '${name}' using dedicated read tools.`,
  };
}

export function budgetPayload(
  payload: Record<string, unknown>,
  maxItemChars = MAX_ITEM_CHARS,
  maxResponseChars = MAX_RESPONSE_CHARS,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...payload };
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === 'string' && v.length > maxItemChars) {
      result[k] = enforceValueBudget(v, k, maxItemChars);
    }
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > maxResponseChars) {
    let largestField: string | null = null;
    let largestLen = 0;
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'string' && v.length > largestLen) {
        largestField = k;
        largestLen = v.length;
      }
    }
    if (largestField && largestLen > 1000) {
      result[largestField] = enforceValueBudget(
        result[largestField] as string,
        largestField,
        1000,
        'Response size exceeded total response budget limit (180k chars).',
      );
    }
  }
  return result;
}
