import crypto from 'node:crypto';
import path from 'node:path';
import { executeMcpTool, getAnnotatedTools, getToolDef, isToolResultError } from './tools.js';
import {
  ISPSOFT_ERROR_JSON_SCHEMA,
  buildStandardizedError,
  classifyToolError,
  mcpIdempotency,
  mcpTelemetry,
} from './mcpProtocol.js';
import { listSimulatorSessions, monitorSimulator } from './simulator.js';
import { getWorkspaceStorageStats, listAllFiles, seedDefaultWorkspace } from './workspace.js';

export const SERVER_NAME = 'ispsoft';
export const SERVER_VERSION = '1.2.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2024-11-05']);

const MAX_MCP_SESSIONS = 1000;
const MCP_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

export const mcpSessions = new Map<string, { createdAt: string; lastSeenAt: number; logLevel: string }>();

export function pruneMcpSessions(now = Date.now()): void {
  for (const [sid, info] of mcpSessions.entries()) {
    if (now - info.lastSeenAt > MCP_SESSION_IDLE_TTL_MS) {
      mcpSessions.delete(sid);
    }
  }
  while (mcpSessions.size >= MAX_MCP_SESSIONS) {
    const oldest = mcpSessions.keys().next().value;
    if (oldest === undefined) break;
    mcpSessions.delete(oldest);
  }
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export const MCP_PROMPTS = [
  {
    name: 'audit_and_optimize_plc',
    description: 'Audit an ISPSoft PLC project for logic defects, simulate it, and eliminate scan bottlenecks.',
    arguments: [
      { name: 'project_path', description: 'Workspace .isp path (e.g. /workspace/sample_es2.isp)', required: true },
    ],
  },
  {
    name: 'author_ld_interlock_safe',
    description: 'Safely add or edit Ladder rungs with IL round-trip validation, static checks, and Soft-PLC verification.',
    arguments: [
      { name: 'project_path', description: 'Workspace .isp path', required: true },
      { name: 'pou_name', description: 'Target LD POU name', required: true },
    ],
  },
  {
    name: 'commission_and_test_sequence',
    description: 'Run deterministic Soft-PLC commissioning scenarios with forced I/O, timers, assertions, and trace capture.',
    arguments: [
      { name: 'project_path', description: 'Workspace .isp path', required: true },
    ],
  },
  {
    name: 'diagnose_sluggish_scan',
    description: 'Profile PLC scan execution speed, loop-cap hits, hot LD networks, and array memory bloat.',
    arguments: [
      { name: 'session_id', description: 'Active simulator session ID (e.g. sim-1)', required: true },
    ],
  },
];

export function buildPromptMessages(name: string, args: Record<string, unknown>) {
  const proj = String(args.project_path ?? '/workspace/sample_es2.isp');
  const pou = String(args.pou_name ?? 'Prog0');
  const simId = String(args.session_id ?? 'sim-1');
  if (name === 'audit_and_optimize_plc') {
    return {
      description: 'End-to-end engineering audit and Soft-PLC optimization workflow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Audit and optimize ${proj}:`,
              `1. Call ispsoft_audit_project on ${proj}.`,
              `2. Start Soft-PLC simulation with ispsoft_sim_start and run ispsoft_sim_diagnostics (sample_cycles=20).`,
              `3. Apply atomic fixes with ispsoft_apply_project_transaction (dry_run=true first, then in_place=true with reload_simulator_session_id).`,
              `4. Re-run ispsoft_sim_diagnostics and ispsoft_static_check_and_compile to verify OPTIMAL health.`,
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'author_ld_interlock_safe') {
    return {
      description: 'Safe Ladder Logic editing with validation and readback verification',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Safely update LD POU ${pou} in ${proj}:`,
              `1. Inspect current rungs with ispsoft_render_ld_ascii and read content_hash.`,
              `2. Validate new IL via ispsoft_validate_il.`,
              `3. Apply edit via ispsoft_edit_ld_rungs (dry_run=true, expected_content_hash), then commit.`,
              `4. Run ispsoft_static_check_and_compile and test the interlock in ispsoft_sim_run_sequence.`,
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'commission_and_test_sequence') {
    return {
      description: 'Deterministic multi-step PLC commissioning testbench workflow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Commission ${proj} in Soft-PLC simulator:`,
              `1. Call ispsoft_sim_start on ${proj}.`,
              `2. Configure watch list with ispsoft_sim_watch_table.`,
              `3. Execute test steps (inputs, step_until timer/counter conditions, expect assertions) via ispsoft_sim_run_sequence.`,
              `4. Inspect trace via ispsoft_sim_watch_table (action="trace") and close session when finished.`,
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'diagnose_sluggish_scan') {
    return {
      description: 'Profile and optimize sluggish PLC simulation cycles',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Diagnose simulation session ${simId}:`,
              `1. Call ispsoft_sim_diagnostics with session_id="${simId}", sample_cycles=10, include_recent_scans=true.`,
              `2. Inspect pou_breakdown (loop_cap_hits, jump_cap_hits, share_of_scan_pct), hot_networks, and memory.array_collections.`,
              `3. Follow recommendations[] to refactor the slowest POU/network and reload the simulator to verify speedup.`,
            ].join('\n'),
          },
        },
      ],
    };
  }
  return null;
}

export function listStaticAndDynamicResources() {
  seedDefaultWorkspace();
  const baseResources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [
    {
      uri: 'ispsoft://models',
      name: 'Supported Delta PLC Models & Qualification Matrix',
      description: 'Canonical AS/DVP PLC profiles and offline/simulator capabilities.',
      mimeType: 'application/json',
    },
    {
      uri: 'ispsoft://workspace/files',
      name: 'Workspace Files & Storage Quota',
      description: 'All .isp/.mpu/.ini files in /workspace plus disk quota utilization.',
      mimeType: 'application/json',
    },
    {
      uri: 'ispsoft://telemetry',
      name: 'MCP Server Telemetry & Quota Summary',
      description: 'Live call counts, error rate, latency stats, active simulator sessions, and storage quota.',
      mimeType: 'application/json',
    },
    {
      uri: 'ispsoft://schemas/error',
      name: 'ISPSoft Standardized Error JSON Schema (Draft-07)',
      description: 'Machine-readable JSON Schema defining error_code, domain, severity, context, and prioritized recovery_actions for AI agents.',
      mimeType: 'application/schema+json',
    },
  ];
  for (const filePath of listAllFiles()) {
    if (/\.isp$/i.test(filePath)) {
      const name = path.posix.basename(filePath);
      baseResources.push({
        uri: `ispsoft://projects/${encodeURIComponent(name)}/overview`,
        name: `Project Overview: ${name}`,
        description: `Structural overview (POUs, tasks, globals, DUTs) for ${filePath}.`,
        mimeType: 'application/json',
      });
      baseResources.push({
        uri: `ispsoft://projects/${encodeURIComponent(name)}/bundle`,
        name: `Project JSON Bundle: ${name}`,
        description: `Complete structured JSON bundle (IL/ST code, variables, tasks, DUTs, comments) for ${filePath}.`,
        mimeType: 'application/json',
      });
    }
  }
  for (const sim of listSimulatorSessions()) {
    baseResources.push({
      uri: `ispsoft://simulator/${encodeURIComponent(sim.session_id)}/status`,
      name: `Simulator Session: ${sim.session_id} (${sim.mode})`,
      description: `Compact online monitor snapshot for ${sim.project_path}.`,
      mimeType: 'application/json',
    });
  }
  return baseResources;
}

export function readMcpResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | null {
  if (uri === 'ispsoft://models') {
    const data = executeMcpTool('ispsoft_list_supported_plc_types', {});
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  if (uri === 'ispsoft://workspace/files') {
    const data = { storage: getWorkspaceStorageStats(), files: listAllFiles() };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  if (uri === 'ispsoft://telemetry') {
    const data = executeMcpTool('ispsoft_server_telemetry', {});
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  if (uri === 'ispsoft://schemas/error') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/schema+json',
          text: JSON.stringify(ISPSOFT_ERROR_JSON_SCHEMA, null, 2),
        },
      ],
    };
  }
  const projMatch = /^ispsoft:\/\/projects\/([^/]+)\/(overview|bundle|source)$/.exec(uri);
  if (projMatch) {
    const fileName = decodeURIComponent(projMatch[1]);
    const kind = projMatch[2];
    const toolName =
      kind === 'bundle'
        ? 'ispsoft_export_project_bundle'
        : kind === 'source'
          ? 'ispsoft_read_project_source'
          : 'ispsoft_get_project_overview';
    const data = executeMcpTool(toolName, { project_path: `/workspace/${fileName}` });
    if (data.success === false) return null;
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  const simMatch = /^ispsoft:\/\/simulator\/([^/]+)\/status$/.exec(uri);
  if (simMatch) {
    const sid = decodeURIComponent(simMatch[1]);
    try {
      const snap = monitorSimulator(sid, undefined, true);
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snap, null, 2) }] };
    } catch {
      return null;
    }
  }
  return null;
}

