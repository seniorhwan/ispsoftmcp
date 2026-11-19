import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { decodeContainer, inspectContainer } from './containers.js';
import { FileTransformError, budgetPayload, encodeCodepage } from './limits.js';
import { IdempotencyCache, validateToolArguments } from './mcpProtocol.js';
import { handleSingleRpc } from './mcpServer.js';
import { compileSymbolicStExpr, evaluateSafeNumericExpr, evaluateSymbolicStAst } from './safeExpr.js';
import { topologicalSortFbd, validateFbdDiagram, validateSfcChart } from './sfcFbd.js';
import { executeMcpTool as invokeTool, getAnnotatedTools } from './tools.js';
import {
  deleteWorkspaceFile,
  getWorkspaceStorageStats,
  listAllFiles,
  readFileBuffer,
  resetWorkspaceMemoryCacheForTests,
  writeFileBuffer,
} from './workspace.js';

function withIsolatedWorkspace(fn: (tmpDir: string) => Promise<void> | void): Promise<void> | void {
  const prevWorkDir = process.env.ISPSOFT_WORK_DIR;
  const prevWrites = process.env.ISPSOFT_WRITES_ENABLED;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispsoft-hardening-'));
  process.env.ISPSOFT_WORK_DIR = tmpDir;
  process.env.ISPSOFT_WRITES_ENABLED = 'true';
  resetWorkspaceMemoryCacheForTests();

  const cleanup = () => {
    if (prevWorkDir === undefined) delete process.env.ISPSOFT_WORK_DIR;
    else process.env.ISPSOFT_WORK_DIR = prevWorkDir;
    if (prevWrites === undefined) delete process.env.ISPSOFT_WRITES_ENABLED;
    else process.env.ISPSOFT_WRITES_ENABLED = prevWrites;
    resetWorkspaceMemoryCacheForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    const out = fn(tmpDir);
    if (out && typeof (out as Promise<void>).then === 'function') {
      return (out as Promise<void>).finally(cleanup);
    }
    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

// =============================================================================
// 1. safeExpr: stack-overflow & expression-length DoS hardening
// =============================================================================
test('safeExpr blocks deeply nested parens, deep unary chains, and >8192 char DoS without stack overflow', () => {
  const deepParens = '('.repeat(400) + '42' + ')'.repeat(400);
  assert.equal(evaluateSafeNumericExpr(deepParens), 0);

  const deepUnary = '!'.repeat(300) + '1';
  assert.equal(evaluateSafeNumericExpr(deepUnary), 0);

  const hugeExpr = '1 + '.repeat(3000) + '1';
  assert.ok(hugeExpr.length > 8192);
  assert.equal(evaluateSafeNumericExpr(hugeExpr), 0);

  // Normal expressions still evaluate accurately
  assert.equal(evaluateSafeNumericExpr('((10 + 5) * 2) - 4'), 26);
});

// =============================================================================
// 2. limits.ts: encodeCodepage integrity & budgetPayload nested/base64 behavior
// =============================================================================
test('encodeCodepage rejects non-ASCII in unsupported multibyte codepages; budgetPayload preserves base64 and bounds nested arrays/objects', () => {
  assert.throws(
    () => encodeCodepage('中文注释', 'cp936'),
    (err: unknown) => err instanceof FileTransformError,
  );
  // ASCII in cp936 still succeeds cleanly
  assert.equal(encodeCodepage('ASCII_OK', 'cp936').toString('ascii'), 'ASCII_OK');

  // budgetPayload allows base64 payloads up to total response budget without silent corruption
  const bigB64 = 'A'.repeat(100_000);
  const b64Budgeted = budgetPayload({ success: true, content_base64: bigB64 }, 60_000, 180_000);
  assert.equal(b64Budgeted.content_base64, bigB64);

  // budgetPayload bounds oversized nested arrays/objects cleanly within maxResponseChars
  const hugeList = Array.from({ length: 5000 }, (_, i) => ({ idx: i, text: 'X'.repeat(40) }));
  const bounded = budgetPayload({ success: true, items: hugeList }, 10_000, 12_000);
  assert.ok(JSON.stringify(bounded).length <= 12_000);
  const itemsField = bounded.items as Record<string, unknown>;
  assert.ok(itemsField._truncated === true || itemsField._omitted === true);
});

// =============================================================================
// 3. mcpProtocol.ts: canonical IdempotencyCache & recursive validateToolArguments
// =============================================================================
test('IdempotencyCache canonicalizes key order and isolates mutations; validateToolArguments checks nested schemas and null', () => {
  const cache = new IdempotencyCache(60_000);
  const originalResp = { success: true, nested: { count: 1 } };
  cache.set('k1', 'tool_x', { a: 1, b: { y: 2, x: 3 } }, originalResp);

  // Mutating caller object after set must not corrupt cache
  originalResp.nested.count = 999;

  // Equivalent payload with reordered keys must replay cleanly without conflict
  const hit = cache.get('k1', 'tool_x', { b: { x: 3, y: 2 }, a: 1 });
  assert.equal(hit.hit, true);
  assert.equal(hit.conflict, false);
  assert.equal((hit.response as { nested: { count: number } }).nested.count, 1);

  // Mutating returned replay object must not corrupt subsequent replays
  (hit.response as { nested: { count: number } }).nested.count = 777;
  const hit2 = cache.get('k1', 'tool_x', { a: 1, b: { x: 3, y: 2 } });
  assert.equal(hit2.hit, true);
  if (hit2.hit) {
    assert.equal((hit2.response as { nested: { count: number } }).nested.count, 1);
  }

  // Recursive schema validation
  const schema = {
    type: 'object',
    required: ['name', 'config', 'items'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 10 },
      config: {
        type: 'object',
        required: ['port'],
        properties: {
          port: { type: 'integer', minimum: 1, maximum: 65535 },
        },
      },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', minLength: 1 },
      },
    },
  };

  assert.equal(validateToolArguments(schema, { name: 'ok', config: { port: 502 }, items: ['a'] }).valid, true);
  assert.equal(validateToolArguments(schema, { name: null, config: { port: 502 }, items: ['a'] }).valid, false);
  assert.equal(validateToolArguments(schema, { name: 'a', config: { port: 502 }, items: ['a'] }).valid, false);
  assert.equal(validateToolArguments(schema, { name: 'ok', config: { port: 99999 }, items: ['a'] }).valid, false);
  assert.equal(validateToolArguments(schema, { name: 'ok', config: {}, items: ['a'] }).valid, false);
  assert.equal(validateToolArguments(schema, { name: 'ok', config: { port: 502 }, items: [] }).valid, false);
  assert.equal(validateToolArguments(schema, { name: 'ok', config: { port: 502 }, items: ['a', 123] }).valid, false);
});

