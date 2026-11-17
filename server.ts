import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_TOOLS,
  executeMcpTool,
  getAnnotatedTools,
  getToolDef,
  isToolResultError,
} from './src/ispsoft/tools.js';
import { classifyToolError, mcpIdempotency, mcpTelemetry } from './src/ispsoft/mcpProtocol.js';
import { listSimulatorSessions, monitorSimulator, shutdownAllSimulators } from './src/ispsoft/simulator.js';
import {
  getWorkspaceStorageStats,
  listAllFiles,
  normalizeVirtualPath,
  readFileBuffer,
  seedDefaultWorkspace,
  writeFileBuffer,
} from './src/ispsoft/workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

seedDefaultWorkspace();

const SERVER_NAME = 'ispsoft';
const SERVER_VERSION = '1.1.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const mcpSessions = new Map<string, { createdAt: string; lastSeenAt: number; logLevel: string }>();

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MCP_PROMPTS = [
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

function buildPromptMessages(name: string, args: Record<string, unknown>) {
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

function listStaticAndDynamicResources() {
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

function readMcpResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | null {
  if (uri === 'ispsoft://models') {
    const data = executeMcpTool('ispsoft_list_supported_plc_types', {});
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  if (uri === 'ispsoft://workspace/files') {
    const data = { storage: getWorkspaceStorageStats(), files: listAllFiles() };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  const projMatch = /^ispsoft:\/\/projects\/([^/]+)\/overview$/.exec(uri);
  if (projMatch) {
    const fileName = decodeURIComponent(projMatch[1]);
    const overview = executeMcpTool('ispsoft_get_project_overview', { project_path: `/workspace/${fileName}` });
    if (overview.success === false) return null;
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(overview, null, 2) }] };
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

export const app = express();

// Request ID, CORS, and industrial HTTP security headers
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()) || crypto.randomUUID();
  res.locals.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Idempotency-Key, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, X-Request-Id');
  if (req.path === '/mcp' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Optional Bearer authentication guard when ISPSOFT_MCP_AUTH_TOKEN is configured
app.use((req: Request, res: Response, next: NextFunction) => {
  const token = process.env.ISPSOFT_MCP_AUTH_TOKEN?.trim();
  if (!token) {
    next();
    return;
  }
  if (req.path === '/api/health' || req.path === '/api/ready' || !req.path.startsWith('/mcp') && !req.path.startsWith('/api/')) {
    next();
    return;
  }
  const authHeader = req.headers.authorization ?? '';
  if (authHeader !== `Bearer ${token}`) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized: missing or invalid Bearer token' },
    });
    return;
  }
  next();
});

app.use(express.json({ limit: '16mb' }));

// JSON syntax error handler -> clean JSON-RPC -32700 on /mcp instead of HTML 400
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    if (req.path === '/mcp') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: malformed JSON request body' },
      });
      return;
    }
    res.status(400).json({ success: false, error_code: 'VALIDATION_ERROR', error: 'Malformed JSON request body' });
    return;
  }
  next(err);
});

app.use(express.static(path.join(__dirname, 'public')));

// ===========================================================================
// MCP JSON-RPC 2.0 Streamable HTTP Endpoint (/mcp) & Agent Discovery
// ===========================================================================
app.get(['/mcp', '/.well-known/mcp.json'], (req: Request, res: Response) => {
  const accept = String(req.headers.accept ?? '');
  if (req.path === '/mcp' && accept.includes('text/event-stream')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: endpoint\ndata: ${JSON.stringify({ endpoint: '/mcp', protocolVersion: MCP_PROTOCOL_VERSION })}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    req.on('close', () => clearInterval(heartbeat));
    return;
  }

  res.json({
    protocol: 'mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'streamable-http-jsonrpc',
    endpoint: '/mcp',
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: 'Industrial-grade AI-agent-first Delta ISPSoft MCP Server (authoring, LD/ST/IL editing, static check, Soft-PLC simulator & diagnostics, Modbus mapping)',
    },
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
    },
    toolCount: MCP_TOOLS.length,
    tools: getAnnotatedTools(),
  });
});

app.delete('/mcp', (req: Request, res: Response) => {
  const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
  if (sid && mcpSessions.has(sid)) {
    mcpSessions.delete(sid);
    res.status(204).end();
    return;
  }
  res.status(404).json({ error: 'Unknown or missing Mcp-Session-Id' });
});

