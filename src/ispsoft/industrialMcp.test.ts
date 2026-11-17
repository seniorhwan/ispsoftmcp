import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSafeNumericExpr } from './safeExpr.js';
import {
  IdempotencyCache,
  McpTelemetryTracker,
  classifyToolError,
  deriveToolAnnotations,
  sanitizeJsonValue,
  validateToolArguments,
} from './mcpProtocol.js';
import {
  getWorkspaceStorageStats,
  normalizeVirtualPath,
  readFileBuffer,
  resetWorkspaceMemoryCacheForTests,
  seedDefaultWorkspace,
  writeFileBuffer,
} from './workspace.js';

test('safeExpr evaluates arithmetic, unary, comparisons, bitwise, logic, and rejects injection', () => {
  assert.equal(evaluateSafeNumericExpr('2 + 3 * 4'), 14);
  assert.equal(evaluateSafeNumericExpr('(2 + 3) * 4'), 20);
  assert.equal(evaluateSafeNumericExpr('10 - -5'), 15);
  assert.equal(evaluateSafeNumericExpr('!0 && (5 >= 5 || 0)'), 1);
  assert.equal(evaluateSafeNumericExpr('10 != 20 && 3 < 4'), 1);
  assert.equal(evaluateSafeNumericExpr('6 & 3'), 2);
  assert.equal(evaluateSafeNumericExpr('5 | 2'), 7);
  assert.equal(evaluateSafeNumericExpr('5 ^ 3'), 6);
  assert.equal(evaluateSafeNumericExpr('10 / 0'), 0);
  assert.equal(evaluateSafeNumericExpr('10 % 0'), 0);
  assert.equal(evaluateSafeNumericExpr('process.exit(1)'), 0);
  assert.equal(evaluateSafeNumericExpr('globalThis.constructor'), 0);
});

test('sanitizeJsonValue strips prototype-pollution keys and blocks deep nesting', () => {
  const polluted = JSON.parse('{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":{"x":2},"ok":"yes"}}');
  const clean = sanitizeJsonValue(polluted) as Record<string, unknown>;
  assert.equal(clean.a, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);
  const nested = clean.nested as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(nested, 'constructor'), false);
  assert.equal(nested.ok, 'yes');

  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => sanitizeJsonValue(deep), /maximum nesting depth/);
});

test('validateToolArguments enforces required, types, enum, and bounds', () => {
  const schema = {
    type: 'object',
    required: ['session_id', 'command'],
    properties: {
      session_id: { type: 'string' },
      command: { type: 'string', enum: ['RUN', 'STOP', 'STEP'] },
      cycles: { type: 'integer', minimum: 1, maximum: 100 },
      addresses: { type: 'array', items: { type: 'string' } },
    },
  };
  assert.equal(validateToolArguments(schema, { session_id: 'sim-1', command: 'STEP', cycles: 5, addresses: ['X0'] }).valid, true);
  const bad = validateToolArguments(schema, { session_id: '', command: 'INVALID', cycles: 1.5, addresses: [123] });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length >= 4);
});

test('deriveToolAnnotations and classifyToolError assign accurate industrial metadata', () => {
  const ro = deriveToolAnnotations('ispsoft_sim_diagnostics');
  assert.equal(ro.readOnlyHint, true);
  assert.equal(ro.destructiveHint, false);

  const mut = deriveToolAnnotations('ispsoft_apply_project_transaction');
  assert.equal(mut.readOnlyHint, false);

  const del = deriveToolAnnotations('ispsoft_manage_workspace_files');
  assert.equal(del.destructiveHint, true);

  assert.equal(classifyToolError({ status: 'REJECTED_BEFORE_WRITE', failure_category: 'state_changed' }).error_code, 'CONFLICT_HASH_MISMATCH');
  assert.equal(classifyToolError({ error: 'Unknown simulator session "sim-99"' }).error_code, 'SIM_SESSION_NOT_FOUND');
  assert.equal(classifyToolError({ status: 'UNSUPPORTED_MODEL', error: 'bad model' }).error_code, 'UNSUPPORTED_MODEL');
});

test('IdempotencyCache replays identical calls and flags mismatched payloads', () => {
  const cache = new IdempotencyCache(10, 60_000);
  assert.equal(cache.get('ispsoft_sim_control', 'k1', { session_id: 'sim-1', command: 'STEP' }).hit, false);
  cache.set('ispsoft_sim_control', 'k1', { session_id: 'sim-1', command: 'STEP' }, { success: true, scan_count: 1 });

  const hit = cache.get('ispsoft_sim_control', 'k1', { session_id: 'sim-1', command: 'STEP' });
  assert.equal(hit.hit, true);
  if (hit.hit) {
    assert.equal(hit.conflict, false);
    assert.equal(hit.response?.scan_count, 1);
  }

  const conflict = cache.get('ispsoft_sim_control', 'k1', { session_id: 'sim-1', command: 'STOP' });
  assert.equal(conflict.hit, true);
  if (conflict.hit) assert.equal(conflict.conflict, true);
});

test('McpTelemetryTracker computes stats and Prometheus metrics text', () => {
  const t = new McpTelemetryTracker();
  t.recordRpcRequest();
  t.recordToolCall({ timestamp: new Date().toISOString(), request_id: 'r1', tool: 'ispsoft_doctor', duration_ms: 2.5, is_error: false });
  t.recordToolCall({ timestamp: new Date().toISOString(), request_id: 'r2', tool: 'ispsoft_sim_start', duration_ms: 10, is_error: true, error_code: 'NOT_FOUND' });
  const sum = t.getSummary();
  assert.equal(sum.totals.tool_calls, 2);
  assert.equal(sum.totals.tool_errors, 1);
  const prom = t.toPrometheusText({ active_simulators: 1 });
  assert.ok(prom.includes('ispsoft_mcp_tool_calls_total 2'));
  assert.ok(prom.includes('ispsoft_mcp_active_simulators 1'));
});

test('workspace persists files atomically to disk across cache resets and blocks path traversal', () => {
  const prevWorkDir = process.env.ISPSOFT_WORK_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-ws-test-'));
  try {
    process.env.ISPSOFT_WORK_DIR = tmpDir;
    resetWorkspaceMemoryCacheForTests();
    seedDefaultWorkspace();

    assert.throws(() => normalizeVirtualPath('/etc/passwd'), /must reside inside/);
    assert.throws(() => normalizeVirtualPath('../outside.isp'), /Invalid path traversal|must reside inside/);

    const payload = Buffer.from('PERSISTENCE_TEST_PAYLOAD', 'utf8');
    writeFileBuffer('/workspace/persisted_test.isp', payload, false);
    assert.ok(fs.existsSync(path.join(tmpDir, 'persisted_test.isp')));

    // Simulate process restart by wiping RAM cache and reloading from disk
    resetWorkspaceMemoryCacheForTests();
    seedDefaultWorkspace();
    const readBack = readFileBuffer('/workspace/persisted_test.isp');
    assert.equal(readBack.toString('utf8'), 'PERSISTENCE_TEST_PAYLOAD');
    assert.ok(getWorkspaceStorageStats().file_count >= 4);
  } finally {
    resetWorkspaceMemoryCacheForTests();
    if (prevWorkDir === undefined) delete process.env.ISPSOFT_WORK_DIR;
    else process.env.ISPSOFT_WORK_DIR = prevWorkDir;
    seedDefaultWorkspace();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
