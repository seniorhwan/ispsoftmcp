import path from 'node:path';
import {
  MODEL_PROFILES,
  PouLanguage,
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
  exportLdPouToMpuBytes,
  exportProjectBundle,
  extractCrossRefsFromText,
  importMpuIntoProjectSource,
  langCodeToName,
  migrateProjectModel,
  patchFbdPouInSource,
  patchIlPouInSource,
  patchSfcPouInSource,
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
  escapeRegex,
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
import { mapDevice, planModbusRequest, reverseMapModbus } from './dvpModbus.js';
import {
  DataExchangeRow,
  DeviceInitEntry,
  HwConfigDocument,
  RetainZone,
  exportProjectToIecStText,
  exportProjectToPlcopenXml,
  formatCommentsCsv,
  formatSymbolsCsv,
  parseCommentsCsv,
  parseSymbolsCsv,
  readDataExchangeFromSource,
  readDeviceInitFromSource,
  readHwConfigFromSource,
  readRetainConfigFromSource,
  setIniKeySafe,
  validateHwConfig,
  writeDataExchangeToSource,
  writeDeviceInitToSource,
  writeHwConfigToSource,
  writeRetainConfigToSource,
} from './hwConfig.js';
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
import { lookupDeltaReference } from './referenceCatalog.js';
import {
  FbdDiagram,
  SfcChart,
  allocateFreeDevices,
  analyzeDeviceUsageFromTexts,
  convertIlInstructionsToSt,
  convertSimpleStToIl,
  parseFbdFromPouBody,
  parseSfcFromPouBody,
  renderFbdAscii,
  renderSfcAscii,
  validateFbdDiagram,
  validateSfcChart,
} from './sfcFbd.js';
import {
  analyzeSimulatorTrace,
  compareSimulatorWithProject,
  controlSimulator,
  dumpSimulatorMemory,
  forceAndWriteSimulator,
  listSimulatorSessions,
  manageBreakpoints,
  manageSimIoModules,
  manageWatchTable,
  monitorSimulator,
  onlineEditSimulatorPou,
  profileSimulatorSession,
  reloadSimulatorSession,
  runSimulatorSequence,
  startSimulatorSession,
  stepSimulatorUntil,
  triggerSimulatorInterrupt,
} from './simulator.js';
import {
  STANDARD_ERROR_CODES,
  ToolAnnotations,
  buildStandardizedError,
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
        'pou_create_rename_delete_all_5_iec_languages',
        'st_il_sfc_fbd_code_patching',
        'ld_rung_edit_stack_ops_and_ascii_render',
        'il_to_ld_and_ld_il_to_st_conversion',
        'local_and_global_var_upsert_delete_and_csv_exchange',
        'dut_struct_enum_management',
        'task_hwconfig_retain_device_init_and_data_exchange',
        'device_usage_map_and_free_address_allocator',
        'plcopen_xml_iec_st_and_mpu_import_export',
        'cross_model_and_cross_family_project_migration',
        'delta_instruction_special_device_and_extension_module_catalog',
        'device_comment_merge_and_csv_exchange',
        'project_wide_symbol_refactor_and_search',
        'deep_engineering_audit_and_project_diff',
      ],
    },
    offline_static_check_and_compile: {
      status: 'QUALIFIED',
      checks: [
        'syntax',
        'double_coil',
        'coil_conflict',
        'floating_contacts',
        'system_var_bounds',
        'task_integrity',
        'variable_wrappers',
        'sfc_graph_validation',
        'fbd_dag_validation',
        'hwconfig_validation',
      ],
    },
    soft_plc_simulator_and_monitor: {
      status: 'QUALIFIED_SIMULATOR',
      features: [
        'run_stop_step_step_until_warm_cold_reset',
        'all_5_iec_languages_ld_st_il_sfc_fbd',
        'true_iec_ladder_stack_machine_anb_orb_mps_mrd_mpp_inv',
        '32bit_dword_float_real_index_registers_v_z_e_and_bit_of_word',
        'standard_iec_fbs_ton_tof_tp_ctu_ctd_ctud_r_trig_f_trig_sr_rs_pid_scale',
        'multi_instance_user_fbs_subroutines_call_sret_fend_for_next_cj',
        'special_module_bfm_from_to_and_sim_io_injection',
        'online_edit_without_stop_and_interrupt_trigger',
        'retentive_memory_on_warm_reset_and_device_init_on_cold_reset',
        'multi_step_sequence_testbench_and_breakpoints',
        'memory_table_dump_watch_tables_trace_analytics_csv_and_diagnostics',
      ],
    },
    dvp_modbus_address_mapping: {
      status: 'QUALIFIED',
      models: Object.keys(MODEL_PROFILES),
      features: ['forward_mapping', 'reverse_mapping', 'rtu_crc16_and_tcp_mbap_frame_planner'],
      device_io: 'NOT_RUN',
    },
    native_windows_ide_automation: { status: process.platform === 'win32' ? 'AVAILABLE' : 'UNAVAILABLE_ON_LINUX' },
    physical_plc_connection: { status: 'NOT_QUALIFIED', write_guard: LIVE_WRITES_ENV },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SFC_CHART_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['steps', 'transitions'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          initial: { type: 'boolean' },
          comment: { type: 'string' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['qualifier', 'code'],
              properties: {
                qualifier: { type: 'string', enum: ['N', 'S', 'R', 'P', 'P1', 'P0', 'L', 'D'] },
                name: { type: 'string' },
                time_ms: { type: 'integer', minimum: 0 },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    transitions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'from', 'to', 'condition'],
        properties: {
          name: { type: 'string' },
          from: { type: 'array', items: { type: 'string' } },
          to: { type: 'array', items: { type: 'string' } },
          condition: { type: 'string' },
          priority: { type: 'integer' },
        },
      },
    },
  },
};

const FBD_DIAGRAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'op'],
        properties: {
          id: { type: 'string' },
          op: { type: 'string' },
          instance: { type: 'string' },
          inputs: { type: 'object', additionalProperties: { type: 'string' } },
          outputs: { type: 'object', additionalProperties: { type: 'string' } },
          comment: { type: 'string' },
        },
      },
    },
  },
};

const HW_CONFIG_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    cpu: {
      type: 'object',
      properties: {
        watchdog_ms: { type: 'integer', minimum: 10, maximum: 10000 },
        constant_scan_ms: { type: 'integer', minimum: 0, maximum: 2000 },
        run_stop_input: { type: 'string' },
        retain_outputs_on_stop: { type: 'boolean' },
        input_filter_ms: { type: 'integer', minimum: 0, maximum: 100 },
        comment: { type: 'string' },
      },
    },
    serial_ports: {
      type: 'array',
      items: {
        type: 'object',
        required: ['port'],
        properties: {
          port: { type: 'string', enum: ['COM1', 'COM2', 'COM3'] },
          baud_rate: { type: 'integer' },
          data_bits: { type: 'integer', enum: [7, 8] },
          parity: { type: 'string', enum: ['NONE', 'EVEN', 'ODD'] },
          stop_bits: { type: 'integer', enum: [1, 2] },
          protocol: { type: 'string', enum: ['MODBUS_RTU', 'MODBUS_ASCII', 'PLC_LINK', 'USER_DEFINED'] },
          station_address: { type: 'integer', minimum: 1, maximum: 254 },
          timeout_ms: { type: 'integer', minimum: 10, maximum: 30000 },
        },
      },
    },
    ethernet: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        ip_address: { type: 'string' },
        subnet_mask: { type: 'string' },
        gateway: { type: 'string' },
        modbus_tcp_port: { type: 'integer', minimum: 1, maximum: 65535 },
        modbus_tcp_enabled: { type: 'boolean' },
        ethernet_ip_enabled: { type: 'boolean' },
        dhcp: { type: 'boolean' },
      },
    },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slot', 'model'],
        properties: {
          slot: { type: 'integer', minimum: 0, maximum: 31 },
          model: { type: 'string' },
          description: { type: 'string' },
          x_start: { type: 'string' },
          x_points: { type: 'integer', minimum: 0 },
          y_start: { type: 'string' },
          y_points: { type: 'integer', minimum: 0 },
          cr_init: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
    },
  },
};

const RETAIN_ZONES_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['area', 'start', 'end'],
    properties: {
      area: { type: 'string', enum: ['M', 'S', 'T', 'C', 'D'] },
      start: { type: 'integer', minimum: 0 },
      end: { type: 'integer', minimum: 0 },
    },
  },
};

