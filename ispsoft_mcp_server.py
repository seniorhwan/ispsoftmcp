"""MCP tools for conservative, offline-first Delta ISPSoft workflows.

The server distinguishes source transformation from vendor compilation. It
never reports a transformed file as compiled, downloaded, or PLC-verified.
"""
from __future__ import annotations

import datetime as dt
import ctypes
import ctypes.wintypes as wintypes
import configparser
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from ispsoft_mcp import containers, dvp, packages
from ispsoft_mcp.limits import FileTransformError, atomic_write, read_bytes


SERVER_NAME = "ispsoft"
ISPSOFT_EXE_ENV = "ISPSOFT_EXE"
LIVE_WRITES_ENV = "ISPSOFT_WRITES_ENABLED"
WORK_DIR = Path(os.environ.get("ISPSOFT_WORK_DIR", str(Path.home() / "Documents" / "Codex-ISPSoft"))).expanduser()
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
_BACKGROUND_IDE_SESSIONS: dict[str, dict[str, Any]] = {}


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
    return bool(_process_ids(name))


def _process_ids(name: str) -> list[int]:
    if sys.platform != "win32":
        return []
    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return []
    pids: list[int] = []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        has_entry = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while has_entry:
            if entry.szExeFile.casefold() == name.casefold():
                pids.append(int(entry.th32ProcessID))
            has_entry = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
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
    process_ids = _process_ids("NewISPSoft.exe")
    running = bool(process_ids)
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
    visible_windows = [window for window in windows if window["visible"] and not window["minimized"]]
    minimized_windows = [window for window in windows if window["visible"] and window["minimized"]]
    return {"process_running": running, "process_ids": process_ids,
            "windows": visible_windows, "window_count": len(windows),
            "all_windows": windows,
            "minimized_window_count": len(minimized_windows),
            "hidden_window_count": len(windows) - len(visible_windows) - len(minimized_windows),
            "visible_window_count": len(visible), "diagnosis": diagnosis}


