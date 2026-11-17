import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyToolError, mcpIdempotency, mcpTelemetry } from './src/ispsoft/mcpProtocol.js';
import {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  handleSingleRpc,
  mcpSessions,
  pruneMcpSessions,
} from './src/ispsoft/mcpServer.js';
import { listSimulatorSessions, shutdownAllSimulators } from './src/ispsoft/simulator.js';
import { MCP_TOOLS, executeMcpTool, getAnnotatedTools, getToolDef, isToolResultError } from './src/ispsoft/tools.js';
import {
  getWorkspaceStorageStats,
  listAllFiles,
  normalizeVirtualPath,
  readFileBuffer,
  seedDefaultWorkspace,
  writeFileBuffer,
} from './src/ispsoft/workspace.js';

const __filename = fileURLToPath(import.meta.url);

seedDefaultWorkspace();

export const app = express();

// Request ID, CORS, and MCP HTTP headers (pure headless API server, no UI)
app.use((req: Request, res: Response, next: NextFunction) => {
  const reqId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()) || crypto.randomUUID();
  res.locals.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Idempotency-Key, X-Request-Id',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, X-Request-Id');
  res.setHeader('Cache-Control', 'no-store');
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
  if (
    req.path === '/' ||
    req.path === '/.well-known/mcp.json' ||
    req.path === '/api/health' ||
    req.path === '/api/ready' ||
    (!req.path.startsWith('/mcp') && !req.path.startsWith('/api/'))
  ) {
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

// ===========================================================================
// Pure JSON Agent Entrypoint & MCP Streamable HTTP Transport (/mcp)
// ===========================================================================
function buildServerManifest(req: Request) {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3000').split(',')[0].trim();
  const mcpUrl = `${proto}://${host}/mcp`;

  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    mode: 'headless-agent-only',
    protocol: 'mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transports: ['streamable-http', 'sse', 'stdio'],
    endpoint: '/mcp',
    endpoints: {
      mcp_http: mcpUrl,
      mcp_discovery: '/.well-known/mcp.json',
      health: '/api/health',
      ready: '/api/ready',
      metrics: '/api/metrics',
      tools: '/api/tools',
    },
    client_configs: {
      vscode_mcp_json: {
        servers: {
          ispsoft: {
            type: 'http',
            url: mcpUrl,
          },
        },
      },
      google_antigravity_mcp_config: {
        mcpServers: {
          ispsoft: {
            serverUrl: mcpUrl,
          },
        },
      },
      local_stdio: {
        command: 'npx',
        args: ['--yes', 'tsx', 'stdio.ts'],
      },
    },
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
    },
    toolCount: MCP_TOOLS.length,
  };
}

app.get('/', (req: Request, res: Response) => {
  res.json(buildServerManifest(req));
});

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
    const cleanup = () => clearInterval(heartbeat);
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  res.json({
    ...buildServerManifest(req),
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
// Headless REST API Routes for Agents, Probes & Metrics
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
  pruneMcpSessions();
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

// Ensure unknown endpoints always return pure JSON (never Express HTML 404/500 pages)
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error_code: 'NOT_FOUND',
    error: `Unknown endpoint: ${req.method} ${req.path}`,
    endpoints: { mcp: '/mcp', discovery: '/.well-known/mcp.json', health: '/api/health', manifest: '/' },
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    success: false,
    error_code: 'INTERNAL_ERROR',
    error: err instanceof Error ? err.message : String(err),
  });
});

const port = Number(process.env.PORT || 3000);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`ISPSoft Headless MCP Server listening on http://0.0.0.0:${port} (HTTP/SSE /mcp + stdio.ts)`);
  });

  const gracefulShutdown = (signal: string) => {
    const closedSims = shutdownAllSimulators();
    console.log(`Received ${signal}: closed ${closedSims} simulator session(s), shutting down HTTP server...`);
    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
