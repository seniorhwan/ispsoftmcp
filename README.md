# Delta ISPSoft MCP Agent Server

Pure headless AI-agent MCP server (**Streamable HTTP** on `/mcp` + **Stdio** via `stdio.ts`, zero UI) implementing the full Delta ISPSoft engineering workflow for **DVP** (`ES2`, `ES2-E`, `ES3`, `EX2`, `EX3`, `EH2`, `EH3`, `SS2`, `SA2`, `SX2`, `SE`, `SV`, `SV2`, `EC3`), **AS** (`AS218PX/RX/TX`, `AS228P/R/T`, `AS300`, `AS320`, `AS332`), and **AH** (`AH500`) PLCs.

## Transports & Endpoints

- **Streamable HTTP MCP**: `POST /mcp`, `GET /mcp` (SSE), `DELETE /mcp` (protocol versions `2025-03-26` & `2024-11-05`)
- **Stdio MCP**: `npx tsx stdio.ts` (NDJSON & `Content-Length` framing)
- **Discovery & Health**: `GET /.well-known/mcp.json`, `GET /api/health`, `GET /metrics` (Prometheus)
- **Auth**: Optional bearer token via `ISPSOFT_MCP_AUTH_TOKEN`

## Full ISPSoft Feature Coverage (78 Active Tools)

### 1. All 5 IEC 61131-3 Programming Languages
- **LD (Ladder Diagram, `P_Lang=1`)**: Rung authoring (`ispsoft_write_ld_program`, `ispsoft_edit_ld_rungs`), raw network inspection/patching, ASCII rendering (`ispsoft_render_ld_ascii`), IL round-trip validation (`ispsoft_validate_il`).
- **ST (Structured Text, `P_Lang=2`)**: Patching (`ispsoft_write_st_candidate`), `IF`/`CASE`/`FOR`/`WHILE`/`REPEAT`, arrays, structs/DUTs, `REAL` floating-point, standard IEC FBs (`TON`, `TOF`, `TP`, `CTU`, `CTD`, `CTUD`, `R_TRIG`, `F_TRIG`, `SR`, `RS`, `PID_FB`, `SCALE`), and multi-instance user FBs/FCs.
- **IL (Instruction List, `P_Lang=3`)**: Native IL POU authoring (`ispsoft_write_il_pou`) and full DVP/IEC instruction set execution.
- **SFC (Sequential Function Chart, `P_Lang=4`)**: Steps, `Step.X`/`Step.T` timers, action qualifiers (`N`, `S`, `R`, `P`, `P1`, `P0`, `L`, `D`), simultaneous divergence/convergence, priority transitions, ASCII rendering (`ispsoft_write_sfc_pou`).
- **FBD / CFC (Function Block Diagram, `P_Lang=5`)**: Topological DAG + feedback execution of logic, math, comparison, selector, standard IEC FB, and user FB blocks (`ispsoft_write_fbd_pou`).

### 2. Hardware, Memory & Communication Configuration
- **HWCONFIG (`ispsoft_configure_hwconfig`)**: CPU parameters (watchdog, constant scan, input filter, STOP behavior), COM1/COM2/COM3 serial settings, Ethernet & Modbus TCP/EtherNet/IP, and right-side extension modules (`DVP08XM`, `DVP16SP`, `DVP04AD-E2`, `DVP04DA-E2`, `DVP06XA-E2`, `DVP04PT-E2`, `DVP04TC-E2`, `AS04AD`, `AS04DA`, `AS04RTD`, etc.) with automatic I/O slot & CR/BFM defaults.
- **Retentive / Latched Memory (`ispsoft_configure_retain_ranges`)**: Custom `M`/`S`/`T`/`C`/`D` retained ranges enforced on Soft-PLC `WARM_RESET`.
- **Device Initial Value Table (`ispsoft_configure_device_init`)**: Startup/cold-reset initial values for `BOOL`/`INT`/`WORD`/`DINT`/`DWORD`/`REAL`/`STRING`.
- **PLC Link / Data Exchange (`ispsoft_configure_data_exchange`)**: COM2/COM3/Ethernet Modbus master-slave polling tables.