// =============================================================================
// 4. Workspace persistence: root protection, strict base64, chunked download, no resurrection
// =============================================================================
test('workspace blocks root writes/deletes, rejects bad base64, supports chunked download, and never resurrects deleted sample', async () => {
  await withIsolatedWorkspace(async () => {
    // Root directory write/delete must throw FileTransformError (never EISDIR)
    assert.throws(
      () => writeFileBuffer('/workspace', Buffer.from('nope')),
      (err: unknown) => err instanceof FileTransformError,
    );
    assert.throws(
      () => deleteWorkspaceFile('/workspace'),
      (err: unknown) => err instanceof FileTransformError,
    );

    // Invalid base64 rejected cleanly
    const badUp = invokeTool('ispsoft_manage_workspace_files', {
      action: 'upload_base64',
      path: '/workspace/bad.isp',
      content_base64: '!!!not-valid-base64!!!',
    });
    assert.equal(badUp.success, false);

    // Create a project and reconstruct it via chunked download_base64
    const created = invokeTool('ispsoft_create_blank_project', {
      model: 'ES2',
      output_path: '/workspace/chunk_test.isp',
    });
    assert.equal(created.success, true, `create_blank_project failed: ${JSON.stringify(created)}`);

    const chunks: Buffer[] = [];
    let offset = 0;
    let loops = 0;
    while (true) {
      loops++;
      assert.ok(loops < 100, 'Chunked download loop exceeded safety cap');
      const dl = invokeTool('ispsoft_manage_workspace_files', {
        action: 'download_base64',
        path: '/workspace/chunk_test.isp',
        offset_bytes: offset,
        max_bytes: 256,
      });
      assert.equal(dl.success, true, `download_base64 failed: ${JSON.stringify(dl)}`);
      chunks.push(Buffer.from(String(dl.content_base64), 'base64'));
      if (!dl.has_more) break;
      offset = Number(dl.next_offset);
    }
    assert.ok(loops >= 2, 'Expected multiple chunks at 256 bytes');
    const reconstructed = Buffer.concat(chunks);
    const decoded = decodeContainer(reconstructed);
    assert.ok(String(inspectContainer(decoded).project_model ?? '').includes('ES2'));

    // Deleting default sample_es2.isp must NOT resurrect it on subsequent listings
    const initialFiles = listAllFiles();
    assert.ok(initialFiles.includes('/workspace/sample_es2.isp'));

    const delRes = invokeTool('ispsoft_manage_workspace_files', {
      action: 'delete',
      path: '/workspace/sample_es2.isp',
    });
    assert.equal(delRes.success, true);

    const afterDeleteFiles = listAllFiles();
    assert.ok(!afterDeleteFiles.includes('/workspace/sample_es2.isp'), 'Deleted sample file must not resurrect');
  });
});