export function handleSingleRpc(
  msg: RpcMessage,
  ctx: { requestId: string; idempotencyKeyHeader?: string; mcpSessionId?: string },
): { status: number; body: Record<string, unknown> | null; newSessionId?: string } {
  const id = msg?.id ?? null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string' || !msg.method.trim()) {
    const message = 'Invalid Request: method is required';
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message,
          data: buildStandardizedError({
            error_code: 'PROTOCOL_INVALID_REQUEST',
            domain: 'MCP_PROTOCOL',
            severity: 'ERROR',
            message,
            retryable: false,
            remediation: 'Send a valid JSON-RPC 2.0 request object with a non-empty string "method".',
            recovery_actions: [
              {
                action: 'FIX_INPUT_PARAMETERS',
                description: 'Provide {"jsonrpc":"2.0","id":1,"method":"initialize"|"tools/list"|"tools/call",...}.',
                automated: true,
                priority: 1,
              },
            ],
            context: { rpc_code: -32600 },
            request_id: ctx.requestId,
          }),
        },
      },
    };
  }
  if (msg.jsonrpc !== undefined && msg.jsonrpc !== '2.0') {
    const message = 'Invalid Request: jsonrpc must be "2.0"';
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message,
          data: buildStandardizedError({
            error_code: 'PROTOCOL_INVALID_REQUEST',
            domain: 'MCP_PROTOCOL',
            severity: 'ERROR',
            message,
            retryable: false,
            remediation: 'Set "jsonrpc": "2.0" on all MCP messages.',
            recovery_actions: [
              {
                action: 'FIX_INPUT_PARAMETERS',
                description: 'Include "jsonrpc": "2.0" in the request payload and retry.',
                automated: true,
                priority: 1,
              },
            ],
            context: { rpc_code: -32600, received_jsonrpc: msg.jsonrpc },
            request_id: ctx.requestId,
          }),
        },
      },
    };
  }

  if (
    msg.params !== undefined &&
    (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params))
  ) {
    const message = 'Invalid params: expected JSON object';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message,
          data: buildStandardizedError({
            error_code: 'PROTOCOL_INVALID_PARAMS',
            domain: 'MCP_PROTOCOL',
            severity: 'ERROR',
            message,
            retryable: false,
            remediation: 'Pass MCP method parameters as a JSON object ({}), not an array or primitive.',
            recovery_actions: [
              {
                action: 'FIX_INPUT_PARAMETERS',
                description: 'Wrap method arguments inside a JSON object in "params".',
                automated: true,
                priority: 1,
              },
            ],
            context: { rpc_code: -32602, method: msg.method },
            request_id: ctx.requestId,
          }),
        },
      },
    };
  }
  const paramsObj = (msg.params ?? {}) as Record<string, unknown>;

  mcpTelemetry.recordRpcRequest();

  if (msg.method.startsWith('notifications/')) {
    return { status: 204, body: null };
  }
  if (msg.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (msg.method === 'initialize') {
    pruneMcpSessions();
    const requestedVersion = typeof paramsObj.protocolVersion === 'string' ? paramsObj.protocolVersion.trim() : '';
    const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION;
    const newSid = ctx.mcpSessionId && mcpSessions.has(ctx.mcpSessionId) ? ctx.mcpSessionId : `mcp-${crypto.randomUUID()}`;
    mcpSessions.set(newSid, { createdAt: new Date().toISOString(), lastSeenAt: Date.now(), logLevel: 'info' });
    return {
      status: 200,
      newSessionId: newSid,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
          instructions:
            'Headless Delta ISPSoft MCP server for AI agents (zero UI). Workspace files reside in /workspace (pre-seeded with sample_es2.isp, sample_as228t.isp, sample_prog0.mpu). Use ispsoft_manage_workspace_files (list/upload_base64/download_base64) for binary file transfer over MCP, dry_run=true + expected_content_hash for safe edits, ispsoft_static_check_and_compile to verify code, and ispsoft_sim_* (start, control, run_sequence, diagnostics) to simulate and profile PLC scans.',
        },
      },
    };
  }
  if (msg.method === 'logging/setLevel') {
    const level = String(paramsObj.level ?? 'info');
    if (ctx.mcpSessionId && mcpSessions.has(ctx.mcpSessionId)) {
      mcpSessions.get(ctx.mcpSessionId)!.logLevel = level;
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (msg.method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          tools: getAnnotatedTools().map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            annotations,
          })),
        },
      },
    };
  }
  if (msg.method === 'resources/list') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { resources: listStaticAndDynamicResources() } },
    };
  }
  if (msg.method === 'resources/templates/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          resourceTemplates: [
            {
              uriTemplate: 'ispsoft://projects/{name}/overview',
              name: 'Project Overview',
              description: 'Inspect POUs, tasks, global variables, and DUTs for a workspace .isp file',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'ispsoft://projects/{name}/bundle',
              name: 'Project Bundle',
              description: 'Read complete structured JSON bundle (IL/ST code, variables, tasks, DUTs, comments)',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'ispsoft://projects/{name}/source',
              name: 'Project Source',
              description: 'Read raw decoded project source text for a workspace .isp file',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'ispsoft://simulator/{session_id}/status',
              name: 'Simulator Status',
              description: 'Read compact live monitor snapshot for an active Soft-PLC simulator session',
              mimeType: 'application/json',
            },
          ],
        },
      },
    };
  }
  if (msg.method === 'resources/read') {
    const uri = String(paramsObj.uri ?? '');
    if (!uri) {
      const message = 'Invalid params: uri is required';
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message,
            data: buildStandardizedError({
              error_code: 'PROTOCOL_INVALID_PARAMS',
              domain: 'MCP_PROTOCOL',
              severity: 'ERROR',
              message,
              retryable: false,
              remediation: 'Provide params.uri from resources/list or resources/templates/list.',
              recovery_actions: [
                {
                  action: 'CREATE_OR_LIST_RESOURCE',
                  description: 'Call resources/list or resources/templates/list to obtain valid ispsoft:// URIs.',
                  automated: true,
                  priority: 1,
                },
              ],
              context: { rpc_code: -32602, method: 'resources/read' },
              request_id: ctx.requestId,
            }),
          },
        },
      };
    }
    const content = readMcpResource(uri);
    if (!content) {
      const message = `Resource not found: ${uri}`;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32002,
            message,
            data: buildStandardizedError({
              error_code: 'PROTOCOL_RESOURCE_NOT_FOUND',
              domain: 'MCP_PROTOCOL',
              severity: 'ERROR',
              message,
              retryable: false,
              remediation: 'Verify the resource URI against resources/list or check /workspace files.',
              recovery_actions: [
                {
                  action: 'CREATE_OR_LIST_RESOURCE',
                  description: 'Call resources/list to inspect available static and dynamic ispsoft:// resources.',
                  automated: true,
                  priority: 1,
                },
              ],
              context: { rpc_code: -32002, uri },
              request_id: ctx.requestId,
            }),
          },
        },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: content } };
  }
  if (msg.method === 'prompts/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } } };
  }
  if (msg.method === 'prompts/get') {
    const name = String(paramsObj.name ?? '');
    const prompt = buildPromptMessages(name, (paramsObj.arguments as Record<string, unknown>) ?? {});
    if (!prompt) {
      const message = `Unknown prompt: ${name}`;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message,
            data: buildStandardizedError({
              error_code: 'PROTOCOL_INVALID_PARAMS',
              domain: 'MCP_PROTOCOL',
              severity: 'ERROR',
              message,
              retryable: false,
              remediation: 'Call prompts/list to retrieve valid prompt names.',
              recovery_actions: [
                {
                  action: 'CREATE_OR_LIST_RESOURCE',
                  description: 'Invoke prompts/list to discover available workflow prompt templates.',
                  automated: true,
                  priority: 1,
                },
              ],
              context: { rpc_code: -32602, prompt: name },
              request_id: ctx.requestId,
            }),
          },
        },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: prompt } };
  }
  if (msg.method === 'completion/complete') {
    const ref = (paramsObj.ref && typeof paramsObj.ref === 'object' ? paramsObj.ref : {}) as Record<string, unknown>;
    const arg = (paramsObj.argument && typeof paramsObj.argument === 'object' ? paramsObj.argument : {}) as Record<string, unknown>;
    const argName = String(arg.name ?? '');
    const partial = String(arg.value ?? '').toLowerCase();
    let values: string[] = [];
    if (ref.type === 'ref/prompt' || ref.type === 'ref/resource') {
      if (argName === 'project_path' || argName === 'name') {
        values = listAllFiles()
          .filter((f) => /\.isp$/i.test(f))
          .filter((f) => f.toLowerCase().includes(partial))
          .slice(0, 25);
      } else if (argName === 'session_id') {
        values = listSimulatorSessions()
          .map((s) => s.session_id)
          .filter((s) => s.toLowerCase().includes(partial))
          .slice(0, 25);
      }
    }
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { completion: { values, total: values.length, hasMore: false } } },
    };
  }
  if (msg.method === 'tools/call') {
    const toolName = String(paramsObj.name ?? '');
    const rawArgs = paramsObj.arguments == null ? {} : paramsObj.arguments;
    const found = getToolDef(toolName);
    if (!found) {
      const classified = classifyToolError(
        {
          error_code: 'NOT_FOUND',
          error: `Unknown MCP tool: ${toolName}`,
        },
        { tool: toolName, request_id: ctx.requestId },
      );
      // If it matches a legacy hardware tool stub, emit HARDWARE_NOT_QUALIFIED guidance in error.data
      const stubCheck = executeMcpTool(toolName, {}, ctx.requestId);
      const errDetail =
        stubCheck.error_code === 'HARDWARE_NOT_QUALIFIED' && stubCheck.error_detail
          ? stubCheck.error_detail
          : buildStandardizedError({
              error_code: 'PROTOCOL_INVALID_PARAMS',
              domain: 'MCP_PROTOCOL',
              severity: 'ERROR',
              message: `Unknown MCP tool: ${toolName}`,
              retryable: false,
              remediation: 'Call tools/list to inspect the 60 active headless ISPSoft MCP tools.',
              recovery_actions: [
                {
                  action: 'FALLBACK_TO_TOOL',
                  description: 'Inspect capabilities or call tools/list for valid tool names.',
                  suggested_tool: 'ispsoft_get_capabilities',
                  suggested_arguments: {},
                  automated: true,
                  priority: 1,
                },
              ],
              context: { rpc_code: -32602, requested_tool: toolName, fallback_code: classified.error_code },
              request_id: ctx.requestId,
              tool: toolName,
            });
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: `Unknown MCP tool: ${toolName}`,
            data: errDetail,
          },
        },
      };
    }

    const meta = (paramsObj._meta && typeof paramsObj._meta === 'object' ? paramsObj._meta : {}) as Record<string, unknown>;
    const idempotencyKey =
      (typeof meta.idempotency_key === 'string' && meta.idempotency_key.trim()) ||
      ctx.idempotencyKeyHeader ||
      '';

    const t0 = process.hrtime.bigint();
    let output: Record<string, unknown>;
    let idempotentReplay = false;

    if (idempotencyKey && rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      const cached = mcpIdempotency.get(toolName, idempotencyKey, rawArgs as Record<string, unknown>);
      if (cached.hit) {
        if (cached.conflict) {
          const baseErr = {
            success: false,
            status: 'IDEMPOTENCY_CONFLICT',
            error_code: 'IDEMPOTENCY_CONFLICT',
            error: `Idempotency-Key "${idempotencyKey}" was already used with different arguments for ${toolName}.`,
          };
          const classified = classifyToolError(baseErr, { tool: toolName, args: rawArgs as Record<string, unknown>, request_id: ctx.requestId });
          output = {
            ...baseErr,
            retryable: classified.retryable,
            remediation: classified.remediation,
            recovery_actions: classified.recovery_actions,
            error_detail: classified.error_detail,
          };
        } else {
          output = cached.response!;
          idempotentReplay = true;
        }
      } else {
        output = executeMcpTool(toolName, rawArgs as Record<string, unknown>, ctx.requestId);
        if (!isToolResultError(output)) {
          mcpIdempotency.set(toolName, idempotencyKey, rawArgs as Record<string, unknown>, output);
        }
      }
    } else {
      output = executeMcpTool(toolName, rawArgs as Record<string, unknown>, ctx.requestId);
    }

    const durationMs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000_000) * 1000) / 1000;
    const isError = isToolResultError(output);
    const errorCode = isError
      ? ((output.error_code as ReturnType<typeof classifyToolError>['error_code']) ?? classifyToolError(output).error_code)
      : undefined;

    mcpTelemetry.recordToolCall({
      timestamp: new Date().toISOString(),
      request_id: ctx.requestId,
      tool: toolName,
      duration_ms: durationMs,
      is_error: isError,
      error_code: errorCode,
      idempotent_replay: idempotentReplay,
    });

    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
          structuredContent: output,
          isError,
          _meta: {
            request_id: ctx.requestId,
            duration_ms: durationMs,
            idempotent_replay: idempotentReplay,
          },
        },
      },
    };
  }
  const methodMsg = `Method not found: ${msg.method}`;
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: methodMsg,
        data: buildStandardizedError({
          error_code: 'PROTOCOL_METHOD_NOT_FOUND',
          domain: 'MCP_PROTOCOL',
          severity: 'ERROR',
          message: methodMsg,
          retryable: false,
          remediation: 'Use supported MCP JSON-RPC methods: initialize, ping, tools/list, tools/call, resources/list, resources/templates/list, resources/read, prompts/list, prompts/get, completion/complete, logging/setLevel.',
          recovery_actions: [
            {
              action: 'FIX_INPUT_PARAMETERS',
              description: 'Retry using a supported MCP method name such as tools/list or tools/call.',
              automated: true,
              priority: 1,
            },
          ],
          context: { rpc_code: -32601, method: msg.method },
          request_id: ctx.requestId,
        }),
      },
    },
  };
}
