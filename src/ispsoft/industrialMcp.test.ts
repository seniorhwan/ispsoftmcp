import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSafeNumericExpr } from './safeExpr.js';
import {
  ISPSOFT_ERROR_JSON_SCHEMA,
  IdempotencyCache,
  McpTelemetryTracker,
  classifyToolError,
  deriveToolAnnotations,
  sanitizeJsonValue,
  validateStandardizedError,
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

test('all MCP_TOOLS have consistent schemas, annotations, and bounded validation', async () => {
  const { MCP_TOOLS, executeMcpTool, getAnnotatedTools } = await import('./tools.js');
  const seen = new Set<string>();
  const annotated = getAnnotatedTools();
  assert.equal(annotated.length, MCP_TOOLS.length);

  for (const t of annotated) {
    assert.ok(!seen.has(t.name), `Duplicate tool name: ${t.name}`);
    seen.add(t.name);
    assert.equal(t.inputSchema.type, 'object', `${t.name} must have object inputSchema`);
    const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    const req = Array.isArray(t.inputSchema.required) ? t.inputSchema.required : [];
    for (const r of req) {
      assert.ok(r in props, `${t.name} required field '${r}' missing from properties`);
    }
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
    assert.equal(typeof t.annotations.destructiveHint, 'boolean');
    assert.equal(typeof t.annotations.idempotentHint, 'boolean');
    assert.equal(typeof t.annotations.openWorldHint, 'boolean');
  }

  const compileTool = annotated.find((t) => t.name === 'ispsoft_compile_and_check');
  const analyzeTool = annotated.find((t) => t.name === 'ispsoft_analyze_source');
  assert.equal(compileTool?.annotations.readOnlyHint, true);
  assert.equal(analyzeTool?.annotations.readOnlyHint, true);

  const badDiag = executeMcpTool('ispsoft_sim_diagnostics', { session_id: 'sim-1', sample_cycles: -5, slow_threshold_ms: 0 });
  assert.equal(badDiag.success, false);
  assert.equal(badDiag.error_code, 'VALIDATION_ERROR');

  const delMissing = executeMcpTool('ispsoft_manage_workspace_files', { action: 'delete', path: '/workspace/does_not_exist_12345.isp' });
  assert.equal(delMissing.success, false);
  assert.equal(delMissing.error_code, 'NOT_FOUND');

  // Strict schema compliance across all 78 AI-agent tools (Gemini / Google Antigravity / OpenAI / VS Code)
  assert.equal(annotated.length, 78);
  const walkSchema = (node: Record<string, unknown>, loc: string) => {
    assert.ok(!Array.isArray(node.type), `${loc}: type must not be an array`);
    if (node.type === 'array') {
      assert.ok(node.items && typeof node.items === 'object', `${loc}: array must define items`);
      walkSchema(node.items as Record<string, unknown>, `${loc}.items`);
    }
    if (node.type === 'object') {
      assert.ok(
        node.properties !== undefined || (node.additionalProperties !== undefined && node.additionalProperties !== true),
        `${loc}: object must define properties or typed additionalProperties`,
      );
      if (node.properties && typeof node.properties === 'object') {
        for (const [k, v] of Object.entries(node.properties as Record<string, Record<string, unknown>>)) {
          walkSchema(v, `${loc}.properties.${k}`);
        }
      }
    }
  };
  for (const t of annotated) {
    walkSchema(t.inputSchema, t.name);
  }
});

test('ispsoft_manage_workspace_files supports pure-MCP list, upload_base64, download_base64, and delete', async () => {
  const { executeMcpTool } = await import('./tools.js');
  const prevWorkDir = process.env.ISPSOFT_WORK_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-b64-test-'));
  try {
    process.env.ISPSOFT_WORK_DIR = tmpDir;
    resetWorkspaceMemoryCacheForTests();
    seedDefaultWorkspace();

    const samplePayload = Buffer.from('DELTA_BINARY_PAYLOAD_123', 'utf8');
    const up = executeMcpTool('ispsoft_manage_workspace_files', {
      action: 'upload_base64',
      path: '/workspace/mcp_uploaded.bin',
      content_base64: samplePayload.toString('base64'),
    });
    assert.equal(up.success, true);
    assert.equal(up.path, '/workspace/mcp_uploaded.bin');

    const listed = executeMcpTool('ispsoft_manage_workspace_files', { action: 'list' });
    assert.equal(listed.success, true);
    assert.ok((listed.files as string[]).includes('/workspace/mcp_uploaded.bin'));

    const dl = executeMcpTool('ispsoft_manage_workspace_files', {
      action: 'download_base64',
      path: '/workspace/mcp_uploaded.bin',
    });
    assert.equal(dl.success, true);
    assert.equal(Buffer.from(String(dl.content_base64), 'base64').toString('utf8'), 'DELTA_BINARY_PAYLOAD_123');

    const del = executeMcpTool('ispsoft_manage_workspace_files', {
      action: 'delete',
      path: '/workspace/mcp_uploaded.bin',
    });
    assert.equal(del.success, true);
    assert.equal(del.deleted, true);
  } finally {
    resetWorkspaceMemoryCacheForTests();
    if (prevWorkDir === undefined) delete process.env.ISPSOFT_WORK_DIR;
    else process.env.ISPSOFT_WORK_DIR = prevWorkDir;
    seedDefaultWorkspace();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('handleSingleRpc negotiates MCP protocol versions, reads resources/completions, and validates params', async () => {
  const { handleSingleRpc } = await import('./mcpServer.js');

  const init24 = handleSingleRpc(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { requestId: 'r1' },
  );
  assert.equal(init24.status, 200);
  const res24 = (init24.body?.result ?? {}) as Record<string, unknown>;
  assert.equal(res24.protocolVersion, '2024-11-05');
  assert.equal(typeof res24.instructions, 'string');

  const init25 = handleSingleRpc(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { requestId: 'r2' },
  );
  assert.equal(((init25.body?.result ?? {}) as Record<string, unknown>).protocolVersion, '2025-03-26');

  const badParams = handleSingleRpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: ['not-an-object'] },
    { requestId: 'r3' },
  );
  assert.equal((badParams.body?.error as Record<string, unknown>)?.code, -32602);

  const telemetryRes = handleSingleRpc(
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ispsoft://telemetry' } },
    { requestId: 'r4' },
  );
  const tContents = ((telemetryRes.body?.result as Record<string, unknown>)?.contents as Array<Record<string, unknown>>) ?? [];
  assert.equal(tContents.length, 1);

  const bundleRes = handleSingleRpc(
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ispsoft://projects/sample_es2.isp/bundle' } },
    { requestId: 'r5' },
  );
  const bContents = ((bundleRes.body?.result as Record<string, unknown>)?.contents as Array<Record<string, unknown>>) ?? [];
  assert.equal(bContents.length, 1);

  const compRes = handleSingleRpc(
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'completion/complete',
      params: { ref: { type: 'ref/prompt', name: 'audit_and_optimize_plc' }, argument: { name: 'project_path', value: 'sample' } },
    },
    { requestId: 'r6' },
  );
  const values = (((compRes.body?.result as Record<string, unknown>)?.completion as Record<string, unknown>)?.values as string[]) ?? [];
  assert.ok(values.some((v) => v.includes('sample_es2.isp')));
});

test('stdio.ts handles NDJSON + multi-header Content-Length framing and clean simulator workflow', async () => {
  const { spawn } = await import('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-stdio-e2e-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'stdio.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ISPSOFT_WORK_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'antigravity-test', version: '1.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ispsoft_doctor', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ispsoft_sim_start', arguments: { project_path: '/workspace/sample_es2.isp' } } },
    ];
    for (const m of msgs) {
      child.stdin.write(JSON.stringify(m) + '\n');
    }

    // Wait for first 4 responses (notification produces no response)
    const waitForLines = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const lines = stdoutBuf.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length >= count) return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`Timed out waiting for ${count} stdio JSON-RPC responses; got stdout=${stdoutBuf} stderr=${stderrBuf}`);
    };

    const batch1 = await waitForLines(4);
    assert.equal(batch1[0].id, 1);
    const listedTools = ((batch1[1].result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
    assert.equal(listedTools.length, 78);

    const simStartOut = JSON.parse(
      String((((batch1[3].result as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]).text),
    ) as Record<string, unknown>;
    assert.equal(simStartOut.success, true);
    const sid = String(simStartOut.session_id);

    // Send sim diagnostics + close via NDJSON, plus ping via Content-Length framing
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'ispsoft_sim_diagnostics', arguments: { session_id: sid, sample_cycles: 3 } },
      }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'ispsoft_sim_control', arguments: { session_id: sid, command: 'CLOSE' } },
      }) + '\n',
    );
    const pingBody = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    child.stdin.write(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(pingBody, 'utf8')}\r\n\r\n${pingBody}`,
    );

    const batch2 = await waitForLines(7);
    assert.equal(batch2[4].id, 5);
    assert.equal(batch2[5].id, 6);
    assert.equal(batch2[6].id, 7);
    assert.deepEqual(batch2[6].result, {});

    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(exitCode, 0);
    assert.equal(stderrBuf.trim(), '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('simulator evaluates ==, <>, nested arrays, CASE multi-ranges, radix literals, and zero-scan diagnostics cleanly', async () => {
  const { executeMcpTool } = await import('./tools.js');
  const prevWorkDir = process.env.ISPSOFT_WORK_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-sim-edge-'));
  let simId = '';
  try {
    process.env.ISPSOFT_WORK_DIR = tmpDir;
    resetWorkspaceMemoryCacheForTests();
    seedDefaultWorkspace();

    const imported = executeMcpTool('ispsoft_import_project_bundle', {
      output_path: '/workspace/edge_case_test.isp',
      bundle: {
        model: 'ES2',
        tasks: [{ id: 0, name: 'Main', type: 0, interval_ms: 50, priority: 1, active: true, program: 'EdgeST' }],
        pous: [
          {
            name: 'EdgeST',
            language: 'ST',
            pou_type: 'PRG',
            code: [
              'Idx[0] := 2;',
              'Buf[2] := 16#FF;',
              'D10 := Buf[Idx[0]] + 2#101;',
              'D11 := 10 / 0;',
              'D12 := -5;',
              'D13 := -D12;',
              'CASE D20 OF',
              '  1, 3..5: D21 := 42;',
              '  ELSE D21 := 99;',
              'END_CASE;',
              'IF D10 == 260 AND D13 = 5 THEN',
              '  M0 := TRUE;',
              'END_IF;',
            ].join('\n'),
          },
        ],
      },
    });
    assert.equal(imported.success, true);

    const started = executeMcpTool('ispsoft_sim_start', { project_path: '/workspace/edge_case_test.isp', scan_interval_ms: 50 });
    assert.equal(started.success, true);
    simId = String(started.session_id);

    // 0-scan diagnostics before stepping must succeed cleanly with zero NaN
    const zeroDiag = executeMcpTool('ispsoft_sim_diagnostics', { session_id: simId, sample_cycles: 0 });
    assert.equal(zeroDiag.success, true);
    assert.equal(zeroDiag.health_status, 'OPTIMAL');
    assert.equal((zeroDiag.timing as Record<string, unknown>).scans_profiled, 0);

    const seq = executeMcpTool('ispsoft_sim_run_sequence', {
      session_id: simId,
      steps: [
        {
          label: 'Run with D20=4 matching range 3..5 and == comparison',
          words: { D20: 4 },
          cycles: 1,
          expect: { D10: 260, D11: 0, D13: 5, D21: 42, M0: true },
          assert_expr: 'D10 == 260 AND D21 <> 99 AND -D12 == 5',
        },
      ],
    });
    assert.equal(seq.success, true, JSON.stringify(seq));
  } finally {
    if (simId) executeMcpTool('ispsoft_sim_control', { session_id: simId, command: 'CLOSE' });
    resetWorkspaceMemoryCacheForTests();
    if (prevWorkDir === undefined) delete process.env.ISPSOFT_WORK_DIR;
    else process.env.ISPSOFT_WORK_DIR = prevWorkDir;
    seedDefaultWorkspace();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('all ISPSoft communication, Modbus, OCC, container, simulator, and MCP protocol errors conform to ISPSOFT_ERROR_JSON_SCHEMA with recovery actions', async () => {
  const { executeMcpTool } = await import('./tools.js');
  const { handleSingleRpc } = await import('./mcpServer.js');

  assert.equal(ISPSOFT_ERROR_JSON_SCHEMA.$id, 'ispsoft://schemas/error');

  // 1. Capabilities advertises schema & ispsoft://schemas/error resource is readable
  const caps = executeMcpTool('ispsoft_get_capabilities', {});
  assert.equal((caps.error_schema as Record<string, unknown>).uri, 'ispsoft://schemas/error');
  const schemaRpc = handleSingleRpc(
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ispsoft://schemas/error' } },
    { requestId: 'err-test-1' },
  );
  const schemaText = String((((schemaRpc.body?.result as Record<string, unknown>).contents as Array<Record<string, unknown>>)[0]).text);
  assert.equal(JSON.parse(schemaText).$id, 'ispsoft://schemas/error');

  // 2. Native hardware / COMMGR stub error -> HARDWARE_NOT_QUALIFIED + FALLBACK_TO_SIMULATOR
  const hwErr = executeMcpTool('ispsoft_connect', { project_path: '/workspace/sample_es2.isp' }, 'req-hw');
  assert.equal(hwErr.success, false);
  assert.equal(hwErr.error_code, 'HARDWARE_NOT_QUALIFIED');
  assert.equal(validateStandardizedError(hwErr.error_detail).valid, true);
  assert.equal((hwErr.error_detail as Record<string, unknown>).domain, 'HARDWARE_TRANSPORT');
  const hwActions = ((hwErr.error_detail as Record<string, unknown>).recovery_actions as Array<Record<string, unknown>>);
  assert.equal(hwActions[0].action, 'FALLBACK_TO_SIMULATOR');
  assert.equal(hwActions[0].suggested_tool, 'ispsoft_sim_start');

  // 3. Modbus address error -> MODBUS_ADDRESS_ERROR + FIX_INPUT_PARAMETERS + ispsoft_get_memory_usage_map
  const modErr = executeMcpTool('ispsoft_map_dvp_modbus_addresses', { model: 'ES2', addresses: ['X89'] }, 'req-mod');
  assert.equal(modErr.success, false);
  assert.equal(modErr.error_code, 'MODBUS_ADDRESS_ERROR');
  assert.equal(validateStandardizedError(modErr.error_detail).valid, true);
  assert.equal((modErr.error_detail as Record<string, unknown>).domain, 'MODBUS_COMM');
  const modItem = (modErr.mappings as Array<Record<string, unknown>>)[0];
  assert.equal(modItem.error_code, 'MODBUS_ADDRESS_ERROR');
  assert.equal(validateStandardizedError(modItem.error_detail).valid, true);

  // 4. OCC Hash Mismatch -> CONFLICT_HASH_MISMATCH + REFRESH_STATE_AND_RETRY
  const occErr = executeMcpTool(
    'ispsoft_compile_and_check',
    { project_path: '/workspace/sample_es2.isp', expected_content_hash: 'isp:sha256:stale_hash' },
    'req-occ',
  );
  assert.equal(occErr.success, false);
  assert.equal(occErr.error_code, 'CONFLICT_HASH_MISMATCH');
  assert.equal(validateStandardizedError(occErr.error_detail).valid, true);
  assert.equal((occErr.error_detail as Record<string, unknown>).retryable, true);
  assert.equal(
    (((occErr.error_detail as Record<string, unknown>).recovery_actions as Array<Record<string, unknown>>)[0]).suggested_tool,
    'ispsoft_inspect_project',
  );

  // 5. Validation error on REJECTED_BEFORE_WRITE (must NOT misclassify as CONFLICT_HASH_MISMATCH)
  const ldValErr = executeMcpTool(
    'ispsoft_write_ld_network_candidate',
    { project_path: '/workspace/sample_es2.isp', pou_name: 'Prog0', network_index: 0, il_program: 'LD X0', model: 'ES2' },
    'req-val',
  );
  assert.equal(ldValErr.success, false);
  assert.equal(ldValErr.error_code, 'VALIDATION_ERROR');
  assert.equal(validateStandardizedError(ldValErr.error_detail).valid, true);

  // 6. Security path traversal -> SECURITY_BLOCKED
  const secErr = executeMcpTool('ispsoft_inspect_project', { project_path: '/etc/passwd' }, 'req-sec');
  assert.equal(secErr.success, false);
  assert.equal(secErr.error_code, 'SECURITY_BLOCKED');
  assert.equal(validateStandardizedError(secErr.error_detail).valid, true);

  // 7. Unknown simulator session -> SIM_SESSION_NOT_FOUND
  const simErr = executeMcpTool('ispsoft_sim_monitor', { session_id: 'sim-nonexistent' }, 'req-sim');
  assert.equal(simErr.success, false);
  assert.equal(simErr.error_code, 'SIM_SESSION_NOT_FOUND');
  assert.equal(validateStandardizedError(simErr.error_detail).valid, true);

  // 8. JSON-RPC protocol errors carry standardized error_detail in error.data
  const rpcCases = [
    handleSingleRpc({ jsonrpc: '2.0', id: 10, method: 'unknown/method' }, { requestId: 'rpc-1' }),
    handleSingleRpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'ispsoft_connect' } }, { requestId: 'rpc-2' }),
    handleSingleRpc({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'ispsoft://projects/missing.isp/overview' } }, { requestId: 'rpc-3' }),
    handleSingleRpc({ jsonrpc: '2.0', id: 13, method: '' }, { requestId: 'rpc-4' }),
  ];
  for (const res of rpcCases) {
    const errObj = res.body?.error as Record<string, unknown>;
    assert.ok(errObj && errObj.data, `Expected standardized error.data on RPC error: ${JSON.stringify(res.body)}`);
    const check = validateStandardizedError(errObj.data);
    assert.equal(check.valid, true, `Invalid RPC error_detail: ${check.errors.join(', ')}`);
  }
});