// =============================================================================
// 5. MCP server: malformed URI handling + nested project resource listing/reading
// =============================================================================
test('mcpServer handles malformed percent-encoding without URIError crash and exposes nested subdirectory projects', async () => {
  await withIsolatedWorkspace(async () => {
    const ctx = { requestId: 'test-req-1' };

    // Malformed percent-encoding returns JSON-RPC -32002 cleanly
    const badRes = handleSingleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ispsoft://projects/%E0%A4%A/overview' },
      },
      ctx,
    );
    const badErr = badRes.body?.error as { code?: number } | undefined;
    assert.ok(badErr);
    assert.equal(badErr?.code, -32002);

    // Create project in nested subdirectory
    const nested = invokeTool('ispsoft_create_blank_project', {
      model: 'ES2',
      output_path: '/workspace/line1/sub_plc.isp',
    });
    assert.equal(nested.success, true, `nested create failed: ${JSON.stringify(nested)}`);

    const listRes = handleSingleRpc({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }, ctx);
    const resources = (
      ((listRes.body?.result as { resources?: Array<{ uri: string }> })?.resources ?? []).map((r) => r.uri)
    );
    const expectedUri = `ispsoft://projects/${encodeURIComponent('line1/sub_plc.isp')}/overview`;
    assert.ok(resources.includes(expectedUri), `Expected ${expectedUri} in ${JSON.stringify(resources)}`);

    const readRes = handleSingleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: expectedUri },
      },
      ctx,
    );
    assert.ok(!readRes.body?.error, `Expected clean resource read, got ${JSON.stringify(readRes.body?.error)}`);
    const contents = (readRes.body?.result as { contents: Array<{ text: string }> }).contents;
    assert.ok(contents[0].text.includes('ES2'));
  });
});

