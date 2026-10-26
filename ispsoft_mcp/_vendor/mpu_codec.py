# -*- coding: utf-8 -*-
"""ISPSoft .mpu 程序包 编解码库（纯 Python，无第三方依赖）

Delta ISPSoft 导出的 ``.mpu``（工具 → 导入/导出 → 导出程序）实测结构：

    [152 字节前缀] + [标准 ZIP 包（单个加密条目 "Unzipped.src"）]

前缀（全部小端 32 位，其余字节为 0）：

    偏移   长度   内容
    0x00   12     全 0
    0x0C    4     = 1020（固定）
    0x10    4     = 8（固定）
    0x14  128     全 0
    0x94    4     = ZIP 部分的字节长度

ZIP 条目名固定为 ``Unzipped.src``，内容是用固定口令 ZipCrypto 加密的**纯文本**
（GBK/ANSI，CRLF 换行），即 POU 的梯形图网络结构文本。

固定口令来自开源项目 ``ahmetdumlupinarr/delta-ispsoft-codec`` 的逆向结论 ——
它**不是用户设置的密码**：无论导出时是否勾选保护选项，ISPSoft 都用这个口令打包。

用法::

    import mpu_codec as mc
    text = mc.extract("ExpFileName0.MPU")          # -> str（已解密）
    data = mc.pack(text, "out.mpu")                # -> bytes，可直接写盘
    mc.pack_file(text, r"D:\\proj\\out.mpu")
"""

import os
import struct
import zlib

# --------------------------------------------------------------------------
# 固定口令（ISPSoft 内置，非用户密码）
# --------------------------------------------------------------------------
ZIP_PASSWORD = b"eL$@.i$-$TuP!D~"
ENTRY_NAME = "Unzipped.src"
PREFIX_LEN = 152
PREFIX_MAGIC_A = 1020      # 偏移 0x0C
PREFIX_MAGIC_B = 8         # 偏移 0x10
PREFIX_LEN_OFFSET = 0x94   # 偏移 148：ZIP 长度


# --------------------------------------------------------------------------
# ZipCrypto（PKWARE 传统加密）
# --------------------------------------------------------------------------
def _build_crc_table():
    tbl = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (c >> 1) ^ (0xEDB88320 if c & 1 else 0)
        tbl.append(c & 0xFFFFFFFF)
    return tbl


_CRC_TABLE = _build_crc_table()


def _crc_byte(crc, byte):
    return ((crc >> 8) ^ _CRC_TABLE[(crc ^ byte) & 0xFF]) & 0xFFFFFFFF


class ZipCrypto:
    """PKWARE 传统加密流。加解密是对称的（同一个 stream_byte）。"""

    def __init__(self, password):
        if isinstance(password, str):
            password = password.encode("latin-1")
        self.k = [0x12345678, 0x23456789, 0x34567890]
        for b in password:
            self._update(b)

    def _update(self, byte):
        k = self.k
        k[0] = _crc_byte(k[0], byte)
        k[1] = (k[1] + (k[0] & 0xFF)) & 0xFFFFFFFF
        k[1] = (k[1] * 134775813 + 1) & 0xFFFFFFFF
        k[2] = _crc_byte(k[2], (k[1] >> 24) & 0xFF)

    def _stream_byte(self):
        t = (self.k[2] | 2) & 0xFFFF
        return ((t * (t ^ 1)) >> 8) & 0xFF

    def encrypt(self, data):
        out = bytearray(len(data))
        for i, p in enumerate(data):
            out[i] = p ^ self._stream_byte()
            self._update(p)
        return bytes(out)

    def decrypt(self, data):
        out = bytearray(len(data))
        for i, c in enumerate(data):
            out[i] = c ^ self._stream_byte()
            self._update(out[i])
        return bytes(out)