def _configured_previous_project() -> Path | None:
    """Read ISPSoft's saved previous project only when its reopen flag is enabled."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    settings = Path(appdata) / "Delta Industrial Automation" / "ISPSoft_New" / "ISPSoft.ini"
    if not settings.is_file():
        return None
    config = configparser.ConfigParser(interpolation=None)
    try:
        with settings.open("r", encoding="cp1252") as stream:
            config.read_file(stream)
        if not config.getboolean("MainForm", "loadPreviousPrj", fallback=False):
            return None
        saved_path = config.get("Project", "ProjectName", fallback="").strip().strip('"')
        if not saved_path:
            saved_path = config.get("MainForm", "MRUfile0", fallback="").strip().strip('"')
        return Path(saved_path).expanduser() if saved_path else None
    except (OSError, configparser.Error, ValueError):
        return None


def _configured_previous_project_summary() -> dict[str, Any]:
    path = _configured_previous_project()
    if path is None:
        return {"configured": False, "active_state": "UNKNOWN"}
    result: dict[str, Any] = {"configured": True, "path": str(path), "active_state": "UNKNOWN"}
    try:
        resolved = path.resolve(strict=True)
        data = read_bytes(resolved)
        container = containers.read_container(resolved)
        info = containers.inspect(container)
        result.update(path=str(resolved), exists=True, readable=True,
                      project_model=info.get("project_model"), pou_count=len(info.get("pous", [])),
                      sha256=_sha(data))
    except (OSError, FileTransformError, ValueError) as exc:
        result.update(exists=path.exists(), readable=False, error=str(exc))
    return result


def _prepare_background_profile(profile_root: Path, project_path: Path) -> Path:
    """Create an ISPSoft per-worker settings profile pointing at a disposable project copy."""
    app_settings = profile_root / "Delta Industrial Automation" / "ISPSoft_New"
    app_settings.mkdir(parents=True, exist_ok=True)
    user_appdata = os.environ.get("APPDATA")
    user_settings = (Path(user_appdata) / "Delta Industrial Automation" / "ISPSoft_New"
                     if user_appdata else None)
    if user_settings is not None and user_settings.is_dir():
        for name in ("ISPSoft.ini", "ISPSoftBar.ini", "ISPSoftDock.ini"):
            source = user_settings / name
            if source.is_file():
                shutil.copy2(source, app_settings / name)
    config_path = app_settings / "ISPSoft.ini"
    config = configparser.ConfigParser(interpolation=None)
    if config_path.is_file():
        with config_path.open("r", encoding="cp1252") as stream:
            config.read_file(stream)
    if not config.has_section("MainForm"):
        config.add_section("MainForm")
    if not config.has_section("Project"):
        config.add_section("Project")
    config.set("MainForm", "loadPreviousPrj", "1")
    config.set("Project", "ProjectName", str(project_path))
    config.set("MainForm", "MRUfile0", str(project_path))
    with config_path.open("w", encoding="cp1252", newline="") as stream:
        config.write(stream)
    return profile_root


def _hide_ide_windows(process_id: int) -> None:
    """Hide only windows owned by an MCP-launched ISPSoft worker process."""
    if sys.platform != "win32":
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    for window in _ide_windows():
        if window["pid"] == process_id and window["visible"]:
            user32.ShowWindow(window["handle"], 0)  # SW_HIDE; never activate/focus the worker.


def _window_child_texts(window_handle: int, limit: int = 24) -> list[dict[str, str]]:
    """Read short standard control labels from one worker window for silent diagnostics."""
    if sys.platform != "win32":
        return []
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
    user32.EnumChildWindows.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    result: list[dict[str, str]] = []

    def inspect(hwnd: int, _lparam: int) -> bool:
        if len(result) >= limit:
            return False
        class_name = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        if class_name.value not in {"Static", "Button", "Edit", "TLabel", "TButton"}:
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if not length:
            return True
        text_buffer = ctypes.create_unicode_buffer(min(length + 1, 513))
        user32.GetWindowTextW(hwnd, text_buffer, len(text_buffer))
        text = text_buffer.value.strip()
        if text:
            result.append({"class_name": class_name.value, "text": text[:512]})
        return True

    callback = callback_type(inspect)
    user32.EnumChildWindows(window_handle, callback, 0)
    return result


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
        "configured_previous_project": _configured_previous_project_summary(),
        "active_ide_project": "not observable; a configured previous project is not proof of the project currently open",
        "ide_automation": "process/window detection and startup only; native build/check remains not qualified",
        "online_transport": "not qualified; no device I/O is enabled",
        "live_writes_enabled": os.environ.get(LIVE_WRITES_ENV, "").strip().lower() in {"1", "true", "yes"},
    })


@mcp.tool()
def ispsoft_get_ide_session() -> str:
    """Report the ISPSoft process and top-level windows observable to this server."""
    if sys.platform != "win32":
        return _json({"status": "WINDOWS_REQUIRED", "process_running": False,
                      "windows": [], "diagnosis": "UNSUPPORTED_PLATFORM"})
    try:
        session = _ide_session()
        session["status"] = "OBSERVED" if session["diagnosis"] == "VISIBLE_WINDOW" else "NOT_VISIBLE"
        session["inspection_scope"] = "process and top-level window metadata only; active project and editor state are not inspected"
        return _json(session)
    except (OSError, AttributeError, ctypes.ArgumentError) as exc:
        return _json({"status": "INSPECTION_FAILED", "error": str(exc),
                      "diagnosis": "WINDOW_ENUMERATION_FAILED"})


def _open_project_and_observe(project_path: str, wait_seconds: int) -> dict[str, Any]:
    """Open one exact project through its Windows file association and observe its title."""
    if sys.platform != "win32":
        return {"success": False, "status": "WINDOWS_REQUIRED"}
    if not isinstance(project_path, str) or not project_path.strip():
        return {"success": False, "status": "PROJECT_PATH_REQUIRED",
                "error": "A project path is required; ISPSoft will not be started blank."}
    if not isinstance(wait_seconds, int) or isinstance(wait_seconds, bool) or not 1 <= wait_seconds <= 60:
        return {"success": False, "status": "REJECTED_BEFORE_OPEN",
                "error": "wait_seconds must be an integer from 1 to 60."}
    try:
        path = Path(project_path).expanduser().resolve(strict=True)
        if path.suffix.lower() not in {".isp", ".bak"}:
            raise FileTransformError("Project path must refer to an .isp or .bak file.")
        container = containers.read_container(path)
        project_info = containers.inspect(container)
    except (OSError, FileTransformError, ValueError) as exc:
        return {"success": False, "status": "PROJECT_REJECTED", "error": str(exc),
                "project_path": project_path}

    expected = path.stem.casefold()
    current_session = _ide_session()
    already_open = [window for window in current_session.get("windows", [])
                    if window.get("visible") and not window.get("minimized")
                    and expected in str(window.get("title", "")).casefold()]
    if already_open:
        return {"success": True, "status": "PROJECT_ALREADY_VISIBLE",
                "project_path": str(path), "model": project_info.get("project_model"),
                "windows": already_open, "title_match": True, "already_open": True,
                "verification": "visible ISPSoft top-level window title contains the exact project filename stem"}

    # ISPSoft's saved previous-project setting is the only supported no-argument
    # launch path. Use it only if it identifies this exact project; otherwise
    # follow the registered .isp command NewISPSoft.exe "%1".
    executable = _exe()
    if executable is None:
        return {"success": False, "status": "NOT_INSTALLED",
                "error": "ISPSoft executable was not found. Set ISPSOFT_EXE to its installed path.",
                "project_path": str(path)}
    configured_previous = _configured_previous_project()
    use_previous_project_setting = False
    if configured_previous is not None:
        try:
            use_previous_project_setting = configured_previous.resolve(strict=True) == path
        except OSError:
            pass
    command = [str(executable)] if use_previous_project_setting else [str(executable), str(path)]
    try:
        launcher = subprocess.Popen(command, cwd=str(executable.parent),
                                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    except (OSError, subprocess.SubprocessError) as exc:
        return {"success": False, "status": "OPEN_FAILED", "error": str(exc),
                "project_path": str(path), "model": project_info.get("project_model"),
                "executable": str(executable)}

    deadline = time.monotonic() + wait_seconds
    session = _ide_session()
    while True:
        matching = [window for window in session.get("windows", [])
                    if window.get("visible") and not window.get("minimized")
                    and expected in str(window.get("title", "")).casefold()]
        if matching:
            return {"success": True, "status": "PROJECT_WINDOW_TITLE_MATCH",
                    "project_path": str(path), "model": project_info.get("project_model"),
                    "windows": matching, "title_match": True,
                    "launch_mode": "ISPSoft_PREVIOUS_PROJECT_SETTING" if use_previous_project_setting else "PROJECT_FILE_ARGUMENT",
                    "verification": "visible ISPSoft top-level window title contains the exact project filename stem"}
        if time.monotonic() >= deadline:
            break
        time.sleep(0.25)
        session = _ide_session()
    return {"success": False, "status": "OPEN_REQUESTED_UNVERIFIED",
            "project_path": str(path), "model": project_info.get("project_model"),
            "launcher_pid": launcher.pid, "executable": str(executable),
            "launch_mode": "ISPSoft_PREVIOUS_PROJECT_SETTING" if use_previous_project_setting else "PROJECT_FILE_ARGUMENT",
            "session": session, "title_match": False,
            "message": "Windows received the exact project-file open request, but no visible ISPSoft window title confirmed it."}


@mcp.tool()
def ispsoft_start_ide(project_path: str = "", wait_seconds: int = 15) -> str:
    """Interactive GUI launch for an explicitly requested project; background agents should use ispsoft_start_background_session."""
    if sys.platform != "win32":
        return _json({"success": False, "status": "WINDOWS_REQUIRED"})
    if not isinstance(project_path, str):
        return _json({"success": False, "status": "PROJECT_REJECTED",
                      "error": "project_path must be text or empty to use ISPSoft's configured previous project."})
    if not project_path.strip():
        configured = _configured_previous_project()
        if configured is None:
            return _json({"success": False, "status": "PREVIOUS_PROJECT_NOT_CONFIGURED",
                          "error": "No ISPSoft previous project is configured; provide project_path. ISPSoft will not be started blank."})
        project_path = str(configured)
    return _json(_open_project_and_observe(project_path, wait_seconds))


@mcp.tool()
def ispsoft_start_background_session(project_path: str, wait_seconds: int = 30) -> str:
    """Start an isolated, hidden ISPSoft worker on a disposable project copy; never focus the user's IDE."""
    if sys.platform != "win32":
        return _json({"success": False, "status": "WINDOWS_REQUIRED"})
    if not isinstance(wait_seconds, int) or isinstance(wait_seconds, bool) or not 1 <= wait_seconds <= 60:
        return _json({"success": False, "status": "REJECTED_BEFORE_START",
                      "error": "wait_seconds must be an integer from 1 to 60."})
    executable = _exe()
    if executable is None:
        return _json({"success": False, "status": "NOT_INSTALLED",
                      "error": "ISPSoft executable was not found. Set ISPSOFT_EXE to its installed path."})

    session_id = uuid.uuid4().hex
    session_root = WORK_DIR / "background-sessions" / session_id
    project_copy: Path | None = None
    process: subprocess.Popen[Any] | None = None
    try:
        source = Path(project_path).expanduser().resolve(strict=True)
        if source.suffix.lower() not in {".isp", ".bak"}:
            raise FileTransformError("Project path must refer to an .isp or .bak file.")
        original = read_bytes(source)
        container = containers.read_container(source)
        project_info = containers.inspect(container)
        project_dir = session_root / "project"
        project_dir.mkdir(parents=True, exist_ok=False)
        # Give the isolated worker a unique filename so its IDE title can prove
        # it loaded this copy instead of silently reopening the user's project.
        worker_name = f"{source.stem}__MCP_{session_id[:12]}{source.suffix}"
        project_copy = project_dir / worker_name
        _write_new(project_copy, original, (source,))
        companion = source.with_suffix(".ini")
        copied_companion: Path | None = None
        if companion.is_file():
            copied_companion = project_copy.with_suffix(".ini")
            _write_new(copied_companion, read_bytes(companion), (companion,))
        profile = _prepare_background_profile(session_root / "profile", project_copy)
        worker_env = os.environ.copy()
        worker_env["APPDATA"] = str(profile)
        startup_info = subprocess.STARTUPINFO()
        startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup_info.wShowWindow = 0  # SW_HIDE: create the worker without showing or focusing it.
        creation_flags = (getattr(subprocess, "DETACHED_PROCESS", 0) |
                          getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) |
                          getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0x00004000))
        process = subprocess.Popen([str(executable), str(project_copy)], cwd=str(executable.parent), env=worker_env,
                                   startupinfo=startup_info, creationflags=creation_flags)
        record: dict[str, Any] = {
            "session_id": session_id, "process": process, "process_id": process.pid,
            "status": "STARTING", "project_path": str(source), "worker_project_path": str(project_copy),
            "session_root": str(session_root), "model": project_info.get("project_model"),
            "source_sha256": _sha(original), "worker_sha256": _sha(read_bytes(project_copy)),
            "readback_verified": read_bytes(project_copy) == original,
            "companion_path": str(copied_companion) if copied_companion else None,
            "profile_path": str(profile), "launch_mode": "PROJECT_FILE_ARGUMENT_WITH_ISOLATED_PROFILE",
            "created_by_server": True, "priority_class": "BELOW_NORMAL",
        }
        _BACKGROUND_IDE_SESSIONS[session_id] = record
        expected = f"__mcp_{session_id[:12]}".casefold()
        deadline = time.monotonic() + wait_seconds
        matching: list[dict[str, Any]] = []
        worker_windows: list[dict[str, Any]] = []
        while True:
            _hide_ide_windows(process.pid)
            worker_windows = [window for window in _ide_windows() if window["pid"] == process.pid]
            matching = [window for window in worker_windows
                        if expected in str(window.get("title", "")).casefold()]
            if matching:
                hidden = all(not window["visible"] for window in worker_windows)
                record.update(success=hidden, status="BACKGROUND_PROJECT_OPEN_TITLE_MATCH", windows=worker_windows,
                              title_match=True, hidden=hidden,
                              message=None if hidden else
                              "The requested project loaded, but at least one worker window could not be hidden.")
                return _json({key: value for key, value in record.items() if key != "process"})
            if process.poll() is not None:
                record.update(status="BACKGROUND_PROCESS_EXITED", windows=worker_windows,
                              title_match=False, hidden=True, exit_code=process.returncode)
                break
            if time.monotonic() >= deadline:
                diagnostic_windows = [window for window in worker_windows
                                      if window.get("title") or window.get("class_name") in {"#32770", "TWaitFrm", "TWaitForm_C"}]
                diagnostic_windows.sort(key=lambda window: (
                    0 if window.get("class_name") == "#32770" else
                    1 if window.get("class_name") in {"TWaitFrm", "TWaitForm_C"} else 2))
                diagnostics = [{"title": window.get("title", ""),
                                "class_name": window.get("class_name", ""),
                                "controls": _window_child_texts(window["handle"])}
                               for window in diagnostic_windows[:8]]
                dialog_text = " ".join(control["text"] for window in diagnostics
                                        for control in window["controls"]).casefold()
                failure_reason = ("PROFILE_WRITE_DENIED" if "cannot create file" in dialog_text or
                                  "access is denied" in dialog_text else
                                  "STARTUP_DIALOG_UNRESOLVED" if any(
                                      window.get("class_name") == "#32770" for window in diagnostics)
                                  else "PROJECT_TITLE_NOT_CONFIRMED")
                process_stopped = False
                try:
                    process.terminate()
                    process.wait(timeout=5)
                    process_stopped = True
                except subprocess.TimeoutExpired:
                    try:
                        process.kill()
                        process.wait(timeout=5)
                        process_stopped = True
                    except (OSError, subprocess.SubprocessError):
                        pass
                except (OSError, subprocess.SubprocessError):
                    pass
                record.update(success=False, status="BACKGROUND_PROJECT_OPEN_UNVERIFIED", windows=worker_windows,
                              title_match=False, hidden=all(not window["visible"] for window in worker_windows),
                              dialog_details=diagnostics, failure_reason=failure_reason,
                              process_stopped=process_stopped,
                              message=("ISPSoft could not create a settings file in its resolved AppData folder; "
                                       "the project did not load in this worker. The worker was stopped."
                                       if failure_reason == "PROFILE_WRITE_DENIED" else
                                       "ISPSoft left a hidden startup dialog open, so the project was not confirmed loaded. "
                                       "The worker was stopped; inspect dialog_details for the exact message."
                                       if failure_reason == "STARTUP_DIALOG_UNRESOLVED" else
                                       "The worker was launched hidden, but no worker window title confirmed the requested project."))
                break
            time.sleep(0.25)
        return _json({key: value for key, value in record.items() if key != "process"})
    except (OSError, FileTransformError, ValueError, configparser.Error, subprocess.SubprocessError) as exc:
        if process is not None and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass
        shutil.rmtree(session_root, ignore_errors=True)
        return _json({"success": False, "status": "BACKGROUND_START_FAILED", "error": str(exc),
                      "project_path": project_path, "created_paths_removed": not session_root.exists()})