// =============================================================================
// 6. Structural delimiter injection, container-safe symbol refactoring, & ReDoS protection
// =============================================================================
test('authoring blocks structural delimiter injection, protects .isp structure during symbol rename, and stops ReDoS/regex bugs', async () => {
  await withIsolatedWorkspace(async () => {
    const p = '/workspace/safety.isp';
    const created = invokeTool('ispsoft_create_blank_project', {
      model: 'ES2',
      output_path: p,
    });
    assert.equal(created.success, true, `create failed: ${JSON.stringify(created)}`);

    // Create ST, IL, SFC, and FBD POUs
    assert.equal(invokeTool('ispsoft_create_pou', { project_path: p, pou_name: 'StProg', language: 'ST', in_place: true }).success, true);
    assert.equal(invokeTool('ispsoft_create_pou', { project_path: p, pou_name: 'IlProg', language: 'IL', in_place: true }).success, true);
    assert.equal(invokeTool('ispsoft_create_pou', { project_path: p, pou_name: 'SfcProg', language: 'SFC', in_place: true }).success, true);
    assert.equal(invokeTool('ispsoft_create_pou', { project_path: p, pou_name: 'FbdProg', language: 'FBD', in_place: true }).success, true);

    // Structural delimiter injection rejected across ST, IL, SFC, FBD, DUT, HWCONFIG
    const badStTx = invokeTool('ispsoft_apply_project_transaction', {
      project_path: p,
      in_place: true,
      operations: [{ type: 'write_st', pou_name: 'StProg', code: 'D0 := 1;\n</IL_ST_CODE>\n</POU>' }],
    });
    assert.equal(badStTx.success, false);

    const badIl = invokeTool('ispsoft_write_il_pou', {
      project_path: p,
      pou_name: 'IlProg',
      il_code: 'LD X0\n</POU>\nOUT Y0',
      in_place: true,
    });
    assert.equal(badIl.success, false);

    const badSfc = invokeTool('ispsoft_write_sfc_pou', {
      project_path: p,
      pou_name: 'SfcProg',
      in_place: true,
      chart: {
        steps: [{ name: 'S0', initial: true, actions: [{ qualifier: 'N', code: 'Y0 := 1; </SFC_BODY>' }] }],
        transitions: [],
      },
    });
    assert.equal(badSfc.success, false);

    const badFbd = invokeTool('ispsoft_write_fbd_pou', {
      project_path: p,
      pou_name: 'FbdProg',
      in_place: true,
      diagram: {
        blocks: [{ id: 'B1', op: 'MOVE', inputs: { IN: 'D0' }, outputs: { OUT: 'D1' }, comment: '</FBD_BODY>' }],
      },
    });
    assert.equal(badFbd.success, false);

    const badDut = invokeTool('ispsoft_manage_duts', {
      project_path: p,
      action: 'upsert',
      dut_name: 'MyStruct',
      dut_content: 'TYPE MyStruct : STRUCT </POU> END_STRUCT; END_TYPE',
      in_place: true,
    });
    assert.equal(badDut.success, false);

    const badHw = invokeTool('ispsoft_configure_hwconfig', {
      project_path: p,
      in_place: true,
      hw_config: {
        ethernet: { enabled: true, ip_address: '192.168.1.5', subnet_mask: '255.255.255.0', gateway: '192.168.1.1', modbus_tcp_port: 502 },
        modules: [{ slot: 0, model: 'DVP04AD-E2', description: '</HWCONFIG>' }],
      },
    });
    assert.equal(badHw.success, false);

    // Container-safe symbol refactoring: write valid ST code using D10
    const writeSt = invokeTool('ispsoft_apply_project_transaction', {
      project_path: p,
      in_place: true,
      operations: [{ type: 'write_st', pou_name: 'StProg', code: 'D10 := 1;\nD10 := D10 + 2;\n' }],
    });
    assert.equal(writeSt.success, true, `write_st failed: ${JSON.stringify(writeSt)}`);

    // Renaming a dangerous structural keyword like `TYPE` must NOT corrupt LD `TYPE=1` or `<POU>` tags
    const renameDanger = invokeTool('ispsoft_find_and_replace_symbol', {
      project_path: p,
      find_symbol: 'TYPE',
      replace_symbol: 'MY_TYPE_SAFE',
      in_place: true,
    });
    assert.equal(renameDanger.success, true);

    // Project must still inspect & decode cleanly with all 5 POUs intact
    const insp = invokeTool('ispsoft_inspect_project', { project_path: p });
    assert.ok(String(insp.project_model).includes('ES2'));
    assert.ok(Array.isArray(insp.pous) && (insp.pous as unknown[]).length >= 5);

    // Real user symbol rename works inside ST code
    const renameD10 = invokeTool('ispsoft_find_and_replace_symbol', {
      project_path: p,
      find_symbol: 'D10',
      replace_symbol: 'D20',
      in_place: true,
    });
    assert.equal(renameD10.success, true);
    assert.ok(Number(renameD10.replacement_count) >= 3);

    // Search: ReDoS nested quantifier rejected cleanly
    const redos = invokeTool('ispsoft_search_project', {
      project_path: p,
      query: '(a+)+$',
      regex: true,
    });
    assert.equal(redos.success, false);

    // Search: invalid regex returns clean error
    const badRe = invokeTool('ispsoft_search_project', {
      project_path: p,
      query: '[unclosed',
      regex: true,
    });
    assert.equal(badRe.success, false);

    // Search: consecutive regex matches are NOT skipped by stateful global lastIndex
    const goodRe = invokeTool('ispsoft_search_project', {
      project_path: p,
      query: 'D20',
      regex: true,
      scope: 'code',
    });
    assert.ok(Number(goodRe.match_count) >= 2, `Expected >=2 consecutive regex line matches, got ${JSON.stringify(goodRe)}`);
  });
});

