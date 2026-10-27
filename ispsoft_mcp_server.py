"""MCP tools for conservative, offline-first Delta ISPSoft workflows.

The server distinguishes source transformation from vendor compilation. It
never reports a transformed file as compiled, downloaded, or PLC-verified.
"""
from __future__ import annotations

import datetime as dt
import csv
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
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
COMMGR_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIATools\COMMGR 2.11\COMMGR.exe"),
)
DVP_ES2_SIMULATOR_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIATools\COMMGR 2.11\Simulator\DVPSimulator_ES2.exe"),
)
DEFAULT_ISPSOFT_ROOT = Path(r"C:\Program Files (x86)\Delta Industrial Automation\ISPSoft 3.24")
MODEL_PROFILES: dict[str, dict[str, Any]] = {
    "AS228T": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "AS228P": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "AS228R": {"family": "AS", "source_container": "qualified v3010", "languages": ["ST"]},
    "ES2": {"family": "DVP", "project_model": "ES2", "source_container": "ISPSoft 3.24 v8 pointer/footer", "pou_exchange": "MPU", "languages": ["LD", "ST", "IL"], "qualification": "offline container and candidate transforms only"},
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
    # ISPSoft's device catalog names the series ES2; the user's DVP32ES2
    # transistor controller uses that project/device series profile.
    aliases.update({"DVP32ES2": "ES2", "DVP32ES2T": "ES2"})
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


def _ispsoft_root() -> Path | None:
    exe = _exe()
    if exe is not None:
        return exe.parent
    return DEFAULT_ISPSOFT_ROOT if DEFAULT_ISPSOFT_ROOT.is_dir() else None


def _installed_device_catalog() -> dict[str, Any]:
    """Read ISPSoft's own installed model catalog without inferring capabilities."""
    root = _ispsoft_root()
    path = root / "Network_Configuration" / "Devices" / "Devices.ini" if root else None
    families: dict[str, list[str]] = {}
    sources: list[str] = []
    errors: list[str] = []
    if path is not None and path.is_file():
        sources.append(str(path))
    else:
        path = None
    ddf_path = root / "DIACommission" / "DataTracer" / "DeviceData" / "DDF" / "Device.xml" if root else None
    if ddf_path is not None and ddf_path.is_file():
        sources.append(str(ddf_path))
    else:
        ddf_path = None
    if not sources:
        return {"available": False, "sources": [], "families": {}}
    if path:
        family: str | None = None
        try:
            text = path.read_text(encoding="cp1252", errors="replace")
            for line in text.splitlines():
                match = re.match(r"^\[([^\]]+)\]", line)
                if not match:
                    continue
                name = match.group(1).strip()
                if name == "DVP-Series":
                    family = "DVP"
                    families.setdefault(family, [])
                elif name == "AH-Series":
                    family = "AH"
                    families.setdefault(family, [])
                elif name in ("PLC", "All_Devices", "DMV", "TP", "DVP-Modules", "AH-Modules", "MODBUS Device"):
                    family = None
                elif family:
                    # Entries sometimes contain aliases separated by a backslash.
                    for model_name in name.split("\\"):
                        model_name = model_name.strip()
                        if model_name and model_name not in families[family]:
                            families[family].append(model_name)
        except OSError as exc:
            errors.append(f"{path}: {exc}")
    if ddf_path:
        try:
            xml_root = ET.parse(ddf_path).getroot()
            as_models = families.setdefault("AS", [])
            for device in xml_root.iter():
                if (device.tag.rsplit("}", 1)[-1] == "Device" and
                        device.get("ProdClass") == "PLC" and
                        device.get("ProdFuncName") == "CPU"):
                    model_name = device.get("ProdType")
                    if (model_name and model_name != "Unknown" and "simulator" not in model_name.casefold()
                            and model_name not in as_models):
                        as_models.append(model_name)
            as_models.sort()
        except (OSError, ET.ParseError) as exc:
            errors.append(f"{ddf_path}: {exc}")
    for model_list in families.values():
        model_list.sort()
    return {"available": bool(families), "sources": sources, "families": families,
            "errors": errors,
            "note": "Installed ISPSoft catalog only; listing a model does not qualify MCP operations."}


def _installed_simulators() -> list[dict[str, str]]:
    root = _ispsoft_root()
    simulator_dir = root.parent / "DIAStudio" / "DIATools" / "COMMGR 2.11" / "Simulator" if root else None
    if simulator_dir is None or not simulator_dir.is_dir():
        return []
    return [{"name": path.stem, "path": str(path)} for path in sorted(simulator_dir.glob("*.exe"))]


def _installed(candidates: tuple[Path, ...]) -> Path | None:
    return next((path for path in candidates if path.is_file()), None)


def _process_running(name: str) -> bool:
    if sys.platform != "win32":
        return False


def _process_ids(name: str) -> list[int]:
    if sys.platform != "win32":
        return []
    try:
        result = subprocess.run(["tasklist", "/fo", "csv", "/nh", "/fi", f"IMAGENAME eq {name}"],
                                capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return []
    pids: list[int] = []
    for row in csv.reader(result.stdout.splitlines()):
        if len(row) >= 2 and row[0].casefold() == name.casefold() and row[1].isdigit():
            pids.append(int(row[1]))
    return pids


def _ide_windows() -> list[dict[str, Any]]:
    """Enumerate ISPSoft top-level windows without assuming the app is visible."""
    if sys.platform != "win32":
        return []
    pids = set(_process_ids("NewISPSoft.exe"))
    if not pids:
        return []
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    windows: list[dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def inspect(hwnd: int, _lparam: int) -> bool:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        length = max(1, user32.GetWindowTextLengthW(hwnd) + 1)
        title = ctypes.create_unicode_buffer(length)
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, length)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        windows.append({"handle": int(hwnd), "pid": pid.value, "title": title.value,
                        "class_name": class_name.value,
                        "visible": bool(user32.IsWindowVisible(hwnd)),
                        "minimized": bool(user32.IsIconic(hwnd))})
        return True

    callback = callback_type(inspect)
    user32.EnumWindows(callback, 0)
    return windows


def _ide_session() -> dict[str, Any]:
    running = _process_running("NewISPSoft.exe")
    windows = _ide_windows() if running else []
    visible = [window for window in windows if window["visible"] and not window["minimized"]]
    if visible:
        diagnosis = "VISIBLE_WINDOW"
    elif windows:
        diagnosis = "WINDOW_HIDDEN_OR_MINIMIZED"
    elif running:
        diagnosis = "PROCESS_WITHOUT_TOP_LEVEL_WINDOW"
    else:
        diagnosis = "PROCESS_NOT_RUNNING"
    return {"process_running": running, "process_ids": _process_ids("NewISPSoft.exe"),
            "windows": windows, "visible_window_count": len(visible), "diagnosis": diagnosis}
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
    companion_data = read_bytes(companion) if companion.is_file() else None
    if target.exists() or backup.exists() or target_companion.exists() or backup_companion.exists():
        raise FileTransformError('Candidate, backup, or companion path already exists; refusing to overwrite.')
    created: list[Path] = []
    try:
        _write_new(backup, original, (source_path,))
        created.append(backup)
        _write_new(target, candidate, (source_path, backup))
        created.append(target)
        if companion_data is not None:
            _write_new(backup_companion, companion_data, (companion,))
            created.append(backup_companion)
            _write_new(target_companion, companion_data, (companion, backup_companion))
            created.append(target_companion)
            return target, backup, target_companion
        return target, backup, None
    except Exception:
        # These paths were checked absent and are exclusively ours. Remove any
        # partial artifact set so a failed candidate cannot look complete.
        for path in reversed(created):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


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
    simulator = _installed(DVP_ES2_SIMULATOR_CANDIDATES)
    simulators = _installed_simulators()
    return _json({
        "ispsoft_installed": exe is not None,
        "ispsoft_executable": str(exe) if exe else None,
        "ispsoft_running": _process_running("NewISPSoft.exe"),
        "ispsoft_version": "3.24" if exe and "3.24" in str(exe.parent) else None,
        "commgr_installed": _installed(COMMGR_CANDIDATES) is not None,
        "commgr_running": _process_running("COMMGR.exe"),
        "dvp_es2_simulator_installed": simulator is not None,
        "dvp_es2_simulator_executable": str(simulator) if simulator else None,
        "dvp_es2_simulator_running": _process_running(simulator.name) if simulator else False,
        "installed_simulators": simulators,
        "device_catalog_available": _installed_device_catalog()["available"],
        "active_ide_project": "not observable; no ISPSoft window/session integration is qualified",
        "ide_automation": "not qualified; MCP will not claim build/check results",
        "online_transport": "not qualified; no device I/O is enabled",
        "live_writes_enabled": os.environ.get(LIVE_WRITES_ENV, "").strip().lower() in {"1", "true", "yes"},
    })


@mcp.tool()
def ispsoft_list_supported_plc_types() -> str:
    """List installed ISPSoft models separately from MCP-qualified model profiles."""
    catalog = _installed_device_catalog()
    return _json({
        "profiles": MODEL_PROFILES,
        "model_aliases": {"DVP32ES2T": "ES2", "DVP32ES2": "ES2"},
        "installed_model_catalog": catalog,
        "capability_matrix": _capability_matrix(),
        "limitations": [
            "The installed model catalog is informational and does not qualify model-specific MCP operations.",
            "Candidate transformation support remains limited to the profiles below.",
            "Native compile/check, PLC transfer, online monitoring, and live device I/O are not qualified.",
        ],
    })


def _capability_matrix() -> dict[str, Any]:
    per_profile = {}
    for name, profile in MODEL_PROFILES.items():
        per_profile[name] = {
            "family": profile["family"],
            "languages": profile.get("languages", []),
            "project_inspection": "QUALIFIED_LIMITED",
            "st_candidate_generation": "QUALIFIED_LIMITED" if "ST" in profile.get("languages", []) else "NOT_QUALIFIED",
            "il_mpu_generation": "QUALIFIED_LIMITED" if profile.get("pou_exchange") == "MPU" else "NOT_QUALIFIED",
            "native_compile_check": "NOT_QUALIFIED",
            "plc_connection_upload_download": "NOT_QUALIFIED",
            "online_monitor_and_device_io": "NOT_QUALIFIED",
        }
    per_profile["DVP32ES2T"] = {**per_profile["ES2"], "profile_alias_of": "ES2"}
    return {
        "per_profile": per_profile,
        "project_inspection": {"status": "QUALIFIED_LIMITED", "formats": ["ISPSoft 3.24 v8 DVP pointer/footer", "legacy 0xAA/0xAC", "AS v3010"]},
        "source_candidate_generation": {"status": "QUALIFIED_LIMITED", "models": list(MODEL_PROFILES), "never_compiles": True},
        "project_template_clone": {"status": "QUALIFIED_LIMITED", "same_model_only": True, "native_compile": "NOT_QUALIFIED"},
        "native_blank_project_creation": {"status": "NOT_QUALIFIED"},
        "native_compile_check": {"status": "NOT_QUALIFIED"},
        "plc_connection": {"status": "NOT_QUALIFIED"},
        "upload_from_plc": {"status": "NOT_QUALIFIED"},
        "download_to_plc": {"status": "NOT_QUALIFIED", "write_guard": LIVE_WRITES_ENV},
        "online_monitor": {"status": "NOT_QUALIFIED"},
        "runtime_device_read": {"status": "NOT_QUALIFIED"},
        "runtime_device_write": {"status": "NOT_QUALIFIED", "write_guard": LIVE_WRITES_ENV},
    }


@mcp.tool()
def ispsoft_get_capabilities() -> str:
    """Return explicit MCP qualification separately from ISPSoft's installed catalog."""
    return _json({"server": SERVER_NAME, "ispsoft_root": str(_ispsoft_root()) if _ispsoft_root() else None,
                  "installed_model_catalog": _installed_device_catalog(),
                  "qualified_profiles": MODEL_PROFILES,
                  "model_aliases": {"DVP32ES2T": "ES2", "DVP32ES2": "ES2"},
                  "operations": _capability_matrix()})


@mcp.tool()
def ispsoft_list_projects(search_path: str = "", max_results: int = 100) -> str:
    """Find ISPSoft project files under a requested folder; report parseability per file."""
    if not isinstance(max_results, int) or isinstance(max_results, bool) or not 1 <= max_results <= 500:
        return _json({"success": False, "error": "max_results must be an integer from 1 to 500."})
    roots: list[Path] = []
    if search_path.strip():
        root = Path(search_path).expanduser()
        if not root.is_dir():
            return _json({"success": False, "error": "search_path must be an existing directory.", "search_path": search_path})
        roots.append(root.resolve())
    else:
        roots.append(WORK_DIR)
        install_root = _ispsoft_root()
        if install_root:
            examples = install_root / "Projects"
            if examples.is_dir():
                roots.append(examples)
    results: list[dict[str, Any]] = []
    errors: list[str] = []
    visited: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        try:
            candidates = sorted((p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in {".isp", ".bak"}),
                                key=lambda p: str(p).casefold())
        except OSError as exc:
            errors.append(f"{root}: {exc}")
            continue
        for path in candidates:
            key = str(path.resolve()).casefold()
            if key in visited:
                continue
            visited.add(key)
            record: dict[str, Any] = {"path": str(path), "bytes": path.stat().st_size}
            try:
                project = containers.read_container(path)
                info = containers.inspect(project)
                record.update(readable=True, model=info.get("project_model"), layout=project.layout,
                              pou_count=len(info.get("pous", [])), sha256=_sha(read_bytes(path)))
            except (OSError, FileTransformError, ValueError) as exc:
                record.update(readable=False, error=str(exc))
            results.append(record)
            if len(results) >= max_results:
                return _json({"success": True, "projects": results, "truncated": True, "errors": errors})
    return _json({"success": True, "projects": results, "truncated": False, "errors": errors})


@mcp.tool()
def ispsoft_create_project_from_template(template_path: str, output_path: str) -> str:
    """Create a new offline project copy from a user-selected matching template."""
    created: list[Path] = []
    try:
        template = Path(template_path).expanduser().resolve(strict=True)
        target = Path(output_path).expanduser().absolute()
        if template.suffix.lower() not in {".isp", ".bak"} or target.suffix.lower() != ".isp":
            raise FileTransformError("Template must be .isp/.bak and output must use the .isp extension.")
        project = containers.read_container(template)
        info = containers.inspect(project)
        if not target.parent.is_dir():
            raise FileTransformError("Output parent directory must already exist.")
        if target.resolve() == template:
            raise FileTransformError("Output path must differ from the selected template.")
        companion = template.with_suffix(".ini")
        target_companion = target.with_suffix(".ini")
        if target.exists() or target.is_symlink() or target_companion.exists() or target_companion.is_symlink():
            raise FileTransformError("Output project or companion already exists; refusing to overwrite.")
        _write_new(target, read_bytes(template), (template,))
        created.append(target)
        if companion.is_file():
            _write_new(target_companion, read_bytes(companion), (companion,))
            created.append(target_companion)
        copied = containers.read_container(target)
        if copied.source != project.source:
            raise FileTransformError("Created project readback differs from the template.")
        return _json({"status": "CREATED_FROM_TEMPLATE_UNCOMPILED", "project_path": str(target),
                      "template_path": str(template), "model": info.get("project_model"),
                      "layout": project.layout, "sha256": _sha(read_bytes(target)),
                      "companion_path": str(target_companion) if target_companion.exists() else None,
                      "readback_verified": True, "vendor_compile": "NOT_RUN", "plc_download": "NOT_RUN"})
    except (OSError, FileTransformError, ValueError) as exc:
        removed = True
        for path in reversed(created):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                removed = False
        return _json({"status": "CREATE_FAILED", "error": str(exc), "created_paths_removed": removed})


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
    simulator = _installed(DVP_ES2_SIMULATOR_CANDIDATES)
    simulator_running = _process_running(simulator.name) if simulator else False
    return _json({"connected": False, "status": "TRANSPORT_NOT_QUALIFIED",
                  "model": canonical, "commgr_running": _process_running("COMMGR.exe"),
                  "dvp_es2_simulator_installed": simulator is not None,
                  "dvp_es2_simulator_running": simulator_running,
                  "message": "COMMGR or simulator process presence alone does not prove an active ISPSoft connection; no live transport is qualified and no device was contacted."})


@mcp.tool()
def ispsoft_connect(model: str, commgr_driver: str) -> str:
    """Report that online connection is unavailable until the vendor adapter is qualified."""
    canonical, error = _model(model)
    if error:
        return _json({"connected": False, "status": "UNSUPPORTED_MODEL", "error": error})
    if not isinstance(commgr_driver, str) or not commgr_driver.strip():
        return _json({"connected": False, "status": "REJECTED_BEFORE_IO", "error": "commgr_driver must be the exact configured COMMGR driver name."})
    return _json({"connected": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "commgr_driver": commgr_driver, "device_contacted": False,
                  "error": "No qualified COMMGR adapter can establish or verify the active target connection."})


@mcp.tool()
def ispsoft_upload_from_plc(model: str, commgr_driver: str, output_path: str) -> str:
    """Fail closed: PLC-to-PC project transfer is not enabled without qualified vendor I/O."""
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "commgr_driver": commgr_driver, "output_path": output_path,
                  "device_contacted": False, "error": "Upload from PLC is not implemented; no device was contacted."})


