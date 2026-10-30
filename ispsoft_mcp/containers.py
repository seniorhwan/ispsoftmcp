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


def ld_networks(text: str) -> list[str]:
    """Return raw ISPSoft LD network bodies between their marker tags."""
    return [match.group(1) for match in ld_network_matches(text)]


def ld_network_matches(text: str) -> list[re.Match[str]]:
    """Return source spans for marker-delimited LD network bodies."""
    return list(re.finditer(r'(?is)<NETWORK_START>\r*\n(.*?)\r*\n<NETWORK_END>', text))


def replace_ld_pou_networks(source: str, pou_name: str,
                            replacement_networks: list[str], newline: str = "\r\n") -> str:
    """Replace every network in one LD POU while preserving the rest of the project.

    ``replacement_networks`` contains complete NETWORK_START/NETWORK_END blocks.
    Each body is structurally checked before the source is changed.
    """
    if not replacement_networks:
        raise FileTransformError("An LD program must contain at least one network.")
    if any(not isinstance(network, str) for network in replacement_networks):
        raise FileTransformError("Every replacement LD network must be text.")
    if any(not re.match(r"(?is)^<NETWORK_START>\r*\n.*?\r*\n<NETWORK_END>$", network.strip())
           for network in replacement_networks):
        raise FileTransformError("Each replacement must be one complete network block.")
    if sum(len(network.encode("utf-8")) for network in replacement_networks) > 4_000_000:
        raise FileTransformError("Replacement LD program exceeds 4 MB.")

    matches = [match for match in sections(source, "POU")
               if property_value(match.group(1), "P_Name") == pou_name]
    if len(matches) != 1:
        raise FileTransformError(f"Expected one POU named {pou_name!r}; found {len(matches)}.")
    pou_match = matches[0]
    pou_body = pou_match.group(1)
    if property_value(pou_body, "P_Lang") != "1":
        raise FileTransformError("The named POU is not a Ladder Diagram POU.")
    old_networks = list(re.finditer(
        r"(?is)<NETWORK_START>\r*\n.*?\r*\n<NETWORK_END>", pou_body))
    if not old_networks:
        raise FileTransformError("The target LD POU has no replaceable networks.")
    bodies = [re.search(r"(?is)^<NETWORK_START>\r*\n(.*?)\r*\n<NETWORK_END>$", item.strip()).group(1)
              for item in replacement_networks]
    for body in bodies:
        errors = validate_ld_network(body)
        if errors:
            raise FileTransformError("Invalid generated LD network: " + "; ".join(errors))
    blocks = (newline + newline).join(item.strip().replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
                                       for item in replacement_networks)
    updated_pou = (pou_body[:old_networks[0].start()] + blocks +
                   pou_body[old_networks[-1].end():])
    updated_source = (source[:pou_match.start(1)] + updated_pou +
                      source[pou_match.end(1):])
    readback = [match.group(0) for match in re.finditer(
        r"(?is)<NETWORK_START>\r*\n.*?\r*\n<NETWORK_END>", updated_pou)]
    if len(readback) != len(replacement_networks):
        raise FileTransformError("LD network replacement readback count does not match.")
    if [normalized(item) for item in readback] != [normalized(item.strip())
                                                    for item in replacement_networks]:
        raise FileTransformError("LD network replacement readback differs from the requested program.")
    return updated_source


def parse_ld_network(network_text: str) -> dict:
    """Extract marker-delimited properties and raw LD nodes without assigning semantics."""
    def marker_region(start: str, end: str) -> str:
        match = re.search(rf'(?is)<{start}>\r*\n(.*?)\r*\n<{end}>', network_text)
        return match.group(1) if match else ""

    def fields(block: str) -> dict[str, str]:
        result: dict[str, str] = {}
        for line in block.splitlines():
            line = line.strip()
            if "=" in line:
                key, value = line.split("=", 1)
                result[key.strip()] = value.strip()
        return result

    def nodes(section: str) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for match in re.finditer(r'(?is)\[LD_NODE\]\r*\n(.*?)\r*\n\[END_LD_NODE\]', section):
            raw = match.group(1)
            result.append({"fields": fields(raw), "raw_text": raw})
        return result

    properties = marker_region("PROPERTIES_START", "PROPERTIES_END")
    roots = marker_region("ROOTLINK_START", "ROOTLINK_END")
    outlinks = marker_region("OUTLINK_START", "OUTLINK_END")
    return {"properties": fields(properties), "root_nodes": nodes(roots),
            "outlink_nodes": nodes(outlinks), "root_section_raw": roots,
            "outlink_section_raw": outlinks}