// =============================================================================
// 7. Simulator: nested-loop DoS cap, NaN/Inf sanitization, float tolerance, transactional online edit
// =============================================================================
test('simulator enforces global ST statement cap, sanitizes NaN/Inf, supports float tolerance, and keeps online_edit transactional', async () => {
  await withIsolatedWorkspace(async () => {
    const p = '/workspace/sim_hardening.isp';
    assert.equal(invokeTool('ispsoft_create_blank_project', { model: 'ES2', output_path: p }).success, true);
    assert.equal(
      invokeTool('ispsoft_create_pou', {
        project_path: p,
        pou_name: 'MainSt',
        language: 'ST',
        in_place: true,
        local_variables: 'VAR\n  i : INT;\n  j : INT;\n  fVal : REAL;\nEND_VAR',
        code: [
          'FOR i := 1 TO 1000 DO',
          '  FOR j := 1 TO 1000 DO',
          '    D0 := D0 + 1;',
          '  END_FOR;',
          'END_FOR;',
          'D1 := EXP(1000);',
          'D2 := EXPT(-1, 0.5);',
          'fVal := 0.1 + 0.2;',
          'D10 := 100;',
        ].join('\n'),
      }).success,
      true,
    );

    const started = invokeTool('ispsoft_sim_start', { project_path: p });
    assert.equal(started.success, true, `sim_start failed: ${JSON.stringify(started)}`);
    const sid = String(started.session_id);

    // Nested 1,000,000-iteration loop must terminate quickly via global per-scan cap
    const t0 = Date.now();
    const step = invokeTool('ispsoft_sim_control', { session_id: sid, command: 'STEP', cycles: 1 });
    const elapsedMs = Date.now() - t0;
    assert.equal(step.success, true, `sim_control STEP failed: ${JSON.stringify(step)}`);
    assert.ok(elapsedMs < 3000, `Nested FOR loop took too long: ${elapsedMs}ms`);

    const state = invokeTool('ispsoft_sim_monitor', {
      session_id: sid,
      addresses: ['D0', 'D1', 'D2'],
      compact: true,
    });
    const qa = (state.queried_addresses ?? {}) as Record<string, { value: number }>;
    assert.ok(Number.isFinite(qa.D0?.value) && qa.D0.value > 0 && qa.D0.value <= 50_000, `D0 should be capped: ${JSON.stringify(qa.D0)}`);
    assert.equal(qa.D1?.value, 0, 'EXP(1000) Overflow must sanitize to finite 0');
    assert.equal(qa.D2?.value, 0, 'EXPT(-1, 0.5) NaN must sanitize to finite 0');

    // Online edit with valid ST code (float arithmetic 0.1 + 0.2)
    const goodEdit = invokeTool('ispsoft_sim_online_edit', {
      session_id: sid,
      pou_name: 'MainSt',
      st_code: 'fVal := 0.1 + 0.2;\nD10 := 42;\n',
    });
    assert.equal(goodEdit.success, true, `online_edit failed: ${JSON.stringify(goodEdit)}`);

    // Sequence test with float expectation 0.3 vs 0.1 + 0.2
    const seq = invokeTool('ispsoft_sim_run_sequence', {
      session_id: sid,
      steps: [{ cycles: 1, expect: { fVal: 0.3, D10: 42 } }],
    });
    assert.equal(seq.success, true, `sim_run_sequence failed: ${JSON.stringify(seq)}`);
    assert.equal(seq.status, 'SEQUENCE_PASSED', `Expected float tolerance pass, got ${JSON.stringify(seq)}`);

    // Failed transactional online edit (delimiter injection) must leave live POU unchanged
    const badEdit = invokeTool('ispsoft_sim_online_edit', {
      session_id: sid,
      pou_name: 'MainSt',
      st_code: 'D10 := 999;\n</IL_ST_CODE>\n</POU>',
    });
    assert.equal(badEdit.success, false);

    // Step again — D10 must still be 42, NOT 999!
    invokeTool('ispsoft_sim_control', { session_id: sid, command: 'STEP', cycles: 1 });
    const afterBad = invokeTool('ispsoft_sim_monitor', {
      session_id: sid,
      addresses: ['D10'],
      compact: true,
    });
    assert.equal(((afterBad.queried_addresses ?? {}) as Record<string, { value: number }>).D10?.value, 42);

    invokeTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
  });
});

