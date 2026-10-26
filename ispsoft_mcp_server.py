"""MCP tools for conservative, offline-first Delta ISPSoft workflows.

The server distinguishes source transformation from vendor compilation. It
never reports a transformed file as compiled, downloaded, or PLC-verified.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from ispsoft_mcp import containers, dvp, packages
from ispsoft_mcp.limits import FileTransformError, atomic_write, read_bytes


SERVER_NAME = "ispsoft"
ISPSOFT_EXE_ENV = "ISPSOFT_EXE"
LIVE_WRITES_ENV = "ISPSOFT_WRITES_ENABLED"
WORK_DIR = Path.home() / "Documents" / "Codex-ISPSoft"
APP_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Delta Industrial Automation\ISPSoft 3.24\NewISPSoft.exe"),
    Path(r"C:\Program Files\Delta Industrial Automation\ISPSoft\NewISPSoft.exe"),
)
MODEL_PROFILES: dict[str, dict[str, Any]] = {
    "AS228T": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "AS228P": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "AS228R": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "ES2": {"family": "DVP", "project_model": "ES2", "source_container": "ISPSoft 3.24 v8 pointer/footer", "pou_exchange": "MPU", "languages": ["LD", "ST", "IL"]},
    "DVP12SE11R": {"family": "DVP", "pou_exchange": "MPU", "languages": ["LD", "IL"]},
    "DVP12SE11T": {"family": "DVP", "pou_exchange": "MPU", "languages": ["LD", "IL"]},
}
DEVICE_RE = re.compile(r"(?<![A-Z0-9_])(X|Y|M|S|T|C|D|V|Z|R)\s*(\d+)(?![A-Z0-9_])", re.I)
WRITE_OPS = {"OUT", "SET", "RST", "MOV", "DMOV", "DADD", "DSUB", "DMUL", "INC", "DEC", "ZRST"}

mcp = FastMCP(SERVER_NAME)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _model(model: str) -> tuple[str | None, str | None]:
    if not isinstance(model, str) or not model.strip():
        return None, "model must be a non-empty exact ISPSoft model name."
    key = re.sub(r"[- /]", "", model.strip().upper())
    aliases = {re.sub(r"[- /]", "", item): item for item in MODEL_PROFILES}
    canonical = aliases.get(key)
    if canonical is None:
        return None, f"Model {model!r} has no qualified MCP profile. Supported exact profiles: {', '.join(MODEL_PROFILES)}."
    return canonical, None


def _exe() -> Path | None:
    explicit = os.environ.get(ISPSOFT_EXE_ENV)
    if explicit:
        path = Path(explicit).expanduser()
        return path if path.is_file() else None
    return next((p for p in APP_CANDIDATES if p.is_file()), None)


def _process_running(name: str) -> bool:
    if sys.platform != "win32":
        return False
    try:
        result = subprocess.run(["tasklist", "/fo", "csv", "/nh"], capture_output=True,
                                text=True, timeout=5, check=False)
        return any(line.lower().startswith('"' + name.lower() + '"') for line in result.stdout.splitlines())
    except (OSError, subprocess.SubprocessError):
        return False


def _artifact_path(prefix: str, suffix: str) -> Path:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = WORK_DIR / f"{prefix}-{stamp}{suffix}"
    if path.exists():
        raise FileTransformError("Artifact name collision; retry the operation.")
    return path


def _write_new(path: str | Path, data: bytes, inputs: tuple[Path, ...] = ()) -> Path:
    target = Path(path).expanduser().absolute()
    if not target.parent.is_dir():
        raise FileTransformError("Output parent directory must already exist.")
    return atomic_write(target, data, inputs)


def _write_project_candidate_and_backup(source_path: Path, target: Path,
                                         original: bytes, candidate: bytes) -> tuple[Path, Path, Path | None]:
    backup = target.with_name(target.stem + '.before' + source_path.suffix)
    companion = source_path.with_suffix('.ini')
    target_companion = target.with_suffix('.ini')
    backup_companion = backup.with_suffix('.ini')
    if target.exists() or backup.exists() or target_companion.exists() or backup_companion.exists():
        raise FileTransformError('Candidate, backup, or companion path already exists; refusing to overwrite.')
    _write_new(backup, original, (source_path,))
    _write_new(target, candidate, (source_path, backup))
    if companion.is_file():
        companion_data = read_bytes(companion)
        _write_new(backup_companion, companion_data, (companion,))
        _write_new(target_companion, companion_data, (companion, backup_companion))
        return target, backup, target_companion
    return target, backup, None


def _cross_refs(source: str) -> list[dict[str, Any]]:
    references: dict[str, dict[str, Any]] = {}
    for line_no, line in enumerate(source.splitlines(), 1):
        code = re.sub(r"\(\*.*?\*\)|//.*$", "", line).strip()
        if not code:
            continue
        op = code.split(None, 1)[0].upper().rstrip(":")
        matches = list(DEVICE_RE.finditer(code))
        for index, match in enumerate(matches):
            address = f"{match.group(1).upper()}{match.group(2)}"
            item = references.setdefault(address, {"address": address, "reads": [], "writes": []})
            # For common IL instructions the last device operand is a destination.
            assignment_target = code[match.end():].lstrip().startswith((':=', '='))
            destination = assignment_target or (op in WRITE_OPS and index == len(matches) - 1)
            item["writes" if destination else "reads"].append({"line": line_no, "instruction": op})
    return [references[key] for key in sorted(references)]


def _project_comment_map(source: str) -> dict[str, str]:
    match = re.search(
        r'(?is)(?:<DEVICE_CMT_START>\r*\n|\[DEVICE_CMT_START\]\r*\n)(.*?)(?:</DEVICE_CMT_START>|\[DEVICE_CMT_END\])',
        source)
    if not match:
        return {}
    result: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if '::' not in line:
            continue
        address, comment = line.split('::', 1)
        result[address.strip().upper()] = comment.strip()
    return result


@mcp.tool()
def ispsoft_get_status() -> str:
    """Report ISPSoft/COMMGR installation and process state without changing it."""
    exe = _exe()
    return _json({
        "ispsoft_installed": exe is not None,
        "ispsoft_executable": str(exe) if exe else None,
        "ispsoft_running": _process_running("NewISPSoft.exe"),
        "commgr_running": _process_running("COMMGR.exe"),
        "ide_automation": "not qualified; MCP will not claim build/check results",
        "online_transport": "not qualified; no device I/O is enabled",
        "live_writes_enabled": os.environ.get(LIVE_WRITES_ENV, "").strip().lower() in {"1", "true", "yes"},
    })


@mcp.tool()
def ispsoft_list_supported_plc_types() -> str:
    """List exact model profiles and the file operations qualified for each."""
    return _json({
        "profiles": MODEL_PROFILES,
        "limitations": [
            "AS source transformation is qualified only for AS228T/P/R v3010 containers.",
            "DVP LD/IL POU exchange is qualified for ES2 and DVP12SE11R/T MPU generation.",
            "These source operations do not compile or download a PLC program.",
            "AH and other models are rejected until an exact profile is qualified.",
        ],
    })


@mcp.tool()
def ispsoft_inspect_project(project_path: str) -> str:
    """Inspect a supported, unprotected .isp/.bak project container read-only."""
    try:
        container = containers.read_container(project_path)
        result = containers.inspect(container)
        result.update(success=True, path=str(Path(project_path).expanduser().resolve()),
                      project_sha256=_sha(read_bytes(project_path)))
        return _json(result)
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc),
                      "supported_formats": "known unprotected ISPSoft streams 0xAA/0xAC and qualified AS228 v3010",
                      "path": project_path})


@mcp.tool()
def ispsoft_read_project_source(project_path: str) -> str:
    """Read source sections and POU metadata from a supported .isp/.bak file."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        info = containers.inspect(container)
        return _json({"success": True, "path": str(Path(project_path).resolve()),
                      "encoding": container.encoding, "newline": repr(container.newline),
                      "project": info, "source": source})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "path": project_path})


