#!/usr/bin/env node
import crypto from 'node:crypto';
import { buildStandardizedError } from './src/ispsoft/mcpProtocol.js';
import { RpcMessage, handleSingleRpc } from './src/ispsoft/mcpServer.js';
import { shutdownAllSimulators } from './src/ispsoft/simulator.js';
import { seedDefaultWorkspace } from './src/ispsoft/workspace.js';

seedDefaultWorkspace();

let buffer = Buffer.alloc(0);

function writeMessage(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function dispatchRawJson(jsonText: string): void {
  const trimmed = jsonText.trim();
  if (!trimmed) return;
  const reqId = crypto.randomUUID();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const message = 'Parse error: malformed JSON message';
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message,
        data: buildStandardizedError({
          error_code: 'PROTOCOL_PARSE_ERROR',
          domain: 'MCP_PROTOCOL',
          severity: 'ERROR',
          message,
          retryable: false,
          remediation: 'Send valid UTF-8 JSON-RPC 2.0 messages framed cleanly as single-line NDJSON or with exact byte Content-Length.',
          recovery_actions: [
            {
              action: 'FIX_INPUT_PARAMETERS',
              description: 'Ensure the JSON payload parses cleanly and matches Content-Length byte size if framed.',
              automated: true,
              priority: 1,
            },
          ],
          context: { rpc_code: -32700, transport: 'stdio' },
          request_id: reqId,
        }),
      },
    });
    return;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      const message = 'Invalid empty JSON-RPC batch';
      writeMessage({
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
            remediation: 'Send at least one JSON-RPC 2.0 request inside a batch array.',
            recovery_actions: [
              {
                action: 'FIX_INPUT_PARAMETERS',
                description: 'Send a single JSON-RPC object or a non-empty array of JSON-RPC requests.',
                automated: true,
                priority: 1,
              },
            ],
            context: { rpc_code: -32600, transport: 'stdio' },
            request_id: reqId,
          }),
        },
      });
      return;
    }
    const responses = parsed
      .map((item) => handleSingleRpc(item as RpcMessage, { requestId: reqId }))
      .filter((r) => r.status !== 204 && r.body !== null)
      .map((r) => r.body!);
    if (responses.length > 0) {
      process.stdout.write(JSON.stringify(responses) + '\n');
    }
    return;
  }

  const outcome = handleSingleRpc(parsed as RpcMessage, { requestId: reqId });
  if (outcome.status !== 204 && outcome.body !== null) {
    writeMessage(outcome.body);
  }
}

function processBuffer(): void {
  while (buffer.length > 0) {
    // Optional LSP-style Content-Length header framing compatibility (with optional extra headers)
    if (/^(?:Content-Length|Content-Type):/i.test(buffer.subarray(0, 32).toString('ascii'))) {
      let sepIdx = buffer.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = buffer.indexOf('\n\n');
        sepLen = 2;
      }
      if (sepIdx === -1) {
        return;
      }
      const headerBlock = buffer.subarray(0, sepIdx).toString('utf8');
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(headerBlock);
      if (lenMatch) {
        const headerByteLen = sepIdx + sepLen;
        const contentLen = parseInt(lenMatch[1], 10);
        if (buffer.length < headerByteLen + contentLen) {
          return;
        }
        const bodyStr = buffer.subarray(headerByteLen, headerByteLen + contentLen).toString('utf8');
        buffer = buffer.subarray(headerByteLen + contentLen);
        dispatchRawJson(bodyStr);
        continue;
      }
    }

    // Standard MCP newline-delimited JSON-RPC framing
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) {
      return;
    }
    const line = buffer.subarray(0, nl).toString('utf8').replace(/\r$/, '');
    buffer = buffer.subarray(nl + 1);
    dispatchRawJson(line);
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

const cleanupAndExit = () => {
  shutdownAllSimulators();
  process.exit(0);
};

process.stdin.on('end', () => {
  if (buffer.length > 0) {
    dispatchRawJson(buffer.toString('utf8'));
    buffer = Buffer.alloc(0);
  }
  cleanupAndExit();
});
process.on('SIGTERM', cleanupAndExit);
process.on('SIGINT', cleanupAndExit);