@mcp.tool()
def ispsoft_get_background_sessions() -> str:
    """List only hidden ISPSoft workers created by this MCP server."""
    sessions: list[dict[str, Any]] = []
    for session_id, record in list(_BACKGROUND_IDE_SESSIONS.items()):
        process = record.get("process")
        process_running = process is not None and process.poll() is None
        windows = [window for window in _ide_windows() if window["pid"] == record.get("process_id")]
        sessions.append({key: value for key, value in record.items() if key != "process"} | {
            "session_id": session_id, "process_running": process_running,
            "windows": windows, "hidden": all(not window["visible"] for window in windows),
        })
    return _json({"success": True, "sessions": sessions})


@mcp.tool()
def ispsoft_stop_background_session(session_id: str) -> str:
    """Stop only the hidden ISPSoft process started by this MCP session."""
    record = _BACKGROUND_IDE_SESSIONS.get(session_id)
    if record is None:
        return _json({"success": False, "status": "UNKNOWN_SESSION",
                      "error": "No background worker with that session_id was started by this MCP process."})
    process = record["process"]
    if process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            return _json({"success": False, "status": "STOP_FAILED", "error": str(exc),
                          "session_id": session_id, "process_id": record["process_id"]})
    record["status"] = "STOPPED"
    return _json({"success": True, "status": "STOPPED", "session_id": session_id,
                  "process_id": record["process_id"], "session_root": record["session_root"],
                  "worker_project_path": record["worker_project_path"],
                  "original_project_untouched": True})


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
            "ld_network_candidate_generation": "QUALIFIED_LIMITED" if name == "ES2" else "NOT_QUALIFIED",
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
        "ld_network_candidate_generation": {"status": "QUALIFIED_LIMITED", "models": ["ES2"], "raw_network_replacement_only": True, "native_compile": "NOT_QUALIFIED"},
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
        networks = containers.ld_networks(body)
        sections['LD_NETWORKS'] = networks
        return _json({"success": True, "name": pou_name,
                      "language": containers.property_value(body, 'P_Lang'),
                      "type": containers.property_value(body, 'P_type'),
                      "network_count": len(networks),
                      "sections": sections,
                      "note": "LD_NETWORKS contains raw network bodies in project order; network marker keys are legacy and no semantic rung decode is claimed."})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "error": str(exc), "pou_name": pou_name})