@mcp.tool()
def ispsoft_get_project_overview(project_path: str) -> str:
    """Summarize project model, task/program assignments, POUs and comments."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        info = containers.inspect(container)
        tasks = []
        for match in containers.sections(source, 'TASK'):
            body = match.group(1)
            task_id = re.search(r'(?m)^T_ID=(\d+)', body)
            program = re.search(r'(?m)^T_PName=([^\r\n]*)', body)
            tasks.append({"id": int(task_id.group(1)) if task_id else None,
                          "program": program.group(1).strip() if program else None})
        comments = _project_comment_map(source)
        return _json({"success": True, "path": str(Path(project_path).resolve()),
                      "model": info.get("project_model"), "pous": info.get("pous", []),
                      "tasks": tasks, "device_comment_count": len(comments),
                      "project_sha256": _sha(read_bytes(project_path))})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "path": project_path})


@mcp.tool()
def ispsoft_read_pou(project_path: str, pou_name: str) -> str:
    """Read one POU's native source sections without interpreting opaque LD nodes."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        candidates = [match for match in containers.sections(source, 'POU')
                      if containers.property_value(match.group(1), 'P_Name') == pou_name]
        if len(candidates) != 1:
            raise FileTransformError(f"Expected one POU named {pou_name!r}; found {len(candidates)}")
        body = candidates[0].group(1)
        section_tags = ('LOCAL_VAR', 'IL_ST_CODE', 'NETWORK_START', 'NETWORK_END')
        sections: dict[str, list[str]] = {}
        for tag in section_tags:
            sections[tag] = [match.group(1) for match in containers.sections(body, tag)]
        return _json({"success": True, "name": pou_name,
                      "language": containers.property_value(body, 'P_Lang'),
                      "type": containers.property_value(body, 'P_type'),
                      "sections": sections,
                      "note": "LD network sections are returned as native project text; no semantic rung decode is claimed."})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "pou_name": pou_name})