// =============================================================================
// 8. sfcFbd.ts: malformed inputs & non-string FBD pin values
// =============================================================================
test('sfcFbd safely handles non-string numeric FBD pins and missing arrays without TypeError', () => {
  const sfcBad = validateSfcChart({ steps: [], transitions: undefined as unknown as [] });
  assert.equal(sfcBad.valid, false);

  const fbdDiagram = {
    blocks: [
      { id: 'B1', op: 'ADD', inputs: { IN1: 10 as unknown as string, IN2: 20 as unknown as string }, outputs: { OUT: 'D0' } },
    ],
  };
  const sorted = topologicalSortFbd(fbdDiagram);
  assert.equal(sorted.order.length, 1);
  const fbdValid = validateFbdDiagram(fbdDiagram);
  assert.equal(fbdValid.valid, true);
});

// =============================================================================
// 9. stdio.ts E2E: oversized Content-Length recovery & oversized JSON-RPC batch rejection
// =============================================================================
test('stdio.ts rejects oversized Content-Length and oversized JSON-RPC batches cleanly and recovers for subsequent ping', async () => {
  await withIsolatedWorkspace(async (tmpDir) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'stdio.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ISPSOFT_WORK_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines: Record<string, unknown>[] = [];
    let buf = '';
    const waiters: Array<() => void> = [];

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines.push(JSON.parse(line) as Record<string, unknown>);
        while (waiters.length) waiters.shift()!();
      }
    });

    const waitForCount = (n: number, timeoutMs = 5000) =>
      new Promise<void>((resolve, reject) => {
        if (lines.length >= n) return resolve();
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${n} stdio responses, got ${lines.length}`)), timeoutMs);
        const check = () => {
          if (lines.length >= n) {
            clearTimeout(timer);
            resolve();
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      });

    try {
      // 1. Send an oversized Content-Length header
      child.stdin.write('Content-Length: 999999999\r\n\r\n');
      await waitForCount(1);
      const err1 = lines[0].error as { code: number; data?: { error_code?: string } };
      assert.equal(err1.code, -32700);
      assert.equal(err1.data?.error_code, 'RESOURCE_LIMIT');

      // 2. Send an oversized JSON-RPC batch (51 requests)
      const bigBatch = Array.from({ length: 51 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
      child.stdin.write(JSON.stringify(bigBatch) + '\n');
      await waitForCount(2);
      const err2 = lines[1].error as { code: number; data?: { error_code?: string } };
      assert.equal(err2.code, -32600);
      assert.equal(err2.data?.error_code, 'RESOURCE_LIMIT');

      // 3. Server must still be alive and answer a normal ping
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'ping' }) + '\n');
      await waitForCount(3);
      assert.equal(lines[2].id, 999);
      assert.deepEqual(lines[2].result, {});

      // 4. Multi-chunk split Content-Length frame must assemble cleanly via O(N) chunk queue
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1000, method: 'ping' });
      const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`;
      for (let i = 0; i < frame.length; i += 7) {
        child.stdin.write(frame.slice(i, i + 7));
      }
      await waitForCount(4);
      assert.equal(lines[3].id, 1000);
      assert.deepEqual(lines[3].result, {});
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  });
});

