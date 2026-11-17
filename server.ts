import express, { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, executeMcpTool } from './src/ispsoft/tools.js';
import {
  listAllFiles,
  normalizeVirtualPath,
  readFileBuffer,
  seedDefaultWorkspace,
  writeFileBuffer,
} from './src/ispsoft/workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

seedDefaultWorkspace();

const app = express();
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===========================================================================
// MCP JSON-RPC 2.0 Streamable HTTP Endpoint (/mcp) & Agent Discovery
// ===========================================================================
app.get(['/mcp', '/.well-known/mcp.json'], (_req: Request, res: Response) => {
  res.json({
    protocol: 'mcp',
    protocolVersion: '2025-03-26',
    transport: 'streamable-http-jsonrpc',
    endpoint: '/mcp',
    serverInfo: {
      name: 'ispsoft',
      version: '1.0.0',
      description: 'AI-agent-first Delta ISPSoft MCP Server (authoring, LD/ST/IL editing, static check, Soft-PLC simulator & online monitor, Modbus mapping)',
    },
    toolCount: MCP_TOOLS.length,
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      category: t.category,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
});

function handleSingleRpc(msg: {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const id = msg.id ?? null;
  if (!msg || typeof msg !== 'object' || !msg.method) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } },
    };
  }
  if (msg.method.startsWith('notifications/')) {
    return { status: 204, body: null };
  }
  if (msg.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (msg.method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'ispsoft',
            version: '1.0.0',
          },
        },
      },
    };
  }
  if (msg.method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      },
    };
  }
  if (msg.method === 'resources/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { resources: [] } } };
  }
  if (msg.method === 'prompts/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { prompts: [] } } };
  }
  if (msg.method === 'tools/call') {
    const params = msg.params ?? {};
    const toolName = String(params.name ?? '');
    const args = (params.arguments as Record<string, unknown>) ?? {};
    const found = MCP_TOOLS.find((t) => t.name === toolName);
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
    const output = executeMcpTool(toolName, args);
    const failStatuses = new Set([
      'REJECTED_BEFORE_WRITE',
      'WRITE_FAILED',
      'UNSUPPORTED_MODEL',
      'MODEL_NOT_QUALIFIED',
      'REJECTED_BEFORE_IO',
      'BLOCKED',
      'CANDIDATE_FAILED',
      'CREATE_FAILED',
    ]);
    const isError =
      output.success === false ||
      output.valid === false ||
      failStatuses.has(String(output.status ?? ''));
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
          isError,
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
  if (Array.isArray(req.body)) {
    const responses = req.body
      .map((item) => handleSingleRpc(item))
      .filter((r) => r.status !== 204 && r.body !== null)
      .map((r) => r.body);
    if (!responses.length) {
      res.status(204).end();
      return;
    }
    res.json(responses);
    return;
  }
  const outcome = handleSingleRpc(req.body);
  if (outcome.status === 204 || outcome.body === null) {
    res.status(204).end();
    return;
  }
  res.status(outcome.status).json(outcome.body);
});

// ===========================================================================
// REST API Routes for Agents & Tooling
// ===========================================================================
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, server: 'ispsoft', tools: MCP_TOOLS.length });
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
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      category: t.category,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
});

app.post('/api/tools/:toolName', (req: Request, res: Response) => {
  const toolName = String(req.params.toolName);
  const exists = MCP_TOOLS.some((t) => t.name === toolName);
  if (!exists) {
    res.status(404).json({ success: false, error: `Unknown tool: ${toolName}` });
    return;
  }
  const args = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  res.json(executeMcpTool(toolName, args));
});

app.get('/api/projects', (req: Request, res: Response) => {
  const searchPath = typeof req.query.search_path === 'string' ? req.query.search_path : '';
  res.json(executeMcpTool('ispsoft_list_projects', { search_path: searchPath }));
});

app.post('/api/projects/upload', (req: Request, res: Response) => {
  try {
    const body = req.body as { filename?: string; content_base64?: string; overwrite?: boolean };
    if (!body.filename || !body.content_base64) {
      res.status(400).json({ success: false, error: 'filename and content_base64 are required' });
      return;
    }
    const target = normalizeVirtualPath(body.filename);
    const data = Buffer.from(body.content_base64, 'base64');
    const saved = writeFileBuffer(target, data, Boolean(body.overwrite));
    res.json({ success: true, path: saved, bytes: data.length, files: listAllFiles() });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
    res.status(404).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Stubs for Windows-only native IDE / COM hardware endpoints
app.all(['/api/ide/*', '/api/serial-ports', '/api/commgr/drivers'], (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not yet migrated (requires Windows ISPSoft desktop runtime)' });
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`ISPSoft MCP Agent Server listening on http://0.0.0.0:${port}`);
});