@mcp.tool()
def ispsoft_get_cross_references(project_path: str, pou_name: str) -> str:
    """Extract a text-based device reference list from one POU."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        pous = [match.group(1) for match in containers.sections(source, 'POU')
                if containers.property_value(match.group(1), 'P_Name') == pou_name]
        if len(pous) != 1:
            raise FileTransformError(f"Expected one POU named {pou_name!r}; found {len(pous)}")
        body = pous[0]
        code = '\n'.join(match.group(1) for match in containers.sections(body, 'IL_ST_CODE'))
        if not code.strip():
            code = '\n'.join(match.group(0) for match in re.finditer(
                r'(?is)<NETWORK_START>.*?</NETWORK_END>', body))
        result = _cross_refs(code)
        return _json({"success": True, "pou_name": pou_name,
                      "analysis_kind": "best-effort textual cross-reference",
                      "references": result, "unique_device_count": len(result)})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "pou_name": pou_name})


@mcp.tool()
def ispsoft_get_memory_usage_map(project_path: str) -> str:
    """Read declared device ranges from the project's SYSTEM_VAR section."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        sections = containers.sections(source, 'SYSTEM_VAR')
        if len(sections) != 1:
            raise FileTransformError('Expected exactly one SYSTEM_VAR section.')
        ranges = []
        for line in sections[0].group(1).splitlines():
            match = re.fullmatch(r'\s*<([A-Z])>(\d+)-(\d+)\s*', line.strip(), re.I)
            if not match:
                continue
            area, start, end = match.group(1).upper(), int(match.group(2)), int(match.group(3))
            if start > end:
                raise FileTransformError(f'Invalid SYSTEM_VAR range for {area}: {start}-{end}')
            ranges.append({"area": area, "start": start, "end": end, "capacity": end - start + 1})
        if not ranges:
            raise FileTransformError('No recognized device ranges in SYSTEM_VAR.')
        return _json({"success": True, "model": containers.inspect(container).get('project_model'),
                      "ranges": ranges, "source": "project SYSTEM_VAR; not a full hardware catalog"})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "project_path": project_path})


