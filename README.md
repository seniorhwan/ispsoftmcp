# ISPSoft MCP

A Python MCP stdio server for conservative ISPSoft source and POU workflows. It
borrows the validation, backup, and explicit-result patterns from the local
SIMATIC STEP 7 and GX Works2 MCP projects.

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
  server does not claim native ISPSoft compilation or IDE readback.
- Project overview, POU-section reads, device-comment reads, and comment
  candidate generation for DVP ES2. LD network blocks are returned as native
  project text; the server does not decode those nodes into a ladder diagram.
- DVP IL-to-MPU POU generation and MPU-to-IL inspection for the qualified ES2,
  DVP12SE11R, and DVP12SE11T profiles. Supported mnemonics and network shapes
  are deliberately limited by the serializer; unsupported or lossy logic is
  rejected.
- Textual cross-reference analysis and DVP-style comment-map validation.
- Status and explicit “not qualified” responses for native build/check and PLC
  operations. No live value or download operation is currently implemented.
- Opening a recognized project can be requested through Windows file association;
  the active project is not read back. Native project creation is not automated.

The included model profiles are narrow interoperability profiles, not a full
catalog of every controller accepted by ISPSoft. Unknown models and unsupported
container variants fail closed. The local ISPSoft 3.24 sample is a DVP ES2
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
| `ispsoft_get_status` | Detect installed/running ISPSoft and COMMGR processes. |
| `ispsoft_list_supported_plc_types` | Show exact model and operation profiles. |
| `ispsoft_inspect_project` | Inspect a recognized `.isp` or `.bak` file. |
| `ispsoft_get_project_overview` | Summarize model, POUs, tasks, and device-comment count. |
| `ispsoft_read_project_source` | Return project source and POU metadata. |
| `ispsoft_read_pou` | Read a single POU's source sections. |
| `ispsoft_read_device_comments` | Read device comments from a project. |
| `ispsoft_get_cross_references` | Build a best-effort reference list for one POU. |
| `ispsoft_get_memory_usage_map` | Read declared ranges from `SYSTEM_VAR`. |
| `ispsoft_open_project` | Ask Windows to open a recognized project; active project is not verified. |
| `ispsoft_write_st_candidate` | Patch an existing ST POU into a new `.isp` candidate with a backup. |
| `ispsoft_write_device_comment_candidate` | Merge comments into a new ES2 project candidate. |
| `ispsoft_validate_il` | Validate supported DVP IL and prove MPU serialization/readback. |
| `ispsoft_generate_mpu` | Generate a `.mpu` POU artifact; it does not import it into a project. |
| `ispsoft_read_mpu` | Inspect a supported MPU package as IL. |
| `ispsoft_analyze_source` | Build a best-effort text cross-reference. |
| `ispsoft_validate_device_comments` | Validate DVP-style addresses and optionally emit a JSON map. |
| `ispsoft_compile_and_check` | Explicitly report native IDE compile/check as unavailable. |
| `ispsoft_online_status` / `ispsoft_runtime_read` | Explicitly report that no transport is qualified. |
| `ispsoft_runtime_write` / `ispsoft_download` | Require both call confirmation and `ISPSOFT_WRITES_ENABLED=1`; even then they remain disabled until transport qualification is implemented. |

## Safe write sequence

1. Inspect the exact project and model.
2. Validate the full candidate.
3. Generate a new candidate and preserve the original.
4. Open the candidate in ISPSoft and manually run native Compile All / Check
   Program. Review the resulting ladder and model-specific warnings.
5. Transfer to hardware only through ISPSoft after engineering approval. MCP
   downloads and runtime writes are not yet available.

## Tests

Run offline regression tests with:

```powershell
python -m unittest discover -s tests -v
```

Tests use synthetic files and never open ISPSoft or contact a PLC. Real project
and hardware qualification remains model- and version-specific.