### 3. Project Lifecycle, Exchange & Engineering Utilities
- **Project Creation, Transactions & OCC**: `ispsoft_create_blank_project`, `ispsoft_export_project_bundle`, `ispsoft_import_project_bundle`, `ispsoft_apply_project_transaction` (20 atomic op types + `dry_run` + `expected_content_hash` + backup/rollback).
- **Packages & Standards Export (`ispsoft_import_export_pou_package`)**: `.mpu` <-> `.isp` import/export, **PLCopen XML (TC6 2.01)** export, and **IEC 61131-3 ST** export.
- **CSV Symbol & Comment Exchange (`ispsoft_csv_symbols_comments`)**: Global/Local symbol table and device comment table CSV import/export.
- **Device Usage Map & Free-Address Allocator (`ispsoft_device_usage_and_allocate`)**: Full project device usage scan + contiguous/individual free-address allocation.
- **Language Converter (`ispsoft_convert_program`)**: Deterministic `il_to_st`, `ld_pou_to_st`, and `st_to_il` conversion.
- **Model Migration (`ispsoft_migrate_project_model`)**: Cross-model and cross-family migration (`DVP <-> AS <-> AH`) with automatic `SYSTEM_VAR` resizing and special-device migration warnings.
- **Delta Reference Catalog (`ispsoft_lookup_reference`)**: Built-in searchable catalog of 85+ Delta instructions/API numbers, DVP/AS special relays & registers (`M1000+`/`D1000+`/`SM*`/`SR*`), and extension module CR/BFM maps.
- **Multi-Series Modbus Planner (`ispsoft_map_dvp_modbus_addresses`, `ispsoft_modbus_planner`)**: Forward mapping, reverse mapping (PDU + FC -> device), and RTU (CRC16) + TCP (MBAP) hex frame generation for DVP, AS, and AH PLCs.
- **Static Check, Audit & Refactor**: `ispsoft_static_check_and_compile`, `ispsoft_audit_project`, `ispsoft_diff_projects`, `ispsoft_search_project`, `ispsoft_refactor_symbol`.

### 4. Headless Soft-PLC Simulator & Diagnostics
- **Execution Engine**: `ispsoft_sim_start`, `ispsoft_sim_control` (`RUN`/`STOP`/`STEP`/`WARM_RESET`/`COLD_RESET`/`CLOSE`), `ispsoft_sim_step_until`, `ispsoft_sim_run_sequence`, `ispsoft_sim_force_and_write`, `ispsoft_sim_monitor`, `ispsoft_sim_memory_dump`, `ispsoft_sim_breakpoints`, `ispsoft_sim_watch_table`, `ispsoft_sim_reload`, `ispsoft_sim_compare_and_upload`, `ispsoft_sim_diagnostics`.
- **Advanced ISPSoft Runtime Features**:
  - **Online Edit (`ispsoft_sim_online_edit`)**: Hot-patch ST, IL/LD, SFC, or FBD POUs in a running simulator without stopping the CPU or losing device memory.
  - **Special I/O Module BFM Simulation (`ispsoft_sim_io_modules`)**: Read/write extension module CR registers interacting live with `FROM`/`TO`/`DFROM`/`DTO` instructions.
  - **Interrupt Trigger (`ispsoft_sim_trigger_interrupt`)**: Trigger interrupt tasks, POUs, or labels (`I001`, etc.) honoring `EI`/`DI`.
  - **Data Tracer Analytics (`ispsoft_sim_trace_analytics`)**: Min/max/avg, rising/falling edge counts, duty cycle %, and CSV trace export.

### 5. MCP Resources & Prompts
- **Resources**: `ispsoft://models`, `ispsoft://workspace/files`, `ispsoft://telemetry`, `ispsoft://schemas/error`, `ispsoft://reference/instructions`, `ispsoft://reference/special-devices`, `ispsoft://reference/extension-modules`, `ispsoft://projects/{name}/overview|bundle|source|hwconfig|device-usage`, `ispsoft://simulator/{session_id}/status`.
- **Prompts**: `audit_and_optimize_plc`, `author_ld_interlock_safe`, `commission_and_test_sequence`, `diagnose_sluggish_scan`, `design_sfc_state_machine`, `configure_hw_and_analog_pid`.

## Development & Verification

```bash
npm install
npm run build
npm run lint
npx tsx --test src/ispsoft/industrialMcp.test.ts src/ispsoft/simulatorDiagnostics.test.ts src/ispsoft/ispsoftFullFeatures.test.ts
```

Start the HTTP MCP server on port 3000:

```bash
npm run dev
```
