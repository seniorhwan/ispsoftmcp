#!/usr/bin/env python3
"""Round-trip editor for unprotected Delta ISPSoft project containers.

The supported .isp/.bak layout was identified from ISPSoft 3.24 files:

    0x0000 .. 0x00A3  container header
    0x00A4             uint16 compression method (8 = deflate)
    0x00A6             uint32 CRC-32 of uncompressed project source
    0x00AA .. EOF      raw DEFLATE stream

This tool never writes over its input file. Editable files are UTF-8/LF, while
the rebuilt ISPSoft source is encoded with the project's declared code page and
uses its original line ending.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


HEADER_SIZE = 0xA4
PAYLOAD_OFFSET = 0xAA
ZIP_PASSWORD = b"eL$@.i$-$TuP!D~"
DUT_NEWLINE_TOKEN = "PLCnnnnnnnewLineAndSubstitudeeeeeeePLC"
MANIFEST_NAME = "manifest.json"


class CodecError(RuntimeError):
    pass


@dataclass(frozen=True)
class IspContainer:
    path: Path
    header: bytes
    source: bytes
    encoding: str
    newline: str


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_isp(path: Path) -> IspContainer:
    data = path.read_bytes()
    if len(data) <= PAYLOAD_OFFSET:
        raise CodecError(f"{path} is too short to be an ISPSoft container")

    method = struct.unpack_from("<H", data, HEADER_SIZE)[0]
    if method != 8:
        raise CodecError(
            f"Unsupported compression method {method} at 0x{HEADER_SIZE:X}"
        )

    stored_payload_size = struct.unpack_from("<I", data, 0x94)[0]
    actual_payload_size = len(data) - HEADER_SIZE
    if stored_payload_size != actual_payload_size:
        raise CodecError(
            "Container payload length mismatch: "
            f"header={stored_payload_size}, actual={actual_payload_size}"
        )

    try:
        source = zlib.decompress(data[PAYLOAD_OFFSET:], wbits=-15)
    except zlib.error as exc:
        raise CodecError(f"Raw DEFLATE payload cannot be decoded: {exc}") from exc

    stored_crc = struct.unpack_from("<I", data, 0xA6)[0]
    actual_crc = zlib.crc32(source) & 0xFFFFFFFF
    if stored_crc != actual_crc:
        raise CodecError(
            f"Source CRC-32 mismatch: header={stored_crc:08X}, actual={actual_crc:08X}"
        )

    declared_size = struct.unpack_from("<I", data, 0x7C)[0]
    if declared_size not in (0, len(source)):
        raise CodecError(
            f"Source length mismatch: header={declared_size}, actual={len(source)}"
        )

    probe = source[:4096].decode("ascii", errors="ignore")
    match = re.search(r"(?m)^Active_CodePage=(\d+)\r?$", probe)
    code_page = match.group(1) if match else "1252"
    encoding = f"cp{code_page}"
    try:
        source.decode(encoding)
    except (LookupError, UnicodeDecodeError) as exc:
        raise CodecError(f"Cannot decode source as {encoding}: {exc}") from exc

    newline = "\r\n" if b"\r\n" in source else "\n"
    return IspContainer(path, data[:HEADER_SIZE], source, encoding, newline)


def unlocked_header(container: IspContainer) -> bytes:
    """Return a saveable header, replacing ISPSoft's open-file lock overlay.

    While a project is open, ISPSoft overwrites bytes 4..31 of the .isp header
    with a path/owner marker. That overlay covers the version fields at 0x0C
    and 0x10. A sibling .bak retains the clean header and can safely restore
    those fields for a rebuilt project.
    """

    header = container.header
    file_version = struct.unpack_from("<I", header, 0x0C)[0]
    format_version = struct.unpack_from("<I", header, 0x10)[0]
    if 1 <= file_version <= 100_000 and 1 <= format_version <= 100_000:
        return header

    backup_path = container.path.with_suffix(".bak")
    if not backup_path.is_file():
        raise CodecError(
            "The ISP header contains an open-file lock overlay and no sibling "
            f".bak exists to restore its version fields: {container.path}"
        )
    backup_header = backup_path.read_bytes()[:HEADER_SIZE]
    if len(backup_header) != HEADER_SIZE:
        raise CodecError(f"Backup header is truncated: {backup_path}")
    backup_file_version = struct.unpack_from("<I", backup_header, 0x0C)[0]
    backup_format_version = struct.unpack_from("<I", backup_header, 0x10)[0]
    if not (
        1 <= backup_file_version <= 100_000
        and 1 <= backup_format_version <= 100_000
    ):
        raise CodecError(f"Backup does not contain a clean ISP header: {backup_path}")
    return backup_header


def normalize_for_editor(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def restore_newlines(text: str, newline: str) -> str:
    return normalize_for_editor(text).replace("\n", newline)


def write_utf8(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write(normalize_for_editor(text))


def read_utf8(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as stream:
        return stream.read()


def safe_name(name: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", name).strip(" .")
    if not value:
        raise CodecError(f"Cannot create a safe filename for {name!r}")
    return value


def section_inner(text: str, tag: str) -> Iterable[re.Match[str]]:
    pattern = rf"(?s)<{re.escape(tag)}>(?:\r\n|\n)(.*?)</{re.escape(tag)}>"
    return re.finditer(pattern, text)


def property_value(body: str, key: str) -> str | None:
    match = re.search(rf"(?mi)^{re.escape(key)}=(.*?)\r?$", body)
    return match.group(1) if match else None


def extract_isp(input_path: Path, workspace: Path, *, force: bool = False) -> None:
    container = read_isp(input_path)
    if workspace.exists() and any(workspace.iterdir()) and not force:
        raise CodecError(
            f"Workspace is not empty: {workspace}. Use --force only for a disposable copy."
        )
    workspace.mkdir(parents=True, exist_ok=True)
    internal = workspace / "_internal"
    internal.mkdir(exist_ok=True)
    (internal / "original_header.bin").write_bytes(unlocked_header(container))
    (internal / "original_source.bin").write_bytes(container.source)

    source_text = container.source.decode(container.encoding)
    write_utf8(workspace / "project-source.txt", source_text)

    manifest: dict[str, object] = {
        "format": "delta-ispsoft-workbench-v1",
        "source_container": str(input_path.resolve()),
        "source_container_sha256": sha256(input_path.read_bytes()),
        "source_sha256": sha256(container.source),
        "encoding": container.encoding,
        "newline": "CRLF" if container.newline == "\r\n" else "LF",
        "pous": [],
        "sections": [],
        "data_types": [],
    }

    pous: list[dict[str, object]] = []
    for index, match in enumerate(section_inner(source_text, "POU")):
        body = match.group(1)
        name = property_value(body, "P_Name")
        if not name:
            raise CodecError(f"POU #{index} has no P_Name")
        file_stem = safe_name(name)

        code_matches = list(section_inner(body, "IL_ST_CODE"))
        local_matches = list(section_inner(body, "LOCAL_VAR"))
        if len(code_matches) != 1:
            raise CodecError(f"POU {name!r} has {len(code_matches)} IL_ST_CODE sections")
        if len(local_matches) != 1:
            raise CodecError(f"POU {name!r} has {len(local_matches)} LOCAL_VAR sections")

        code_file = Path("pous") / f"{file_stem}.st"
        vars_file = Path("pous") / f"{file_stem}.vars.txt"
        write_utf8(workspace / code_file, code_matches[0].group(1))
        write_utf8(workspace / vars_file, local_matches[0].group(1))
        pous.append(
            {
                "index": index,
                "name": name,
                "p_type": property_value(body, "P_type"),
                "language": property_value(body, "P_Lang"),
                "code_file": code_file.as_posix(),
                "local_vars_file": vars_file.as_posix(),
            }
        )
    manifest["pous"] = pous

    editable_tags = [
        "PROJECT",
        "TASK",
        "GLOBAL_VAR",
        "GLOBAL_AXIS_VAR",
        "GLOBAL_ETHERCAT_VAR",
        "SYSTEM_VAR",
        "MOTION_CONTROL",
    ]
    sections: list[dict[str, object]] = []
    for tag in editable_tags:
        matches = list(section_inner(source_text, tag))
        for index, match in enumerate(matches):
            suffix = "" if len(matches) == 1 else f"-{index + 1}"
            section_file = Path("sections") / f"{tag.lower()}{suffix}.txt"
            write_utf8(workspace / section_file, match.group(1))
            sections.append(
                {"tag": tag, "index": index, "file": section_file.as_posix()}
            )
    manifest["sections"] = sections

    data_types: list[dict[str, object]] = []
    for index, match in enumerate(section_inner(source_text, "DUT_NODE")):
        body = match.group(1)
        name = property_value(body, "DutName")
        dut_match = re.search(r"(?mi)^DutContent=(.*?)\r?$", body)
        if not name or not dut_match:
            raise CodecError(f"DUT_NODE #{index} is missing DutName or DutContent")
        dut_text = dut_match.group(1).replace(DUT_NEWLINE_TOKEN, "\n")
        dut_file = Path("data-types") / f"{safe_name(name)}.st"
        write_utf8(workspace / dut_file, dut_text)
        data_types.append(
            {"index": index, "name": name, "file": dut_file.as_posix()}
        )
    manifest["data_types"] = data_types

    with (workspace / MANIFEST_NAME).open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def replace_nth_section(text: str, tag: str, index: int, new_inner: str) -> str:
    matches = list(section_inner(text, tag))
    if index >= len(matches):
        raise CodecError(f"Cannot find {tag} section #{index}")
    match = matches[index]
    return text[: match.start(1)] + new_inner + text[match.end(1) :]


def replace_pou_parts(
    text: str, name: str, new_code: str, new_local_vars: str
) -> str:
    matches = []
    for match in section_inner(text, "POU"):
        if property_value(match.group(1), "P_Name") == name:
            matches.append(match)
    if len(matches) != 1:
        raise CodecError(f"Expected one POU named {name!r}, found {len(matches)}")

    match = matches[0]
    body = match.group(1)
    body = replace_nth_section(body, "LOCAL_VAR", 0, new_local_vars)
    body = replace_nth_section(body, "IL_ST_CODE", 0, new_code)
    return text[: match.start(1)] + body + text[match.end(1) :]


def replace_dut(text: str, index: int, name: str, dut_text: str) -> str:
    matches = list(section_inner(text, "DUT_NODE"))
    if index >= len(matches):
        raise CodecError(f"Cannot find DUT_NODE #{index}")
    match = matches[index]
    body = match.group(1)
    if property_value(body, "DutName") != name:
        raise CodecError(f"DUT_NODE #{index} is no longer named {name!r}")
    encoded = normalize_for_editor(dut_text).replace("\n", DUT_NEWLINE_TOKEN)
    pattern = re.compile(r"(?mi)^(DutContent=)([^\r\n]*)(\r?)$")
    if len(pattern.findall(body)) != 1:
        raise CodecError(f"DUT {name!r} has an unexpected DutContent layout")
    body = pattern.sub(
        lambda match: match.group(1) + encoded + match.group(3), body, count=1
    )
    return text[: match.start(1)] + body + text[match.end(1) :]


def build_source(workspace: Path) -> tuple[bytes, dict[str, object]]:
    manifest_path = workspace / MANIFEST_NAME
    if not manifest_path.is_file():
        raise CodecError(f"Missing workspace manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "delta-ispsoft-workbench-v1":
        raise CodecError("Unsupported workspace format")

    encoding = str(manifest["encoding"])
    newline = "\r\n" if manifest["newline"] == "CRLF" else "\n"
    original_source = (workspace / "_internal" / "original_source.bin").read_bytes()
    if sha256(original_source) != manifest["source_sha256"]:
        raise CodecError("The protected original_source.bin has changed")
    text = original_source.decode(encoding)

    for entry in manifest["pous"]:
        code = restore_newlines(read_utf8(workspace / entry["code_file"]), newline)
        local_vars = restore_newlines(
            read_utf8(workspace / entry["local_vars_file"]), newline
        )
        text = replace_pou_parts(text, entry["name"], code, local_vars)

    for entry in manifest["sections"]:
        inner = restore_newlines(read_utf8(workspace / entry["file"]), newline)
        text = replace_nth_section(text, entry["tag"], entry["index"], inner)

    for entry in manifest["data_types"]:
        dut_text = read_utf8(workspace / entry["file"])
        text = replace_dut(text, entry["index"], entry["name"], dut_text)

    try:
        return text.encode(encoding), manifest
    except UnicodeEncodeError as exc:
        raise CodecError(
            f"Edited text contains a character unsupported by {encoding}: {exc}"
        ) from exc


def write_isp(workspace: Path, output_path: Path) -> None:
    source, manifest = build_source(workspace)
    header_path = workspace / "_internal" / "original_header.bin"
    header = bytearray(header_path.read_bytes())
    if len(header) != HEADER_SIZE:
        raise CodecError(f"Unexpected saved header length: {len(header)}")

    compressor = zlib.compressobj(
        level=9, method=zlib.DEFLATED, wbits=-15, memLevel=9
    )
    compressed = compressor.compress(source) + compressor.flush()
    payload_size = 6 + len(compressed)

    # Preserve unknown/vendor-reserved fields, including the two 16-bit values
    # at 0x90/0x92. The fields ISPSoft validates are updated below.
    struct.pack_into("<I", header, 0x7C, len(source))
    struct.pack_into("<I", header, 0x94, payload_size)
    struct.pack_into("<I", header, 0x98, HEADER_SIZE)

    output = bytearray(header)
    output += struct.pack("<HI", 8, zlib.crc32(source) & 0xFFFFFFFF)
    output += compressed

    source_path = Path(str(manifest["source_container"]))
    if output_path.resolve() == source_path.resolve():
        raise CodecError("Refusing to overwrite the original ISPSoft project")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(output)

    check = read_isp(output_path)
    if check.source != source:
        raise CodecError("Internal verification failed after writing the container")


def build_bundle(workspace: Path, output_dir: Path, output_name: str) -> Path:
    manifest = json.loads((workspace / MANIFEST_NAME).read_text(encoding="utf-8"))
    source_isp = Path(str(manifest["source_container"]))
    source_dir = source_isp.parent
    source_stem = source_isp.stem
    output_dir.mkdir(parents=True, exist_ok=True)
    output_isp = output_dir / f"{output_name}.isp"
    write_isp(workspace, output_isp)

    companion_extensions = {
        ".dlhw",
        ".etg",
        ".ex",
        ".hw",
        ".hwc",
        ".ini",
        ".inivals",
        ".tag",
    }
    for source_file in source_dir.iterdir():
        if (
            source_file.is_file()
            and source_file.stem == source_stem
            and source_file.suffix.lower() in companion_extensions
        ):
            shutil.copy2(source_file, output_dir / f"{output_name}{source_file.suffix}")

    description_dirs = [
        item
        for item in source_dir.iterdir()
        if item.is_dir() and item.name.startswith("Description File.")
    ]
    for directory in description_dirs:
        target = output_dir / directory.name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(directory, target)
    return output_isp


def inspect_isp(path: Path) -> None:
    container = read_isp(path)
    text = container.source.decode(container.encoding)
    print(f"file: {path}")
    print(f"container bytes: {path.stat().st_size}")
    print(f"source bytes: {len(container.source)}")
    print(f"encoding: {container.encoding}")
    print(f"source sha256: {sha256(container.source)}")
    for index, match in enumerate(section_inner(text, "POU")):
        body = match.group(1)
        print(
            f"POU {index:02d}: {property_value(body, 'P_Name')} "
            f"type={property_value(body, 'P_type')} "
            f"lang={property_value(body, 'P_Lang')}"
        )


def zip_start(data: bytes) -> int:
    offset = data.find(b"PK\x03\x04")
    if offset < 0:
        raise CodecError("No ZIP local-file header found")
    return offset


def extract_package(input_path: Path, output_dir: Path) -> None:
    data = input_path.read_bytes()
    start = zip_start(data)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "prefix.bin").write_bytes(data[:start])
    with zipfile.ZipFile(input_path) as archive:
        archive.extractall(output_dir / "contents", pwd=ZIP_PASSWORD)
        members = [
            {
                "name": info.filename,
                "compress_type": info.compress_type,
                "encrypted": bool(info.flag_bits & 1),
            }
            for info in archive.infolist()
        ]
    metadata = {
        "format": "delta-ispsoft-package-v1",
        "source_package": str(input_path.resolve()),
        "source_sha256": sha256(data),
        "zip_offset": start,
        "members": members,
    }
    (output_dir / MANIFEST_NAME).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def find_7zip() -> Path:
    candidates = [
        Path(__file__).resolve().parent.parent / "vendor" / "7zip" / "7z.exe",
        Path(r"C:\Program Files\7-Zip\7z.exe"),
        Path(r"C:\Program Files (x86)\7-Zip\7z.exe"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise CodecError("7-Zip is required to create ISPSoft-compatible ZipCrypto packages")


def build_package(workspace: Path, output_path: Path) -> None:
    metadata = json.loads((workspace / MANIFEST_NAME).read_text(encoding="utf-8"))
    if metadata.get("format") != "delta-ispsoft-package-v1":
        raise CodecError("Unsupported package workspace format")
    source_package = Path(str(metadata["source_package"]))
    if output_path.resolve() == source_package.resolve():
        raise CodecError("Refusing to overwrite the original ISPSoft package")

    prefix = bytearray((workspace / "prefix.bin").read_bytes())
    contents = workspace / "contents"
    expected_names = [entry["name"] for entry in metadata["members"]]
    actual_names = sorted(
        file.relative_to(contents).as_posix()
        for file in contents.rglob("*")
        if file.is_file()
    )
    if sorted(expected_names) != actual_names:
        raise CodecError(
            f"Package member set changed: expected={expected_names}, actual={actual_names}"
        )

    with tempfile.TemporaryDirectory(prefix="ispsoft-package-") as temp_name:
        temp = Path(temp_name)
        zip_path = temp / "package.zip"
        command = [
            str(find_7zip()),
            "a",
            "-tzip",
            "-mem=ZipCrypto",
            "-mx=9",
            f"-p{ZIP_PASSWORD.decode('ascii')}",
            str(zip_path),
            *expected_names,
        ]
        result = subprocess.run(
            command,
            cwd=contents,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise CodecError(f"7-Zip failed:\n{result.stdout}\n{result.stderr}")
        zip_data = zip_path.read_bytes()

    if len(prefix) >= 0x98:
        struct.pack_into("<I", prefix, 0x94, len(zip_data))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(prefix + zip_data)

    with zipfile.ZipFile(output_path) as archive:
        for name in expected_names:
            archive.read(name, pwd=ZIP_PASSWORD)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract, edit and rebuild unprotected Delta ISPSoft files."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_cmd = sub.add_parser("inspect", help="show ISP project structure")
    inspect_cmd.add_argument("input", type=Path)

    extract_cmd = sub.add_parser("extract", help="create an editable ISP workspace")
    extract_cmd.add_argument("input", type=Path)
    extract_cmd.add_argument("workspace", type=Path)
    extract_cmd.add_argument("--force", action="store_true")

    build_cmd = sub.add_parser("build", help="rebuild an ISP file from a workspace")
    build_cmd.add_argument("workspace", type=Path)
    build_cmd.add_argument("output", type=Path)

    bundle_cmd = sub.add_parser(
        "bundle", help="build an ISP file and copy its noncompiled companion files"
    )
    bundle_cmd.add_argument("workspace", type=Path)
    bundle_cmd.add_argument("output_dir", type=Path)
    bundle_cmd.add_argument("output_name")

    xp_cmd = sub.add_parser(
        "extract-package", help="extract an FBU/MPU/FCU/CLU package"
    )
    xp_cmd.add_argument("input", type=Path)
    xp_cmd.add_argument("workspace", type=Path)

    bp_cmd = sub.add_parser(
        "build-package", help="rebuild an FBU/MPU/FCU/CLU package"
    )
    bp_cmd.add_argument("workspace", type=Path)
    bp_cmd.add_argument("output", type=Path)
    return parser


def main() -> int:
    parser = make_parser()
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            inspect_isp(args.input)
        elif args.command == "extract":
            extract_isp(args.input, args.workspace, force=args.force)
        elif args.command == "build":
            write_isp(args.workspace, args.output)
        elif args.command == "bundle":
            result = build_bundle(args.workspace, args.output_dir, args.output_name)
            print(result)
        elif args.command == "extract-package":
            extract_package(args.input, args.workspace)
        elif args.command == "build-package":
            build_package(args.workspace, args.output)
        else:
            parser.error("unknown command")
    except (CodecError, OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