# --------------------------------------------------------------------------
# 打包 / 解包
# --------------------------------------------------------------------------
def _build_zip(data, name, dos_time=None, dos_date=None, mtime=None):
    """构造只含一个加密条目的标准 ZIP 包（bytes）。"""
    crc = zlib.crc32(data) & 0xFFFFFFFF
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    comp = co.compress(data) + co.flush()

    # 12 字节 ZipCrypto 头：前 11 字节随机，末字节 = CRC 高字节
    head = bytearray(os.urandom(11))
    head.append((crc >> 24) & 0xFF)

    enc = ZipCrypto(ZIP_PASSWORD).encrypt(bytes(head) + comp)
    csize = len(enc)
    usize = len(data)
    flags = 0x0003          # bit0 加密 + bit1 最大压缩（与 ISPSoft 自身导出一致）
    method = 8

    if dos_time is None or dos_date is None:
        import time as _t
        st = _t.localtime(mtime) if mtime else _t.localtime()
        if dos_time is None:
            dos_time = (st.tm_hour << 11) | (st.tm_min << 5) | (st.tm_sec // 2)
        if dos_date is None:
            dos_date = ((st.tm_year - 1980) << 9) | (st.tm_mon << 5) | st.tm_mday

    nb = name.encode("ascii")
    lfh = struct.pack("<IHHHHHIIIHH", 0x04034B50, 14, flags, method,
                      dos_time, dos_date, crc, csize, usize, len(nb), 0) + nb
    cd = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 14, 14, flags, method,
                     dos_time, dos_date, crc, csize, usize, len(nb),
                     0, 0, 0, 1, 0x20, 0) + nb
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(cd),
                       len(lfh) + csize, 0)
    return lfh + enc + cd + eocd


def _parse_zip(blob):
    """从 ZIP 字节里取出唯一加密条目，用固定口令解密，返回原始 bytes。"""
    idx = blob.find(b"PK\x03\x04")
    if idx < 0:
        raise ValueError("不是有效的 ZIP：找不到本地文件头")
    (ver, flags, method, _t, _d, crc, csize, usize, fnl, exl) = struct.unpack_from(
        "<HHHHHIIIHH", blob, idx + 4)
    name = blob[idx + 30:idx + 30 + fnl].decode("ascii", "replace")
    body_off = idx + 30 + fnl + exl
    body = blob[body_off:body_off + csize]

    if flags & 0x1:
        plain = ZipCrypto(ZIP_PASSWORD).decrypt(body)
        raw = plain[12:]                       # 去掉 12 字节 ZipCrypto 头
    else:
        raw = body

    if method == 8:
        raw = zlib.decompress(raw, -15)
    elif method != 0:
        raise ValueError("不支持的压缩方法: %d" % method)

    if (zlib.crc32(raw) & 0xFFFFFFFF) != crc:
        raise ValueError("CRC 校验失败：口令或格式不对（条目 %s）" % name)
    return name, raw


def extract_bytes(path):
    """读 .mpu -> 内部 Unzipped.src 原始 bytes。"""
    with open(path, "rb") as f:
        blob = f.read()
    return _parse_zip(blob)[1]


def extract(path, encoding="gbk"):
    """读 .mpu -> 内部文本（str）。"""
    return extract_bytes(path).decode(encoding, "replace")


def prefill_prefix(zip_len):
    """生成 152 字节前缀。"""
    p = bytearray(PREFIX_LEN)
    struct.pack_into("<I", p, 0x0C, PREFIX_MAGIC_A)
    struct.pack_into("<I", p, 0x10, PREFIX_MAGIC_B)
    struct.pack_into("<I", p, PREFIX_LEN_OFFSET, zip_len)
    return bytes(p)


def pack(text, encoding="latin-1", prefix_template=None):
    """文本 -> .mpu 字节。Latin-1 是为了逐字节保真（内容本来是 ANSI）。"""
    data = text.encode(encoding) if isinstance(text, str) else text
    zp = _build_zip(data, ENTRY_NAME)
    if prefix_template:
        p = bytearray(prefix_template[:PREFIX_LEN])
        if len(p) < PREFIX_LEN:
            p += bytes(PREFIX_LEN - len(p))
    else:
        p = bytearray(prefill_prefix(len(zp)))
    struct.pack_into("<I", p, PREFIX_LEN_OFFSET, len(zp))
    return bytes(p) + zp


def pack_file(text, path, encoding="latin-1", prefix_template=None):
    data = pack(text, encoding=encoding, prefix_template=prefix_template)
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def verify(path):
    """自检：解包 -> 内容可读性 -> 重新打包 -> 再解包一致。"""
    raw = extract_bytes(path)
    repacked = pack(raw, encoding=None)
    again = _parse_zip(repacked)[1]
    return {
        "size": os.path.getsize(path),
        "src_bytes": len(raw),
        "roundtrip_ok": again == raw,
        "printable_pct": round(
            100.0 * sum(1 for b in raw if 32 <= b < 127 or b in (9, 10, 13)) / max(1, len(raw)), 1),
        "networks": raw.count(b"<NETWORK_START>"),
    }


if __name__ == "__main__":
    import sys
    args = [a for a in sys.argv[1:] if a not in ("-h", "--help")]
    if not args:
        print(__doc__)
        raise SystemExit(0)
    for p in args:
        try:
            print("%-42s %s" % (p, verify(p)))
        except Exception as e:
            print("%-42s [失败] %s: %s" % (p, type(e).__name__, e))