@mcp.tool()
def ispsoft_read_ld_network(project_path: str, pou_name: str, network_index: int) -> str:
    """Read one raw LD network body by its one-based order within a named POU."""
    if not isinstance(network_index, int) or isinstance(network_index, bool) or network_index < 1:
        return _json({"success": False, "status": "REJECTED_BEFORE_READ",
                      "error": "network_index must be a positive one-based integer."})
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        candidates = [match for match in containers.sections(source, 'POU')
                      if containers.property_value(match.group(1), 'P_Name') == pou_name]
        if len(candidates) != 1:
            raise FileTransformError(f"Expected one POU named {pou_name!r}; found {len(candidates)}")
        body = candidates[0].group(1)
        networks = containers.ld_networks(body)
        if not networks:
            return _json({"success": False, "status": "NO_LD_NETWORKS",
                          "project_path": str(Path(project_path).expanduser().resolve()),
                          "pou_name": pou_name, "network_count": 0})
        if network_index > len(networks):
            return _json({"success": False, "status": "NETWORK_INDEX_OUT_OF_RANGE",
                          "pou_name": pou_name, "network_index": network_index,
                          "network_count": len(networks)})
        network_text = networks[network_index - 1]
        structure = containers.parse_ld_network(network_text)
        return _json({"success": True, "status": "READ_RAW_NETWORK",
                      "project_path": str(Path(project_path).expanduser().resolve()),
                      "pou_name": pou_name, "language": containers.property_value(body, 'P_Lang'),
                      "network_index": network_index, "network_count": len(networks),
                      "network_text": network_text, "structure": structure,
                      "interpretation": "Raw marker fields and ordered node records only; node type semantics, rung topology, and compilation are not inferred."})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "status": "READ_FAILED", "error": str(exc),
                      "pou_name": pou_name})