@mcp.tool()
def ispsoft_start_monitor(model: str, commgr_driver: str) -> str:
    """Fail closed until ISPSoft monitor mode has a qualified connection and readback adapter."""
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "commgr_driver": commgr_driver, "monitoring": False, "device_contacted": False,
                  "error": "Monitor mode is not implemented; no device was contacted."})


@mcp.tool()
def ispsoft_stop_monitor() -> str:
    """Report monitor state; this server cannot currently enter monitor mode."""
    return _json({"success": True, "status": "ALREADY_OFFLINE", "monitoring": False,
                  "message": "No monitor session is owned by this server."})


@mcp.tool()
def ispsoft_runtime_read(model: str, addresses: list[str]) -> str:
    """Read live values only after a model-specific transport implementation is qualified."""
    canonical, error = _model(model)
    if error:
        return _json({"success": False, "status": "UNSUPPORTED_MODEL", "error": error})
    if not isinstance(addresses, list) or not addresses or len(addresses) > 200:
        return _json({"success": False, "status": "REJECTED_BEFORE_IO", "error": "addresses must contain 1-200 device addresses."})
    invalid = [str(address) for address in addresses
               if not isinstance(address, str) or not re.fullmatch(r"(?:X|Y|M|S|T|C|D|V|Z|R)\d+", address.strip(), re.I)]
    if invalid:
        return _json({"success": False, "status": "REJECTED_BEFORE_IO", "invalid_addresses": invalid})
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
    if not isinstance(values, dict) or not values or len(values) > 200:
        return _json({"success": False, "status": "REJECTED_BEFORE_IO", "error": "values must contain 1-200 device/value pairs."})
    invalid = [str(address) for address in values
               if not isinstance(address, str) or not re.fullmatch(r"(?:X|Y|M|S|T|C|D|V|Z|R)\d+", address.strip(), re.I)]
    if invalid:
        return _json({"success": False, "status": "REJECTED_BEFORE_IO", "invalid_addresses": invalid})
    return _json({"success": False, "status": "TRANSPORT_NOT_QUALIFIED", "model": canonical,
                  "addresses": list(values), "error": "Both safeguards are enabled, but live writes are not implemented; no device was contacted."})


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
