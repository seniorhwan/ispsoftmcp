# ISPSoft MCP

A Python MCP stdio server for Delta ISPSoft. It borrows the validation, backup,
and explicit-result patterns from the local SIMATIC STEP 7 and GX Works2 MCP
projects. The installed ISPSoft model catalog is discovered separately from
operations qualified by this server; an installed or listed model is not proof
that an MCP operation works on it.

## Current support

- Read-only inspection and source extraction for unprotected ISPSoft project
  containers recognized by the codec (ISPSoft 3.24 v8 pointer/footer files for
  qualified DVP series, legacy `0xAA`/`0xAC` streams, and the qualified
  AS228T/P/R v3010 layout).
- ST source patching to a **new candidate file** for AS228T/P/R and DVP ES2.
  The POU must be identified as ST in its source metadata. The original project
  is retained and a byte-identical backup is
  written beside the candidate. A project `.ini` companion is copied to both
  new filenames when present. The result is `GENERATED_UNCOMPILED`; this
  candidate-generation tool does not compile or claim IDE readback. Use the
  separate native compile/check tool for qualified ES2 projects.
- Local-variable/symbol section replacement to a **new ES2 candidate file**.
  The caller supplies the complete inner `LOCAL_VAR` text returned by
  `ispsoft_read_pou`; the original project and its companion file are preserved,
  and the candidate section is verified by decoding it again. This is a raw
  native-section edit, so the candidate remains uncompiled until native Check.
- Project overview, POU-section reads, device-comment reads, and comment
  candidate generation for DVP ES2. LD network blocks are returned as raw
  native project text and can be read one at a time or summarized as ordered
  node records. A structurally validated raw-network candidate editor writes
  a new project and byte-identical backup. Node type semantics and rung
  topology are not inferred, and candidates remain uncompiled.
- DVP IL-to-MPU POU generation and MPU-to-IL inspection for the qualified ES2,
  DVP12SE11R, and DVP12SE11T profiles. Supported mnemonics and network shapes
  are deliberately limited by the serializer; unsupported or lossy logic is
  rejected.
