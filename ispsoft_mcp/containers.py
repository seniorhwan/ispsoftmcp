"""Known ISPSoft raw-DEFLATE containers with bounded integrity checks."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import struct
import zlib

from .limits import FileTransformError, MAX_SOURCE_BYTES, inflate, read_bytes
from ._vendor.ispsoft_codec import normalize_for_editor


@dataclass(frozen=True)
class Container:
    data: bytes
    offset: int
    source: bytes
    encoding: str
    newline: str
    layout: str = 'legacy'
    trailer_offset: int | None = None

    def rebuild(self, source: bytes) -> bytes:
        if len(source) > MAX_SOURCE_BYTES:
            raise FileTransformError('Source exceeds size limit')
        source.decode(self.encoding)
        compressor = zlib.compressobj(level=9, wbits=-15)
        payload = compressor.compress(source) + compressor.flush()
        header = bytearray(self.data[:self.offset])
        struct.pack_into('<I', header, self.offset - 4, zlib.crc32(source) & 0xffffffff)
        struct.pack_into('<I', header, 0x7c, len(source))
        struct.pack_into('<I', header, 0x94, len(payload) + 6)
        trailer = b''
        if self.layout == 'ispsoft-3.24-v8':
            end = self.offset + len(payload)
            struct.pack_into('<I', header, 0x58, end)
            if self.trailer_offset is None:
                raise FileTransformError('Missing ISPSoft 3.24 trailer boundary')
            trailer = self.data[self.trailer_offset:]
        elif self.offset == 0xac:
            struct.pack_into('<I', header, 0x58, self.offset + len(payload))
        result = bytes(header) + payload + trailer
        if decode(result).source != source:
            raise FileTransformError('Container round-trip check failed')
        return result


def decode(data: bytes) -> Container:
    if len(data) <= 0xaa:
        raise FileTransformError('Truncated ISP container')
    versions = struct.unpack_from('<II', data, 0x0c)
    layout = 'legacy'
    trailer_offset = None
    compiled_size = struct.unpack_from('<I', data, 0x9c)[0]
    if versions == (1020, 8):
        # ISPSoft 3.24's source pointer is at 0x98 and its opaque trailer starts
        # at 0x58. Validate both pointers and the declared payload length; do
        # not scan the file for a coincidental DEFLATE marker.
        payload_header = struct.unpack_from('<I', data, 0x98)[0]
        payload_end = struct.unpack_from('<I', data, 0x58)[0]
        if (payload_header < 0xa4 or payload_header + 6 > payload_end or
                payload_end > len(data) or payload_end - payload_header !=
                struct.unpack_from('<I', data, 0x94)[0] or
                struct.unpack_from('<H', data, payload_header)[0] != 8):
            raise FileTransformError('Unsupported ISPSoft 3.24 pointer/footer layout')
        offset = payload_header + 6
        source, consumed = inflate(data[offset:payload_end])
        if consumed != payload_end - offset:
            raise FileTransformError('Unexpected bytes inside the ISPSoft source payload')
        if struct.unpack_from('<I', data, offset - 4)[0] != zlib.crc32(source) & 0xffffffff:
            raise FileTransformError('Source CRC mismatch')
        layout = 'ispsoft-3.24-v8'
        trailer_offset = payload_end
    elif versions == (1020, 3010) and compiled_size:
        # AS ISPSoft 3.19 (file 1020 / format 3010) stores a compiled prefix
        # before the source payload. Resolve only the explicit header pointer;
        # never scan for arbitrary decompressible data.
        payload_start = struct.unpack_from('<I', data, 0x98)[0]
        if (versions != (1020, 3010) or compiled_size == 0 or
                payload_start != 0xa4 + compiled_size or
                not 0xa4 < payload_start <= len(data) - 7 or
                struct.unpack_from('<H', data, payload_start)[0] != 8):
            raise FileTransformError('Unsupported ISP variant; expected 0xAA/0xAC or explicit AS v3010 source pointer')
        offset = payload_start + 6
        source, consumed = inflate(data[offset:])
        if consumed != len(data) - offset:
            raise FileTransformError('Unexpected data after compressed stream')
        if struct.unpack_from('<I', data, offset-4)[0] != zlib.crc32(source) & 0xffffffff:
            raise FileTransformError('Source CRC mismatch')
    else:
        offset = next((o for o in (0xaa, 0xac) if len(data) > o and
                       struct.unpack_from('<H', data, o-6)[0] == 8), None)
        if offset is None:
            raise FileTransformError('Unsupported ISP variant; recognized stream offsets: 0xAA/0xAC')
    if layout != 'ispsoft-3.24-v8':
        payload_size = struct.unpack_from('<I', data, 0x94)[0]
        if payload_size != len(data) - (offset - 6):
            raise FileTransformError('Container payload length mismatch')
        source, consumed = inflate(data[offset:])
        if consumed != len(data) - offset:
            raise FileTransformError('Unexpected data after compressed stream')
        if struct.unpack_from('<I', data, offset-4)[0] != zlib.crc32(source) & 0xffffffff:
            raise FileTransformError('Source CRC mismatch')
    if struct.unpack_from('<I', data, 0x7c)[0] not in (0, len(source)):
        raise FileTransformError('Source length mismatch')
    if not source.startswith(b'<PROJECT>'):
        raise FileTransformError('Not an unprotected ISP project source')
    for position in (0x0c, 0x10):
        if not 1 <= struct.unpack_from('<I', data, position)[0] <= 100_000:
            raise FileTransformError('Header is locked or unsupported; use an explicitly selected clean backup')
    probe = source[:4096].decode('ascii', errors='ignore')
    codepage = re.search(r'(?m)^Active_CodePage=(\d+)\r*$', probe)
    encoding = 'cp' + (codepage.group(1) if codepage else '1252')
    try:
        text = source.decode(encoding)
    except (UnicodeError, LookupError) as exc:
        raise FileTransformError(f'Invalid source encoding: {encoding}') from exc
    # Native protection is not treated as an invitation to decode/modify it.
    if re.search(r'(?mi)^Prj_C_SourceCodeLocked=TRUE\r*$', text):
        raise FileTransformError('Protected source is unsupported')
    if layout == 'ispsoft-3.24-v8':
        model = property_value(text, 'Prj_DT')
        if model not in ('ES2', 'ES2-E', 'EH3', 'SA2', 'SX2', 'SS2', 'EX2'):
            raise FileTransformError(f'ISPSoft 3.24 pointer/footer layout is not qualified for project series {model!r}')
    elif offset not in (0xaa, 0xac):
        model = property_value(text, 'Prj_DT')
        if model not in ('AS228T', 'AS228P', 'AS228R'):
            raise FileTransformError('AS v3010 pointer layout is qualified only for AS228T/P/R source metadata')
    newline = '\r\r\n' if b'\r\r\n' in source else ('\r\n' if b'\r\n' in source else '\n')
    return Container(data, offset, source, encoding, newline, layout, trailer_offset)


def read_container(path: str | Path) -> Container:
    return decode(read_bytes(path))


def normalized(text: str) -> str:
    return normalize_for_editor(text.replace('\r\r\n', '\n'))


def sections(text: str, tag: str):
    return list(re.finditer(rf'<{re.escape(tag)}>\r*\n(.*?)</{re.escape(tag)}>', text, re.S))


def property_value(body: str, key: str) -> str | None:
    match = re.search(rf'(?m)^{re.escape(key)}=([^\r\n]*)', body)
    return match.group(1) if match else None


def inspect(container: Container) -> dict:
    text = container.source.decode(container.encoding)
    return dict(stream_offset=container.offset, source_bytes=len(container.source),
                encoding=container.encoding, project_model=property_value(text, 'Prj_DT'),
                pous=[dict(name=property_value(m.group(1), 'P_Name'),
                           language=property_value(m.group(1), 'P_Lang'),
                           pou_type=property_value(m.group(1), 'P_type')) for m in sections(text, 'POU')])


def patch_st(container: Container, pou_name: str, code: str | None, variables: str | None) -> bytes:
    if code is None and variables is None:
        raise FileTransformError('Provide code_path and/or variables_path')
    text = container.source.decode(container.encoding)
    matches = [m for m in sections(text, 'POU') if property_value(m.group(1), 'P_Name') == pou_name]
    if len(matches) != 1:
        raise FileTransformError(f'Expected one POU named {pou_name!r}; found {len(matches)}')
    match = matches[0]
    body = match.group(1)
    for tag, content in [('IL_ST_CODE', code), ('LOCAL_VAR', variables)]:
        if content is None:
            continue
        inner = sections(body, tag)
        if len(inner) != 1:
            raise FileTransformError(f'Expected exactly one {tag}; this POU layout is unsupported')
        if re.search(r'</?(?:POU|IL_ST_CODE|LOCAL_VAR)(?:>|\s)', content, re.I):
            raise FileTransformError('Replacement contains structural container delimiters')
        replacement = normalized(content).replace('\n', container.newline)
        body = body[:inner[0].start(1)] + replacement + body[inner[0].end(1):]
    result = text[:match.start(1)] + body + text[match.end(1):]
    return container.rebuild(result.encode(container.encoding))
