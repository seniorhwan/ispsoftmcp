import { crc32 } from './limits.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ZIP_PASSWORD = Buffer.from('eL$@.i$-$TuP!D~', 'latin1');
export const ENTRY_NAME = 'Unzipped.src';
export const PREFIX_LEN = 152;
export const PREFIX_MAGIC_A = 1020;
export const PREFIX_MAGIC_B = 8;
export const PREFIX_LEN_OFFSET = 0x94;

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crcByte(crc: number, byte: number): number {
  return ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]) >>> 0;
}

export class ZipCrypto {
  private k = new Uint32Array([0x12345678, 0x23456789, 0x34567890]);

  constructor(password: Buffer | string) {
    const pw = typeof password === 'string' ? Buffer.from(password, 'latin1') : password;
    for (let i = 0; i < pw.length; i++) {
      this.update(pw[i]);
    }
  }

  private update(byte: number): void {
    this.k[0] = crcByte(this.k[0], byte);
    this.k[1] = (this.k[1] + (this.k[0] & 0xff)) >>> 0;
    this.k[1] = (Math.imul(this.k[1], 134775813) + 1) >>> 0;
    this.k[2] = crcByte(this.k[2], (this.k[1] >>> 24) & 0xff);
  }

  private streamByte(): number {
    const t = (this.k[2] | 2) & 0xffff;
    return ((t * (t ^ 1)) >>> 8) & 0xff;
  }

  encrypt(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      out[i] = p ^ this.streamByte();
      this.update(p);
    }
    return out;
  }

  decrypt(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
      const p = data[i] ^ this.streamByte();
      out[i] = p;
      this.update(p);
    }
    return out;
  }
}

export function prefillPrefix(zipLen: number): Buffer {
  const p = Buffer.alloc(PREFIX_LEN, 0);
  p.writeUInt32LE(PREFIX_MAGIC_A, 0x0c);
  p.writeUInt32LE(PREFIX_MAGIC_B, 0x10);
  p.writeUInt32LE(zipLen >>> 0, PREFIX_LEN_OFFSET);
  return p;
}

export function buildSingleZip(data: Buffer, name = ENTRY_NAME): Buffer {
  const dataCrc = crc32(data);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const head = Buffer.concat([crypto.randomBytes(11), Buffer.from([(dataCrc >>> 24) & 0xff])]);
  const enc = new ZipCrypto(ZIP_PASSWORD).encrypt(Buffer.concat([head, comp]));
  const csize = enc.length;
  const usize = data.length;
  const nb = Buffer.from(name, 'ascii');
  const lfh = Buffer.alloc(30 + nb.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(14, 4);
  lfh.writeUInt16LE(3, 6);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(dataCrc, 14);
  lfh.writeUInt32LE(csize, 18);
  lfh.writeUInt32LE(usize, 22);
  lfh.writeUInt16LE(nb.length, 26);
  nb.copy(lfh, 30);

  const cd = Buffer.alloc(46 + nb.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(14, 4);
  cd.writeUInt16LE(14, 6);
  cd.writeUInt16LE(3, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(dataCrc, 16);
  cd.writeUInt32LE(csize, 20);
  cd.writeUInt32LE(usize, 24);
  cd.writeUInt16LE(nb.length, 28);
  cd.writeUInt16LE(1, 36);
  cd.writeUInt32LE(0x20, 38);
  nb.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(lfh.length + csize, 16);
  return Buffer.concat([lfh, enc, cd, eocd]);
}