def validate_ld_network(network_text: str) -> list[str]:
    """Validate marker and node-record structure without interpreting TYPE values."""
    errors: list[str] = []
    if not isinstance(network_text, str) or not network_text.strip():
        return ["replacement network must be non-empty text"]
    try:
        size = len(network_text.encode("utf-8"))
    except UnicodeEncodeError:
        return ["replacement network contains invalid Unicode"]
    if size > 1_000_000:
        return ["replacement network exceeds 1 MB"]
    if re.search(r'(?i)</?NETWORK_(?:START|END)>', network_text):
        errors.append("replacement must contain a network body only, without NETWORK_START/NETWORK_END wrappers")
    required_pairs = (("PROPERTIES_START", "PROPERTIES_END"),
                      ("ROOTLINK_START", "ROOTLINK_END"),
                      ("OUTLINK_START", "OUTLINK_END"))
    positions: list[int] = []
    for start, end in required_pairs:
        starts = list(re.finditer(rf'(?i)<{start}>', network_text))
        ends = list(re.finditer(rf'(?i)<{end}>', network_text))
        if len(starts) != 1 or len(ends) != 1:
            errors.append(f"expected exactly one {start}/{end} marker pair")
        elif starts[0].start() >= ends[0].start():
            errors.append(f"{start} must precede {end}")
        else:
            positions.extend((starts[0].start(), ends[0].start()))
    if len(positions) == 6 and positions != sorted(positions):
        errors.append("network sections must be ordered PROPERTIES, ROOTLINK, then OUTLINK")
    opens = len(re.findall(r'(?i)\[LD_NODE\]', network_text))
    closes = len(re.findall(r'(?i)\[END_LD_NODE\]', network_text))
    if opens != closes:
        errors.append("LD_NODE and END_LD_NODE records are unbalanced")
    parsed = parse_ld_network(network_text)
    parsed_nodes = parsed["root_nodes"] + parsed["outlink_nodes"]
    if len(parsed_nodes) != opens:
        errors.append("every LD_NODE record must be fully contained in ROOTLINK or OUTLINK")
    for index, node in enumerate(parsed_nodes, 1):
        if not node["fields"].get("TYPE"):
            errors.append(f"LD_NODE record {index} is missing TYPE")
    return errors


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


def parse_local_variables(section_text: str) -> dict:
    """Return a best-effort structured view of block-form local VAR sections.

    ISPSoft's source dialect contains other local-variable encodings. Those
    remain available in ``raw`` and are marked unparsed rather than inferred.
    """
    if not isinstance(section_text, str):
        return {"status": "UNPARSED", "entries": [], "errors": ["section is not text"], "raw": ""}
    wrappers = sections(section_text, "VAR")
    if len(wrappers) != 1:
        return {"status": "UNPARSED", "entries": [],
                "errors": [f"expected one VAR wrapper; found {len(wrappers)}"], "raw": section_text}
    body = wrappers[0].group(1)
    blocks: list[str] = []
    current: list[str] | None = None
    errors: list[str] = []
    for line_number, line in enumerate(body.splitlines(), 1):
        token = line.strip()
        if token == "{":
            if current is not None:
                errors.append(f"nested record opening at line {line_number}")
            else:
                current = []
        elif token == "}":
            if current is None:
                errors.append(f"unmatched record closing at line {line_number}")
            else:
                blocks.append("\n".join(current))
                current = None
        elif current is not None:
            current.append(line)
        elif token:
            errors.append(f"text outside a symbol record at line {line_number}")
    if current is not None:
        errors.append("unterminated symbol record")

    entries: list[dict[str, str | None]] = []
    declaration_re = re.compile(
        r"^\s*(?P<identifier>[A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?P<type>.+?)"
        r"\s*:=\s*(?P<initial>.*?)\s+\{(?P<class>[A-Za-z_][A-Za-z0-9_]*)\}\s*$"
    )
    for index, block in enumerate(blocks, 1):
        lines = [line for line in block.splitlines() if line.strip()]
        declaration = declaration_re.fullmatch(lines[0]) if lines else None
        if declaration is None:
            errors.append(f"symbol record {index} has an unrecognized declaration")
            continue
        initial = declaration.group("initial").strip()
        address_match = re.search(r"\[@([A-Za-z][A-Za-z0-9]*\d+)@\]", initial)
        comment_match = re.search(r"\(\*(.*?)\*\)", block, re.S)
        entries.append({
            "identifier": declaration.group("identifier"),
            "type": declaration.group("type").strip(),
            "address": address_match.group(1).upper() if address_match else None,
            "class": declaration.group("class"),
            "initial_value": initial,
            "comment": comment_match.group(1).strip() if comment_match else None,
        })
    if not blocks and not errors:
        errors.append("VAR wrapper contains no recognized symbol records")
    status = "PARSED_LIMITED" if not errors else ("PARTIAL" if entries else "UNPARSED")
    return {"status": status, "entries": entries, "errors": errors, "raw": section_text}


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