@mcp.tool()
def ispsoft_read_device_comments(project_path: str) -> str:
    """Read the project-level DEVICE_CMT section from a supported project."""
    try:
        container = containers.read_container(project_path)
        comments = _project_comment_map(container.source.decode(container.encoding))
        return _json({"success": True, "path": str(Path(project_path).resolve()),
                      "count": len(comments), "device_comments": comments})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "path": project_path})


@mcp.tool()
def ispsoft_open_project(project_path: str) -> str:
    """Ask Windows to open a supported project in its registered ISPSoft app."""
    path = Path(project_path).expanduser().resolve()
    try:
        containers.read_container(path)
        if sys.platform != 'win32':
            return _json({"success": False, "status": "WINDOWS_REQUIRED", "project_path": str(path)})
        os.startfile(str(path))  # type: ignore[attr-defined]
        return _json({"success": True, "status": "OPEN_REQUESTED_UNVERIFIED",
                      "project_path": str(path),
                      "message": "Windows received the file-open request; the active ISPSoft project was not inspected."})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "status": "OPEN_FAILED", "error": str(exc), "project_path": str(path)})


@mcp.tool()
def ispsoft_write_st_candidate(project_path: str, pou_name: str, code: str,
                               model: str, output_path: str = "") -> str:
    """Create a new ST-patched .isp candidate and original backup; never edits input."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": model_error})
    if "ST" not in MODEL_PROFILES[canonical]["languages"]:
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": "ST project patching is not qualified for this model."})
    if not isinstance(code, str) or not code.strip() or len(code.encode("utf-8")) > 1_000_000:
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": "code must be non-empty and no larger than 1 MB."})
    try:
        source_path = Path(project_path).expanduser().resolve(strict=True)
        original = read_bytes(source_path)
        container = containers.read_container(source_path)
        info = containers.inspect(container)
        metadata = str(info.get("project_model") or "").upper()
        expected_metadata = MODEL_PROFILES[canonical].get("project_model")
        if expected_metadata and metadata != expected_metadata:
            raise FileTransformError(f"Project metadata {metadata!r} conflicts with selected model {canonical}.")
        if canonical.startswith("AS228") and metadata and metadata not in ("AS", "AS228T", "AS228P", "AS228R"):
            raise FileTransformError(f"Project metadata {metadata!r} conflicts with selected model {canonical}.")
        pou_info = [p for p in info["pous"] if p["name"] == pou_name]
        if len(pou_info) != 1 or pou_info[0].get("language") != "2":
            raise FileTransformError("The named POU is not an ST POU in the supported source representation.")
        patched = containers.patch_st(container, pou_name, code, None)
        verified = containers.decode(patched)
        verified_info = containers.inspect(verified)
        matches = [p for p in verified_info["pous"] if p["name"] == pou_name]
        if len(matches) != 1 or code.strip() not in verified.source.decode(verified.encoding):
            raise FileTransformError("Candidate readback does not contain the requested POU source.")
        if output_path.strip():
            target = Path(output_path).expanduser().absolute()
            if not target.parent.is_dir():
                raise FileTransformError("Output parent directory must already exist.")
        else:
            target = _artifact_path(f"{source_path.stem}-{pou_name}-candidate", ".isp")
        target, backup_path, companion_path = _write_project_candidate_and_backup(
            source_path, target, original, patched)
        return _json({"status": "GENERATED_UNCOMPILED", "candidate": str(target),
                      "backup": str(backup_path), "candidate_companion": str(companion_path) if companion_path else None,
                      "model": canonical, "pou_name": pou_name,
                      "source_sha256": _sha(verified.source),
                      "vendor_compile": "NOT_RUN: ISPSoft native build/check automation is not qualified",
                      "plc_download": "NOT_RUN"})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"status": "CANDIDATE_FAILED", "error": str(exc)})


@mcp.tool()
def ispsoft_validate_il(program: str, pou_name: str, model: str) -> str:
    """Validate the supported DVP IL subset and confirm it serializes to MPU."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"valid": False, "errors": [model_error], "warnings": []})
    if MODEL_PROFILES[canonical].get("pou_exchange") != "MPU":
        return _json({"valid": False, "errors": ["IL-to-MPU conversion is not qualified for this model."], "warnings": []})
    try:
        parsed = dvp.parse_il(program)
        artifact, detail = dvp.il_to_mpu(program, pou_name, "cp1252")
        back, back_detail = dvp.mpu_to_il(artifact, "cp1252")
        if not back.strip():
            raise FileTransformError("Generated MPU has no readable ladder logic.")
        return _json({"valid": True, "model": canonical, "instruction_count": len(parsed),
                      "instructions": [{"opcode": op, "operands": operands} for op, operands in parsed],
                      "network_count": detail.get("network_count"), "mpu_bytes": len(artifact),
                      "roundtrip_il": back, "warnings": detail.get("warnings", []) + back_detail.get("warnings", [])})
    except (FileTransformError, ValueError) as exc:
        return _json({"valid": False, "errors": [str(exc)], "warnings": []})