const DEVICE_INIT_ENTRIES_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['device', 'data_type', 'value'],
    properties: {
      device: { type: 'string' },
      data_type: { type: 'string', enum: ['BOOL', 'INT', 'WORD', 'DINT', 'DWORD', 'REAL', 'STRING'] },
      value: { description: 'Initial scalar value (number, boolean, or string)' },
      comment: { type: 'string' },
    },
  },
};

const DATA_EXCHANGE_ROWS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['index', 'enabled', 'interface', 'slave_id', 'function_code', 'remote_address', 'local_device', 'length'],
    properties: {
      index: { type: 'integer', minimum: 0 },
      enabled: { type: 'boolean' },
      interface: { type: 'string', enum: ['COM2', 'COM3', 'ETHERNET'] },
      slave_id: { type: 'integer', minimum: 1, maximum: 247 },
      slave_ip: { type: 'string' },
      function_code: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 15, 16] },
      remote_address: { type: 'string' },
      local_device: { type: 'string' },
      length: { type: 'integer', minimum: 1, maximum: 125 },
      poll_interval_ms: { type: 'integer', minimum: 10, maximum: 60000 },
      comment: { type: 'string' },
    },
  },
};

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
      error_schema: {
        uri: 'ispsoft://schemas/error',
        http_endpoint: '/api/schemas/error',
        schema_version: '1.0.0',
        error_codes: [...STANDARD_ERROR_CODES],
      },
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
        max_results: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
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
    description: 'List, upload_base64, download_base64, copy, move/rename, delete workspace files, restore backups, or clean up *.before.* clutter purely over MCP.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'upload_base64', 'download_base64', 'copy', 'move', 'delete', 'restore_backup', 'cleanup_backups'] },
        path: { type: 'string', description: 'Workspace path (e.g. /workspace/myproj.isp)' },
        content_base64: { type: 'string', description: 'Base64-encoded binary file bytes for upload_base64' },
        destination_path: { type: 'string', description: 'Destination path for copy/move' },
        backup_path: { type: 'string', description: 'Optional explicit backup path for restore_backup (defaults to <name>.latest.before.isp)' },
        overwrite: { type: 'boolean', default: false },
        prefix: { type: 'string', description: 'Optional directory filter for list/cleanup_backups' },
      },
    },
    handler: (args) => {
      try {
        const action = String(args.action ?? '');
        if (action === 'list') {
          const prefix = typeof args.prefix === 'string' ? args.prefix : '';
          return {
            success: true,
            action,
            storage: getWorkspaceStorageStats(),
            files: listAllFiles(prefix),
          };
        }
        if (action === 'upload_base64') {
          const target = normalizeVirtualPath(String(args.path ?? ''));
          const b64 = String(args.content_base64 ?? '').trim();
          if (!b64) throw new FileTransformError('content_base64 is required for upload_base64');
          const data = Buffer.from(b64, 'base64');
          const saved = writeFileBuffer(target, data, Boolean(args.overwrite));
          return {
            success: true,
            action,
            path: saved,
            bytes: data.length,
            sha256: sha256(data),
            content_hash: computeContentHash('file', data),
          };
        }
        if (action === 'download_base64') {
          const target = normalizeVirtualPath(String(args.path ?? ''));
          const data = readFileBuffer(target);
          return {
            success: true,
            action,
            path: target,
            bytes: data.length,
            sha256: sha256(data),
            content_base64: data.toString('base64'),
          };
        }
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
          if (!deleted) {
            return { success: false, action, path: p, deleted: false, error: `File not found in workspace: ${p}` };
          }
          return { success: true, action, path: p, deleted: true };
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
        bundle: {
          type: 'object',
          description: 'Project bundle matching ispsoft_export_project_bundle output schema',
          properties: {
            model: { type: 'string', description: 'PLC model, e.g. ES2, AS228T' },
            properties: { type: 'object', additionalProperties: { type: 'string' } },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  type: { type: 'integer' },
                  interval_ms: { type: 'integer' },
                  priority: { type: 'integer' },
                  active: { type: 'boolean' },
                  program: { type: 'string' },
                },
              },
            },
            system_vars: { type: 'object', additionalProperties: { type: 'string' } },
            global_vars: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  address: { type: 'string' },
                  initial_value: { type: 'string' },
                  comment: { type: 'string' },
                  class: { type: 'string' },
                },
              },
            },
            duts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  content: { type: 'string' },
                },
              },
            },
            device_comments: { type: 'object', additionalProperties: { type: 'string' } },
            hw_config: HW_CONFIG_SCHEMA,
            retain_config: {
              type: 'object',
              properties: { zones: RETAIN_ZONES_SCHEMA },
            },
            device_init: DEVICE_INIT_ENTRIES_SCHEMA,
            data_exchange: DATA_EXCHANGE_ROWS_SCHEMA,
            pous: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  language: { type: 'string', enum: ['LD', 'ST', 'IL', 'SFC', 'FBD'] },
                  pou_type: { type: 'string', enum: ['PRG', 'FB', 'FC'] },
                  return_type: { type: 'string' },
                  active: { type: 'boolean' },
                  code: { type: 'string', description: 'ST or IL source code (or IL for LD POUs)' },
                  il: { type: 'string', description: 'DVP IL program text for LD POUs' },
                  sfc: SFC_CHART_SCHEMA,
                  fbd: FBD_DIAGRAM_SCHEMA,
                  networks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        il: { type: 'string' },
                        active: { type: 'boolean' },
                        bookmark: { type: 'boolean' },
                        label: { type: 'string' },
                      },
                    },
                  },
                  local_vars: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        type: { type: 'string' },
                        address: { type: 'string' },
                        initial_value: { type: 'string' },
                        comment: { type: 'string' },
                        class: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
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
          description: 'Sequence of ops: edit_properties, configure_tasks, configure_hardware_io, configure_hwconfig, configure_retain_ranges, configure_device_init, configure_data_exchange, create_pou, manage_pou, write_st, write_ld, write_il, write_sfc, write_fbd, edit_ld_rungs, edit_local_vars, edit_global_vars, manage_dut, write_comments, rename_symbol',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'edit_properties',
                  'configure_tasks',
                  'configure_hardware_io',
                  'configure_hwconfig',
                  'configure_retain_ranges',
                  'configure_device_init',
                  'configure_data_exchange',
                  'create_pou',
                  'manage_pou',
                  'write_st',
                  'write_ld',
                  'write_il',
                  'write_sfc',
                  'write_fbd',
                  'edit_ld_rungs',
                  'edit_local_vars',
                  'edit_global_vars',
                  'manage_dut',
                  'write_comments',
                  'rename_symbol',
                ],
              },
              pou_name: { type: 'string' },
              code: { type: 'string' },
              program: { type: 'string' },
              language: { type: 'string', enum: ['LD', 'ST', 'IL', 'SFC', 'FBD'] },
              pou_type: { type: 'string', enum: ['PRG', 'FB', 'FC'] },
              return_type: { type: 'string' },
              sfc_chart: SFC_CHART_SCHEMA,
              fbd_diagram: FBD_DIAGRAM_SCHEMA,
              hw_config: HW_CONFIG_SCHEMA,
              retain_zones: RETAIN_ZONES_SCHEMA,
              device_init: DEVICE_INIT_ENTRIES_SCHEMA,
              data_exchange: DATA_EXCHANGE_ROWS_SCHEMA,
              action: { type: 'string' },
              new_name: { type: 'string' },
              properties: { type: 'object', additionalProperties: { type: 'string' } },
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    type: { type: 'integer' },
                    interval_ms: { type: 'integer' },
                    priority: { type: 'integer' },
                    active: { type: 'boolean' },
                    program: { type: 'string' },
                  },
                },
              },
              ranges: { type: 'object', additionalProperties: { type: 'string' } },
              local_variables: { type: 'string' },
              assign_to_task: { type: 'boolean' },
              variables: { type: 'string' },
              global_var_text: { type: 'string' },
              dut_name: { type: 'string' },
              dut_content: { type: 'string' },
              replace_all: { type: 'boolean' },
              operations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    op: { type: 'string' },
                    network_index: { type: 'integer' },
                    to_index: { type: 'integer' },
                    il_program: { type: 'string' },
                    active: { type: 'boolean' },
                    bookmark: { type: 'boolean' },
                    label: { type: 'string' },
                  },
                },
              },
              upsert_vars: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    address: { type: 'string' },
                    initial_value: { type: 'string' },
                    comment: { type: 'string' },
                    class: { type: 'string' },
                  },
                },
              },
              delete_vars: { type: 'array', items: { type: 'string' } },
              device_comments: { type: 'object', additionalProperties: { type: 'string' } },
              find_symbol: { type: 'string' },
              replace_symbol: { type: 'string' },
            },
          },
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
              const re = new RegExp(`^${escapeRegex(k)}=[^\\r\\n]*`, 'm');
              inner = re.test(inner) ? inner.replace(re, `${k}=${v}`) : inner.trimEnd() + c.newline + `${k}=${v}` + c.newline;
            }
            source = source.slice(0, projSec.innerStart) + inner + source.slice(projSec.innerEnd);
          } else if (t === 'configure_tasks') {
            source = replaceTasksInSource(source, (op.tasks as TaskConfig[]) ?? [], c.newline);
          } else if (t === 'configure_hardware_io') {
            source = writeSystemVarsInSource(source, (op.ranges as Record<string, string>) ?? {}, c.newline);
          } else if (t === 'configure_hwconfig') {
            const cur = readHwConfigFromSource(source);
            const patch = (op.hw_config as Partial<HwConfigDocument>) ?? {};
            const merged: HwConfigDocument = {
              cpu: { ...cur.cpu, ...(patch.cpu ?? {}) },
              serial_ports: Array.isArray(patch.serial_ports) ? patch.serial_ports : cur.serial_ports,
              ethernet: { ...cur.ethernet, ...(patch.ethernet ?? {}) },
              modules: Array.isArray(patch.modules) ? patch.modules : cur.modules,
            };
            const errs = validateHwConfig(merged);
            if (errs.length) throw new FileTransformError(`HWCONFIG validation failed: ${errs.join('; ')}`);
            source = writeHwConfigToSource(source, merged, c.newline);
          } else if (t === 'configure_retain_ranges') {
            source = writeRetainConfigToSource(source, { zones: (op.retain_zones as RetainZone[]) ?? [] }, c.newline);
          } else if (t === 'configure_device_init') {
            source = writeDeviceInitToSource(source, (op.device_init as DeviceInitEntry[]) ?? [], c.newline);
          } else if (t === 'configure_data_exchange') {
            source = writeDataExchangeToSource(source, (op.data_exchange as DataExchangeRow[]) ?? [], c.newline);
          } else if (t === 'create_pou') {
            source = createPouInSource(
              source,
              {
                pouName: String(op.pou_name ?? ''),
                language: (op.language as PouLanguage) ?? 'LD',
                pouType: (op.pou_type as 'PRG' | 'FB' | 'FC') ?? 'PRG',
                returnType: typeof op.return_type === 'string' ? op.return_type : undefined,
                code: typeof op.code === 'string' ? op.code : undefined,
                sfcChart: op.sfc_chart as SfcChart | undefined,
                fbdDiagram: op.fbd_diagram as FbdDiagram | undefined,
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
          } else if (t === 'write_il') {
            source = patchIlPouInSource(source, String(op.pou_name ?? ''), String(op.code ?? ''), c.newline);
          } else if (t === 'write_sfc') {
            source = patchSfcPouInSource(source, String(op.pou_name ?? ''), op.sfc_chart as SfcChart, c.newline);
          } else if (t === 'write_fbd') {
            source = patchFbdPouInSource(source, String(op.pou_name ?? ''), op.fbd_diagram as FbdDiagram, c.newline);
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
        language: { type: 'string', enum: ['LD', 'ST', 'IL', 'SFC', 'FBD'], default: 'LD' },
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
          language: (typeof args.language === 'string' ? args.language : 'LD') as PouLanguage,
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
        properties: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional map of PROJECT keys to update, e.g. { Prj_DT: "EH3" }' },
        ini_settings: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional map of .ini [PRJ_DATA] keys, e.g. { STATION_ADDR: "2" }' },
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
          const lineRe = new RegExp(`^${escapeRegex(k)}=[^\\r\\n]*`, 'm');
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
            iniText = setIniKeySafe(iniText, k, String(v), '\r\n');
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
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              type: { type: 'integer' },
              interval_ms: { type: 'integer' },
              priority: { type: 'integer' },
              active: { type: 'boolean' },
              program: { type: 'string' },
            },
          },
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
          additionalProperties: { type: 'string' },
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
    description: 'Create a new PRG, FB, or FC POU in LD, ST, IL, SFC, or FBD inside a project (in_place or backed-up candidate).',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'language'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        language: { type: 'string', enum: ['LD', 'ST', 'IL', 'SFC', 'FBD'] },
        pou_type: { type: 'string', enum: ['PRG', 'FB', 'FC'], default: 'PRG' },
        return_type: { type: 'string', description: 'Optional IEC return type for FC POUs (e.g. INT, REAL, BOOL)' },
        en_eno: { type: 'boolean', description: 'Optional EN/ENO enable flag for FB/FC POUs' },
        code: { type: 'string', description: 'ST code or IL program (compiled to LD networks if language=LD)' },
        sfc_chart: SFC_CHART_SCHEMA,
        fbd_diagram: FBD_DIAGRAM_SCHEMA,
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
            language: (args.language as PouLanguage) ?? 'LD',
            pouType: (args.pou_type as 'PRG' | 'FB' | 'FC') ?? 'PRG',
            returnType: typeof args.return_type === 'string' ? args.return_type : undefined,
            enEno: typeof args.en_eno === 'boolean' ? args.en_eno : undefined,
            code: typeof args.code === 'string' ? args.code : undefined,
            sfcChart: args.sfc_chart as SfcChart | undefined,
            fbdDiagram: args.fbd_diagram as FbdDiagram | undefined,
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
    description: 'Read one POU source sections (LOCAL_VAR, IL_ST_CODE, LD_NETWORKS, SFC_BODY, FBD_BODY) and parsed symbol/graph view.',
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
        const raw = readFileBuffer(p);
        const c = decodeContainer(raw);
        const source = decodeCodepage(c.source, c.encoding);
        const candidates = sections(source, 'POU').filter((m) => propertyValue(m.inner, 'P_Name') === pouName);
        if (candidates.length !== 1) throw new FileTransformError(`Expected one POU named ${JSON.stringify(pouName)}; found ${candidates.length}`);
        const body = candidates[0].inner;
        const lang = propertyValue(body, 'P_Lang') ?? '1';
        const secMap: Record<string, string[]> = {};
        for (const tag of ['LOCAL_VAR', 'IL_ST_CODE', 'SFC_BODY', 'FBD_BODY']) {
          secMap[tag] = sections(body, tag).map((m) => m.inner);
        }
        const networks = ldNetworks(body);
        secMap.LD_NETWORKS = networks;
        const localVarText = secMap.LOCAL_VAR.length === 1 ? secMap.LOCAL_VAR[0] : '';
        const localSymbols = parseLocalVariables(localVarText);
        const extra: Record<string, unknown> = {};
        if (lang === '3') {
          extra.il_code = secMap.IL_ST_CODE[0] ?? '';
        } else if (lang === '4') {
          const parsedSfc = parseSfcFromPouBody(body);
          extra.sfc_chart = parsedSfc.chart;
          if (parsedSfc.error) extra.sfc_error = parsedSfc.error;
          extra.sfc_ascii = parsedSfc.chart ? renderSfcAscii(parsedSfc.chart) : '';
        } else if (lang === '5') {
          const parsedFbd = parseFbdFromPouBody(body);
          extra.fbd_diagram = parsedFbd.diagram;
          if (parsedFbd.error) extra.fbd_error = parsedFbd.error;
          extra.fbd_ascii = parsedFbd.diagram ? renderFbdAscii(parsedFbd.diagram) : '';
        }
        return {
          success: true,
          name: pouName,
          language: lang,
          language_name: langCodeToName(lang),
          type: propertyValue(body, 'P_type'),
          network_count: networks.length,
          sections: secMap,
          ...extra,
          local_variable_symbols: { status: localSymbols.status, entries: localSymbols.entries, errors: localSymbols.errors },
          content_hash: computeContentHash('pou', body),
          project_content_hash: computeContentHash('isp', raw),
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
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              address: { type: 'string' },
              initial_value: { type: 'string' },
              comment: { type: 'string' },
              class: { type: 'string' },
            },
          },
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
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              address: { type: 'string' },
              initial_value: { type: 'string' },
              comment: { type: 'string' },
              class: { type: 'string' },
            },
          },
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
        network_index: { type: 'integer', minimum: 1 },
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
        network_index: { type: 'integer', minimum: 1, description: 'Optional 1-based rung index' },
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
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['insert', 'append', 'replace', 'delete', 'move', 'set_active', 'set_bookmark', 'set_label'] },
              network_index: { type: 'integer' },
              to_index: { type: 'integer' },
              il_program: { type: 'string' },
              active: { type: 'boolean' },
              bookmark: { type: 'boolean' },
              label: { type: 'string' },
            },
          },
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
      properties: { device_comments: { type: 'object', additionalProperties: { type: 'string' } }, model: { type: 'string' } },
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
        device_comments: { type: 'object', additionalProperties: { type: 'string' } },
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
    description: 'Translate Delta DVP, AS, and AH device addresses (X, Y, M, SM, S, T, C, HC, D, SR) to zero-based Modbus PDU addresses.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['model', 'addresses'],
      properties: {
        model: { type: 'string', description: 'Delta PLC model (e.g. ES2, ES3, EH3, SV2, SE, AS228T, AS300, AH500)' },
        addresses: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: (args) => {
      const { canonical, error } = resolveModel(String(args.model ?? ''));
      if (error || !canonical) return { status: 'UNSUPPORTED_MODEL', model: args.model, device_contacted: false, serial_port_opened: false, error };
      const addresses = Array.isArray(args.addresses) ? args.addresses : [];
      if (!addresses.length || addresses.length > 200) {
        return { status: 'REJECTED_BEFORE_IO', model: canonical, device_contacted: false, serial_port_opened: false, error: 'addresses must contain 1-200 strings' };
      }
      const mappings = addresses.map((addr) => {
        try {
          return { success: true, ...mapDevice(String(addr), canonical) };
        } catch (e) {
          const msg = errMsg(e);
          const detail = classifyToolError(
            { error_code: 'MODBUS_ADDRESS_ERROR', error: msg },
            { tool: 'ispsoft_map_dvp_modbus_addresses', args },
          ).error_detail;
          return {
            success: false,
            device: String(addr),
            error: msg,
            error_code: 'MODBUS_ADDRESS_ERROR',
            error_detail: detail,
          };
        }
      });
      const errCount = mappings.filter((m) => !m.success).length;
      return {
        success: errCount < mappings.length,
        status: errCount === 0 ? 'MAPPED_OFFLINE_ONLY' : errCount === mappings.length ? 'MODBUS_ADDRESS_ERROR' : 'PARTIAL_MAPPING',
        ...(errCount === mappings.length ? { error_code: 'MODBUS_ADDRESS_ERROR', error: 'All Modbus device address mappings failed.' } : {}),
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
        scan_interval_ms: { type: 'integer', minimum: 10, maximum: 10000, default: 100, description: 'Simulated time per scan cycle in ms (e.g. 100ms = 1 timer tick)' },
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
        cycles: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
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
        max_cycles: { type: 'integer', minimum: 1, maximum: 10000, default: 500 },
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
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              bits: { type: 'object', additionalProperties: { type: 'boolean' } },
              words: { type: 'object', additionalProperties: { type: 'number' } },
              force_bits: { type: 'object', additionalProperties: { description: 'Boolean coil/input state, or null to unforce' } },
              force_words: { type: 'object', additionalProperties: { description: 'Numeric word value, or null to unforce' } },
              symbols: { type: 'object', additionalProperties: { description: 'Scalar value (boolean or number)' } },
              cycles: { type: 'integer' },
              step_until: { type: 'string' },
              max_cycles: { type: 'integer' },
              expect: { type: 'object', additionalProperties: { description: 'Expected scalar value (boolean, number, or string)' } },
              assert_expr: { type: 'string' },
            },
          },
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
        start: { type: 'integer', minimum: 0, default: 0 },
        count: { type: 'integer', minimum: 1, maximum: 256, default: 32 },
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
        bits: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Non-forced bit writes e.g. {"M0": true}' },
        words: { type: 'object', additionalProperties: { type: 'number' }, description: 'Word writes e.g. {"D10": 50}' },
        force_bits: { type: 'object', additionalProperties: { description: 'Boolean coil/input state, or null to unforce' }, description: 'Forced inputs/coils (pass null to unforce) e.g. {"X0": true, "X1": null}' },
        force_words: { type: 'object', additionalProperties: { description: 'Numeric word value, or null to unforce' }, description: 'Forced words (pass null to unforce)' },
        symbols: { type: 'object', additionalProperties: { description: 'Scalar value (boolean or number)' }, description: 'Write by symbolic variable name' },
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
          minimum: 0,
          maximum: 2000,
          default: 0,
          description: 'Optional number of benchmark scan cycles to step immediately before generating the diagnostic report (0 = passive read of existing scan history)',
        },
        slow_threshold_ms: {
          type: 'number',
          minimum: 0.001,
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
  // 7. Full ISPSoft Feature Suite: IL/SFC/FBD, HWCONFIG, Retain, Init, Exchange,
  //    Packages, CSV, Converter, Allocator, Migration, Reference & Advanced Sim
  // =========================================================================
  {
    name: 'ispsoft_write_il_pou',
    description: 'Patch an Instruction List (IL, P_Lang=3) POU body with syntax validation, OCC expected_content_hash, and dry_run.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'il_code'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        il_code: { type: 'string' },
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
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const updated = patchIlPouInSource(source, pouName, String(args.il_code ?? ''), c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, pou_name: pouName, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-il`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          pou_name: pouName,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_sfc_pou',
    description: 'Patch an IEC 61131-3 Sequential Function Chart (SFC, P_Lang=4) POU with steps, action qualifiers (N/S/R/P/P1/P0/L/D), and transitions.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'sfc_chart'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        sfc_chart: SFC_CHART_SCHEMA,
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
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const chart = args.sfc_chart as SfcChart;
        const validation = validateSfcChart(chart);
        if (!validation.valid) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error: validation.errors.join('; '), validation };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const updated = patchSfcPouInSource(source, pouName, chart, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        const ascii = renderSfcAscii(chart);
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, pou_name: pouName, sfc_ascii: ascii, warnings: validation.warnings, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-sfc`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          pou_name: pouName,
          sfc_ascii: ascii,
          warnings: validation.warnings,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_write_fbd_pou',
    description: 'Patch an IEC 61131-3 Function Block Diagram / CFC (FBD, P_Lang=5) POU with interconnected logic, math, standard IEC FBs, and user FBs.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'pou_name', 'fbd_diagram'],
      properties: {
        project_path: { type: 'string' },
        pou_name: { type: 'string' },
        fbd_diagram: FBD_DIAGRAM_SCHEMA,
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
        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const diagram = args.fbd_diagram as FbdDiagram;
        const validation = validateFbdDiagram(diagram);
        if (!validation.valid) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error: validation.errors.join('; '), validation };
        }
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);
        const updated = patchFbdPouInSource(source, pouName, diagram, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        const ascii = renderFbdAscii(diagram);
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, pou_name: pouName, fbd_ascii: ascii, warnings: validation.warnings, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-${pouName}-fbd`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          pou_name: pouName,
          fbd_ascii: ascii,
          warnings: validation.warnings,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_hwconfig',
    description: 'Read or update ISPSoft HWCONFIG: CPU parameters (watchdog/scan/filter), COM1-3 serial ports, Ethernet/Modbus TCP, and right-side extension modules with automatic I/O & CR allocation.',
    category: 'Hardware & System Configuration',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        hw_config: HW_CONFIG_SCHEMA,
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
        const currentCfg = readHwConfigFromSource(source);
        if (!args.hw_config || typeof args.hw_config !== 'object') {
          return {
            success: true,
            status: 'READ_HWCONFIG',
            model: inspectContainer(c).project_model,
            hw_config: currentCfg,
            validation_errors: validateHwConfig(currentCfg),
            content_hash: currentHash,
          };
        }
        const patch = args.hw_config as Partial<HwConfigDocument>;
        const merged: HwConfigDocument = {
          cpu: { ...currentCfg.cpu, ...(patch.cpu ?? {}) },
          serial_ports: Array.isArray(patch.serial_ports) ? patch.serial_ports : currentCfg.serial_ports,
          ethernet: { ...currentCfg.ethernet, ...(patch.ethernet ?? {}) },
          modules: Array.isArray(patch.modules) ? patch.modules : currentCfg.modules,
        };
        const errs = validateHwConfig(merged);
        if (errs.length) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'validation_error', error: errs.join('; '), validation_errors: errs };
        }
        const updated = writeHwConfigToSource(source, merged, c.newline);
        const normalizedSaved = readHwConfigFromSource(updated);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, hw_config: normalizedSaved, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-hwconfig`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          hw_config: normalizedSaved,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_retain_ranges',
    description: 'Read or configure ISPSoft Retentive / Latched Memory ranges (M/S/T/C/D) preserved across WARM_RESET and power cycles.',
    category: 'Hardware & System Configuration',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        zones: RETAIN_ZONES_SCHEMA,
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
        if (!Array.isArray(args.zones)) {
          return { success: true, status: 'READ_RETAIN_RANGES', retain_config: readRetainConfigFromSource(source), content_hash: currentHash };
        }
        const zones = args.zones as RetainZone[];
        for (const z of zones) {
          if (z.end < z.start) throw new FileTransformError(`Retain zone ${z.area}${z.start}-${z.end} has end < start`);
        }
        const updated = writeRetainConfigToSource(source, { zones }, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, retain_config: { zones }, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-retain`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          retain_config: { zones },
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_device_init',
    description: 'Read or configure the ISPSoft Device Initial Value Table (BOOL/INT/WORD/DINT/DWORD/REAL values seeded on PLC startup and COLD_RESET).',
    category: 'Hardware & System Configuration',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        entries: DEVICE_INIT_ENTRIES_SCHEMA,
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
        if (!Array.isArray(args.entries)) {
          return { success: true, status: 'READ_DEVICE_INIT', entries: readDeviceInitFromSource(source), content_hash: currentHash };
        }
        const entries = args.entries as DeviceInitEntry[];
        const updated = writeDeviceInitToSource(source, entries, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, entries, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-devinit`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          entries,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_configure_data_exchange',
    description: 'Read or configure ISPSoft PLC Link / Modbus Data Exchange polling tables (COM2/COM3/Ethernet master-slave register sync).',
    category: 'Hardware & System Configuration',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: { type: 'string' },
        rows: DATA_EXCHANGE_ROWS_SCHEMA,
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
        if (!Array.isArray(args.rows)) {
          return { success: true, status: 'READ_DATA_EXCHANGE', rows: readDataExchangeFromSource(source), content_hash: currentHash };
        }
        const rows = args.rows as DataExchangeRow[];
        const updated = writeDataExchangeToSource(source, rows, c.newline);
        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        if (args.dry_run) {
          return { success: true, status: 'DRY_RUN_PASSED', dry_run: true, rows, current_content_hash: currentHash };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-exchange`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'GENERATED_UNCOMPILED',
          candidate: written.target,
          backup: written.backup,
          rows,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_import_export_pou_package',
    description: 'Import an .mpu POU package into an .isp project, export an LD POU to .mpu, or export the entire project to PLCopen XML (TC6 2.01) or IEC 61131-3 Structured Text.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['action', 'project_path'],
      properties: {
        action: { type: 'string', enum: ['import_mpu', 'export_mpu', 'export_plcopen_xml', 'export_iec_st'] },
        project_path: { type: 'string' },
        mpu_path: { type: 'string', description: 'Source .mpu path for import_mpu or output .mpu path for export_mpu' },
        pou_name: { type: 'string', description: 'Target POU name (required for export_mpu, optional override for import_mpu)' },
        overwrite: { type: 'boolean', default: false },
        assign_to_task: { type: 'boolean', default: false },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string', description: 'Optional workspace path to save exported .isp / .xml / .st / .mpu file' },
      },
    },
    handler: (args) => {
      try {
        const action = String(args.action ?? '');
        const projPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(projPath);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);

        if (action === 'import_mpu') {
          const mpuPath = normalizeVirtualPath(String(args.mpu_path ?? ''));
          const mpuBytes = readFileBuffer(mpuPath);
          const imported = importMpuIntoProjectSource(source, mpuBytes, {
            pouName: typeof args.pou_name === 'string' && args.pou_name.trim() ? args.pou_name.trim() : undefined,
            overwrite: Boolean(args.overwrite),
            assignToTask: Boolean(args.assign_to_task),
            newline: c.newline,
          });
          const candidateBytes = c.rebuild(encodeCodepage(imported.updatedSource, c.encoding));
          const target =
            typeof args.output_path === 'string' && args.output_path.trim()
              ? normalizeVirtualPath(args.output_path)
              : artifactPath(`${path.posix.parse(projPath).name}-imp-${imported.pouName}`, '.isp');
          const written = writeProjectCandidateAndBackup(projPath, target, original, candidateBytes, Boolean(args.in_place));
          return {
            success: true,
            status: 'MPU_IMPORTED',
            candidate: written.target,
            backup: written.backup,
            pou_name: imported.pouName,
            network_count: imported.networkCount,
            content_hash: computeContentHash('isp', candidateBytes),
          };
        }

        if (action === 'export_mpu') {
          const pouName = String(args.pou_name ?? '').trim();
          if (!pouName) throw new FileTransformError('pou_name is required for export_mpu');
          const exported = exportLdPouToMpuBytes(source, pouName);
          const target =
            typeof args.output_path === 'string' && args.output_path.trim()
              ? normalizeVirtualPath(args.output_path)
              : typeof args.mpu_path === 'string' && args.mpu_path.trim()
                ? normalizeVirtualPath(args.mpu_path)
                : artifactPath(`${pouName}`, '.mpu');
          const saved = writeFileBuffer(target, exported.mpuBytes, Boolean(args.overwrite));
          return {
            success: true,
            status: 'MPU_EXPORTED',
            mpu_path: saved,
            pou_name: pouName,
            network_count: exported.networkCount,
            il: exported.il,
            sha256: sha256(exported.mpuBytes),
          };
        }

        const bundle = exportProjectBundle(source, inspectContainer(c));
        const pouInputs = bundle.pous.map((p) => {
          let bodyText = '';
          if (p.language === 'ST' || p.language === 'IL') {
            bodyText = p.code ?? '';
          } else if (p.language === 'LD') {
            const ilLines = (p.networks ?? []).flatMap((n) => (Array.isArray(n.il) ? n.il : []));
            const parsed = parseIl(ilLines.join('\n'));
            bodyText = convertIlInstructionsToSt(parsed).st;
          } else if (p.language === 'SFC' && p.sfc) {
            bodyText = renderSfcAscii(p.sfc);
          } else if (p.language === 'FBD' && p.fbd) {
            bodyText = renderFbdAscii(p.fbd);
          }
          return {
            name: p.name,
            pouType: (p.pou_type === 'FB' ? 'FUNCTION_BLOCK' : p.pou_type === 'FC' ? 'FUNCTION' : 'PROGRAM') as
              | 'PROGRAM'
              | 'FUNCTION_BLOCK'
              | 'FUNCTION',
            language: p.language,
            variables: p.local_vars,
            bodyText,
          };
        });

        const projectName = path.posix.parse(projPath).name;
        if (action === 'export_plcopen_xml') {
          const xml = exportProjectToPlcopenXml({
            projectName,
            model: bundle.model ?? 'ES2',
            pous: pouInputs,
          });
          let savedPath: string | null = null;
          if (typeof args.output_path === 'string' && args.output_path.trim()) {
            savedPath = writeFileBuffer(normalizeVirtualPath(args.output_path), Buffer.from(xml, 'utf-8'), Boolean(args.overwrite));
          }
          return {
            success: true,
            status: 'PLCOPEN_XML_EXPORTED',
            format: 'PLCopen_TC6_0201',
            saved_path: savedPath,
            pou_count: pouInputs.length,
            xml: enforceValueBudget(xml, 'xml'),
          };
        }

        const stText = exportProjectToIecStText({
          projectName,
          model: bundle.model ?? 'ES2',
          pous: pouInputs,
        });
        let savedPath: string | null = null;
        if (typeof args.output_path === 'string' && args.output_path.trim()) {
          savedPath = writeFileBuffer(normalizeVirtualPath(args.output_path), Buffer.from(stText, 'utf-8'), Boolean(args.overwrite));
        }
        return {
          success: true,
          status: 'IEC_ST_EXPORTED',
          format: 'IEC_61131_3_ST',
          saved_path: savedPath,
          pou_count: pouInputs.length,
          st_text: enforceValueBudget(stText, 'st_text'),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_csv_symbols_comments',
    description: 'Export or import ISPSoft Global/Local Symbol Tables and Device Comment Tables in standard CSV format.',
    category: 'POU & Symbol Authoring',
    inputSchema: {
      type: 'object',
      required: ['action', 'project_path'],
      properties: {
        action: { type: 'string', enum: ['export_symbols', 'import_symbols', 'export_comments', 'import_comments'] },
        project_path: { type: 'string' },
        csv_text: { type: 'string', description: 'CSV payload required for import_symbols / import_comments' },
        replace_all: { type: 'boolean', default: false, description: 'Replace all existing device comments when importing comments' },
        in_place: { type: 'boolean', default: false },
        output_path: { type: 'string' },
        expected_content_hash: { type: 'string' },
      },
    },
    handler: (args) => {
      try {
        const action = String(args.action ?? '');
        const srcPath = normalizeVirtualPath(String(args.project_path ?? ''));
        const original = readFileBuffer(srcPath);
        const currentHash = computeContentHash('isp', original);
        const c = decodeContainer(original);
        const source = decodeCodepage(c.source, c.encoding);

        if (action === 'export_symbols') {
          const rows: Array<{
            scope: string;
            identifier: string;
            data_type: string;
            address: string;
            class_name: string;
            initial_value: string;
            comment: string;
          }> = [];
          const gSec = sections(source, 'GLOBAL_VAR')[0];
          if (gSec) {
            for (const e of parseLocalVariables(gSec.inner).entries) {
              rows.push({
                scope: 'GLOBAL',
                identifier: e.identifier,
                data_type: e.type,
                address: e.address ?? '',
                class_name: e.class,
                initial_value: e.initial_value,
                comment: e.comment ?? '',
              });
            }
          }
          for (const pou of sections(source, 'POU')) {
            const pName = propertyValue(pou.inner, 'P_Name') ?? 'POU';
            const lSec = sections(pou.inner, 'LOCAL_VAR')[0];
            if (lSec) {
              for (const e of parseLocalVariables(lSec.inner).entries) {
                rows.push({
                  scope: pName,
                  identifier: e.identifier,
                  data_type: e.type,
                  address: e.address ?? '',
                  class_name: e.class,
                  initial_value: e.initial_value,
                  comment: e.comment ?? '',
                });
              }
            }
          }
          return { success: true, action, row_count: rows.length, csv: formatSymbolsCsv(rows) };
        }

        if (action === 'export_comments') {
          const comments = readDeviceComments(source);
          const rows = Object.entries(comments)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([device, comment]) => ({ device, comment }));
          return { success: true, action, row_count: rows.length, csv: formatCommentsCsv(rows) };
        }

        if (args.expected_content_hash && args.expected_content_hash !== currentHash) {
          return { success: false, status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed', current_content_hash: currentHash };
        }
        const csvText = String(args.csv_text ?? '');
        if (!csvText.trim()) throw new FileTransformError('csv_text is required for CSV import');

        let updated = source;
        let importedCount = 0;

        if (action === 'import_symbols') {
          const parsedRows = parseSymbolsCsv(csvText);
          const globalUpserts: Array<Record<string, unknown>> = [];
          const byPou = new Map<string, Array<Record<string, unknown>>>();
          for (const r of parsedRows) {
            const entry = {
              name: r.identifier,
              type: r.data_type,
              address: r.address || undefined,
              class: r.class_name,
              initial_value: r.initial_value || undefined,
              comment: r.comment || undefined,
            };
            if (r.scope.toUpperCase() === 'GLOBAL') {
              globalUpserts.push(entry);
            } else {
              if (!byPou.has(r.scope)) byPou.set(r.scope, []);
              byPou.get(r.scope)!.push(entry);
            }
            importedCount++;
          }
          if (globalUpserts.length) {
            updated = editGlobalVarsInSource(updated, { upsertVars: globalUpserts }, c.newline).updatedSource;
          }
          for (const [pName, vars] of byPou.entries()) {
            updated = editLocalVarsInSource(updated, pName, { upsertVars: vars }, c.newline).updatedSource;
          }
        } else {
          const commentRows = parseCommentsCsv(csvText);
          const map: Record<string, string> = {};
          for (const r of commentRows) {
            map[r.device] = r.comment;
            importedCount++;
          }
          updated = writeDeviceCommentsInSource(updated, map, c.newline, Boolean(args.replace_all)).updatedSource;
        }

        const candidateBytes = c.rebuild(encodeCodepage(updated, c.encoding));
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-csv`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, candidateBytes, Boolean(args.in_place));
        return {
          success: true,
          status: 'CSV_IMPORTED',
          candidate: written.target,
          backup: written.backup,
          imported_count: importedCount,
          content_hash: computeContentHash('isp', candidateBytes),
        };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_device_usage_and_allocate',
    description: 'Scan the entire project (POUs, variables, comments, HWCONFIG, device_init) to build an ISPSoft Used-Device Map and automatically allocate free contiguous or individual X/Y/M/S/T/C/D addresses.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'action'],
      properties: {
        project_path: { type: 'string' },
        action: { type: 'string', enum: ['usage_map', 'allocate'] },
        area: { type: 'string', enum: ['X', 'Y', 'M', 'S', 'T', 'C', 'D'], description: 'Device area to allocate (required for action=allocate)' },
        count: { type: 'integer', minimum: 1, maximum: 256, default: 1 },
        start_from: { type: 'integer', minimum: 0, default: 0 },
        contiguous: { type: 'boolean', default: true },
      },
    },
    handler: (args) => {
      try {
        const p = normalizeVirtualPath(String(args.project_path ?? ''));
        const c = decodeContainer(readFileBuffer(p));
        const source = decodeCodepage(c.source, c.encoding);
        const model = propertyValue(source, 'Prj_DT') ?? 'ES2';
        const isOctal = !(model.toUpperCase().startsWith('AS') || model.toUpperCase().startsWith('AH'));
        const sysVars = readSystemVars(source);
        const limits: Record<string, number> = { X: 255, Y: 255, M: 4095, S: 1023, T: 255, C: 255, D: 9999 };
        for (const r of sysVars) {
          limits[r.area.toUpperCase()] = r.end;
        }
        const texts: string[] = [source];
        for (const pou of sections(source, 'POU')) {
          if (propertyValue(pou.inner, 'P_Lang') === '1') {
            const rendered = renderLdAsciiForPou(pou.inner);
            for (const rung of rendered.rungs) {
              texts.push(rung.il.join(' '));
            }
          }
        }
        const usage = analyzeDeviceUsageFromTexts(texts, limits, isOctal);
        if (args.action === 'allocate') {
          const area = String(args.area ?? 'D').toUpperCase() as 'X' | 'Y' | 'M' | 'S' | 'T' | 'C' | 'D';
          const count = typeof args.count === 'number' ? args.count : 1;
          const allocated = allocateFreeDevices(usage, area, count, {
            start_from: typeof args.start_from === 'number' ? args.start_from : 0,
            contiguous: args.contiguous !== false,
            is_octal_xy: isOctal,
          });
          return {
            success: allocated.length === count,
            model,
            area,
            requested_count: count,
            allocated_count: allocated.length,
            allocated,
            area_summary: usage[area],
          };
        }
        return {
          success: true,
          model,
          octal_xy: isOctal,
          usage,
        };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_convert_program',
    description: 'Deterministically convert PLC logic between DVP IL / Ladder POU and IEC 61131-3 Structured Text (il_to_st, ld_pou_to_st, st_to_il).',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['direction'],
      properties: {
        direction: { type: 'string', enum: ['il_to_st', 'ld_pou_to_st', 'st_to_il'] },
        code: { type: 'string', description: 'Source IL or ST text (required for il_to_st and st_to_il)' },
        project_path: { type: 'string', description: 'Required for ld_pou_to_st' },
        pou_name: { type: 'string', description: 'Required for ld_pou_to_st' },
      },
    },
    handler: (args) => {
      try {
        const dir = String(args.direction ?? '');
        if (dir === 'il_to_st') {
          const instructions = parseIl(String(args.code ?? ''));
          const conv = convertIlInstructionsToSt(instructions);
          return { success: true, direction: dir, st_code: conv.st, warnings: conv.warnings };
        }
        if (dir === 'ld_pou_to_st') {
          const p = normalizeVirtualPath(String(args.project_path ?? ''));
          const pouName = String(args.pou_name ?? '');
          const c = decodeContainer(readFileBuffer(p));
          const source = decodeCodepage(c.source, c.encoding);
          const pou = sections(source, 'POU').find((m) => propertyValue(m.inner, 'P_Name') === pouName);
          if (!pou) throw new FileTransformError(`POU ${JSON.stringify(pouName)} not found`);
          const rendered = renderLdAsciiForPou(pou.inner);
          const ilText = rendered.rungs.flatMap((r) => (r.label ? [`${r.label}:`, ...r.il] : r.il)).join('\n');
          const instructions = parseIl(ilText);
          const conv = convertIlInstructionsToSt(instructions);
          return { success: true, direction: dir, pou_name: pouName, il_code: ilText, st_code: conv.st, warnings: conv.warnings };
        }
        const conv = convertSimpleStToIl(String(args.code ?? ''));
        return { success: true, direction: 'st_to_il', il_code: conv.il, warnings: conv.warnings };
      } catch (e) {
        return { success: false, failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_migrate_project_model',
    description: 'Migrate an ISPSoft .isp project to a different Delta PLC CPU model (e.g. ES2->EH3, ES2->AS228T, AS228T->AS300, AS300->AH500), resizing SYSTEM_VAR and reporting cross-family special-device warnings.',
    category: 'Project Management',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'target_model'],
      properties: {
        project_path: { type: 'string' },
        target_model: { type: 'string', description: 'Target Delta PLC model (e.g. EH3, ES3, SV2, AS228T, AS300, AH500)' },
        output_path: { type: 'string' },
        in_place: { type: 'boolean', default: false },
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
        const migrated = migrateProjectModel(source, String(args.target_model ?? ''));
        if (args.dry_run) {
          return {
            success: true,
            status: 'DRY_RUN_PASSED',
            dry_run: true,
            source_model: migrated.sourceModel,
            target_model: migrated.targetModel,
            source_family: migrated.sourceFamily,
            target_family: migrated.targetFamily,
            migration_notes: migrated.migrationNotes,
            warnings: migrated.warnings,
            current_content_hash: currentHash,
          };
        }
        const target =
          typeof args.output_path === 'string' && args.output_path.trim()
            ? normalizeVirtualPath(args.output_path)
            : artifactPath(`${path.posix.parse(srcPath).name}-${migrated.targetModel}`, '.isp');
        const written = writeProjectCandidateAndBackup(srcPath, target, original, migrated.ispBytes, Boolean(args.in_place));
        const iniPath = written.target.replace(/\.isp$/i, '.ini');
        writeFileBuffer(iniPath, migrated.iniBytes, true);
        return {
          success: true,
          status: 'PROJECT_MIGRATED',
          candidate: written.target,
          companion_path: iniPath,
          backup: written.backup,
          source_model: migrated.sourceModel,
          target_model: migrated.targetModel,
          source_family: migrated.sourceFamily,
          target_family: migrated.targetFamily,
          migration_notes: migrated.migrationNotes,
          warnings: migrated.warnings,
          content_hash: computeContentHash('isp', migrated.ispBytes),
        };
      } catch (e) {
        return { success: false, status: 'CANDIDATE_FAILED', failure_category: 'validation_error', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_lookup_reference',
    description: 'Search the built-in Delta PLC engineering reference catalog: DVP/AS/AH instructions & API numbers, special relays/registers (M1000+/D1000+/SM/SR), and extension modules with CR/BFM register maps.',
    category: 'Diagnostics',
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string', enum: ['instructions', 'special_devices', 'extension_modules', 'all'] },
        query: { type: 'string', description: 'Optional keyword/mnemonic/device/module search string' },
        series: { type: 'string', enum: ['DVP', 'AS', 'AH'] },
        category: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: (args) => {
      try {
        const res = lookupDeltaReference({
          topic: (String(args.topic ?? 'all') as 'instructions' | 'special_devices' | 'extension_modules' | 'all'),
          query: typeof args.query === 'string' ? args.query : undefined,
          series: typeof args.series === 'string' ? (args.series as 'DVP' | 'AS' | 'AH') : undefined,
          category: typeof args.category === 'string' ? args.category : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 50,
        });
        return { success: true, ...res };
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_modbus_planner',
    description: 'Multi-series Delta Modbus toolkit: forward map devices (DVP/AS/AH), reverse map PDU address + function code back to PLC device, or generate exact Modbus RTU (CRC16) and Modbus TCP (MBAP) hex frames.',
    category: 'Analysis & Compilation',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['forward', 'reverse', 'plan_frame'] },
        model: { type: 'string', default: 'ES2', description: 'Delta PLC model (e.g. ES2, EH3, AS228T, AS300, AH500)' },
        addresses: { type: 'array', items: { type: 'string' }, description: 'Device addresses for action=forward' },
        pdu_address: { type: 'integer', minimum: 0, maximum: 65535, description: 'Zero-based Modbus PDU address for action=reverse' },
        function_code: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 15, 16], default: 3, description: 'Modbus function code for action=reverse' },
        device: { type: 'string', description: 'Target PLC device for action=plan_frame (e.g. D100, M0, Y0.1)' },
        operation: { type: 'string', enum: ['read', 'write'], default: 'read' },
        slave_id: { type: 'integer', minimum: 1, maximum: 247, default: 1 },
        count: { type: 'integer', minimum: 1, maximum: 125, default: 1 },
        value: { type: 'integer', description: 'Register or coil value (0/1 or 16-bit int) for write frames' },
        transaction_id: { type: 'integer', minimum: 0, maximum: 65535, default: 1 },
      },
    },
    handler: (args) => {
      try {
        const { canonical, error } = resolveModel(String(args.model ?? 'ES2'));
        if (error || !canonical) return { success: false, status: 'UNSUPPORTED_MODEL', error };
        const action = String(args.action ?? 'forward');
        if (action === 'forward') {
          const addrs = Array.isArray(args.addresses) ? args.addresses.map(String) : [];
          if (!addrs.length) throw new FileTransformError('addresses must be a non-empty array for action=forward');
          return {
            success: true,
            action,
            model: canonical,
            mappings: addrs.map((a) => mapDevice(a, canonical)),
          };
        }
        if (action === 'reverse') {
          if (typeof args.pdu_address !== 'number') throw new FileTransformError('pdu_address is required for action=reverse');
          const fc = typeof args.function_code === 'number' ? args.function_code : 3;
          const match = reverseMapModbus(args.pdu_address, fc, canonical);
          return {
            success: match !== null,
            action,
            model: canonical,
            match,
            ...(match === null ? { error: `No ${canonical} PLC device maps to PDU ${args.pdu_address} with FC${fc}` } : {}),
          };
        }
        const dev = String(args.device ?? '').trim();
        if (!dev) throw new FileTransformError('device is required for action=plan_frame');
        const plan = planModbusRequest({
          device: dev,
          model: canonical,
          operation: args.operation === 'write' ? 'write' : 'read',
          slave_id: typeof args.slave_id === 'number' ? args.slave_id : 1,
          count: typeof args.count === 'number' ? args.count : 1,
          value: typeof args.value === 'number' ? args.value : 0,
          transaction_id: typeof args.transaction_id === 'number' ? args.transaction_id : 1,
        });
        return { success: true, action, ...plan };
      } catch (e) {
        return { success: false, error_code: 'MODBUS_ADDRESS_ERROR', error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_online_edit',
    description: 'ISPSoft Online Edit: hot-patch a POU (ST, IL/LD, SFC, or FBD) inside a running Soft-PLC simulator WITHOUT stopping the CPU or losing device/timer/counter memory, optionally persisting back to disk.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'pou_name'],
      properties: {
        session_id: { type: 'string' },
        pou_name: { type: 'string' },
        st_code: { type: 'string' },
        il_code: { type: 'string' },
        sfc_chart: SFC_CHART_SCHEMA,
        fbd_diagram: FBD_DIAGRAM_SCHEMA,
        persist_to_disk: { type: 'boolean', default: false },
      },
    },
    handler: (args) => {
      try {
        return onlineEditSimulatorPou(String(args.session_id ?? ''), {
          pouName: String(args.pou_name ?? ''),
          stCode: typeof args.st_code === 'string' ? args.st_code : undefined,
          ilCode: typeof args.il_code === 'string' ? args.il_code : undefined,
          sfcChart: args.sfc_chart as SfcChart | undefined,
          fbdDiagram: args.fbd_diagram as FbdDiagram | undefined,
          persistToDisk: Boolean(args.persist_to_disk),
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_io_modules',
    description: 'Inspect or inject right-side special extension module Buffer Memory (BFM / CR registers) in a live Soft-PLC simulator (e.g. simulate DVP04AD-E2 analog channel readings or inspect DVP04DA-E2 DAC outputs written by FROM/TO).',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id', 'action'],
      properties: {
        session_id: { type: 'string' },
        action: { type: 'string', enum: ['list', 'read', 'write'] },
        slot: { type: 'integer', minimum: 0, maximum: 31 },
        cr_values: { type: 'object', additionalProperties: { type: 'number' }, description: 'Map of CR index -> 16-bit integer value, e.g. {"6": 2000, "12": 2000}' },
      },
    },
    handler: (args) => {
      try {
        return manageSimIoModules(String(args.session_id ?? ''), {
          action: (String(args.action ?? 'list') as 'list' | 'read' | 'write'),
          slot: typeof args.slot === 'number' ? args.slot : undefined,
          cr_values: args.cr_values as Record<string, number> | undefined,
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_trigger_interrupt',
    description: 'Trigger an interrupt task, interrupt POU, or interrupt subroutine label (I001/I100/etc.) immediately in the Soft-PLC simulator (honors EI/DI interrupt enable state).',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        task_name: { type: 'string', description: 'Interrupt task name to trigger' },
        pou_name: { type: 'string', description: 'Interrupt POU name to execute' },
        label: { type: 'string', description: 'Interrupt label inside an LD/IL POU (e.g. I001)' },
      },
    },
    handler: (args) => {
      try {
        return triggerSimulatorInterrupt(String(args.session_id ?? ''), {
          taskName: typeof args.task_name === 'string' ? args.task_name : undefined,
          pouName: typeof args.pou_name === 'string' ? args.pou_name : undefined,
          label: typeof args.label === 'string' ? args.label : undefined,
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },
  {
    name: 'ispsoft_sim_trace_analytics',
    description: 'Compute oscilloscope-style Data Tracer analytics (min/max/avg/last, rising & falling edge counts, duty cycle %) and optional CSV export from a Soft-PLC simulator trace buffer.',
    category: 'Soft-PLC Simulator & Monitor',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        addresses: { type: 'array', items: { type: 'string' }, description: 'Optional subset of traced addresses to analyze' },
        format: { type: 'string', enum: ['summary', 'csv'], default: 'summary' },
      },
    },
    handler: (args) => {
      try {
        return analyzeSimulatorTrace(String(args.session_id ?? ''), {
          addresses: Array.isArray(args.addresses) ? args.addresses.map(String) : undefined,
          format: args.format === 'csv' ? 'csv' : 'summary',
        });
      } catch (e) {
        return { success: false, error: errMsg(e) };
      }
    },
  },

];

const LEGACY_HW_STUB_TOOLS = new Set([
  'ispsoft_get_status',
  'ispsoft_list_serial_ports',
  'ispsoft_list_commgr_drivers',
  'ispsoft_get_ide_session',
  'ispsoft_start_ide',
  'ispsoft_open_project',
  'ispsoft_start_background_session',
  'ispsoft_get_background_sessions',
  'ispsoft_stop_background_session',
  'ispsoft_online_status',
  'ispsoft_connect',
  'ispsoft_upload_from_plc',
  'ispsoft_start_monitor',
  'ispsoft_stop_monitor',
  'ispsoft_runtime_read',
  'ispsoft_runtime_write',
  'ispsoft_download',
]);

const TOOL_MAP = new Map<string, McpToolDef>(
  MCP_TOOLS.map((t) => {
    if (!t.annotations) t.annotations = deriveToolAnnotations(t.name);
    return [t.name, t];
  }),
);

export const FAIL_STATUSES = new Set([
  'REJECTED_BEFORE_WRITE',
  'REJECTED_BEFORE_READ',
  'REJECTED_BEFORE_COMPILE',
  'WRITE_FAILED',
  'COMPILE_FAILED',
  'NO_LD_NETWORKS',
  'NETWORK_INDEX_OUT_OF_RANGE',
  'OFFLINE_STATIC_CHECK_FAILED',
  'LD_PROGRAM_STATIC_CHECK_FAILED',
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
  'MODBUS_ADDRESS_ERROR',
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

export function executeMcpTool(
  name: string,
  args: Record<string, unknown> = {},
  requestId?: string,
): Record<string, unknown> {
  seedDefaultWorkspace();
  if (LEGACY_HW_STUB_TOOLS.has(name)) {
    const projectPath = typeof args.project_path === 'string' ? args.project_path : undefined;
    const classified = classifyToolError(
      {
        status: 'TRANSPORT_NOT_QUALIFIED',
        error_code: 'HARDWARE_NOT_QUALIFIED',
        error: `Tool '${name}' requires a native Windows ISPSoft desktop / COMMGR hardware connection and is omitted from the active agent catalog.`,
      },
      { tool: name, args, request_id: requestId },
    );
    return {
      success: false,
      status: 'TRANSPORT_NOT_QUALIFIED',
      error_code: classified.error_code,
      retryable: classified.retryable,
      error: classified.error_detail.message,
      remediation: classified.remediation,
      recovery_actions: classified.recovery_actions,
      error_detail: classified.error_detail,
      ...(projectPath ? { project_path: projectPath } : {}),
    };
  }
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    const detail = buildStandardizedError({
      error_code: 'NOT_FOUND',
      domain: 'MCP_PROTOCOL',
      severity: 'ERROR',
      message: `Unknown tool: ${name}`,
      retryable: false,
      remediation: 'Call tools/list to inspect available MCP tools.',
      recovery_actions: [
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'List qualified ISPSoft MCP tools via tools/list or inspect capabilities.',
          suggested_tool: 'ispsoft_get_capabilities',
          suggested_arguments: {},
          automated: true,
          priority: 1,
        },
      ],
      context: { requested_tool: name },
      request_id: requestId,
      tool: name,
    });
    return {
      success: false,
      error_code: 'NOT_FOUND',
      retryable: false,
      error: detail.message,
      remediation: detail.remediation,
      recovery_actions: detail.recovery_actions,
      error_detail: detail,
    };
  }

  let sanitizedArgs: Record<string, unknown>;
  try {
    sanitizedArgs = sanitizeJsonValue(args);
  } catch (err) {
    mcpTelemetry.recordValidationError();
    const message = errMsg(err);
    const detail = buildStandardizedError({
      error_code: 'VALIDATION_ERROR',
      domain: 'VALIDATION',
      severity: 'ERROR',
      message,
      retryable: false,
      remediation: 'Reduce JSON nesting depth and remove reserved keys.',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Flatten nested JSON arguments (max depth 32) and strip prototype keys.',
          automated: true,
          priority: 1,
        },
      ],
      request_id: requestId,
      tool: name,
    });
    return {
      success: false,
      status: 'VALIDATION_ERROR',
      error_code: 'VALIDATION_ERROR',
      retryable: false,
      error: message,
      remediation: detail.remediation,
      recovery_actions: detail.recovery_actions,
      error_detail: detail,
    };
  }

  const check = validateToolArguments(tool.inputSchema, sanitizedArgs);
  if (!check.valid) {
    mcpTelemetry.recordValidationError();
    const message = check.errors.map((e) => e.message).join('; ');
    const detail = buildStandardizedError({
      error_code: 'VALIDATION_ERROR',
      domain: 'VALIDATION',
      severity: 'ERROR',
      message,
      retryable: false,
      remediation: 'Verify required fields and types against the tool inputSchema.',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Fix the fields listed in context.validation_errors to satisfy the tool inputSchema and retry.',
          automated: true,
          priority: 1,
        },
      ],
      context: { validation_errors: check.errors },
      request_id: requestId,
      tool: name,
    });
    return {
      success: false,
      status: 'VALIDATION_ERROR',
      error_code: 'VALIDATION_ERROR',
      retryable: false,
      error: message,
      validation_errors: check.errors,
      remediation: detail.remediation,
      recovery_actions: detail.recovery_actions,
      error_detail: detail,
    };
  }

  let rawResult: Record<string, unknown>;
  try {
    rawResult = tool.handler(sanitizedArgs);
  } catch (err) {
    rawResult = { success: false, error: errMsg(err) };
  }

  const budgeted = budgetPayload(rawResult, MAX_ITEM_CHARS, MAX_RESPONSE_CHARS);
  if (isToolResultError(budgeted)) {
    const classified = classifyToolError(budgeted, { tool: name, args: sanitizedArgs, request_id: requestId });
    if (!budgeted.error_code) budgeted.error_code = classified.error_code;
    if (budgeted.retryable === undefined) budgeted.retryable = classified.retryable;
    if (!budgeted.remediation) budgeted.remediation = classified.remediation;
    if (!budgeted.recovery_actions) budgeted.recovery_actions = classified.recovery_actions;
    if (!budgeted.error_detail) budgeted.error_detail = classified.error_detail;
  }
  return budgeted;
}

export { getFileMeta };