function handleSingleRpc(
  msg: RpcMessage,
  ctx: { requestId: string; idempotencyKeyHeader?: string; mcpSessionId?: string },
): { status: number; body: Record<string, unknown> | null; newSessionId?: string } {
  const id = msg?.id ?? null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string' || !msg.method.trim()) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: method is required' } },
    };
  }
  if (msg.jsonrpc !== undefined && msg.jsonrpc !== '2.0') {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } },
    };
  }

  mcpTelemetry.recordRpcRequest();

  if (msg.method.startsWith('notifications/')) {
    return { status: 204, body: null };
  }
  if (msg.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (msg.method === 'initialize') {
    const newSid = ctx.mcpSessionId && mcpSessions.has(ctx.mcpSessionId) ? ctx.mcpSessionId : `mcp-${crypto.randomUUID()}`;
    mcpSessions.set(newSid, { createdAt: new Date().toISOString(), lastSeenAt: Date.now(), logLevel: 'info' });
    return {
      status: 200,
      newSessionId: newSid,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
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
        },
      },
    };
  }
  if (msg.method === 'logging/setLevel') {
    const level = String(msg.params?.level ?? 'info');
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
    const uri = String(msg.params?.uri ?? '');
    if (!uri) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: uri is required' } },
      };
    }
    const content = readMcpResource(uri);
    if (!content) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32002, message: `Resource not found: ${uri}` } },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: content } };
  }
  if (msg.method === 'prompts/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } } };
  }
  if (msg.method === 'prompts/get') {
    const name = String(msg.params?.name ?? '');
    const prompt = buildPromptMessages(name, (msg.params?.arguments as Record<string, unknown>) ?? {});
    if (!prompt) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${name}` } },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: prompt } };
  }
  if (msg.method === 'completion/complete') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { completion: { values: [], total: 0, hasMore: false } } },
    };
  }
  if (msg.method === 'tools/call') {
    const params = msg.params ?? {};
    const toolName = String(params.name ?? '');
    const rawArgs = params.arguments === undefined ? {} : params.arguments;
    const found = getToolDef(toolName);
    if (!found) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown MCP tool: ${toolName}` },
        },
      };
    }

    const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
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
          output = {
            success: false,
            status: 'IDEMPOTENCY_CONFLICT',
            error_code: 'IDEMPOTENCY_CONFLICT',
            retryable: false,
            error: `Idempotency-Key "${idempotencyKey}" was already used with different arguments for ${toolName}.`,
            remediation: 'Use a new Idempotency-Key for distinct arguments.',
          };
        } else {
          output = cached.response!;
          idempotentReplay = true;
        }
      } else {
        output = executeMcpTool(toolName, rawArgs as Record<string, unknown>);
        if (!isToolResultError(output)) {
          mcpIdempotency.set(toolName, idempotencyKey, rawArgs as Record<string, unknown>, output);
        }
      }
    } else {
      output = executeMcpTool(toolName, rawArgs as Record<string, unknown>);
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
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    },
  };
}

app.post('/mcp', (req: Request, res: Response) => {
  const reqId = String(res.locals.requestId ?? crypto.randomUUID());
  const idemHeader = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim() : '';
  const mcpSessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';

  if (mcpSessionId && mcpSessions.has(mcpSessionId)) {
    mcpSessions.get(mcpSessionId)!.lastSeenAt = Date.now();
    res.setHeader('Mcp-Session-Id', mcpSessionId);
  }

  if (Array.isArray(req.body)) {
    if (req.body.length === 0) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid empty JSON-RPC batch' } });
      return;
    }
    const outcomes = req.body.map((item) =>
      handleSingleRpc(item, { requestId: reqId, idempotencyKeyHeader: idemHeader, mcpSessionId }),
    );
    const createdSid = outcomes.find((o) => o.newSessionId)?.newSessionId;
    if (createdSid) res.setHeader('Mcp-Session-Id', createdSid);
    const responses = outcomes.filter((r) => r.status !== 204 && r.body !== null).map((r) => r.body);
    if (!responses.length) {
      res.status(204).end();
      return;
    }
    res.json(responses);
    return;
  }

  const outcome = handleSingleRpc(req.body, { requestId: reqId, idempotencyKeyHeader: idemHeader, mcpSessionId });
  if (outcome.newSessionId) {
    res.setHeader('Mcp-Session-Id', outcome.newSessionId);
  }
  if (outcome.status === 204 || outcome.body === null) {
    res.status(204).end();
    return;
  }
  res.status(outcome.status).json(outcome.body);
});

// ===========================================================================
// REST API Routes for Agents, Telemetry & Tooling
// ===========================================================================
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    server: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: MCP_TOOLS.length,
    uptime_seconds: mcpTelemetry.getSummary().uptime_seconds,
  });
});