@mcp.tool()
def ispsoft_generate_mpu(program: str, pou_name: str, model: str, output_path: str = "") -> str:
    """Generate a DVP LD POU package (.mpu) from validated IL and verify readback."""
    validation = json.loads(ispsoft_validate_il(program, pou_name, model))
    if not validation.get("valid"):
        return _json({"status": "REJECTED_BEFORE_WRITE", "errors": validation.get("errors")})
    canonical, _ = _model(model)
    try:
        data, details = dvp.il_to_mpu(program, pou_name, "cp1252")
        restored, _ = dvp.mpu_to_il(data, "cp1252")
        if restored.strip() != validation["roundtrip_il"].strip():
            raise FileTransformError("MPU readback differs from validation round-trip.")
        if output_path.strip():
            target = _write_new(output_path, data)
        else:
            target = _write_new(_artifact_path(f"{canonical}-{pou_name}", ".mpu"), data)
        return _json({"status": "SUCCESS_ARTIFACT_ONLY", "mpu_path": str(target),
                      "model": canonical, "pou_name": pou_name, "network_count": details["network_count"],
                      "bytes": len(data), "sha256": _sha(data), "roundtrip_verified": True,
                      "vendor_compile": "NOT_RUN", "project_import": "NOT_RUN"})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"status": "WRITE_FAILED", "error": str(exc)})