@mcp.tool()
def ispsoft_get_ld_program_structure(project_path: str, pou_name: str) -> str:
    """Summarize every LD network as ordered raw node records without semantic guesses."""
    try:
        container = containers.read_container(project_path)
        source = container.source.decode(container.encoding)
        candidates = [match for match in containers.sections(source, 'POU')
                      if containers.property_value(match.group(1), 'P_Name') == pou_name]
        if len(candidates) != 1:
            raise FileTransformError(f"Expected one POU named {pou_name!r}; found {len(candidates)}")
        body = candidates[0].group(1)
        raw_networks = containers.ld_networks(body)
        if not raw_networks:
            return _json({"success": False, "status": "NO_LD_NETWORKS",
                          "project_path": str(Path(project_path).expanduser().resolve()),
                          "pou_name": pou_name, "network_count": 0})
        networks: list[dict[str, Any]] = []
        totals: dict[str, dict[str, int]] = {"root": {}, "outlink": {}}
        for index, raw in enumerate(raw_networks, 1):
            parsed = containers.parse_ld_network(raw)
            root_nodes = parsed["root_nodes"]
            outlink_nodes = parsed["outlink_nodes"]
            for side, nodes in (("root", root_nodes), ("outlink", outlink_nodes)):
                for node in nodes:
                    fields = node["fields"]
                    type_code = str(fields.get("TYPE", "UNSPECIFIED"))
                    totals[side][type_code] = totals[side].get(type_code, 0) + 1
            networks.append({"index": index, **parsed,
                             "root_node_count": len(root_nodes),
                             "outlink_node_count": len(outlink_nodes)})
        return _json({"success": True, "status": "READ_RAW_STRUCTURE",
                      "project_path": str(Path(project_path).expanduser().resolve()),
                      "project_sha256": _sha(read_bytes(project_path)),
                      "pou_name": pou_name,
                      "language": containers.property_value(body, 'P_Lang'),
                      "network_count": len(networks), "node_type_counts": totals,
                      "networks": networks,
                      "interpretation": "Ordered raw fields only; type-code meaning, rung topology, execution behavior, and compile status are not inferred."})
    except (OSError, FileTransformError, ValueError) as exc:
        return _json({"success": False, "status": "READ_FAILED", "error": str(exc),
                      "pou_name": pou_name})


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
            code = '\n'.join(containers.ld_networks(body))
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
    """Interactive GUI open for a specific project; use the background-session tools for silent agent work."""
    return ispsoft_start_ide(project_path, 15)


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
def ispsoft_write_ld_network_candidate(project_path: str, pou_name: str, network_index: int,
                                       replacement_network: str, model: str,
                                       output_path: str = "") -> str:
    """Replace one raw ES2 LD network in a new candidate; never alter or compile the source."""
    canonical, model_error = _model(model)
    if model_error:
        return _json({"status": "REJECTED_BEFORE_WRITE", "error": model_error})
    if canonical != "ES2":
        return _json({"status": "REJECTED_BEFORE_WRITE",
                      "error": "Raw LD network candidate editing is qualified only for ISPSoft 3.24 DVP ES2 projects."})
    if not isinstance(network_index, int) or isinstance(network_index, bool) or network_index < 1:
        return _json({"status": "REJECTED_BEFORE_WRITE",
                      "error": "network_index must be a positive one-based integer."})
    validation_errors = containers.validate_ld_network(replacement_network)
    if validation_errors:
        return _json({"status": "REJECTED_BEFORE_WRITE", "validation_errors": validation_errors})
    try:
        source_path = Path(project_path).expanduser().resolve(strict=True)
        if source_path.suffix.lower() not in {".isp", ".bak"}:
            raise FileTransformError("Source project must use .isp or .bak extension.")
        original = read_bytes(source_path)
        container = containers.read_container(source_path)
        info = containers.inspect(container)
        if str(info.get("project_model") or "").upper() != "ES2":
            raise FileTransformError("Project metadata does not match the DVP ES2 profile.")
        pou_matches = [match for match in containers.sections(
            container.source.decode(container.encoding), "POU")
                       if containers.property_value(match.group(1), "P_Name") == pou_name]
        if len(pou_matches) != 1 or containers.property_value(pou_matches[0].group(1), "P_Lang") != "1":
            raise FileTransformError("Expected exactly one LD POU with the requested name.")
        source = container.source.decode(container.encoding)
        pou_match = pou_matches[0]
        pou_body = pou_match.group(1)
        network_matches = containers.ld_network_matches(pou_body)
        if network_index > len(network_matches):
            raise FileTransformError(f"POU {pou_name!r} has {len(network_matches)} LD networks; index {network_index} is out of range.")
        old_match = network_matches[network_index - 1]
        normalized_network = containers.normalized(replacement_network).replace("\n", container.newline)
        new_source = (source[:pou_match.start(1) + old_match.start(1)] + normalized_network +
                      source[pou_match.start(1) + old_match.end(1):])
        candidate_bytes = container.rebuild(new_source.encode(container.encoding))
        verified = containers.decode(candidate_bytes)
        verified_source = verified.source.decode(verified.encoding)
        verified_pous = [match for match in containers.sections(verified_source, "POU")
                         if containers.property_value(match.group(1), "P_Name") == pou_name]
        if len(verified_pous) != 1:
            raise FileTransformError("Candidate readback did not preserve the target POU.")
        verified_networks = containers.ld_networks(verified_pous[0].group(1))
        if len(verified_networks) != len(network_matches):
            raise FileTransformError("Candidate readback changed the POU network count.")
        if verified_networks[network_index - 1] != normalized_network:
            raise FileTransformError("Candidate network readback differs from the requested replacement.")
        if output_path.strip():
            target = Path(output_path).expanduser().absolute()
            if target.suffix.lower() != ".isp":
                raise FileTransformError("Candidate output must use the .isp extension.")
            if not target.parent.is_dir():
                raise FileTransformError("Output parent directory must already exist.")
        else:
            target = _artifact_path(f"{source_path.stem}-{pou_name}-network-{network_index}-candidate", ".isp")
        target, backup, companion = _write_project_candidate_and_backup(
            source_path, target, original, candidate_bytes)
        return _json({"status": "GENERATED_UNCOMPILED", "candidate": str(target),
                      "backup": str(backup), "candidate_companion": str(companion) if companion else None,
                      "model": canonical, "pou_name": pou_name,
                      "network_index": network_index, "network_count": len(verified_networks),
                      "source_sha256": _sha(container.source),
                      "candidate_sha256": _sha(verified.source),
                      "readback_verified": True, "vendor_compile": "NOT_RUN",
                      "plc_download": "NOT_RUN"})
    except (OSError, FileTransformError, ValueError, UnicodeError) as exc:
        return _json({"status": "CANDIDATE_FAILED", "error": str(exc),
                      "project_path": project_path, "pou_name": pou_name,
                      "network_index": network_index})


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