app.get('/api/ready', (_req: Request, res: Response) => {
  try {
    seedDefaultWorkspace();
    const storage = getWorkspaceStorageStats();
    res.json({
      ready: true,
      tools: MCP_TOOLS.length,
      workspace_files: storage.file_count,
      active_simulators: listSimulatorSessions().length,
    });
  } catch (err) {
    res.status(503).json({ ready: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/metrics', (req: Request, res: Response) => {
  const storage = getWorkspaceStorageStats();
  const activeSims = listSimulatorSessions().length;
  const format = String(req.query.format ?? '').toLowerCase();
  const accept = String(req.headers.accept ?? '');
  if (format === 'prometheus' || accept.includes('text/plain')) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(
      mcpTelemetry.toPrometheusText({
        active_simulators: activeSims,
        workspace_files: storage.file_count,
        workspace_bytes: storage.total_bytes,
        mcp_sessions: mcpSessions.size,
      }),
    );
    return;
  }
  res.json(
    mcpTelemetry.getSummary({
      workspace_storage: storage,
      active_simulator_sessions: activeSims,
      active_mcp_sessions: mcpSessions.size,
      idempotency_cache_entries: mcpIdempotency.size,
      tool_catalog_count: MCP_TOOLS.length,
    }),
  );
});

app.get('/api/doctor', (_req: Request, res: Response) => {
  res.json(executeMcpTool('ispsoft_doctor', {}));
});

app.get('/api/capabilities', (_req: Request, res: Response) => {
  res.json(executeMcpTool('ispsoft_get_capabilities', {}));
});

app.get('/api/plc-types', (_req: Request, res: Response) => {
  res.json(executeMcpTool('ispsoft_list_supported_plc_types', {}));
});

app.get('/api/tools', (_req: Request, res: Response) => {
  res.json({
    count: MCP_TOOLS.length,
    tools: getAnnotatedTools(),
  });
});

app.post('/api/tools/:toolName', (req: Request, res: Response) => {
  const toolName = String(req.params.toolName);
  const exists = Boolean(getToolDef(toolName));
  if (!exists) {
    res.status(404).json({ success: false, error_code: 'NOT_FOUND', error: `Unknown tool: ${toolName}` });
    return;
  }
  const args = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const t0 = process.hrtime.bigint();
  const output = executeMcpTool(toolName, args);
  const durationMs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000_000) * 1000) / 1000;
  const isError = isToolResultError(output);
  mcpTelemetry.recordToolCall({
    timestamp: new Date().toISOString(),
    request_id: String(res.locals.requestId ?? ''),
    tool: toolName,
    duration_ms: durationMs,
    is_error: isError,
    error_code: isError ? ((output.error_code as ReturnType<typeof classifyToolError>['error_code']) ?? 'INTERNAL_ERROR') : undefined,
  });
  res.json(output);
});

app.get('/api/projects', (req: Request, res: Response) => {
  const searchPath = typeof req.query.search_path === 'string' ? req.query.search_path : '';
  res.json(executeMcpTool('ispsoft_list_projects', { search_path: searchPath }));
});

app.post('/api/projects/upload', (req: Request, res: Response) => {
  try {
    const body = req.body as { filename?: string; content_base64?: string; overwrite?: boolean };
    if (!body.filename || !body.content_base64) {
      res.status(400).json({ success: false, error_code: 'VALIDATION_ERROR', error: 'filename and content_base64 are required' });
      return;
    }
    const target = normalizeVirtualPath(body.filename);
    const data = Buffer.from(body.content_base64, 'base64');
    const saved = writeFileBuffer(target, data, Boolean(body.overwrite));
    res.json({ success: true, path: saved, bytes: data.length, files: listAllFiles() });
  } catch (err) {
    res.status(400).json({ success: false, error_code: 'VALIDATION_ERROR', error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/download', (req: Request, res: Response) => {
  try {
    const filePath = String(req.query.path ?? '');
    const norm = normalizeVirtualPath(filePath);
    const data = readFileBuffer(norm);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.posix.basename(norm)}"`);
    res.send(data);
  } catch (err) {
    res.status(404).json({ success: false, error_code: 'NOT_FOUND', error: err instanceof Error ? err.message : String(err) });
  }
});

// Stubs for Windows-only native IDE / COM hardware endpoints
app.all(['/api/ide/*', '/api/serial-ports', '/api/commgr/drivers'], (_req: Request, res: Response) => {
  res.status(501).json({ error_code: 'HARDWARE_NOT_QUALIFIED', error: 'Not yet migrated (requires Windows ISPSoft desktop runtime)' });
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = Number(process.env.PORT || 3000);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`ISPSoft MCP Agent Server listening on http://0.0.0.0:${port}`);
  });

  const gracefulShutdown = (signal: string) => {
    const closedSims = shutdownAllSimulators();
    console.log(`Received ${signal}: closed ${closedSims} simulator session(s), shutting down HTTP server...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