@mcp.tool()
def ispsoft_read_mpu(package_path: str, model: str) -> str:
    """Read a supported DVP MPU ladder POU as normalized IL."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"success": False, "error": model_error})
    if MODEL_PROFILES[canonical]["family"] != "DVP":
        return _json({"success": False, "error": "MPU decoding is only qualified for DVP12SE11R/T."})
    try:
        data = read_bytes(package_path)
        il, details = dvp.mpu_to_il(data, "cp1252")
        prefix, members = packages.unpack(data)
        return _json({"success": True, "model": canonical, "path": str(Path(package_path).resolve()),
                      "il": il, "network_count": details.get("network_count"),
                      "member_names": sorted(members), "package_prefix_bytes": len(prefix),
                      "warnings": details.get("warnings", [])})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "path": package_path})


@mcp.tool()
def ispsoft_analyze_source(source: str) -> str:
    """Return a best-effort device cross-reference and memory-use inventory."""
    if not isinstance(source, str) or len(source) > 2_000_000:
        return _json({"success": False, "error": "source must be text no larger than 2 MB."})
    refs = _cross_refs(source)
    by_area: dict[str, int] = {}
    for item in refs:
        by_area[item["address"][0]] = by_area.get(item["address"][0], 0) + 1
    return _json({"success": True, "analysis_kind": "textual cross-reference; not vendor semantic analysis",
                  "devices": refs, "unique_device_count": len(refs), "devices_by_area": by_area})


@mcp.tool()
def ispsoft_validate_device_comments(device_comments: dict[str, str], model: str,
                                     output_path: str = "") -> str:
    """Validate DVP-style device/comment pairs and optionally save a JSON artifact."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"valid": False, "errors": [model_error]})
    if MODEL_PROFILES[canonical]["family"] != "DVP":
        return _json({"valid": False, "errors": ["Device-comment profile is only qualified for the DVP MPU target models."]})
    if not isinstance(device_comments, dict) or not device_comments:
        return _json({"valid": False, "errors": ["device_comments must be a non-empty mapping."]})
    normalized: dict[str, str] = {}
    errors: list[str] = []
    for address, comment in device_comments.items():
        match = re.fullmatch(r"\s*(X|Y|M|S|T|C|D|V|Z|R)\s*(\d+)\s*", str(address), re.I)
        if not match:
            errors.append(f"Unsupported DVP device address: {address!r}")
            continue
        key = f"{match.group(1).upper()}{int(match.group(2))}"
        if key in normalized:
            errors.append(f"Duplicate normalized address: {key}")
        if not isinstance(comment, str) or not comment.strip() or len(comment) > 64 or any(ord(ch) < 32 for ch in comment):
            errors.append(f"Invalid comment for {key}: use 1-64 printable characters.")
            continue
        normalized[key] = comment.strip()
    if errors:
        return _json({"valid": False, "errors": errors})
    if not output_path.strip():
        return _json({"valid": True, "model": canonical, "comments": normalized,
                      "artifact_status": "not_saved; ISPSoft comment import format is not qualified"})
    try:
        content = _json({"format": "ispsoft-device-comments-v1", "model": canonical,
                          "comments": normalized}).encode("utf-8")
        target = _write_new(output_path, content)
        return _json({"valid": True, "model": canonical, "count": len(normalized),
                      "artifact": str(target), "artifact_status": "JSON mapping only; not an ISPSoft import file"})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"valid": False, "errors": [str(exc)]})


