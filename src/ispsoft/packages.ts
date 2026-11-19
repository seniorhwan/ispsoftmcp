import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  FileTransformError,
  MAX_MEMBERS,
  MAX_SOURCE_BYTES,
  crc32,
  safeMember,
} from './limits.js';
import { ZIP_PASSWORD, ZipCrypto } from './mpuCodec.js';

export function unpackPackage(data: Buffer): { prefix: Buffer; members: Record<string, Buffer> } {
  const start = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (start !== 0x98 && start !== 0xa4 && start !== 0xa6) {
    throw new FileTransformError('Unsupported library prefix length');
  }
  if (data.length < start + 22 || data.readUInt32LE(0x94) !== data.length - start) {
    throw new FileTransformError('Library ZIP length mismatch');
  }

  const archiveBuf = data.subarray(start);
  const members: Record<string, Buffer> = {};
  const seen = new Set<string>();
  let total = 0;

  let eocdOffset = -1;
  for (let i = archiveBuf.length - 22; i >= Math.max(0, archiveBuf.length - 65557); i--) {
    if (
      archiveBuf[i] === 0x50 &&
      archiveBuf[i + 1] === 0x4b &&
      archiveBuf[i + 2] === 0x05 &&
      archiveBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new FileTransformError('Invalid or unsupported package archive');
  }

  const entryCount = archiveBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = archiveBuf.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || entryCount > MAX_MEMBERS || cdOffset >= eocdOffset) {
    throw new FileTransformError('Invalid package member count');
  }

  let cursor = cdOffset;
  for (let idx = 0; idx < entryCount; idx++) {
    if (cursor + 46 > eocdOffset || archiveBuf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }
    const flags = archiveBuf.readUInt16LE(cursor + 8);
    const method = archiveBuf.readUInt16LE(cursor + 10);
    const crc = archiveBuf.readUInt32LE(cursor + 16);
    const csize = archiveBuf.readUInt32LE(cursor + 20);
    const usize = archiveBuf.readUInt32LE(cursor + 24);
    const fnLen = archiveBuf.readUInt16LE(cursor + 28);
    const exLen = archiveBuf.readUInt16LE(cursor + 30);
    const cmtLen = archiveBuf.readUInt16LE(cursor + 32);
    const extAttr = archiveBuf.readUInt32LE(cursor + 38);
    const lfhOffset = archiveBuf.readUInt32LE(cursor + 42);
    if (cursor + 46 + fnLen + exLen + cmtLen > eocdOffset) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }
    const rawFilename = archiveBuf.subarray(cursor + 46, cursor + 46 + fnLen).toString('utf-8');
    cursor += 46 + fnLen + exLen + cmtLen;

    if (rawFilename.endsWith('/')) {
      throw new FileTransformError('Duplicate/ambiguous member or directory entry');
    }
    const name = safeMember(rawFilename);
    if (seen.has(name.toLowerCase())) {
      throw new FileTransformError('Duplicate/ambiguous member or directory entry');
    }
    seen.add(name.toLowerCase());

    if (((extAttr >>> 16) & 0o170000) === 0o120000) {
      throw new FileTransformError('Symbolic links are not package contents');
    }
    if (method !== 0 && method !== 8) {
      throw new FileTransformError('Unsupported package compression');
    }
    total += usize;
    if (total > MAX_SOURCE_BYTES) {
      throw new FileTransformError('Package expansion exceeds size limit');
    }

    if (lfhOffset + 30 > cdOffset || archiveBuf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }
    const lfhFnLen = archiveBuf.readUInt16LE(lfhOffset + 26);
    const lfhExLen = archiveBuf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnLen + lfhExLen;
    if (dataStart > cdOffset || dataStart + csize > cdOffset) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }
    const payload = archiveBuf.subarray(dataStart, dataStart + csize);
    if (payload.length !== csize) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }

    let compressedStream = payload;
    if (flags & 0x1) {
      const decrypted = new ZipCrypto(ZIP_PASSWORD).decrypt(payload);
      if (decrypted.length < 12) {
        throw new FileTransformError('Invalid or unsupported package archive');
      }
      compressedStream = decrypted.subarray(12);
    }

    let raw: Buffer;
    try {
      raw = method === 8
        ? zlib.inflateRawSync(compressedStream, { maxOutputLength: MAX_SOURCE_BYTES + 1 })
        : Buffer.from(compressedStream);
    } catch {
      throw new FileTransformError('Invalid or unsupported package archive');
    }

    if (raw.length !== usize) {
      throw new FileTransformError('Package member size mismatch');
    }
    if (crc32(raw) !== crc) {
      throw new FileTransformError('Invalid or unsupported package archive');
    }
    members[name] = raw;
  }

  return { prefix: data.subarray(0, start), members };
}

export function packPackage(prefix: Buffer, members: Record<string, Buffer>): Buffer {
  const entries = Object.entries(members);
  if (
    (prefix.length !== 0x98 && prefix.length !== 0xa4 && prefix.length !== 0xa6) ||
    entries.length < 1 ||
    entries.length > MAX_MEMBERS
  ) {
    throw new FileTransformError('Unsupported package prefix/member count');
  }
  const totalUncompressed = entries.reduce((acc, [, buf]) => acc + buf.length, 0);
  if (totalUncompressed > MAX_SOURCE_BYTES) {
    throw new FileTransformError('Package exceeds expanded size limit');
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const seen = new Set<string>();
  let localOffset = 0;

  for (const [rawName, data] of entries) {
    const name = safeMember(rawName);
    if (seen.has(name.toLowerCase())) {
      throw new FileTransformError('Duplicate package name');
    }
    seen.add(name.toLowerCase());
    if (!/^[\x00-\x7f]*$/.test(name)) {
      throw new FileTransformError('Package member names must be ASCII for this profile');
    }
    const filename = Buffer.from(name, 'ascii');
    const dataCrc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const header = Buffer.concat([crypto.randomBytes(11), Buffer.from([(dataCrc >>> 24) & 0xff])]);
    const encrypted = new ZipCrypto(ZIP_PASSWORD).encrypt(Buffer.concat([header, compressed]));
    const size = encrypted.length;

    const lfh = Buffer.alloc(30 + filename.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(3, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(33, 12);
    lfh.writeUInt32LE(dataCrc, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(filename.length, 26);
    filename.copy(lfh, 30);

    const cd = Buffer.alloc(46 + filename.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(3, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(33, 14);
    cd.writeUInt32LE(dataCrc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(filename.length, 28);
    cd.writeUInt32LE(0x20, 38);
    cd.writeUInt32LE(localOffset, 42);
    filename.copy(cd, 46);

    localParts.push(lfh, encrypted);
    centralParts.push(cd);
    localOffset += lfh.length + encrypted.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  const archive = Buffer.concat([...localParts, centralBuf, eocd]);
  const header = Buffer.from(prefix);
  header.writeUInt32LE(archive.length >>> 0, 0x94);
  const result = Buffer.concat([header, archive]);

  const check = unpackPackage(result);
  for (const [k, v] of entries) {
    if (!check.members[k] || !check.members[k].equals(v)) {
      throw new FileTransformError('Package round-trip verification failed');
    }
  }
  return result;
}
