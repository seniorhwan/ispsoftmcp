# ISPSoft MCP Review, Architectural Hardening, and Implementation Plan

## Executive Summary

This document details the architectural review findings, domain and platform defect resolutions, and safety enhancement implementations executed for the **Delta ISPSoft Model Context Protocol (MCP) Server** (`C:\Users\jethr\Downloads\ispsoft mcp`).

The Delta ISPSoft MCP server enables LLMs and automated engineering workflows to safely inspect, analyze, and author Delta DVP/AS PLC programs (Ladder Diagram and Structured Text), interface with Delta ISPSoft 3.24 automation on Windows, perform offline Modbus address translation, and validate instruction lists. Prior to this milestone, comprehensive review revealed four critical domain/platform defects along with architectural opportunities to introduce robust safety patterns derived from Czarnak safety principles: Optimistic Concurrency Control (OCC), universal dry-run execution, bounded value budgeting, thread-safe session concurrency, and proactive self-diagnostic doctor tooling.

All identified defects have been resolved with genuine production implementations, verified against an expanded test suite of 87 unit and integration tests with zero failures (100% passing).

---

## Catalog of Identified Defects and Remediations

### 1. DEF-MODBUS-01: 32-bit Counter Word Address Calculation Formula
- **Location**: `ispsoft_mcp/dvp_modbus.py:64`
- **Severity**: High (Domain Protocol Defect)
- **Root Cause**:
  In Delta DVP series PLCs (e.g., DVP-ES2), counters C200 through C255 are 32-bit high-speed counters. Each 32-bit counter occupies two consecutive 16-bit Modbus holding registers (low word then high word). The original implementation computed the holding register PDU address as:
  ```python
  # Faulty implementation:
  0x700 + (number - 200)
  ```
  This mapped C200 to 0x700, C201 to 0x701, and C202 to 0x702. Consequently, accessing C201 would collide with the high word of C200, corrupting register reads and writes over Modbus RTU/TCP.
- **Fix**:
  Corrected the 32-bit counter holding register formula to account for the 2-word stride:
  ```python
  # Corrected implementation:
  0x700 + (number - 200) * 2
  ```
- **Verification**:
  - `C200`: Base address `0x700`, 2 words (`0x700`-`0x701`).
  - `C201`: Base address `0x702`, 2 words (`0x702`-`0x703`).
  - `C202`: Base address `0x704`, 2 words (`0x704`-`0x705`).
  - `C255`: Base address `0x76E` (`0x700 + 55 * 2 = 0x76E`), 2 words (`0x76E`-`0x76F`).
  - Verified by `tests/test_ispsoft_enhancements.py::test_modbus_32bit_counter_address_calculation`.

### 2. DEF-GDI-01: GDI Device Context and Bitmap Handle Leak in Screen Capture
- **Location**: `ispsoft_mcp_server.py:1078-1115`
- **Severity**: Critical (Platform Resource Leak)
- **Root Cause**:
  `_capture_private_window_bmp` allocates Win32 GDI handles (`screen_dc` via `user32.GetDC`, `memory_dc` via `gdi32.CreateCompatibleDC`, and `bitmap` via `gdi32.CreateCompatibleBitmap`). If an exception occurred during `BitBlt`, `GetDIBits`, or memory copying, handle destruction calls were bypassed, leaking GDI and user handles into the host Windows session. Over repeated OCR compile-and-check invocations, this exhausted the OS GDI table limit (10,000 objects per process), leading to application crashes or desktop freezing.
- **Fix**:
  Restructured `_capture_private_window_bmp` using structured `try...finally` guards that guarantee `user32.ReleaseDC(None, screen_dc)`, `gdi32.DeleteDC(memory_dc)`, and `gdi32.DeleteObject(bitmap)` execute regardless of exceptions, memory errors, or control flow exits.
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_gdi_resources_freed_on_capture_failure`.

### 3. DEF-CRLF-01: Double Carriage Return (`\r\r\n`) Accumulation in LD POU Network Replacement
- **Location**: `ispsoft_mcp/containers.py:191-193`
- **Severity**: Medium (Data Integrity & File Corruption)
- **Root Cause**:
  `containers.replace_ld_pou_networks` joined replacement network blocks using `(newline + newline).join(replacement_networks)`. When replacement networks were constructed on Windows with `\r\n` line endings and passed with `newline="\r\n"`, joining lines produced redundant carriage returns `\r\r\n` or `\r\r\r\n`. Over multiple mutation iterations, ISPSoft parser choked on unbalanced carriage returns or raised `Container round-trip check failed`.
- **Fix**:
  Added universal newline pre-normalization for every replacement block before joining:
  ```python
  blocks = (newline + newline).join(
      item.strip().replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
      for item in replacement_networks
  )
  ```
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_crlf_normalization_prevents_double_carriage_returns`.

