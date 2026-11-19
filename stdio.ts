#!/usr/bin/env node
import crypto from 'node:crypto';
import { buildStandardizedError } from './src/ispsoft/mcpProtocol.js';
import { MAX_RPC_BATCH_SIZE, RpcMessage, handleSingleRpc } from './src/ispsoft/mcpServer.js';
import { shutdownAllSimulators } from './src/ispsoft/simulator.js';
import { seedDefaultWorkspace } from './src/ispsoft/workspace.js';

seedDefaultWorkspace();

const MAX_STDIO_BUFFER_BYTES = 20 * 1024 * 1024;
const MAX_CONTENT_LENGTH_BYTES = 16 * 1024 * 1024;
let buffer = Buffer.alloc(0);

function writeMessage(payload: Record<string, unknown> | Record<string, unknown>[]): void {
  try {
    if (!process.stdout.destroyed && process.stdout.writable) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    }
  } catch {
    // Ignore EPIPE / closed stdout during client teardown
  }
}

function emitFramingError(code: number, errorCode: 'PROTOCOL_PARSE_ERROR' | 'PROTOCOL_INVALID_REQUEST' | 'RESOURCE_LIMIT', message: string): void {
  const reqId = crypto.randomUUID();
  writeMessage({
    jsonrpc: '2.0',
    id: null,
    error: {
      code,
      message,
      data: buildStandardizedError({
        error_code: errorCode,
        domain: errorCode === 'RESOURCE_LIMIT' ? 'QUOTA_LIMIT' : 'MCP_PROTOCOL',
        severity: 'ERROR',
        message,
        retryable: false,
        remediation:
          'Send valid UTF-8 JSON-RPC 2.0 messages framed cleanly as single-line NDJSON or with exact byte Content-Length (<= 16MB).',
        recovery_actions: [
          {
            action: 'FIX_INPUT_PARAMETERS',
            description: 'Ensure the JSON payload parses cleanly and obeys Content-Length and batch limits.',
            automated: true,
            priority: 1,
          },
        ],
        context: { rpc_code: code, transport: 'stdio' },
        request_id: reqId,
      }),
    },
  });
}

function dispatchRawJson(jsonText: string): void {
  const trimmed = jsonText.trim();
  if (!trimmed) return;
  const reqId = crypto.randomUUID();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    emitFramingError(-32700, 'PROTOCOL_PARSE_ERROR', 'Parse error: malformed JSON message');
    return;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      emitFramingError(-32600, 'PROTOCOL_INVALID_REQUEST', 'Invalid empty JSON-RPC batch');
      return;
    }
    if (parsed.length > MAX_RPC_BATCH_SIZE) {
      emitFramingError(
        -32600,
        'RESOURCE_LIMIT',
        `JSON-RPC batch size (${parsed.length}) exceeds maximum allowed (${MAX_RPC_BATCH_SIZE})`,
      );
      return;
    }
    const responses = parsed
      .map((item) => handleSingleRpc(item as RpcMessage, { requestId: reqId }))
      .filter((r) => r.status !== 204 && r.body !== null)
      .map((r) => r.body!);
    if (responses.length > 0) {
      writeMessage(responses);
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
    // Strip leading blank CR/LF bytes so header/NDJSON detection isn't confused by trailing newlines
    let trimIdx = 0;
    while (trimIdx < buffer.length && (buffer[trimIdx] === 0x0a || buffer[trimIdx] === 0x0d)) {
      trimIdx += 1;
    }
    if (trimIdx > 0) {
      buffer = buffer.subarray(trimIdx);
      if (buffer.length === 0) return;
    }

    // Optional LSP-style Content-Length header framing compatibility (with optional extra headers)
    if (/^(?:Content-Length|Content-Type):/i.test(buffer.subarray(0, 32).toString('ascii'))) {
      let sepIdx = buffer.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = buffer.indexOf('\n\n');
        sepLen = 2;
      }
      if (sepIdx === -1) {
        if (buffer.length > 8192) {
          buffer = Buffer.alloc(0);
          emitFramingError(-32700, 'PROTOCOL_PARSE_ERROR', 'Malformed or unterminated Content-Length header block');
        }
        return;
      }
      const headerBlock = buffer.subarray(0, sepIdx).toString('utf8');
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(headerBlock);
      const headerByteLen = sepIdx + sepLen;
      if (!lenMatch) {
        buffer = buffer.subarray(headerByteLen);
        emitFramingError(-32700, 'PROTOCOL_PARSE_ERROR', 'Header block missing valid numeric Content-Length');
        continue;
      }
      const contentLen = parseInt(lenMatch[1], 10);
      if (!Number.isSafeInteger(contentLen) || contentLen < 0 || contentLen > MAX_CONTENT_LENGTH_BYTES) {
        buffer = Buffer.alloc(0);
        emitFramingError(
          -32700,
          'RESOURCE_LIMIT',
          `Content-Length (${lenMatch[1]}) exceeds maximum allowed message size (${MAX_CONTENT_LENGTH_BYTES} bytes)`,
        );
        return;
      }
      if (buffer.length < headerByteLen + contentLen) {
        return;
      }
      const bodyStr = buffer.subarray(headerByteLen, headerByteLen + contentLen).toString('utf8');
      buffer = buffer.subarray(headerByteLen + contentLen);
      dispatchRawJson(bodyStr);
      continue;
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

const cleanupAndExit = () => {
  shutdownAllSimulators();
  process.exit(0);
};

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    cleanupAndExit();
  }
});

process.stdin.on('data', (chunk: Buffer) => {
  if (buffer.length + chunk.length > MAX_STDIO_BUFFER_BYTES) {
    buffer = Buffer.alloc(0);
    emitFramingError(
      -32700,
      'RESOURCE_LIMIT',
      `Stdio input buffer exceeded maximum limit (${MAX_STDIO_BUFFER_BYTES} bytes)`,
    );
    return;
  }
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  if (buffer.length > 0) {
    dispatchRawJson(buffer.toString('utf8'));
    buffer = Buffer.alloc(0);
  }
  cleanupAndExit();
});
process.on('SIGTERM', cleanupAndExit);
process.on('SIGINT', cleanupAndExit);