// =============================================================================
// 10. Performance & Cache Safety: symbolic ST AST, container LRU, workspace byte accounting, Soft-PLC speed
// =============================================================================
test('compileSymbolicStExpr handles IEC radix/keywords/dotted tokens and bails out cleanly on calls/arrays', () => {
  const env: Record<string, number> = {
    i: 4,
    D100: 10,
    'T0.Q': 1,
    'D0.0': 1,
    'Pump.Speed': 75,
  };
  const resolver = (name: string) => env[name] ?? 0;

  const ast1 = compileSymbolicStExpr('(i MOD 2) = 0 AND TRUE AND NOT(D100 <> 10)');
  assert.ok(ast1 !== null);
  assert.equal(evaluateSymbolicStAst(ast1, resolver), 1);

  const ast2 = compileSymbolicStExpr('16#FF + 2#1010 + 8#10 + Pump.Speed + T0.Q + D0.0');
  assert.ok(ast2 !== null);
  assert.equal(evaluateSymbolicStAst(ast2, resolver), 255 + 10 + 8 + 75 + 1 + 1);

  const ast3 = compileSymbolicStExpr('(1 XOR 0) OR FALSE');
  assert.ok(ast3 !== null);
  assert.equal(evaluateSymbolicStAst(ast3, resolver), 1);

  // Must return null so full ST evaluator handles function calls and array indexing
  assert.equal(compileSymbolicStExpr('ABS(-5) + 1'), null);
  assert.equal(compileSymbolicStExpr('arr[i] + 1'), null);
});