### 4. DEF-IL-01: IL Instruction Parser Tokenization and Negative Constant Support
- **Location**: `ispsoft_mcp/dvp.py:23, 29`
- **Severity**: Medium (Language Syntax Support)
- **Root Cause**:
  `parse_il_lines` tokenized instruction operands using `re.split(r'[,]+', line)`. In standard DVP Instruction List syntax, instructions such as `LD X0` or `OUT Y0` separate mnemonic and operand via whitespace without commas. Furthermore, the operand validation regex `r'^(?:[A-Za-z_][A-Za-z_0-9]*|\d+|[Kk]\d+)$'` disallowed negative constants such as `K-5` or `-100`, which are valid in DVP arithmetic instructions (e.g. `ADD D0 K-5 D2`).
- **Fix**:
  - Updated tokenization regex to `re.split(r'[,\s]+', line)` to cleanly handle space-delimited, comma-delimited, or mixed operands.
  - Updated operand validation pattern to `r'^(?:[A-Za-z_][A-Za-z_0-9]*|-?\d+|[Kk]-?\d+)$'` to permit negative decimal integer literals and negative K-constants.
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_il_tokenization_whitespace_and_negative_constants`.

---

## Architectural Hardening & Safety Patterns

### 1. Optimistic Concurrency Control (OCC) with `contentHash`
- **Implementation**: `ispsoft_mcp/limits.py:compute_content_hash`, `ispsoft_mcp_server.py`
- **Pattern**:
  To protect multi-agent and human-in-the-loop workflows against lost updates, stale overwrites, or race conditions:
  - **Read Envelopes**: All project, POU, network, and comment inspection tools (`ispsoft_inspect_project`, `ispsoft_read_project_source`, `ispsoft_get_project_overview`, `ispsoft_read_pou`, `ispsoft_read_ld_network`, `ispsoft_get_ld_program_structure`, `ispsoft_read_device_comments`) now emit standard content hashes prefixed with their scope:
    - Project scope: `isp:sha256:<64-hex>`
    - POU scope: `pou:sha256:<64-hex>`
    - Network scope: `network:sha256:<64-hex>`
    - Comments scope: `comments:sha256:<64-hex>`
  - **Mutation Preconditions**: All mutation tools (`ispsoft_write_st_candidate`, `ispsoft_write_local_variables_candidate`, `ispsoft_write_ld_network_candidate`, `ispsoft_write_ld_program`, `ispsoft_write_device_comment_candidate`, `ispsoft_compile_and_check`) accept an optional parameter `expected_content_hash: str = ""`.
  - **Fail-Closed Enforcement**: If `expected_content_hash` is provided and does not match the current target state, the tool immediately aborts mutation with zero side effects:
    ```json
    {
      "success": false,
      "status": "REJECTED_BEFORE_WRITE",
      "failure_category": "state_changed",
      "error": "Target was modified concurrently. Expected '...' does not match current state.",
      "current_content_hash": "isp:sha256:..."
    }
    ```
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_read_tools_emit_content_hashes` and `test_mutation_tools_reject_stale_content_hash`.

### 2. Universal Dry-Run Execution Mode (`dry_run=True`)
- **Implementation**: `ispsoft_mcp_server.py` (mutation and compile tools)
- **Pattern**:
  Every state-altering tool supports `dry_run: bool = False`:
  - `ispsoft_write_st_candidate`
  - `ispsoft_write_local_variables_candidate`
  - `ispsoft_write_ld_network_candidate`
  - `ispsoft_write_ld_program`
  - `ispsoft_write_device_comment_candidate`
  - `ispsoft_compile_and_check`
