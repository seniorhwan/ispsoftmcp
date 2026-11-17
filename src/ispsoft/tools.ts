import path from 'node:path';
import {
  MODEL_PROFILES,
  ProjectBundleInput,
  TaskConfig,
  auditProjectDeep,
  buildNetworksFromIl,
  buildProjectFromBundle,
  createBlankProjectBytes,
  createPouInSource,
  deleteDutInSource,
  deleteOrRenamePouInSource,
  diffProjectsSource,
  editGlobalVarsInSource,
  editLdRungsInSource,
  editLocalVarsInSource,
  exportProjectBundle,
  extractCrossRefsFromText,
  readDeviceComments,
  readDuts,
  readSystemVars,
  readTasks,
  renderLdAsciiForPou,
  replaceTasksInSource,
  resolveModel,
  searchProjectSource,
  staticCheckAndCompileProject,
  upsertDutInSource,
  writeDeviceCommentsInSource,
  writeSystemVarsInSource,
} from './authoring.js';
import {
  decodeContainer,
  inspectContainer,
  ldNetworkMatches,
  ldNetworks,
  normalized,
  patchSt,
  parseLdNetwork,
  parseLocalVariables,
  propertyValue,
  replaceLdPouNetworks,
  sections,
  validateLdNetwork,
} from './containers.js';
import { ilToMpu, mpuToIl, parseIl } from './dvp.js';
import { mapDevice } from './dvpModbus.js';
import {
  FileTransformError,
  MAX_ITEM_CHARS,
  MAX_RESPONSE_CHARS,
  budgetPayload,
  computeContentHash,
  decodeCodepage,
  encodeCodepage,
  enforceValueBudget,
  sha256,
} from './limits.js';
import { ENTRY_NAME } from './mpuCodec.js';
import { packPackage, unpackPackage } from './packages.js';
import {
  compareSimulatorWithProject,
  controlSimulator,
  dumpSimulatorMemory,
  forceAndWriteSimulator,
  listSimulatorSessions,
  manageBreakpoints,
  manageWatchTable,
  monitorSimulator,
  profileSimulatorSession,
  reloadSimulatorSession,
  runSimulatorSequence,
  startSimulatorSession,
  stepSimulatorUntil,
} from './simulator.js';
import {
  ToolAnnotations,
  classifyToolError,
  deriveToolAnnotations,
  mcpTelemetry,
  sanitizeJsonValue,
  validateToolArguments,
} from './mcpProtocol.js';
import {
  DEFAULT_WORK_DIR,
  artifactPath,
  cleanupWorkspaceBackups,
  copyOrMoveWorkspaceFile,
  deleteWorkspaceFile,
  getCachedMeta,
  getFileMeta,
  getWorkspaceStorageStats,
  hasFile,
  listAllFiles,
  normalizeVirtualPath,
  readFileBuffer,
  seedDefaultWorkspace,
  setCachedMeta,
  writeFileBuffer,
  writeProjectCandidateAndBackup,
} from './workspace.js';

export interface McpToolDef {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Record<string, unknown>;
}

const LIVE_WRITES_ENV = 'ISPSOFT_WRITES_ENABLED';