test('container LRU cache, inspectContainer defensive copy, tools/list memoization, and workspace byte tracking stay isolated and consistent', async () => {
  await withIsolatedWorkspace(async () => {
    // getAnnotatedTools returns stable memoized reference
    const toolsA = getAnnotatedTools();
    const toolsB = getAnnotatedTools();
    assert.strictEqual(toolsA, toolsB);
    assert.ok(toolsA.length >= 70);

    // Create two distinct blank projects and ensure decodeContainer LRU never conflates them
    assert.equal(invokeTool('ispsoft_create_blank_project', { model: 'ES2', output_path: '/workspace/a.isp', project_name: 'ProjA' }).success, true);
    assert.equal(invokeTool('ispsoft_create_blank_project', { model: 'SA2', output_path: '/workspace/b.isp', project_name: 'ProjB' }).success, true);

    const bufA = Buffer.from(readFileBuffer('/workspace/a.isp'));
    const bufB = Buffer.from(readFileBuffer('/workspace/b.isp'));

    const cA1 = decodeContainer(bufA);
    const cB1 = decodeContainer(bufB);
    const iA1 = inspectContainer(cA1);
    const iB1 = inspectContainer(cB1);
    assert.equal(iA1.project_model, 'ES2');
    assert.equal(iB1.project_model, 'SA2');

    // Mutating returned inspect summary pous must NOT poison cached inspect summary
    iA1.pous.push({ name: 'Injected', pou_type: 'PRG', language: 'ST' });
    const iA2 = inspectContainer(decodeContainer(bufA));
    assert.equal(iA2.pous.some((p) => p.name === 'Injected'), false);

    // O(1) incremental workspace byte tracking matches actual file sizes across write/overwrite/delete
    const statsBefore = getWorkspaceStorageStats();
    const payload = Buffer.alloc(1024, 0x41);
    writeFileBuffer('/workspace/bytes_test.bin', payload);
    const statsAfterWrite = getWorkspaceStorageStats();
    assert.equal(statsAfterWrite.total_bytes - statsBefore.total_bytes, 1024);

    writeFileBuffer('/workspace/bytes_test.bin', Buffer.alloc(256, 0x42), true);
    const statsAfterOverwrite = getWorkspaceStorageStats();
    assert.equal(statsAfterOverwrite.total_bytes - statsBefore.total_bytes, 256);

    deleteWorkspaceFile('/workspace/bytes_test.bin');
    const statsAfterDelete = getWorkspaceStorageStats();
    assert.equal(statsAfterDelete.total_bytes, statsBefore.total_bytes);
  });
});

test('Soft-PLC compiled ST AST executes 200 scans of 150-symbol + 100-iteration loop accurately and without bottleneck', async () => {
  await withIsolatedWorkspace(async () => {
    const p = '/workspace/perf_regression.isp';
    assert.equal(invokeTool('ispsoft_create_blank_project', { model: 'ES2', output_path: p, project_name: 'PerfReg' }).success, true);
    const syms = Array.from({ length: 150 }, (_, i) => ({
      name: `Var${i}`,
      type: 'INT',
      address: `D${200 + i}`,
      initial_value: String(i),
    }));
    assert.equal(invokeTool('ispsoft_edit_global_variables', { project_path: p, upsert_vars: syms, in_place: true }).success, true);
    const stCode = [
      'D100 := 0;',
      'FOR i := 1 TO 100 DO',
      '  IF (i MOD 2) = 0 THEN',
      '    D100 := D100 + i + Var10 + Var140;',
      '  ELSE',
      '    D100 := D100 + 1;',
      '  END_IF;',
      'END_FOR;',
    ].join('\n');
    assert.equal(
      invokeTool('ispsoft_create_pou', { project_path: p, pou_name: 'PerfMain', language: 'ST', code: stCode, assign_to_task: true, in_place: true }).success,
      true,
    );

    const started = invokeTool('ispsoft_sim_start', { project_path: p });
    assert.equal(started.success, true);
    const sid = String(started.session_id);

    const t0 = performance.now();
    const stepped = invokeTool('ispsoft_sim_control', { session_id: sid, command: 'STEP', cycles: 200 });
    const elapsedMs = performance.now() - t0;
    assert.equal(stepped.success, true);
    assert.ok(elapsedMs < 600, `Expected 200 scans < 600ms, got ${elapsedMs.toFixed(1)}ms`);

    const mon = invokeTool('ispsoft_sim_monitor', { session_id: sid, addresses: ['D100'], compact: true });
    const qa = (mon.queried_addresses ?? {}) as Record<string, { value: number }>;
    assert.equal(qa.D100?.value, 10100);

    invokeTool('ispsoft_sim_control', { session_id: sid, command: 'CLOSE' });
  });
});

