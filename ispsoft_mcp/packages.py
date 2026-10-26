"""Bounded ISPSoft library package I/O; ZipCrypto is the vendor container format."""
from __future__ import annotations

import io
import os
import struct
import zipfile
import zlib

from ._vendor.mpu_codec import ZIP_PASSWORD, ZipCrypto
from .limits import FileTransformError, MAX_MEMBERS, MAX_SOURCE_BYTES, safe_member


def unpack(data: bytes) -> tuple[bytes, dict[str, bytes]]:
    start = data.find(b'PK\x03\x04')
    if start not in (0x98, 0xa4, 0xa6):
        raise FileTransformError('Unsupported library prefix length')
    if struct.unpack_from('<I', data, 0x94)[0] != len(data) - start:
        raise FileTransformError('Library ZIP length mismatch')
    try:
        with zipfile.ZipFile(io.BytesIO(data[start:])) as archive:
            infos = archive.infolist()
            if not 1 <= len(infos) <= MAX_MEMBERS:
                raise FileTransformError('Invalid package member count')
            members, seen, total = {}, set(), 0
            for item in infos:
                name = safe_member(item.filename)
                if name.casefold() in seen or item.is_dir():
                    raise FileTransformError('Duplicate/ambiguous member or directory entry')
                seen.add(name.casefold())
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise FileTransformError('Symbolic links are not package contents')
                if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise FileTransformError('Unsupported package compression')
                total += item.file_size
                if total > MAX_SOURCE_BYTES:
                    raise FileTransformError('Package expansion exceeds size limit')
                with archive.open(item, pwd=ZIP_PASSWORD) as stream:
                    raw = stream.read(MAX_SOURCE_BYTES + 1)
                if len(raw) != item.file_size:
                    raise FileTransformError('Package member size mismatch')
                members[name] = raw
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as exc:
        raise FileTransformError('Invalid or unsupported package archive') from exc
    return data[:start], members


def pack(prefix: bytes, members: dict[str, bytes]) -> bytes:
    if len(prefix) not in (0x98, 0xa4, 0xa6) or not 1 <= len(members) <= MAX_MEMBERS:
        raise FileTransformError('Unsupported package prefix/member count')
    if sum(map(len, members.values())) > MAX_SOURCE_BYTES:
        raise FileTransformError('Package exceeds expanded size limit')
    local, central = bytearray(), bytearray()
    seen = set()
    for name, data in members.items():
        name = safe_member(name)
        if name.casefold() in seen:
            raise FileTransformError('Duplicate package name')
        seen.add(name.casefold())
        try:
            filename = name.encode('ascii')
        except UnicodeEncodeError as exc:
            raise FileTransformError('Package member names must be ASCII for this profile') from exc
        crc = zlib.crc32(data) & 0xffffffff
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        compressed = compressor.compress(data) + compressor.flush()
        encrypted = ZipCrypto(ZIP_PASSWORD).encrypt(os.urandom(11) + bytes([crc >> 24]) + compressed)
        size, offset = len(encrypted), len(local)
        # Fixed valid DOS timestamp; source semantics do not depend on ZIP time.
        local += struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 3, 8, 0, 33,
                             crc, size, len(data), len(filename), 0) + filename + encrypted
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 3, 8, 0, 33,
                               crc, size, len(data), len(filename), 0, 0, 0, 0, 0x20, offset) + filename
    end = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(members), len(members), len(central), len(local), 0)
    archive = bytes(local + central) + end
    header = bytearray(prefix)
    struct.pack_into('<I', header, 0x94, len(archive))
    result = bytes(header) + archive
    if unpack(result)[1] != members:
        raise FileTransformError('Package round-trip verification failed')
    return result