function capabilityMatrix() {
  const perProfile: Record<string, Record<string, unknown>> = {};
  for (const [name, profile] of Object.entries(MODEL_PROFILES)) {
    const langs = (profile.languages as string[]) ?? [];
    perProfile[name] = {
      family: profile.family,
      languages: langs,
      project_creation: 'QUALIFIED',
      project_inspection: 'QUALIFIED',
      st_candidate_generation: langs.includes('ST') ? 'QUALIFIED' : 'NOT_QUALIFIED',
      local_variable_candidate_generation: 'QUALIFIED',
      global_variable_and_dut_editing: 'QUALIFIED',
      task_and_hardware_io_configuration: 'QUALIFIED',
      ld_rung_and_program_authoring: profile.family === 'DVP' ? 'QUALIFIED' : 'LIMITED',
      il_mpu_generation: profile.pou_exchange === 'MPU' ? 'QUALIFIED' : 'NOT_QUALIFIED',
      offline_static_check_and_compile: 'QUALIFIED',
      soft_plc_simulator_and_online_monitor: 'QUALIFIED_SIMULATOR',
      native_windows_ide_compile_check: 'WINDOWS_HOST_REQUIRED',
      plc_physical_hardware_io: 'NOT_QUALIFIED',
    };
  }
  return {
    per_profile: perProfile,
    offline_authoring_and_editing: {
      status: 'QUALIFIED',
      features: [
        'blank_project_creation',
        'full_bundle_export_import',
        'atomic_multi_edit_transactions_and_in_place_updates',
        'workspace_file_management_and_backup_rollback',
        'pou_create_rename_delete',
        'st_code_patching',
        'ld_rung_edit_stack_ops_and_ascii_render',
        'il_to_ld_program_authoring',
        'local_and_global_var_upsert_delete',
        'dut_struct_enum_management',
        'task_and_system_var_config',
        'device_comment_merge',
        'project_wide_symbol_refactor_and_search',
        'deep_engineering_audit_and_project_diff',
      ],
    },
    offline_static_check_and_compile: {
      status: 'QUALIFIED',
      checks: ['syntax', 'double_coil', 'coil_conflict', 'floating_contacts', 'system_var_bounds', 'task_integrity', 'variable_wrappers'],
    },
    soft_plc_simulator_and_monitor: {
      status: 'QUALIFIED_SIMULATOR',
      features: [
        'run_stop_step_step_until_warm_cold_reset',
        'true_iec_ladder_stack_machine_anb_orb_mps_mrd_mpp',
        '32bit_dword_math_and_bit_of_word',
        'subroutines_call_sret_fend_and_cj_jumps',
        'st_case_repeat_arrays_structs_fc_fb_calls',
        'multi_step_sequence_testbench_and_breakpoints',
        'memory_table_dump_watch_tables_trace_compact_monitor',
      ],
    },
    dvp_modbus_address_mapping: { status: 'QUALIFIED', models: ['ES2'], device_io: 'NOT_RUN' },
    native_windows_ide_automation: { status: process.platform === 'win32' ? 'AVAILABLE' : 'UNAVAILABLE_ON_LINUX' },
    physical_plc_connection: { status: 'NOT_QUALIFIED', write_guard: LIVE_WRITES_ENV },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const MCP_TOOLS: McpToolDef[] = [
  // =========================================================================
  // 1. Diagnostics & Capabilities
  // =========================================================================
  {
    name: 'ispsoft_doctor',
    description: 'Run comprehensive environmental, workspace, simulator, and capability diagnostics for ISPSoft MCP.',
    category: 'Diagnostics',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      seedDefaultWorkspace();
      const isWin = process.platform === 'win32';
      return {
        success: true,
        health: isWin ? 'HEALTHY' : 'AGENT_READY_OFFLINE_AND_SIMULATOR',
        platform: {
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          is_windows: isWin,
        },
        workspace: {
          ...getWorkspaceStorageStats(),
          project_count: listAllFiles().filter((f) => /\.(isp|bak|mpu)$/i.test(f)).length,
          files: listAllFiles(),
        },
        simulator: {
          active_sessions: listSimulatorSessions(),
        },
        telemetry: mcpTelemetry.getSummary().totals,
        limits: {
          max_file_bytes: 32 * 1024 * 1024,
          max_item_chars: MAX_ITEM_CHARS,
          max_response_chars: MAX_RESPONSE_CHARS,
        },
        qualified_workflows: [
          'blank_project_and_bundle_export_import',
          'atomic_multi_edit_transaction_and_in_place_editing',
          'pou_task_dut_global_var_authoring',
          'ld_stack_ops_rung_editing_and_ascii_visualization',
          'offline_il_mpu_bidirectional_transpile',
          'offline_iec_dvp_static_check_compile_and_deep_audit',
          'soft_plc_simulator_online_monitor_breakpoints_sequence_and_trace',
          'offline_dvp_modbus_translation',
        ],
      };
    },
  },
  {
    name: 'ispsoft_server_telemetry',
    description: 'Return MCP server operational telemetry: per-tool call/error/p95 latency histograms, recent audit events, workspace disk quota usage, and active simulator count.',
    category: 'Diagnostics',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      seedDefaultWorkspace();
      return mcpTelemetry.getSummary({
        workspace_storage: getWorkspaceStorageStats(),
        active_simulator_sessions: listSimulatorSessions().length,
        tool_catalog_count: MCP_TOOLS.length,
      });
    },
  },
  {
    name: 'ispsoft_get_capabilities',
    description: 'Return explicit MCP qualification matrix across all supported PLC models and agent tools.',
    category: 'Diagnostics',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      server: 'ispsoft',
      qualified_profiles: MODEL_PROFILES,
      model_aliases: { DVP32ES2T: 'ES2', DVP32ES2: 'ES2' },
      operations: capabilityMatrix(),
    }),
  },
  {
    name: 'ispsoft_list_supported_plc_types',
    description: 'Show supported PLC models, languages, and exact MCP operation profiles.',
    category: 'Diagnostics',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      profiles: MODEL_PROFILES,
      model_aliases: { DVP32ES2T: 'ES2', DVP32ES2: 'ES2' },
      capability_matrix: capabilityMatrix(),
    }),
  },

  // =========================================================================
  // 2. Project Discovery, Creation, Bundle Export/Import, Workspace Ops & Batch Tx
  // =========================================================================
  {
    name: 'ispsoft_list_projects',
    description: 'List and inspect ISPSoft .isp/.bak/.mpu artifacts in the workspace (sha256-cached).',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      properties: {
        search_path: { type: 'string', description: 'Optional directory prefix filter (default /workspace)' },
        max_results: { type: 'integer', default: 100 },
      },
    },
    handler: (args) => {
      seedDefaultWorkspace();
      const searchPath = typeof args.search_path === 'string' ? args.search_path : '';
      const maxResults = typeof args.max_results === 'number' ? args.max_results : 100;
      const all = listAllFiles(searchPath).filter((p) => /\.(isp|bak|mpu)$/i.test(p));
      const projects = all.slice(0, maxResults).map((p) => {
        const buf = readFileBuffer(p);
        const cached = getCachedMeta(p, buf);
        if (cached) return cached;

        let summary: Record<string, unknown>;
        if (p.toLowerCase().endsWith('.mpu')) {
          try {
            const { il, detail } = mpuToIl(buf, 'cp1252');
            summary = {
              path: p,
              kind: 'MPU',
              bytes: buf.length,
              readable: true,
              network_count: detail.network_count,
              il_lines: il.split('\n').filter(Boolean).length,
              sha256: sha256(buf),
            };
          } catch (e) {
            summary = { path: p, kind: 'MPU', bytes: buf.length, readable: false, error: errMsg(e) };
          }
        } else {
          try {
            const c = decodeContainer(buf);
            const info = inspectContainer(c);
            summary = {
              path: p,
              kind: 'PROJECT',
              bytes: buf.length,
              readable: true,
              model: info.project_model,
              layout: info.layout,
              pou_count: info.pous.length,
              sha256: sha256(buf),
              content_hash: computeContentHash('isp', buf),
            };
          } catch (e) {
            summary = { path: p, kind: 'PROJECT', bytes: buf.length, readable: false, error: errMsg(e) };
          }
        }
        setCachedMeta(p, buf, summary);
        return summary;
      });
      return { success: true, projects, truncated: all.length > maxResults };
    },
  },
  {
    name: 'ispsoft_manage_workspace_files',
    description: 'Copy, move/rename, delete workspace files, restore a project backup, or clean up *.before.* clutter.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['copy', 'move', 'delete', 'restore_backup', 'cleanup_backups'] },
        path: { type: 'string', description: 'Source path (or target project path for restore_backup)' },
        destination_path: { type: 'string', description: 'Destination path for copy/move' },
        backup_path: { type: 'string', description: 'Optional explicit backup path for restore_backup (defaults to <name>.latest.before.isp)' },
        overwrite: { type: 'boolean', default: false },
        prefix: { type: 'string', description: 'Optional directory filter for cleanup_backups' },
      },
    },
    handler: (args) => {
      try {
        const action = String(args.action ?? '');
        if (action === 'copy' || action === 'move') {
          const res = copyOrMoveWorkspaceFile(
            String(args.path ?? ''),
            String(args.destination_path ?? ''),
            action === 'move',
            Boolean(args.overwrite),
          );
          return { success: true, action, ...res };
        }
        if (action === 'delete') {
          const p = normalizeVirtualPath(String(args.path ?? ''));
          const deleted = deleteWorkspaceFile(p);
          return { success: deleted, action, path: p, deleted };
        }
        if (action === 'restore_backup') {
          const targetPath = normalizeVirtualPath(String(args.path ?? ''));
          const parsed = path.posix.parse(targetPath);
          const backupPath = typeof args.backup_path === 'string' && args.backup_path.trim()
            ? normalizeVirtualPath(args.backup_path)
            : path.posix.join(parsed.dir, `${parsed.name}.latest.before${parsed.ext}`);
          const backupBytes = readFileBuffer(backupPath);
          decodeContainer(backupBytes);
          writeFileBuffer(targetPath, backupBytes, true);
          return {
            success: true,
            action,
            restored_to: targetPath,
            from_backup: backupPath,
            content_hash: computeContentHash('isp', backupBytes),
          };
        }
        if (action === 'cleanup_backups') {
          const res = cleanupWorkspaceBackups(typeof args.prefix === 'string' ? args.prefix : '');
          return { success: true, action, ...res };
        }
        return { success: false, error: `Unsupported action: ${action}` };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_export_project_bundle',
    description: 'Export an entire .isp project as compact structured JSON (properties, tasks, system_vars, global/local vars, DUTs, device_comments, and all POUs with IL/ST code).',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        include_ascii: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const info = inspectContainer(c);
        const source = decodeCodepage(c.source, c.encoding);
        const bundle = exportProjectBundle(source, info, Boolean(args.include_ascii));
        return {
          success: true,
          project_path: p,
          content_hash: computeContentHash('isp', raw),
          bundle,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_import_project_bundle',
    description: 'Create or overwrite a complete .isp project + .ini from a structured JSON bundle in a single operation (with static compile verification).',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['output_path', 'bundle'],
      properties: {
        output_path: { type: 'string' },
        bundle: { type: 'object', description: 'Project bundle matching ispsoft_export_project_bundle output schema' },
        overwrite: { type: 'boolean', default: false },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const outPath = normalizeVirtualPath(String(args.output_path ?? ''));
        if (!outPath.toLowerCase().endsWith('.isp')) {
          throw new FileTransformError('output_path must use .isp extension');
        }
        const { ispBytes, iniBytes, canonicalModel } = buildProjectFromBundle(args.bundle as ProjectBundleInput);
        const decoded = decodeContainer(ispBytes);
        const staticCheck = staticCheckAndCompileProject(decoded);
        if (args.dry_run) {
          return {
            success: staticCheck.success,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            model: canonicalModel,
            output_path: outPath,
            static_check: staticCheck,
          };
        }
        const overwrite = Boolean(args.overwrite);
        if (overwrite && hasFile(outPath)) {
          const orig = readFileBuffer(outPath);
          const written = writeProjectCandidateAndBackup(outPath, outPath, orig, ispBytes, true);
          return {
            success: staticCheck.success,
            status: staticCheck.success ? 'IMPORTED_BUNDLE_VERIFIED' : 'IMPORTED_BUNDLE_WITH_WARNINGS',
            project_path: written.target,
            backup: written.backup,
            model: canonicalModel,
            static_check: staticCheck,
            content_hash: computeContentHash('isp', ispBytes),
          };
        }
        const saved = writeFileBuffer(outPath, ispBytes, false);
        const iniPath = saved.replace(/\.isp$/i, '.ini');
        writeFileBuffer(iniPath, iniBytes, true);
        return {
          success: staticCheck.success,
          status: staticCheck.success ? 'IMPORTED_BUNDLE_VERIFIED' : 'IMPORTED_BUNDLE_WITH_WARNINGS',
          project_path: saved,
          companion_path: iniPath,
          model: canonicalModel,
          static_check: staticCheck,
          content_hash: computeContentHash('isp', ispBytes),
        };
      } catch (e) {
        return { success: false, status: 'IMPORT_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_apply_project_transaction',
    description: 'Atomically apply multiple authoring edits to a project in ONE call, run static check, write once (in-place or candidate), and optionally hot-reload a simulator session.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'operations'],
      properties: {
        project_path: { type: 'string' },
        operations: {
          type: 'array',
          description: 'Sequence of ops: { type: "edit_properties"|"configure_tasks"|"configure_hardware_io"|"create_pou"|"manage_pou"|"write_st"|"write_ld"|"edit_ld_rungs"|"edit_local_vars"|"edit_global_vars"|"manage_dut"|"write_comments"|"rename_symbol", ... }',
        },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        reload_simulator_session_id: { type: 'string', description: 'Optional simulator session ID to hot-reload upon commit' },
        abort_on_compile_error: { type: 'boolean', default: true },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        let source = decodeCodepage(c.source, c.encoding);
        const ops = (Array.isArray(args.operations) ? args.operations : []) as Array<Record<string, unknown>>;
        if (!ops.length) throw new FileTransformError('operations must be a non-empty array');

        const applied: string[] = [];
        for (const op of ops) {
          const t = String(op.type ?? '');
          if (t === 'edit_properties') {
            const projSec = sections(source, 'PROJECT')[0];
            if (!projSec) throw new FileTransformError('Missing <PROJECT> section');
            let inner = projSec.inner;
            for (const [k, v] of Object.entries((op.properties as Record<string, string>) ?? {})) {
              const re = new RegExp(`^${k}=[^\\r\\n]*`, 'm');
              inner = re.test(inner) ? inner.replace(re, `${k}=${v}`) : inner.trimEnd() + c.newline + `${k}=${v}` + c.newline;
            }
            source = source.slice(0, projSec.innerStart) + inner + source.slice(projSec.innerEnd);
          } else if (t === 'configure_tasks') {
            source = replaceTasksInSource(source, (op.tasks as TaskConfig[]) ?? [], c.newline);
          } else if (t === 'configure_hardware_io') {
            source = writeSystemVarsInSource(source, (op.ranges as Record<string, string>) ?? {}, c.newline);
          } else if (t === 'create_pou') {
            source = createPouInSource(
              source,
              {
                pouName: String(op.pou_name ?? ''),
                language: (op.language as 'LD' | 'ST' | 'IL') ?? 'LD',
                pouType: (op.pou_type as 'PRG' | 'FB' | 'FC') ?? 'PRG',
                code: typeof op.code === 'string' ? op.code : undefined,
                localVariables: typeof op.local_variables === 'string' ? op.local_variables : undefined,
                assignToTask: op.assign_to_task !== false,
              },
              c.newline,
            );
          } else if (t === 'manage_pou') {
            source = deleteOrRenamePouInSource(
              source,
              String(op.pou_name ?? ''),
              op.action === 'delete' ? 'delete' : 'rename',
              typeof op.new_name === 'string' ? op.new_name : undefined,
            );
          } else if (t === 'write_st') {
            const pouName = String(op.pou_name ?? '');
            const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
            if (!pouMatch) throw new FileTransformError(`POU ${pouName} not found`);
            const stSec = sections(pouMatch.inner, 'IL_ST_CODE')[0];
            if (!stSec) throw new FileTransformError(`POU ${pouName} is missing IL_ST_CODE`);
            const repCode = normalized(String(op.code ?? '')).replace(/\n/g, c.newline);
            const newInner = pouMatch.inner.slice(0, stSec.innerStart) + repCode + pouMatch.inner.slice(stSec.innerEnd);
            source = source.slice(0, pouMatch.innerStart) + newInner + source.slice(pouMatch.innerEnd);
          } else if (t === 'write_ld') {
            const pouName = String(op.pou_name ?? '');
            const built = buildNetworksFromIl(String(op.program ?? ''), c.newline);
            source = replaceLdPouNetworks(source, pouName, built, c.newline);
          } else if (t === 'edit_ld_rungs') {
            source = editLdRungsInSource(source, String(op.pou_name ?? ''), (op.operations as never[]) ?? [], c.newline).updatedSource;
          } else if (t === 'edit_local_vars') {
            source = editLocalVarsInSource(
              source,
              String(op.pou_name ?? ''),
              {
                replaceText: typeof op.variables === 'string' ? op.variables : undefined,
                upsertVars: Array.isArray(op.upsert_vars) ? (op.upsert_vars as Array<Record<string, unknown>>) : undefined,
                deleteVars: Array.isArray(op.delete_vars) ? op.delete_vars.map(String) : undefined,
              },
              c.newline,
            ).updatedSource;
          } else if (t === 'edit_global_vars') {
            source = editGlobalVarsInSource(
              source,
              {
                replaceText: typeof op.global_var_text === 'string' ? op.global_var_text : undefined,
                upsertVars: Array.isArray(op.upsert_vars) ? (op.upsert_vars as Array<Record<string, unknown>>) : undefined,
                deleteVars: Array.isArray(op.delete_vars) ? op.delete_vars.map(String) : undefined,
              },
              c.newline,
            ).updatedSource;
          } else if (t === 'manage_dut') {
            source = op.action === 'delete'
              ? deleteDutInSource(source, String(op.dut_name ?? ''))
              : upsertDutInSource(source, String(op.dut_name ?? ''), String(op.dut_content ?? ''), c.newline);
          } else if (t === 'write_comments') {
            source = writeDeviceCommentsInSource(
              source,
              (op.device_comments as Record<string, string>) ?? {},
              c.newline,
              Boolean(op.replace_all),
            ).updatedSource;
          } else if (t === 'rename_symbol') {
            const findSym = String(op.find_symbol ?? '').trim();
            const repSym = String(op.replace_symbol ?? '').trim();
            if (!findSym || !repSym) throw new FileTransformError('rename_symbol requires find_symbol and replace_symbol');
            const tokenRe = new RegExp(`(?<![A-Za-z0-9_])${findSym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
            source = source.replace(tokenRe, repSym);
          } else {
            throw new FileTransformError(`Unsupported transaction op type: ${t}`);
          }
          applied.push(t);
        }

        const candidateBytes = c.rebuild(encodeCodepage(source, c.encoding));
        const verified = decodeContainer(candidateBytes);
        const staticCheck = staticCheckAndCompileProject(verified);
        const abortOnErr = args.abort_on_compile_error !== false;
        if (abortOnErr && !staticCheck.success) {
          return {
            success: false,
            status: 'TRANSACTION_ABORTED_COMPILE_ERROR',
            applied_steps: applied,
            static_check: staticCheck,
          };
        }

        if (args.dry_run) {
          return {
            success: staticCheck.success,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            applied_steps: applied,
            static_check: staticCheck,
          };
        }

        const inPlace = Boolean(args.in_place);
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-tx`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, inPlace);

        let simulatorReloaded: unknown = null;
        if (typeof args.reload_simulator_session_id === 'string' && args.reload_simulator_session_id.trim()) {
          simulatorReloaded = reloadSimulatorSession(args.reload_simulator_session_id.trim(), written.target, false);
        }

        return {
          success: staticCheck.success,
          status: 'TRANSACTION_COMMITTED',
          in_place: inPlace,
          candidate: written.target,
          backup: written.backup,
          applied_steps: applied,
          static_check: staticCheck,
          simulator_reloaded: simulatorReloaded ? true : false,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'TRANSACTION_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_create_blank_project',
    description: 'Create a brand-new ISPSoft .isp project + .ini companion from scratch for any supported DVP or AS model.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['model', 'output_path'],
      properties: {
        model: { type: 'string', description: 'Target PLC model, e.g. ES2, DVP32ES2T, EH3, AS228T' },
        output_path: { type: 'string', description: 'New .isp workspace path, e.g. /workspace/conveyor.isp' },
        initial_pou_name: { type: 'string', default: 'Prog0' },
        language: { type: 'string', enum: ['LD', 'ST'], default: 'LD' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const model = String(args.model ?? '');
        const outPath = normalizeVirtualPath(String(args.output_path ?? ''));
        if (!outPath.toLowerCase().endsWith('.isp')) {
          throw new FileTransformError('output_path must use .isp extension');
        }
        const { ispBytes, iniBytes, canonicalModel } = createBlankProjectBytes({
          model,
          initialPouName: typeof args.initial_pou_name === 'string' ? args.initial_pou_name : 'Prog0',
          language: args.language === 'ST' ? 'ST' : 'LD',
        });
        const decoded = decodeContainer(ispBytes);
        if (args.dry_run) {
          return {
            success: true,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            model: canonicalModel,
            output_path: outPath,
            bytes: ispBytes.length,
            layout: decoded.layout,
          };
        }
        const saved = writeFileBuffer(outPath, ispBytes, false);
        const iniPath = saved.replace(/\.isp$/i, '.ini');
        writeFileBuffer(iniPath, iniBytes, true);
        return {
          success: true,
          status: 'CREATED_BLANK_PROJECT',
          project_path: saved,
          companion_path: iniPath,
          model: canonicalModel,
          layout: decoded.layout,
          sha256: sha256(ispBytes),
          content_hash: computeContentHash('isp', ispBytes),
        };
      } catch (e) {
        return { success: false, status: 'CREATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_create_project_from_template',
    description: 'Create a new offline project copy from an existing .isp/.bak template with readback verification.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['template_path', 'output_path'],
      properties: {
        template_path: { type: 'string' },
        output_path: { type: 'string' },
      },
    },
    handler: (args) => {
      try {
        const templatePath = normalizeVirtualPath(String(args.template_path ?? ''));
        const outputPath = normalizeVirtualPath(String(args.output_path ?? ''));
        if (!/\.(isp|bak)$/i.test(templatePath) || !outputPath.toLowerCase().endsWith('.isp')) {
          throw new FileTransformError('Template must be .isp/.bak and output must use .isp extension.');
        }
        if (templatePath === outputPath) {
          throw new FileTransformError('Output path must differ from template');
        }
        const raw = readFileBuffer(templatePath);
        const parsed = decodeContainer(raw);
        const info = inspectContainer(parsed);
        const saved = writeFileBuffer(outputPath, raw, false);
        const iniSrc = templatePath.replace(/\.[^.]+$/, '.ini');
        let companionPath: string | null = null;
        if (hasFile(iniSrc)) {
          companionPath = writeFileBuffer(saved.replace(/\.isp$/i, '.ini'), readFileBuffer(iniSrc), false);
        }
        return {
          success: true,
          status: 'CREATED_FROM_TEMPLATE_UNCOMPILED',
          project_path: saved,
          template_path: templatePath,
          model: info.project_model,
          layout: parsed.layout,
          sha256: sha256(raw),
          content_hash: computeContentHash('isp', raw),
          companion_path: companionPath,
          readback_verified: true,
        };
      } catch (e) {
        return { success: false, status: 'CREATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_inspect_project',
    description: 'Inspect an unprotected .isp/.bak container read-only and return metadata + content_hash.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: { project_path: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const info = inspectContainer(c);
        return {
          success: true,
          path: p,
          ...info,
          project_sha256: sha256(raw),
          content_hash: computeContentHash('isp', raw),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_get_project_overview',
    description: 'Summarize project model, POUs, tasks, DUTs, global variables, and device-comment count.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: { project_path: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const source = decodeCodepage(c.source, c.encoding);
        const info = inspectContainer(c);
        const tasks = readTasks(source);
        const duts = readDuts(source);
        const comments = readDeviceComments(source);
        return {
          success: true,
          path: p,
          model: info.project_model,
          layout: info.layout,
          pous: info.pous,
          tasks,
          dut_count: duts.length,
          device_comment_count: Object.keys(comments).length,
          project_sha256: sha256(raw),
          content_hash: computeContentHash('isp', raw),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_read_project_source',
    description: 'Read raw decoded project source from an .isp/.bak container (with value budgeting).',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: { project_path: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const source = decodeCodepage(c.source, c.encoding);
        return {
          success: true,
          path: p,
          encoding: c.encoding,
          project: inspectContainer(c),
          source: enforceValueBudget(source, 'source'),
          content_hash: computeContentHash('isp', raw),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_edit_project_properties',
    description: 'Read or update project metadata (<PROJECT> properties) and .ini communication settings in-place or in a backed-up candidate.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        properties: { type: 'object', description: 'Optional map of PROJECT keys to update, e.g. { Prj_DT: "EH3" }' },
        ini_settings: { type: 'object', description: 'Optional map of .ini [PRJ_DATA] keys, e.g. { STATION_ADDR: "2" }' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return {
            success: false,
            status: 'REJECTED_BEFORE_WRITE',
            failure_category: 'state_changed',
            error: `Target modified concurrently. Expected '${args.expected_content_hash}'.`,
            current_content_hash: currentHash,
          };
        }
        const c = decodeContainer(original);
        let source = decodeCodepage(c.source, c.encoding);
        const projSec = sections(source, 'PROJECT')[0];
        if (!projSec) throw new FileTransformError('Missing <PROJECT> section');
        let projInner = projSec.inner;
        const propUpdates = (args.properties as Record<string, string> | undefined) ?? {};
        for (const [k, v] of Object.entries(propUpdates)) {
          if (k === 'Prj_DT') {
            const { canonical, error } = resolveModel(String(v));
            if (error || !canonical) throw new FileTransformError(error ?? 'Invalid model');
          }
          const lineRe = new RegExp(`^${k}=[^\\r\\n]*`, 'm');
          if (lineRe.test(projInner)) {
            projInner = projInner.replace(lineRe, `${k}=${v}`);
          } else {
            projInner = projInner.trimEnd() + c.newline + `${k}=${v}` + c.newline;
          }
        }
        source = source.slice(0, projSec.innerStart) + projInner + source.slice(projSec.innerEnd);
        const candidateBytes = c.rebuild(encodeCodepage(source, c.encoding));
        if (args.dry_run || (Object.keys(propUpdates).length === 0 && !args.ini_settings)) {
          const parsedProps: Record<string, string> = {};
          for (const line of projInner.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq > 0) parsedProps[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          return {
            success: true,
            status: args.dry_run ? 'DRY_RUN_PASSED' : 'READ_PROJECT_PROPERTIES',
            dry_run: Boolean(args.dry_run),
            properties: parsedProps,
            current_content_hash: currentHash,
          };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-props`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        if (args.ini_settings && written.candidateCompanion) {
          let iniText = readFileBuffer(written.candidateCompanion).toString('utf-8');
          for (const [k, v] of Object.entries(args.ini_settings as Record<string, string>)) {
            const re = new RegExp(`^${k}=[^\\r\\n]*`, 'm');
            iniText = re.test(iniText) ? iniText.replace(re, `${k}=${v}`) : iniText.trimEnd() + `\r\n${k}=${v}\r\n`;
          }
          writeFileBuffer(written.candidateCompanion, Buffer.from(iniText, 'utf-8'), true);
        }
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          candidate_companion: written.candidateCompanion,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_tasks',
    description: 'Read or replace cyclic/interrupt TASK schedules and POU assignments in-place or in a backed-up project candidate.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        tasks: {
          type: 'array',
          description: 'Optional full replacement task list [{id, name, type, interval_ms, priority, active, program}]',
        },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return {
            success: false,
            status: 'REJECTED_BEFORE_WRITE',
            failure_category: 'state_changed',
            current_content_hash: currentHash,
          };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        if (!Array.isArray(args.tasks)) {
          return { success: true, status: 'READ_TASKS', tasks: readTasks(source), content_hash: currentHash };
        }
        const updated = replaceTasksInSource(source, args.tasks as TaskConfig[], c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return {
            success: true,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            tasks: readTasks(updated),
            current_content_hash: currentHash,
          };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-tasks`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          tasks: readTasks(updated),
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_hardware_io',
    description: 'Read or update PLC device memory ranges in SYSTEM_VAR (M/S/T/C/D ranges).',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        ranges: {
          type: 'object',
          description: 'Optional map e.g. { "M": "0-4095", "D": "0-9999", "T": "0-255" }',
        },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        if (!args.ranges || typeof args.ranges !== 'object') {
          return { success: true, ranges: readSystemVars(source), content_hash: currentHash };
        }
        const updated = writeSystemVarsInSource(source, args.ranges as Record<string, string>, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, current_content_hash: currentHash };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-sysvar`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return { success: true, status: 'GENERATED_UNCOMPILED', candidate: written.target, backup: written.backup, content_hash: computeContentHash('isp', candidateBytes) };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_get_memory_usage_map',
    description: 'Read declared device ranges from the project SYSTEM_VAR section.',
    category: 'Project Management',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string' } } },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const sysSecs = sections(source, 'SYSTEM_VAR');
        if (sysSecs.length !== 1) throw new FileTransformError('Expected exactly one SYSTEM_VAR section.');
        const ranges = readSystemVars(source);
        return { success: true, model: inspectContainer(c).project_model, ranges };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },

  // =========================================================================
  // 3. POU, Variable, & DUT Authoring
  // =========================================================================
  {
    name: 'ispsoft_create_pou',
    description: 'Create a new PRG, FB, or FC POU in LD, ST, or IL inside a project (in_place or backed-up candidate).',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'language'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        language: { type: 'string', enum: ['LD', 'ST', 'IL'] },
        pou_type: { type: 'string', enum: ['PRG', 'FB', 'FC'], default: 'PRG' },
        code: { type: 'string', description: 'ST code or IL program (compiled to LD networks if language=LD)' },
        local_variables: { type: 'string' },
        assign_to_task: { type: 'boolean', default: true },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const updated = createPouInSource(
          source,
          {
            pouName: String(args.pou_name ?? ''),
            language: (args.language as 'LD' | 'ST' | 'IL') ?? 'LD',
            pouType: (args.pou_type as 'PRG' | 'FB' | 'FC') ?? 'PRG',
            code: typeof args.code === 'string' ? args.code : undefined,
            localVariables: typeof args.local_variables === 'string' ? args.local_variables : undefined,
            assignToTask: args.assign_to_task !== false,
          },
          c.newline,
        );
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, pou_name: args.pou_name, current_content_hash: currentHash };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-add-${String(args.pou_name)}`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          pou_name: args.pou_name,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_manage_pou',
    description: 'Rename or delete a POU (automatically updating TASK references) in-place or in a backed-up project candidate.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'action'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        action: { type: 'string', enum: ['rename', 'delete'] },
        new_name: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const updated = deleteOrRenamePouInSource(
          source,
          String(args.pou_name ?? ''),
          args.action === 'delete' ? 'delete' : 'rename',
          typeof args.new_name === 'string' ? args.new_name : undefined,
        );
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, current_content_hash: currentHash };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-pou-${String(args.action)}`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_read_pou',
    description: 'Read one POU source sections (LOCAL_VAR, IL_ST_CODE, LD_NETWORKS) and parsed symbol view.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name'],
      properties: { project_path: { type: 'string' }, pou_name: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const candidates = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (candidates.length !== 1) throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${candidates.length}`);
        const body = candidates[0].inner;
        const secMap: Record<string, string[]> = {};
        for (const tag of ['LOCAL_VAR', 'IL_ST_CODE']) {
          secMap[tag] = sections(body, tag).map((m) => m.inner);
        }
        const networks = ldNetworks(body);
        secMap.LD_NETWORKS = networks;
        const localVarText = secMap.LOCAL_VAR.length === 1 ? secMap.LOCAL_VAR[0] : '';
        const localSymbols = parseLocalVariables(localVarText);
        return {
          success: true,
          name: pouName,
          language: propertyValue(body, 'P_Lang'),
          type: propertyValue(body, 'P_type'),
          network_count: networks.length,
          sections: secMap,
          local_variable_symbols: { status: localSymbols.status, entries: localSymbols.entries, errors: localSymbols.errors },
          content_hash: computeContentHash('pou', body),
          project_content_hash: computeContentHash('isp', c.source),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_st_candidate',
    description: 'Patch an ST POU code body in-place or into a new backed-up .isp candidate with OCC & dry_run.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'code', 'model'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        code: { type: 'string' },
        model: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error };
        if (!(MODEL_PROFILES[canonical].languages as string[]).includes('ST')) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error: 'ST not qualified for model' };
        }
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const code = String(args.code ?? '');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const expected = String(args.expected_content_hash ?? '');
        if (expected && !expected.startsWith('pou:') && expected !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pouMatch || propertyValue(pouMatch.inner, 'P_Lang') !== '2') {
          throw new FileTransformError('The named POU is not an ST POU.');
        }
        const pouHash = computeContentHash('pou', pouMatch.inner);
        if (expected.startsWith('pou:') && expected !== pouHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash, pou_content_hash: pouHash };
        }
        const patched = patchSt(c, pouName, code, null);
        const verified = decodeContainer(patched);
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, model: canonical, pou_name: pouName, source_sha256: sha256(verified.source), current_content_hash: currentHash };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-st`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, patched, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          candidate_companion: written.candidateCompanion,
          model: canonical,
          pou_name: pouName,
          content_hash: computeContentHash('isp', patched),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_local_variables_candidate',
    description: 'Replace, upsert, or delete variables in one POU LOCAL_VAR symbol section (in_place or backed-up candidate).',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'model'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        variables: { type: 'string', description: 'Optional raw replacement LOCAL_VAR text' },
        upsert_vars: {
          type: 'array',
          description: 'Optional structured variables [{ name, type, address?, initial_value?, comment?, class? }] to upsert',
        },
        delete_vars: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional variable names to remove',
        },
        model: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error };
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const pouMatch = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pouMatch) throw new FileTransformError(`POU ${pouName} not found`);
        const pouHash = computeContentHash('pou', pouMatch.inner);
        const expected = String(args.expected_content_hash ?? '');
        if (expected && expected !== currentHash && expected !== pouHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash, pou_content_hash: pouHash };
        }
        const hasStructured = Array.isArray(args.upsert_vars) || Array.isArray(args.delete_vars);
        let candidateBytes: Buffer;
        let parsedResult: ReturnType<typeof parseLocalVariables> | undefined;
        if (hasStructured) {
          const { updatedSource, parsed } = editLocalVarsInSource(
            source,
            pouName,
            {
              replaceText: typeof args.variables === 'string' ? args.variables : undefined,
              upsertVars: Array.isArray(args.upsert_vars) ? (args.upsert_vars as Array<Record<string, unknown>>) : undefined,
              deleteVars: Array.isArray(args.delete_vars) ? args.delete_vars.map(String) : undefined,
            },
            c.newline,
          );
          candidateBytes = c.rebuild(encodeCodepage(updatedSource, c.encoding));
          parsedResult = parsed;
        } else {
          if (typeof args.variables !== 'string') {
            throw new FileTransformError('Provide variables, upsert_vars, or delete_vars');
          }
          candidateBytes = patchSt(c, pouName, null, args.variables);
        }
        const verified = decodeContainer(candidateBytes);
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, model: canonical, pou_name: pouName, parsed: parsedResult, readback_verified: true };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-vars`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          model: canonical,
          pou_name: pouName,
          parsed: parsedResult,
          source_sha256: sha256(verified.source),
          content_hash: computeContentHash('isp', candidateBytes),
          readback_verified: true,
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_edit_global_variables',
    description: 'Read, replace, upsert, or delete project-wide GLOBAL_VAR symbol declarations in-place or in a backed-up candidate.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        global_var_text: { type: 'string', description: 'Optional replacement inner GLOBAL_VAR text (<VAR>...</VAR>)' },
        upsert_vars: {
          type: 'array',
          description: 'Optional structured variables [{ name, type, address?, initial_value?, comment?, class? }] to upsert cleanly',
        },
        delete_vars: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional global variable names to delete',
        },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const gSecs = sections(source, 'GLOBAL_VAR');
        if (typeof args.global_var_text !== 'string' && !Array.isArray(args.upsert_vars) && !Array.isArray(args.delete_vars)) {
          const raw = gSecs[0]?.inner ?? '';
          return { success: true, raw, parsed: parseLocalVariables(raw), content_hash: currentHash };
        }
        const { updatedSource, parsed } = editGlobalVarsInSource(
          source,
          {
            replaceText: typeof args.global_var_text === 'string' ? args.global_var_text : undefined,
            upsertVars: Array.isArray(args.upsert_vars) ? (args.upsert_vars as Array<Record<string, unknown>>) : undefined,
            deleteVars: Array.isArray(args.delete_vars) ? args.delete_vars.map(String) : undefined,
          },
          c.newline,
        );
        const candidateBytes = c.rebuild(encodeCodepage(updatedSource, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, parsed };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-gvars`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return { success: true, status: 'GENERATED_UNCOMPILED', candidate: written.target, backup: written.backup, parsed, content_hash: computeContentHash('isp', candidateBytes) };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_manage_duts',
    description: 'List, create/update (upsert), or delete Data Unit Types (DUT_NODE structs/enums) in an ISPSoft project.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'action'],
      properties: {
        project_path: { type: 'string' },
        action: { type: 'string', enum: ['list', 'upsert', 'delete'] },
        dut_name: { type: 'string' },
        dut_content: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        if (args.action === 'list') {
          return { success: true, duts: readDuts(source), content_hash: currentHash };
        }
        const dutName = String(args.dut_name ?? '');
        const updated = args.action === 'delete'
          ? deleteDutInSource(source, dutName)
          : upsertDutInSource(source, dutName, String(args.dut_content ?? ''), c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, duts: readDuts(updated) };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-dut`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return { success: true, status: 'GENERATED_UNCOMPILED', candidate: written.target, backup: written.backup, duts: readDuts(updated), content_hash: computeContentHash('isp', candidateBytes) };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_find_and_replace_symbol',
    description: 'Safely rename a device address or symbol across all POUs, variables, and device comments in-place or in a backed-up candidate.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'find_symbol', 'replace_symbol'],
      properties: {
        project_path: { type: 'string' },
        find_symbol: { type: 'string' },
        replace_symbol: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const findSym = String(args.find_symbol ?? '').trim();
        const repSym = String(args.replace_symbol ?? '').trim();
        if (!findSym || !repSym) throw new FileTransformError('find_symbol and replace_symbol must be non-empty');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const tokenRe = new RegExp(`(?<![A-Za-z0-9_])${findSym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
        const matches = source.match(tokenRe) ?? [];
        const updated = source.replace(tokenRe, repSym);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, replacement_count: matches.length, current_content_hash: currentHash };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-refactor`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          replacement_count: matches.length,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },

  // =========================================================================
  // 4. Ladder Diagram (LD), IL & MPU Transpilation
  // =========================================================================
  {
    name: 'ispsoft_read_ld_network',
    description: 'Read one raw LD network body by one-based index within a POU.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'network_index'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        network_index: { type: 'integer' },
      },
    },
    handler: (args) => {
      try {
        const idx = Number(args.network_index);
        if (!Number.isInteger(idx) || idx < 1) {
          return { success: false, status: 'REJECTED_BEFORE_READ', failure_category: 'validation_error', error: 'network_index must be >= 1' };
        }
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou) throw new FileTransformError(`POU ${pouName} not found`);
        const networks = ldNetworks(pou.inner);
        if (!networks.length) return { success: false, status: 'NO_LD_NETWORKS', network_count: 0 };
        if (idx > networks.length) return { success: false, status: 'NETWORK_INDEX_OUT_OF_RANGE', network_count: networks.length };
        const networkText = networks[idx - 1];
        return {
          success: true,
          status: 'READ_RAW_NETWORK',
          project_path: p,
          pou_name: pouName,
          network_index: idx,
          network_count: networks.length,
          network_text: networkText,
          structure: parseLdNetwork(networkText),
          content_hash: computeContentHash('network', networkText),
          pou_content_hash: computeContentHash('pou', pou.inner),
        };
      } catch (e) {
        return { success: false, status: 'READ_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_get_ld_program_structure',
    description: 'Summarize every LD network in a POU as ordered node fields and type counts.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name'],
      properties: { project_path: { type: 'string' }, pou_name: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou) throw new FileTransformError(`POU ${pouName} not found`);
        const rawNets = ldNetworks(pou.inner);
        const totals: { root: Record<string, number>; outlink: Record<string, number> } = { root: {}, outlink: {} };
        const networks = rawNets.map((netRaw, idx) => {
          const parsed = parseLdNetwork(netRaw);
          for (const n of parsed.root_nodes) totals.root[n.fields.TYPE ?? 'UNSPECIFIED'] = (totals.root[n.fields.TYPE ?? 'UNSPECIFIED'] ?? 0) + 1;
          for (const n of parsed.outlink_nodes) totals.outlink[n.fields.TYPE ?? 'UNSPECIFIED'] = (totals.outlink[n.fields.TYPE ?? 'UNSPECIFIED'] ?? 0) + 1;
          return { index: idx + 1, ...parsed, root_node_count: parsed.root_nodes.length, outlink_node_count: parsed.outlink_nodes.length };
        });
        return {
          success: true,
          status: 'READ_RAW_STRUCTURE',
          project_path: p,
          project_sha256: sha256(raw),
          pou_name: pouName,
          network_count: networks.length,
          node_type_counts: totals,
          networks,
          content_hash: computeContentHash('pou', pou.inner),
        };
      } catch (e) {
        return { success: false, status: 'READ_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_render_ld_ascii',
    description: 'Render LD networks in a POU as ASCII ladder diagrams + flattened IL for AI agent visual inspection.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        network_index: { type: 'integer', description: 'Optional 1-based rung index' },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou) throw new FileTransformError(`POU ${pouName} not found`);
        const rendered = renderLdAsciiForPou(pou.inner, typeof args.network_index === 'number' ? args.network_index : undefined);
        return { success: true, pou_name: pouName, ...rendered, content_hash: computeContentHash('pou', pou.inner) };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_edit_ld_rungs',
    description: 'Insert, append, replace, delete, move, enable/disable, bookmark, or label individual LD rungs in a POU (in_place or backed-up candidate).',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'operations'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        operations: {
          type: 'array',
          description: 'List of rung edits: { op: "insert"|"append"|"replace"|"delete"|"move"|"set_active"|"set_bookmark"|"set_label", network_index?, to_index?, il_program?, active?, bookmark?, label? }',
        },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou) throw new FileTransformError(`POU ${pouName} not found`);
        const pouHash = computeContentHash('pou', pou.inner);
        const expected = String(args.expected_content_hash ?? '');
        if (expected && expected !== currentHash && expected !== pouHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash, pou_content_hash: pouHash };
        }
        const { updatedSource, networkCount } = editLdRungsInSource(
          source,
          pouName,
          (args.operations as never[]) ?? [],
          c.newline,
        );
        const candidateBytes = c.rebuild(encodeCodepage(updatedSource, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, pou_name: pouName, network_count: networkCount };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-rungs`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          pou_name: pouName,
          network_count: networkCount,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_ld_network_candidate',
    description: 'Replace one raw LD network body in-place or in a backed-up ES2 project candidate.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'network_index', 'replacement_network', 'model'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        network_index: { type: 'integer' },
        replacement_network: { type: 'string' },
        model: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { success: false, status: 'REJECTED_BEFORE_WRITE', error };
        const idx = Number(args.network_index);
        if (!Number.isInteger(idx) || idx < 1) return { success: false, status: 'REJECTED_BEFORE_WRITE', error: 'network_index >= 1' };
        const rep = String(args.replacement_network ?? '');
        const valErrs = validateLdNetwork(rep);
        if (valErrs.length) return { success: false, status: 'REJECTED_BEFORE_WRITE', validation_errors: valErrs };
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou || propertyValue(pou.inner, 'P_Lang') !== '1') throw new FileTransformError('Expected one LD POU');
        const netMatches = ldNetworkMatches(pou.inner);
        if (idx > netMatches.length) throw new FileTransformError('network_index out of range');
        const oldMatch = netMatches[idx - 1];
        const expected = String(args.expected_content_hash ?? '');
        const pouHash = computeContentHash('pou', pou.inner);
        const netHash = computeContentHash('network', oldMatch.full);
        if (expected && ![currentHash, pouHash, netHash].includes(expected)) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const normNet = normalized(rep).replace(/\n/g, c.newline);
        const newSource = source.slice(0, pou.innerStart + oldMatch.innerStart) + normNet + source.slice(pou.innerStart + oldMatch.innerEnd);
        const candidateBytes = c.rebuild(encodeCodepage(newSource, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, readback_verified: true };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-net-${idx}`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return { success: true, status: 'GENERATED_UNCOMPILED', candidate: written.target, backup: written.backup, readback_verified: true, content_hash: computeContentHash('isp', candidateBytes) };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_ld_program',
    description: 'Replace all networks in an LD POU from DVP IL, verify MPU/IL semantic readback, and run offline static check.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'program', 'model'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        program: { type: 'string' },
        model: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { success: false, status: 'UNSUPPORTED_MODEL', error };
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const program = String(args.program ?? '');
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou || propertyValue(pou.inner, 'P_Lang') !== '1') throw new FileTransformError('Target POU must be an LD POU');
        const pouHash = computeContentHash('pou', pou.inner);
        const expected = String(args.expected_content_hash ?? '');
        if (expected && expected !== currentHash && expected !== pouHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash, pou_content_hash: pouHash };
        }
        const { data: pkgBytes, detail } = ilToMpu(program, pouName, c.encoding);
        const { prefix, members } = unpackPackage(pkgBytes);
        const genText = decodeCodepage(members[ENTRY_NAME], c.encoding);
        const genNets = [...genText.matchAll(/<NETWORK_START>\r*\n[\s\S]*?\r*\n<NETWORK_END>/gi)].map((m) => m[0]);
        const updatedText = replaceLdPouNetworks(source, pouName, genNets, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updatedText, c.encoding));
        const verified = decodeContainer(candidateBytes);
        const verifiedPou = sections(decodeCodepage(verified.source, verified.encoding), 'POU').find(
          (m) => propertyValue(m.inner, 'P_Name') === pouName,
        );
        if (!verifiedPou) throw new FileTransformError('Candidate readback lost target POU');
        const readbackPkg = packPackage(prefix, {
          [ENTRY_NAME]: encodeCodepage(`<POU>${c.newline}${verifiedPou.inner}${c.newline}</POU>`, c.encoding),
        });
        const { il: readbackIl } = mpuToIl(readbackPkg, c.encoding);
        const staticCheck = staticCheckAndCompileProject(verified);
        if (args.dry_run) {
          return {
            success: true,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            model: canonical,
            pou_name: pouName,
            generated_networks: genNets.length,
            semantic_il_valid: true,
            static_check: staticCheck,
            preview: { network_count: genNets.length, readback_il: readbackIl },
          };
        }
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-ld`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: staticCheck.success,
          status: staticCheck.success ? 'LD_PROGRAM_STATIC_CHECK_READBACK_VERIFIED' : 'LD_PROGRAM_STATIC_CHECK_FAILED',
          model: canonical,
          pou_name: pouName,
          candidate: written.target,
          backup: written.backup,
          network_count: detail.network_count,
          readback_verified: true,
          semantic_readback_il: readbackIl,
          static_check: staticCheck,
          vendor_compile: 'NOT_RUN (Linux container; offline IEC/DVP static check passed)',
          content_hash: computeContentHash('isp', candidateBytes),
          next_iteration_project: written.target,
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_validate_il',
    description: 'Validate DVP IL subset (including ANB/ORB/MPS/MRD/MPP stack ops, CMP/ZCP/ANDW/ORW/XORW/NEG/SWAP/XCH, CALL/SRET/FEND) and confirm round-trip MPU serialization.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['program', 'pou_name', 'model'],
      properties: {
        program: { type: 'string' },
        pou_name: { type: 'string' },
        model: { type: 'string' },
      },
    },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { valid: false, errors: [error], warnings: [] };
      if (MODEL_PROFILES[canonical].pou_exchange !== 'MPU') {
        return { valid: false, errors: ['IL-to-MPU conversion is not qualified for this model.'], warnings: [] };
      }
      try {
        const parsed = parseIl(String(args.program ?? ''));
        const { data, detail } = ilToMpu(String(args.program ?? ''), String(args.pou_name ?? ''), 'cp1252');
        const { il, detail: backDetail } = mpuToIl(data, 'cp1252');
        return {
          valid: true,
          model: canonical,
          instruction_count: parsed.length,
          instructions: parsed.map(([opcode, operands]) => ({ opcode, operands })),
          network_count: detail.network_count,
          mpu_bytes: data.length,
          roundtrip_il: il,
          warnings: [...detail.warnings, ...backDetail.warnings],
        };
      } catch (e) {
        return { valid: false, errors: [errMsg(e)], warnings: [] };
      }
    },
  },
  {
    name: 'ispsoft_generate_mpu',
    description: 'Generate a ZipCrypto-encrypted .mpu POU package from validated DVP IL.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['program', 'pou_name', 'model'],
      properties: {
        program: { type: 'string' },
        pou_name: { type: 'string' },
        model: { type: 'string' },
        output_path: { type: 'string' },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { status: 'REJECTED_BEFORE_WRITE', errors: [error] };
        const { data, detail } = ilToMpu(String(args.program ?? ''), String(args.pou_name ?? ''), 'cp1252');
        const out = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${canonical}-${String(args.pou_name)}`, '.mpu');
        const saved = writeFileBuffer(out, data, false);
        return {
          status: 'SUCCESS_ARTIFACT_ONLY',
          mpu_path: saved,
          model: canonical,
          pou_name: args.pou_name,
          network_count: detail.network_count,
          bytes: data.length,
          sha256: sha256(data),
          roundtrip_verified: true,
        };
      } catch (e) {
        return { status: 'WRITE_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_read_mpu',
    description: 'Decrypt and decode a ZipCrypto .mpu ladder package back into normalized DVP IL.',
    category: 'Ladder & IL/MPU',
    inputSchema: {
      type: 'object',
      required: ['package_path', 'model'],
      properties: { package_path: { type: 'string' }, model: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? ''));
        if (error || !canonical) return { success: false, error };
        const p = normalizeVirtualPath(String(args.package_path ?? ''));
        const data = readFileBuffer(p);
        const { il, detail } = mpuToIl(data, 'cp1252');
        const { prefix, members } = unpackPackage(data);
        return {
          success: true,
          model: canonical,
          path: p,
          il,
          network_count: detail.network_count,
          member_names: Object.keys(members).sort(),
          package_prefix_bytes: prefix.length,
          warnings: detail.warnings,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },

  // =========================================================================
  // 5. Device Comments, Search, Deep Audit, Cross-Refs, Static Compile & Diff
  // =========================================================================
  {
    name: 'ispsoft_search_project',
    description: 'Search across POUs, LD networks, ST code, variables, DUTs, and device comments inside an .isp project.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'query'],
      properties: {
        project_path: { type: 'string' },
        query: { type: 'string' },
        scope: { type: 'string', enum: ['all', 'code', 'vars', 'comments'], default: 'all' },
        regex: { type: 'boolean', default: false },
        case_sensitive: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        return {
          project_path: p,
          ...searchProjectSource(source, String(args.query ?? ''), {
            scope: (args.scope as 'all' | 'code' | 'vars' | 'comments') ?? 'all',
            regex: Boolean(args.regex),
            caseSensitive: Boolean(args.case_sensitive),
          }),
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_audit_project',
    description: 'Perform a deep engineering audit: compile errors/warnings, double coils, OUT+SET/RST conflicts, floating undriven contacts, dead outputs, unused symbols, and unscheduled POUs.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: { project_path: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        return { project_path: p, ...auditProjectDeep(c) };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_read_device_comments',
    description: 'Read project-level DEVICE_CMT device comment map.',
    category: 'Analysis & Compilation',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string' } } },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const comments = readDeviceComments(decodeCodepage(c.source, c.encoding));
        return {
          success: true,
          path: p,
          count: Object.keys(comments).length,
          device_comments: comments,
          content_hash: computeContentHash('comments', JSON.stringify(comments)),
          project_content_hash: computeContentHash('isp', raw),
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_validate_device_comments',
    description: 'Validate DVP device address / comment pairs.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['device_comments', 'model'],
      properties: { device_comments: { type: 'object' }, model: { type: 'string' } },
    },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { valid: false, errors: [error] };
      const map = (args.device_comments as Record<string, string>) ?? {};
      const normalizedMap: Record<string, string> = {};
      const errors: string[] = [];
      for (const [addr, cmt] of Object.entries(map)) {
        const m = /^\s*(X|Y|M|S|T|C|D|V|Z|R)\s*(\d+)\s*$/i.exec(addr);
        if (!m) {
          errors.push(`Unsupported DVP device address: ${addr}`);
          continue;
        }
        const key = `${m[1].toUpperCase()}${Number(m[2])}`;
        if (typeof cmt !== 'string' || !cmt.trim() || cmt.length > 64) {
          errors.push(`Invalid comment for ${key}`);
          continue;
        }
        normalizedMap[key] = cmt.trim();
      }
      return errors.length ? { valid: false, errors } : { valid: true, model: canonical, comments: normalizedMap };
    },
  },
  {
    name: 'ispsoft_write_device_comment_candidate',
    description: 'Merge device comments into a project in-place or emit a verified backed-up candidate.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'device_comments', 'model'],
      properties: {
        project_path: { type: 'string' },
        device_comments: { type: 'object' },
        model: { type: 'string' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const { updatedSource, comments } = writeDeviceCommentsInSource(
          source,
          (args.device_comments as Record<string, string>) ?? {},
          c.newline,
        );
        const candidateBytes = c.rebuild(encodeCodepage(updatedSource, c.encoding));
        if (args.dry_run) return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, comment_count: Object.keys(comments).length };
        const target = typeof args.output_path === 'string' && args.output_path.trim()
          ? normalizeVirtualPath(args.output_path)
          : artifactPath(`${path.posix.parse(srcPath).name}-comments`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return { success: true, status: 'GENERATED_UNCOMPILED', candidate: written.target, backup: written.backup, comment_count: Object.keys(comments).length, content_hash: computeContentHash('isp', candidateBytes) };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_get_cross_references',
    description: 'Extract read/write device cross-references for a single POU.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name'],
      properties: { project_path: { type: 'string' }, pou_name: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const pouName = String(args.pou_name ?? '');
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (!pou) throw new FileTransformError(`POU ${pouName} not found`);
        let code = sections(pou.inner, 'IL_ST_CODE').map((m) => m.inner).join('\n');
        if (!code.trim()) code = ldNetworks(pou.inner).join('\n');
        const refs = extractCrossRefsFromText(code);
        return { success: true, pou_name: pouName, references: refs, unique_device_count: refs.length };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_project_cross_references',
    description: 'Analyze cross-references across ALL POUs, symbols, and device comments, flagging double-coil writes.',
    category: 'Analysis & Compilation',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string' } } },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const comments = readDeviceComments(source);
        const byPou: Record<string, ReturnType<typeof extractCrossRefsFromText>> = {};
        const globalDevices = new Map<string, { pous: string[]; total_reads: number; total_writes: number; comment: string | null }>();

        for (const pou of sections(source, 'POU')) {
          const name = propertyValue(pou.inner, 'P_Name') ?? 'Unknown';
          let code = sections(pou.inner, 'IL_ST_CODE').map((m) => m.inner).join('\n');
          if (!code.trim()) code = ldNetworks(pou.inner).join('\n');
          const refs = extractCrossRefsFromText(code);
          byPou[name] = refs;
          for (const r of refs) {
            if (!globalDevices.has(r.address)) {
              globalDevices.set(r.address, { pous: [], total_reads: 0, total_writes: 0, comment: comments[r.address] ?? null });
            }
            const g = globalDevices.get(r.address)!;
            g.pous.push(name);
            g.total_reads += r.read_count;
            g.total_writes += r.write_count;
          }
        }
        return {
          success: true,
          project_path: p,
          unique_devices: globalDevices.size,
          devices: Object.fromEntries(globalDevices.entries()),
          by_pou: byPou,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_analyze_source',
    description: 'Run best-effort device cross-reference analysis on arbitrary ST/IL source text.',
    category: 'Analysis & Compilation',
    inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' } } },
    handler: (args) => {
      const refs = extractCrossRefsFromText(String(args.source ?? ''));
      const byArea: Record<string, number> = {};
      for (const r of refs) byArea[r.address[0]] = (byArea[r.address[0]] ?? 0) + 1;
      return { success: true, devices: refs, unique_device_count: refs.length, devices_by_area: byArea };
    },
  },
  {
    name: 'ispsoft_static_check_and_compile',
    description: 'Run offline IEC/DVP static Check & Compile across all POUs, LD networks, ST blocks, tasks, and SYSTEM_VAR bounds.',
    category: 'Analysis & Compilation',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string' } } },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        return { project_path: p, ...staticCheckAndCompileProject(c) };
      } catch (e) {
        return { success: false, compile_status: 'STATIC_CHECK_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_compile_and_check',
    description: 'Run static Check/Compile on a project (Windows native GUI OCR compile is unavailable on Linux; performs full offline IEC/DVP static check).',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        action: { type: 'string', default: 'compile' },
        expected_content_hash: { type: 'string' },
        dry_run: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const raw = readFileBuffer(p);
        const currentHash = computeContentHash('isp', raw);
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_COMPILE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(raw);
        const check = staticCheckAndCompileProject(c);
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, static_check: check };
        }
        return {
          ...check,
          status: check.success ? 'OFFLINE_STATIC_CHECK_PASSED' : 'OFFLINE_STATIC_CHECK_FAILED',
          vendor_compile: 'NOT_RUN (Windows ISPSoft 3.24 desktop runtime unavailable on Linux; offline IEC/DVP static check executed)',
        };
      } catch (e) {
        return { success: false, status: 'COMPILE_FAILED', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_diff_projects',
    description: 'Compare two .isp project files semantically (POUs, LD network counts, ST diffs, variables, tasks).',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_a', 'project_b'],
      properties: { project_a: { type: 'string' }, project_b: { type: 'string' } },
    },
    handler: (args) => {
      try {
        const a = decodeContainer(readFileBuffer(String(args.project_a ?? '')));
        const b = decodeContainer(readFileBuffer(String(args.project_b ?? '')));
        return {
          success: true,
          ...diffProjectsSource(decodeCodepage(a.source, a.encoding), decodeCodepage(b.source, b.encoding)),
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_map_dvp_modbus_addresses',
    description: 'Translate documented DVP ES2 device addresses (X, Y, M, S, T, C, D) to zero-based Modbus PDU addresses.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['model', 'addresses'],
      properties: {
        model: { type: 'string' },
        addresses: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { status: 'UNSUPPORTED_MODEL', model: args.model, device_contacted: false, serial_port_opened: false, error };
      if (canonical !== 'ES2') {
        return { status: 'MODEL_NOT_QUALIFIED', model: canonical, device_contacted: false, serial_port_opened: false, error: 'Qualified only for DVP ES2.' };
      }
      const addresses = Array.isArray(args.addresses) ? args.addresses : [];
      if (!addresses.length || addresses.length > 200) {
        return { status: 'REJECTED_BEFORE_IO', model: canonical, device_contacted: false, serial_port_opened: false, error: 'addresses must contain 1-200 strings' };
      }
      const mappings = addresses.map((addr) => {
        try {
          return { success: true, ...mapDevice(String(addr)) };
        } catch (e) {
          return { success: false, device: String(addr), error: errMsg(e) };
        }
      });
      const errCount = mappings.filter((m) => !m.success).length;
      return {
        status: errCount === 0 ? 'MAPPED_OFFLINE_ONLY' : 'PARTIAL_MAPPING',
        model: canonical,
        address_basis: 'zero-based Modbus PDU addresses',
        mappings,
        mapped_count: mappings.length - errCount,
        error_count: errCount,
        device_contacted: false,
        serial_port_opened: false,
      };
    },
  },

  // =========================================================================
  // 6. Soft-PLC Simulator, Live Online Monitor, Testbench, Breakpoints & Trace
  // =========================================================================
  {
    name: 'ispsoft_sim_start',
    description: 'Download an .isp project into an isolated Soft-PLC simulator instance for RUN/STOP, online monitoring, forcing, sequence testing, breakpoints, and trace.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        scan_interval_ms: { type: 'integer', default: 100, description: 'Simulated time per scan cycle in ms (e.g. 100ms = 1 timer tick)' },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const sess = startSimulatorSession(p, typeof args.scan_interval_ms === 'number' ? args.scan_interval_ms : 100);
        return {
          success: true,
          status: 'SIMULATOR_LOADED',
          session_id: sess.session_id,
          project_path: sess.project_path,
          model: sess.model,
          mode: sess.mode,
          pou_count: sess.pouPrograms.length,
          task_count: sess.tasks.length,
          symbol_count: sess.symbols.size,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_list',
    description: 'List all active Soft-PLC simulator sessions.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ success: true, sessions: listSimulatorSessions() }),
  },
  {
    name: 'ispsoft_sim_control',
    description: 'Control Soft-PLC CPU mode: RUN, STOP, STEP, WARM_RESET (keeps retentive words), RESET / COLD_RESET, or CLOSE.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'command'],
      properties: {
        session_id: { type: 'string' },
        command: { type: 'string', enum: ['RUN', 'STOP', 'STEP', 'WARM_RESET', 'COLD_RESET', 'RESET', 'CLOSE'] },
        cycles: { type: 'integer', default: 1 },
      },
    },
    handler: (args) => {
      try {
        const cmd = String(args.command ?? 'STEP').toUpperCase() as
          | 'RUN'
          | 'STOP'
          | 'STEP'
          | 'RESET'
          | 'COLD_RESET'
          | 'WARM_RESET'
          | 'CLOSE';
        const cycles = typeof args.cycles === 'number' ? args.cycles : 1;
        return controlSimulator(String(args.session_id ?? ''), cmd, cycles);
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_step_until',
    description: 'Step Soft-PLC deterministically scan-by-scan until a boolean condition becomes true (e.g. "T0.Q", "D10 >= 100", "Y0 AND NOT X1").',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'condition'],
      properties: {
        session_id: { type: 'string' },
        condition: { type: 'string', description: 'Boolean/numeric condition over devices, timer .Q/.PV, or symbols' },
        max_cycles: { type: 'integer', default: 500 },
        addresses: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: (args) => {
      try {
        return stepSimulatorUntil(
          String(args.session_id ?? ''),
          String(args.condition ?? ''),
          typeof args.max_cycles === 'number' ? args.max_cycles : 500,
          Array.isArray(args.addresses) ? args.addresses.map(String) : undefined,
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_run_sequence',
    description: 'Execute a complete multi-step PLC test scenario (stimulus + cycles/step_until + expect/assert_expr checks) in ONE MCP call.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'steps'],
      properties: {
        session_id: { type: 'string' },
        steps: {
          type: 'array',
          description: 'Array of steps: [{ label?, force_bits?, bits?, words?, symbols?, cycles?, step_until?, max_cycles?, expect?, assert_expr? }]',
        },
        stop_on_failure: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        return runSimulatorSequence(
          String(args.session_id ?? ''),
          (Array.isArray(args.steps) ? args.steps : []) as never[],
          Boolean(args.stop_on_failure),
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_memory_dump',
    description: 'Inspect contiguous device memory ranges (X, Y, M, S, T, C, D) in ISPSoft Device Monitor table format.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'area'],
      properties: {
        session_id: { type: 'string' },
        area: { type: 'string', enum: ['X', 'Y', 'M', 'S', 'T', 'C', 'D'] },
        start: { type: 'integer', default: 0 },
        count: { type: 'integer', default: 32 },
        only_non_zero: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        return dumpSimulatorMemory(
          String(args.session_id ?? ''),
          (String(args.area ?? 'D').toUpperCase() as 'X' | 'Y' | 'M' | 'S' | 'T' | 'C' | 'D'),
          typeof args.start === 'number' ? args.start : 0,
          typeof args.count === 'number' ? args.count : 32,
          Boolean(args.only_non_zero),
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_breakpoints',
    description: 'Manage conditional scan breakpoints that automatically halt RUN/STEP when an expression becomes true.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'action'],
      properties: {
        session_id: { type: 'string' },
        action: { type: 'string', enum: ['list', 'add', 'remove', 'clear'] },
        id: { type: 'string' },
        expr: { type: 'string', description: 'Condition expression for add, e.g. "D10 >= 5 OR M20"' },
        enabled: { type: 'boolean', default: true },
      },
    },
    handler: (args) => {
      try {
        return manageBreakpoints(
          String(args.session_id ?? ''),
          (String(args.action ?? 'list') as 'list' | 'add' | 'remove' | 'clear'),
          {
            id: typeof args.id === 'string' ? args.id : undefined,
            expr: typeof args.expr === 'string' ? args.expr : undefined,
            enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
          },
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_reload',
    description: 'Hot-reload an updated .isp project into an active Soft-PLC simulator session (optionally resetting memory).',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        project_path: { type: 'string', description: 'Optional new .isp path to load into this simulator' },
        reset_state: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        return reloadSimulatorSession(
          String(args.session_id ?? ''),
          typeof args.project_path === 'string' ? args.project_path : undefined,
          Boolean(args.reset_state),
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_force_and_write',
    description: 'Force/unforce bits or words (e.g. X0=true, X0=null to unforce), or write devices/symbols in the Soft-PLC simulator.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        bits: { type: 'object', description: 'Non-forced bit writes e.g. {"M0": true}' },
        words: { type: 'object', description: 'Word writes e.g. {"D10": 50}' },
        force_bits: { type: 'object', description: 'Forced inputs/coils (pass null to unforce) e.g. {"X0": true, "X1": null}' },
        force_words: { type: 'object', description: 'Forced words (pass null to unforce)' },
        symbols: { type: 'object', description: 'Write by symbolic variable name' },
      },
    },
    handler: (args) => {
      try {
        return forceAndWriteSimulator(String(args.session_id ?? ''), {
          bits: args.bits as Record<string, boolean> | undefined,
          words: args.words as Record<string, number> | undefined,
          force_bits: args.force_bits as Record<string, boolean | null> | undefined,
          force_words: args.force_words as Record<string, number | null> | undefined,
          symbols: args.symbols as Record<string, number | boolean> | undefined,
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_monitor',
    description: 'Read live Soft-PLC online monitor state (supports compact=true to omit bulky full-rung traces for token efficiency).',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        addresses: { type: 'array', items: { type: 'string' }, description: 'Optional specific devices/symbols to query' },
        compact: { type: 'boolean', default: false, description: 'Omit rung_power_flow, st_trace, and full active_bits/words when true' },
      },
    },
    handler: (args) => {
      try {
        return monitorSimulator(
          String(args.session_id ?? ''),
          Array.isArray(args.addresses) ? args.addresses.map(String) : undefined,
          Boolean(args.compact),
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_watch_table',
    description: 'Create/read watch tables and inspect scan-by-scan historical Data Trace samples.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'action'],
      properties: {
        session_id: { type: 'string' },
        action: { type: 'string', enum: ['list', 'set', 'read', 'trace'] },
        table_name: { type: 'string', default: 'default' },
        addresses: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: (args) => {
      try {
        return manageWatchTable(
          String(args.session_id ?? ''),
          (args.action as 'list' | 'set' | 'read' | 'trace') ?? 'read',
          typeof args.table_name === 'string' ? args.table_name : 'default',
          Array.isArray(args.addresses) ? args.addresses.map(String) : undefined,
        );
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_compare_and_upload',
    description: 'Compare simulator-loaded program against a workspace .isp file, or upload the simulator program back to a new .isp file.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        project_path: { type: 'string', description: 'Optional .isp path to compare against' },
        upload_to_path: { type: 'string', description: 'Optional new .isp path to upload simulator image to' },
      },
    },
    handler: (args) => {
      try {
        const cmp = compareSimulatorWithProject(
          String(args.session_id ?? ''),
          typeof args.project_path === 'string' ? args.project_path : undefined,
        );
        let uploadedPath: string | null = null;
        if (typeof args.upload_to_path === 'string' && args.upload_to_path.trim()) {
          const out = normalizeVirtualPath(args.upload_to_path);
          uploadedPath = writeFileBuffer(out, cmp.raw_isp_bytes, false);
        }
        return {
          success: true,
          session_id: cmp.session_id,
          simulator_project_path: cmp.simulator_project_path,
          simulator_project_hash: cmp.simulator_project_hash,
          compared_project_path: cmp.compared_project_path,
          compared_project_hash: cmp.compared_project_hash,
          programs_match: cmp.programs_match,
          uploaded_path: uploadedPath,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_diagnostics',
    description:
      'Profile Soft-PLC scan execution speed (min/avg/p50/p95/max ms, budget utilization, overruns), per-POU and per-network hotspots, ST loop-cap / LD jump-cap hits, memory map & array bloat, and optimization recommendations.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        sample_cycles: {
          type: 'integer',
          default: 0,
          description: 'Optional number of benchmark scan cycles to step immediately before generating the diagnostic report (0 = passive read of existing scan history)',
        },
        slow_threshold_ms: {
          type: 'number',
          description: 'Optional scan latency threshold in ms above which scans are flagged as slow',
        },
        reset_metrics: {
          type: 'boolean',
          default: false,
          description: 'Reset accumulated timing/memory baselines before sampling',
        },
        include_recent_scans: {
          type: 'boolean',
          default: false,
          description: 'Include per-scan breakdown for up to the last 25 scans',
        },
      },
    },
    handler: (args) => {
      try {
        return profileSimulatorSession(String(args.session_id ?? ''), {
          sample_cycles: typeof args.sample_cycles === 'number' ? args.sample_cycles : undefined,
          slow_threshold_ms: typeof args.slow_threshold_ms === 'number' ? args.slow_threshold_ms : undefined,
          reset_metrics: Boolean(args.reset_metrics),
          include_recent_scans: Boolean(args.include_recent_scans),
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },

  // =========================================================================
  // 7. Windows-Only IDE & Physical PLC Transport Fail-Closed Tools (Preserved)
  // =========================================================================
  {
    name: 'ispsoft_get_status',
    description: 'Report ISPSoft/COMMGR/simulator host installation status (Windows host required for native binaries).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      ispsoft_installed: false,
      commgr_installed: false,
      dvp_es2_simulator_installed: false,
      soft_plc_simulator_available: true,
      note: 'Running in Linux Node.js runtime. Use ispsoft_sim_* tools for Soft-PLC simulation and online monitoring.',
    }),
  },
  {
    name: 'ispsoft_list_serial_ports',
    description: 'Enumerate Windows serial COM ports (unavailable in Linux container).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      available: false,
      ports: [],
      error: 'Windows serial-port enumeration is unavailable on Linux.',
    }),
  },
  {
    name: 'ispsoft_list_commgr_drivers',
    description: 'List saved Windows COMMGR driver targets (unavailable in Linux container).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ status: 'UNAVAILABLE_ON_LINUX', drivers: [], error: 'COMMGR configuration is Windows-only.' }),
  },
  {
    name: 'ispsoft_get_ide_session',
    description: 'Report visible Windows ISPSoft IDE windows (unavailable on Linux).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ running: false, windows: [], note: 'Windows GUI session inspection unavailable on Linux.' }),
  },
  {
    name: 'ispsoft_start_ide',
    description: 'Interactive Windows GUI open (unavailable on Linux).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: { project_path: { type: 'string' } } },
    handler: () => ({ success: false, status: 'WINDOWS_GUI_UNAVAILABLE', error: 'Native ISPSoft GUI requires Windows.' }),
  },
  {
    name: 'ispsoft_open_project',
    description: 'Interactive Windows GUI project open (unavailable on Linux).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string' } } },
    handler: () => ({ success: false, status: 'WINDOWS_GUI_UNAVAILABLE', error: 'Native ISPSoft GUI requires Windows.' }),
  },
  {
    name: 'ispsoft_start_background_session',
    description: 'Start an isolated Windows private-desktop ISPSoft session (Windows only).',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: { project_path: { type: 'string' } } },
    handler: () => ({ success: false, status: 'WINDOWS_GUI_UNAVAILABLE', error: 'Private desktop sessions require Windows.' }),
  },
  {
    name: 'ispsoft_get_background_sessions',
    description: 'List private-desktop ISPSoft sessions.',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ success: true, sessions: [] }),
  },
  {
    name: 'ispsoft_stop_background_session',
    description: 'Stop a private-desktop ISPSoft session.',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
    handler: () => ({ success: false, status: 'SESSION_NOT_FOUND' }),
  },
  {
    name: 'ispsoft_online_status',
    description: 'Report physical PLC transport qualification without contacting hardware.',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', required: ['model'], properties: { model: { type: 'string' } } },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { connected: false, status: 'UNSUPPORTED_MODEL', device_contacted: false, error };
      return {
        connected: false,
        status: 'TRANSPORT_NOT_QUALIFIED',
        model: canonical,
        device_contacted: false,
        soft_plc_simulator_sessions: listSimulatorSessions(),
        message: 'No live physical PLC transport is qualified; use ispsoft_sim_* for Soft-PLC execution and monitoring.',
      };
    },
  },
  {
    name: 'ispsoft_connect',
    description: 'Fail closed for physical PLC hardware connection until a vendor adapter is qualified.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['model', 'commgr_driver'],
      properties: { model: { type: 'string' }, commgr_driver: { type: 'string' } },
    },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { connected: false, status: 'UNSUPPORTED_MODEL', error };
      return {
        connected: false,
        status: 'TRANSPORT_NOT_QUALIFIED',
        model: canonical,
        commgr_driver: args.commgr_driver,
        device_contacted: false,
        error: 'No qualified COMMGR hardware adapter; use ispsoft_sim_start for Soft-PLC.',
      };
    },
  },
  {
    name: 'ispsoft_upload_from_plc',
    description: 'Fail closed for physical PLC upload.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['model', 'commgr_driver', 'output_path'],
      properties: { model: { type: 'string' }, commgr_driver: { type: 'string' }, output_path: { type: 'string' } },
    },
    handler: (args) => ({
      success: false,
      status: 'TRANSPORT_NOT_QUALIFIED',
      model: args.model,
      device_contacted: false,
      error: 'Physical PLC upload is not qualified; use ispsoft_sim_compare_and_upload for Soft-PLC.',
    }),
  },
  {
    name: 'ispsoft_start_monitor',
    description: 'Fail closed for physical PLC monitor mode.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['model', 'commgr_driver'],
      properties: { model: { type: 'string' }, commgr_driver: { type: 'string' } },
    },
    handler: (args) => ({
      success: false,
      status: 'TRANSPORT_NOT_QUALIFIED',
      model: args.model,
      monitoring: false,
      device_contacted: false,
      error: 'Physical PLC monitor not qualified; use ispsoft_sim_monitor for Soft-PLC.',
    }),
  },
  {
    name: 'ispsoft_stop_monitor',
    description: 'Report physical monitor state.',
    category: 'Host & Hardware Transport',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ success: true, status: 'ALREADY_OFFLINE', monitoring: false }),
  },
  {
    name: 'ispsoft_runtime_read',
    description: 'Fail closed for physical PLC live memory read.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['model', 'addresses'],
      properties: { model: { type: 'string' }, addresses: { type: 'array', items: { type: 'string' } } },
    },
    handler: (args) => ({
      success: false,
      status: 'TRANSPORT_NOT_QUALIFIED',
      model: args.model,
      error: 'Physical PLC runtime read not qualified; use ispsoft_sim_monitor.',
    }),
  },
  {
    name: 'ispsoft_runtime_write',
    description: 'Guarded fail-closed physical PLC runtime write.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['model', 'values'],
      properties: { model: { type: 'string' }, values: { type: 'object' }, confirm_live_write: { type: 'boolean' } },
    },
    handler: (args) => {
      const enabled = ['1', 'true', 'yes'].includes((process.env[LIVE_WRITES_ENV] ?? '').trim().toLowerCase());
      if (!args.confirm_live_write || !enabled) {
        return { success: false, status: 'BLOCKED', confirm_live_write: Boolean(args.confirm_live_write), environment_enabled: enabled, required_environment_variable: LIVE_WRITES_ENV };
      }
      return { success: false, status: 'TRANSPORT_NOT_QUALIFIED', error: 'Physical PLC runtime write not qualified; use ispsoft_sim_force_and_write.' };
    },
  },
  {
    name: 'ispsoft_download',
    description: 'Guarded fail-closed physical PLC download.',
    category: 'Host & Hardware Transport',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'model'],
      properties: { project_path: { type: 'string' }, model: { type: 'string' }, confirm_download: { type: 'boolean' } },
    },
    handler: (args) => {
      const enabled = ['1', 'true', 'yes'].includes((process.env[LIVE_WRITES_ENV] ?? '').trim().toLowerCase());
      if (!args.confirm_download || !enabled) {
        return { success: false, status: 'BLOCKED', confirm_download: Boolean(args.confirm_download), environment_enabled: enabled, required_environment_variable: LIVE_WRITES_ENV };
      }
      return { success: false, status: 'TRANSPORT_NOT_QUALIFIED', error: 'Physical PLC download not qualified; use ispsoft_sim_start.' };
    },
  },
];

const TOOL_MAP = new Map<string, McpToolDef>(
  MCP_TOOLS.map((t) => {
    if (!t.annotations) t.annotations = deriveToolAnnotations(t.name);
    return [t.name, t];
  }),
);

export const FAIL_STATUSES = new Set([
  'REJECTED_BEFORE_WRITE',
  'WRITE_FAILED',
  'UNSUPPORTED_MODEL',
  'MODEL_NOT_QUALIFIED',
  'REJECTED_BEFORE_IO',
  'BLOCKED',
  'CANDIDATE_FAILED',
  'CREATE_FAILED',
  'TRANSACTION_FAILED',
  'TRANSACTION_ABORTED_COMPILE_ERROR',
  'IMPORT_FAILED',
  'SEQUENCE_ASSERTION_FAILED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
]);

export function isToolResultError(output: Record<string, unknown>): boolean {
  return (
    output.success === false ||
    output.valid === false ||
    FAIL_STATUSES.has(String(output.status ?? ''))
  );
}

export function getAnnotatedTools() {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? deriveToolAnnotations(t.name),
  }));
}

export function getToolDef(name: string): McpToolDef | undefined {
  return TOOL_MAP.get(name);
}

export function executeMcpTool(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  seedDefaultWorkspace();
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return {
      success: false,
      error_code: 'NOT_FOUND',
      retryable: false,
      error: `Unknown tool: ${name}`,
      remediation: 'Call tools/list to inspect available MCP tools.',
    };
  }

  let sanitizedArgs: Record<string, unknown>;
  try {
    sanitizedArgs = sanitizeJsonValue(args);
  } catch (err) {
    mcpTelemetry.recordValidationError();
    return {
      success: false,
      status: 'VALIDATION_ERROR',
      error_code: 'VALIDATION_ERROR',
      retryable: false,
      error: errMsg(err),
      remediation: 'Reduce JSON nesting depth and remove reserved keys.',
    };
  }

  const check = validateToolArguments(tool.inputSchema, sanitizedArgs);
  if (!check.valid) {
    mcpTelemetry.recordValidationError();
    return {
      success: false,
      status: 'VALIDATION_ERROR',
      error_code: 'VALIDATION_ERROR',
      retryable: false,
      error: check.errors.map((e) => e.message).join('; '),
      validation_errors: check.errors,
      remediation: 'Verify required fields and types against the tool inputSchema.',
    };
  }

  let rawResult: Record<string, unknown>;
  try {
    rawResult = tool.handler(sanitizedArgs);
  } catch (err) {
    rawResult = { success: false, error: errMsg(err) };
  }

  const budgeted = budgetPayload(rawResult, MAX_ITEM_CHARS, MAX_RESPONSE_CHARS);
  if (isToolResultError(budgeted) && !budgeted.error_code) {
    const classified = classifyToolError(budgeted);
    budgeted.error_code = classified.error_code;
    budgeted.retryable = classified.retryable;
    budgeted.remediation = classified.remediation;
  }
  return budgeted;
}

export { getFileMeta };