- Textual cross-reference analysis and DVP-style comment-map validation.
- Offline DVP ES2 device-to-Modbus PDU address translation. It reports standard
  function codes and zero-based PDU addresses for documented X/Y/M/S/T/C/D
  regions. It is address planning only; it neither opens a port nor qualifies
  a live connection. The mapping follows Delta's [DVP-PLC Application Manual,
  section 2.12](https://filecenter.deltaww.com/Products/download/06/060301/Manual/DELTA_IA-PLC_DVP-PLC_PM_EN_20220407.pdf). In particular, the later manual lists D4096 at communication address `0x9000`; an older application note has an inconsistent decimal reference for this range.
- Native ISPSoft 3.24 Check/Compile for ES2 projects uses a private desktop,
  disposable project copy, and Windows OCR of the Compile Message pane. Other
  project models remain unqualified. PLC connection, upload, download, monitor
  mode, and live device I/O remain disabled until a vendor adapter is implemented
  and qualified.
- ISPSoft process/window diagnostics and verified application startup are
  available through `ispsoft_get_ide_session` and `ispsoft_start_ide`. These
  report visible windows and startup failures; they do not inspect the active
  project. Compile/check runs through the isolated worker tool described below.
- Silent background sessions start a separate ISPSoft process on a uniquely
  named Windows desktop, with a private settings profile and a disposable
  project copy. This keeps the user's visible ISPSoft session open and prevents
  the worker from taking its keyboard focus. The server verifies the copied
  project's title on that desktop and confirms the worker created no windows
  on the user's desktop. Use these session tools for agent work; the GUI
  start/open tools are interactive-only. If Windows denies private desktop
  creation, ISPSoft cannot initialize its settings, or the project title is
  not confirmed, the server reports failure and stops the worker. The MCP
  process must have normal access to ISPSoft's AppData files. A local
  ISPSoft 3.24 project-copy launch has been qualified with the user's desktop
  left unchanged.
- Installed PLC family/model catalog and installed simulator executables are
  discovered from ISPSoft 3.24's own device configuration. This catalog is
  informational; MCP capability status remains per operation.
- Windows serial-port enumeration is read-only and reports COM names and
  adapter descriptions. It does not identify a connected PLC or verify serial
  settings; transport remains disabled until the exact target and protocol are
  qualified.
- Project discovery under an explicit folder and readback-verified offline
  project cloning from a user-selected template are supported. Native blank
  project creation and active-project readback are not automated.

The included operation profiles are narrow interoperability profiles, not a
claim of support for every controller accepted by ISPSoft. Unknown models and
unsupported container variants fail closed. The DVP32ES2 transistor model maps
to the ES2 project-source profile, but PLC communication is not qualified. The
local ISPSoft 3.24 sample is a DVP ES2
v8 pointer/footer project; its read/patch container path is covered by a
portable synthetic regression and a conditional read-only smoke test. The
sample itself is never modified by the test suite.

## Install

Windows with Python 3.11 or newer:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Run the MCP server with:

```powershell
python ispsoft_mcp_server.py
```

Configure an MCP client to launch that Python executable with the absolute path
to `ispsoft_mcp_server.py`. Set `ISPSOFT_EXE` only if `NewISPSoft.exe` is not in
the detected Delta installation path.

## Tools

| Tool | Purpose |
|---|---|
| `ispsoft_get_status` | Detect installed/running ISPSoft, COMMGR, and the DVP ES2 simulator. Presence is not a connection check. |
| `ispsoft_list_commgr_drivers` | Read the active user-profile COMMGR driver/endpoint catalog (falling back to the install default) without starting COMMGR or contacting a device. It flags multiple driver names that share a serial port or network target. Returned targets describe configuration only; they are not proof of identity or reachability. |
| `ispsoft_list_serial_ports` | List Windows Ports-class adapters and compare configured COMMGR serial ports without opening a port. Adapter presence does not identify a PLC. |
| `ispsoft_get_ide_session` | Report ISPSoft process IDs and visible top-level window metadata. Does not identify the open project. |
| `ispsoft_start_ide` | Interactive-only: open an explicit project or ISPSoft's configured previous project. Does not start blank. Background agents should not call this tool. |
| `ispsoft_start_background_session` | Open the requested project, or ISPSoft's configured previous project when `project_path` is omitted, on a private Windows desktop using a disposable copy and private settings profile. It refuses to start blank and waits up to 60 seconds by default for ISPSoft's cold start. |
| `ispsoft_get_background_sessions` | Report private-desktop workers created by this MCP process, including worker windows and project-copy paths. |
| `ispsoft_stop_background_session` | Stop only a private-desktop worker created by this MCP process; retains its disposable project folder for inspection. |
| `ispsoft_get_capabilities` | Separate detected ISPSoft models from MCP-qualified operation profiles. |
| `ispsoft_map_dvp_modbus_addresses` | Translate documented ES2 device addresses to Modbus function codes and zero-based PDU addresses; offline only, with no serial I/O. |
| `ispsoft_list_supported_plc_types` | Show the installed model catalog and exact MCP operation profiles. |
| `ispsoft_list_projects` | Find and inspect ISPSoft project files in a requested folder. |
| `ispsoft_create_project_from_template` | Create a new offline project copy with verified readback; does not compile. |
| `ispsoft_inspect_project` | Inspect a recognized `.isp` or `.bak` file. |
| `ispsoft_get_project_overview` | Summarize model, POUs, tasks, and device-comment count. |
| `ispsoft_read_project_source` | Return project source and POU metadata. |
| `ispsoft_read_pou` | Read a single POU's raw source sections plus a limited structured local-symbol view; unrecognized declarations remain in raw form and are marked. |
| `ispsoft_read_ld_network` | Read one raw LD network by one-based POU order without modifying the project. |
| `ispsoft_get_ld_program_structure` | Return all LD networks as ordered node fields and raw type-code counts, without guessing type semantics. |
| `ispsoft_read_device_comments` | Read device comments from a project. |
| `ispsoft_get_cross_references` | Build a best-effort reference list for one POU. |
| `ispsoft_get_memory_usage_map` | Read declared ranges from `SYSTEM_VAR`. |
| `ispsoft_open_project` | Interactive-only: open a project in the user's IDE; background agents should use an isolated background session. |
| `ispsoft_write_st_candidate` | Patch an existing ST POU into a new `.isp` candidate with a backup. |
| `ispsoft_write_local_variables_candidate` | Replace one ES2 POU's native `LOCAL_VAR` symbol section in a new backed-up candidate, with exact decoded readback verification. |
| `ispsoft_write_ld_network_candidate` | Replace one raw ES2 LD network into a backed-up `.isp` candidate; structural checks only, never compile or download. |
| `ispsoft_write_device_comment_candidate` | Merge comments into a new ES2 project candidate. |
| `ispsoft_validate_il` | Validate supported DVP IL and prove MPU serialization/readback. |
| `ispsoft_generate_mpu` | Generate a `.mpu` POU artifact; it does not import it into a project. |
| `ispsoft_read_mpu` | Inspect a supported MPU package as IL. |
| `ispsoft_analyze_source` | Build a best-effort text cross-reference. |
| `ispsoft_validate_device_comments` | Validate DVP-style addresses and optionally emit a JSON map. |
| `ispsoft_compile_and_check` | Run ISPSoft 3.24 Compile or Check on an ES2 project copy in a private desktop; OCR the Compile Message pane and save compiler sidecars plus screenshot evidence. Set `action` to `"check"` to run Check, `timeout_seconds` to wait up to five minutes, or `idle_wait_seconds` to silently wait for the user's ISPSoft window to leave the foreground (default 15 seconds, maximum five minutes). |
| `ispsoft_online_status`, `ispsoft_connect`, `ispsoft_upload_from_plc`, `ispsoft_start_monitor`, `ispsoft_runtime_read` | Explicitly report that no PLC transport is qualified; no device is contacted. Serial targets must match an exact saved COMMGR driver, have no shared endpoint, and be present in Windows' port inventory before any future adapter can proceed. `ispsoft_list_commgr_drivers` and `ispsoft_list_serial_ports` are configuration/device-enumeration only. |
| `ispsoft_runtime_write` / `ispsoft_download` | Require a call-level confirmation and `ISPSOFT_WRITES_ENABLED=1`; even then they remain disabled until transport qualification is implemented. |
| `ispsoft_stop_monitor` | Report that this server has no active monitor session. |

## Safe write sequence

1. Inspect the exact project and model.
2. Validate the full candidate.
3. Generate a new candidate and preserve the original.
4. Run `ispsoft_compile_and_check` on the candidate. Native menu automation is
   qualified only for ISPSoft 3.24 ES2 projects; it opens a disposable copy on a
   private desktop, leaves the user's foreground session alone, and reports a
   pass only when Windows OCR reads the Compile Message pane's error and warning
   counts. Inspect the retained screenshot and compiler sidecars when OCR fails.
5. Transfer to hardware only through ISPSoft after engineering approval. MCP
   downloads and runtime writes are not yet available. Never treat the
   installed model catalog or COMMGR process presence as proof of connectivity.

## Tests

Run offline regression tests with:

```powershell
python -m unittest discover -s tests -v
```

Tests use synthetic files and never open ISPSoft or contact a PLC. The installed
ISPSoft sample smoke test is read-only. Real project and hardware qualification
remains model- and version-specific. Native compile/check writes fixed-name
compiler sidecars beneath the Windows roaming profile despite the worker's
private `APPDATA`. The MCP snapshots those files and restores their previous
contents after the check only if no user activity occurred and each current
file still matches the worker's captured output. A concurrent change is
preserved and makes the result unverified. MCP instances serialize their
builds within the current Windows logon session. A build waits briefly for the
visible ISPSoft window to leave the foreground; if it remains active, the tool
returns without starting a worker. It is marked unverified if the user
interacts with ISPSoft during the build. In particular, DVP32ES2 COM1 transfer
and monitor behavior still require a controlled physical PLC qualification.