- **Behavior**:
  When `dry_run=True`:
  - Performs full syntactic parsing, model validation, and schema checking.
  - Performs in-memory container patching and decoded readback verification.
  - Zero disk writes: no `.isp`, `.bak`, or companion files are created.
  - Zero process spawning: no background IDE or compilation tasks are executed.
  - Returns `status: "DRY_RUN_PASSED"` and `dry_run: true` alongside detailed preview metadata.
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_dry_run_executes_validation_with_zero_disk_mutation` and `test_dry_run_compile_and_check`.

### 3. Safe Value Budgeting and Response Envelopes
- **Implementation**: `ispsoft_mcp/limits.py` (`enforce_value_budget`, `budget_payload`)
- **Constants**:
  - `MAX_ITEM_CHARS = 60_000` (per string item)
  - `MAX_RESPONSE_CHARS = 180_000` (per tool response payload)
- **Behavior**:
  - Automatically truncates runaway output fields (such as disassembled source or extensive diagnostic dumps) to prevent MCP context window exhaustion.
  - Emits descriptive `[TRUNCATED: original length N characters, capped at M characters]` notices.
  - Adds `_budget_applied: true` metadata to notify calling agents when clipping has occurred.
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_value_budgeting_truncates_large_payloads`.

### 4. Thread-Safe Background IDE Session Management
- **Implementation**: `ispsoft_mcp_server.py` (`_SESSIONS_LOCK`)
- **Behavior**:
  `_BACKGROUND_IDE_SESSIONS` tracking dictionary is now protected by an explicit `threading.Lock()` across creation, inspection, and termination routines, preventing race conditions during concurrent tool calls.
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_sessions_lock_prevents_race_conditions`.

### 5. Proactive Diagnostic Doctor Subsystem
- **Implementation**:
  - Tool: `ispsoft_doctor(detail_level: str = "full")`
  - CLI: `python -m ispsoft_mcp_server --doctor`
- **Diagnostic Checks**:
  1. Operating System and Win32 compatibility (checks for Windows platform, administrative privileges).
  2. Delta ISPSoft installation paths (scans Delta installation directories, checks `NewISPSoft.exe` presence and version).
  3. COMMGR status (detects running COMMGR process and driver configurations).
  4. Serial COM port inventory (detects available hardware and virtual serial communication ports).
  5. Windows OCR engine availability (verifies WinRT / Windows Media OCR subsystem for message pane inspection).
  6. Temporary and roaming profile write access (validates `%APPDATA%` and artifact creation capabilities).
- **Verification**:
  Verified by `tests/test_ispsoft_enhancements.py::test_ispsoft_doctor_diagnostic_output`.

---

## Verification Results & Test Coverage Matrix

The entire test suite was executed on Python 3.13 (win32) with pytest:

```
============================= test session starts =============================
platform win32 -- Python 3.13.12, pytest-8.0.2, pluggy-1.6.0
rootdir: C:\Users\jethr\Downloads\ispsoft mcp
plugins: anyio-4.15.1, langsmith-0.8.4
collected 87 items

tests\test_ispsoft_enhancements.py .............                         [ 14%]
tests\test_ispsoft_mcp.py .............................................. [ 67%]
...........................                                              [ 98%]
tests\test_stdio_integration.py .                                        [100%]

============================= 87 passed in 5.23s ==============================
```

### Coverage Matrix Summary
| Subsystem / Test File | Test Count | Pass Rate | Key Areas Covered |
| :--- | :---: | :---: | :--- |
| `tests/test_ispsoft_mcp.py` | 73 | 100% | Container DEFLATE decode/encode, CRC validation, POU extraction, LD network parsing, MPU bytecode compilation, IL validation, offline Modbus mapping, compiler sidecar isolation, session lifecycle. |
| `tests/test_ispsoft_enhancements.py` | 13 | 100% | 32-bit Modbus counter stride, GDI leak prevention, CRLF normalization, IL negative constants and whitespace, OCC content hashing, stale hash rejection across 6 mutation tools, uniform dry-run mode, value budgeting, doctor diagnostics. |
| `tests/test_stdio_integration.py` | 1 | 100% | Full JSON-RPC stdio protocol handshake, MCP tool registration, initialization, and tool enumeration. |
| **Total** | **87** | **100%** | **Zero failures, zero regressions across all targets.** |

---

## Future Roadmap & Recommendations

1. **Hardware Download Qualification**:
   Currently, all candidate generation and compiler checks operate strictly offline or on isolated private desktops. PLC download qualification should remain strictly gated behind physical hardware test benches with verified fail-safe interlocks.
2. **Extended Model Catalog Qualification**:
   While DVP-ES2 and AS228 profiles are fully qualified for structured text and ladder candidate generation, qualification for EH3, SA2, and SX2 models can be expanded following the same container integrity and pointer layout patterns established here.
3. **Automated CI/CD Integration**:
   Integrate pytest and `--doctor` smoke tests into Windows runner GitHub Actions workflows to ensure zero regressions across future commits.