@mcp.tool()
def ispsoft_write_device_comment_candidate(project_path: str, device_comments: dict[str, str],
                                           model: str, output_path: str = "") -> str:
    """Merge comments into an ES2 project and emit a verified, uncompiled candidate."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": model_error})
    if canonical != 'ES2':
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": "Project comment editing is qualified only for the DVP ES2 source layout."})
    validation = json.loads(ispsoft_validate_device_comments(device_comments, canonical))
    if not validation.get('valid'):
        return _json({"status": "REJECTED_BEFORE_WRITE", "errors": validation.get('errors')})
    try:
        source_path = Path(project_path).expanduser().resolve(strict=True)
        original = read_bytes(source_path)
        container = containers.read_container(source_path)
        source = container.source.decode(container.encoding)
        if containers.inspect(container).get('project_model') != 'ES2':
            raise FileTransformError('Project metadata does not match the DVP ES2 profile.')
        comment_sections = list(re.finditer(
            r'(?is)(?:<DEVICE_CMT_START>\r*\n|\[DEVICE_CMT_START\]\r*\n)(.*?)(?:</DEVICE_CMT_START>|\[DEVICE_CMT_END\])',
            source))
        if len(comment_sections) != 1:
            raise FileTransformError('Expected exactly one supported DEVICE_CMT_START section.')
        comments = _project_comment_map(source)
        comments.update({key.upper(): value.strip() for key, value in device_comments.items()})
        ordered = sorted(comments.items(), key=lambda pair: (pair[0][0], int(re.search(r'\d+', pair[0]).group())))
        body = container.newline.join(f'{address}::{comment}' for address, comment in ordered)
        match = comment_sections[0]
        updated = source[:match.start(1)] + body + source[match.end(1):]
        candidate_bytes = container.rebuild(updated.encode(container.encoding))
        check = containers.decode(candidate_bytes)
        actual_comments = _project_comment_map(check.source.decode(check.encoding))
        if actual_comments != comments:
            raise FileTransformError('Candidate comment readback differs from the requested map.')
        if output_path.strip():
            target = Path(output_path).expanduser().absolute()
            if not target.parent.is_dir():
                raise FileTransformError('Output parent directory must already exist.')
        else:
            target = _artifact_path(f'{source_path.stem}-comments-candidate', '.isp')
        target, backup, companion_path = _write_project_candidate_and_backup(
            source_path, target, original, candidate_bytes)
        return _json({"status": "GENERATED_UNCOMPILED", "candidate": str(target),
                      "backup": str(backup), "candidate_companion": str(companion_path) if companion_path else None,
                      "model": canonical, "comment_count": len(comments),
                      "readback_verified": True, "vendor_compile": "NOT_RUN", "plc_download": "NOT_RUN"})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"status": "CANDIDATE_FAILED", "error": str(exc)})


@mcp.tool()
def ispsoft_compile_and_check(project_path: str) -> str:
    """Report native compile/check availability; never infer success from parsing."""
    return _json({"success": False, "status": "NOT_AVAILABLE",
                  "error": "ISPSoft 3.24 native Compile/Check automation is not qualified. Open the candidate in ISPSoft and run Compile All/Check Program manually.",
                  "project_path": project_path, "vendor_compile": "NOT_RUN"})


@mcp.tool()
def ispsoft_online_status(model: str) -> str:
    """Report transport qualification for an exact model without connecting."""
    canonical, error = _model(model)
    if error:
        return _json({"connected": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"connected": False, "status": "TRANSPORT_NOT_QUALIFIED",
                  "model": canonical, "commgr_running": _process_running("COMMGR.exe"),
                  "message": "COMMGR presence alone does not prove a PLC connection; online transport is disabled."})


@mcp.tool()
def ispsoft_runtime_read(model: str, addresses: list[str]) -> str:
    """Read live values only after a model-specific transport implementation is qualified."""
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "addresses": addresses, "error": "No live protocol implementation is qualified; no device was contacted."})


@mcp.tool()
def ispsoft_runtime_write(model: str, values: dict[str, Any], confirm_live_write: bool = False) -> str:
    """Guarded placeholder for live writes; no device writes are currently qualified."""
    enabled = os.environ.get(LIVE_WRITES_ENV, "").strip().lower() in {"1", "true", "yes"}
    if not confirm_live_write or not enabled:
        return _json({"success": False, "status": "BLOCKED", "confirm_live_write": confirm_live_write,
                      "environment_enabled": enabled, "required_environment_variable": LIVE_WRITES_ENV})
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "values": values, "error": "Both safeguards are enabled, but live writes are not implemented; no device was contacted."})


@mcp.tool()
def ispsoft_download(project_path: str, model: str, confirm_download: bool = False) -> str:
    """Guarded placeholder for a PLC download; the transport is intentionally disabled."""
    enabled = os.environ.get(LIVE_WRITES_ENV, "").strip().lower() in {"1", "true", "yes"}
    if not confirm_download or not enabled:
        return _json({"success": False, "status": "BLOCKED", "confirm_download": confirm_download,
                      "environment_enabled": enabled, "required_environment_variable": LIVE_WRITES_ENV})
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "project_path": project_path, "error": "PLC download is not implemented; no device was contacted."})


if __name__ == "__main__":
    mcp.run(transport="stdio")
