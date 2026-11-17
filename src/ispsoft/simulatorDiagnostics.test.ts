import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  analyzeSimulationDiagnostics,
  computeMemoryBreakdown,
  percentile,
} from './simDiagnostics.js';
import { buildProjectFromBundle } from './authoring.js';
import { controlSimulator, profileSimulatorSession, startSimulatorSession } from './simulator.js';
import { DEFAULT_WORK_DIR, deleteWorkspaceFile, seedDefaultWorkspace, writeFileBuffer } from './workspace.js';

test('percentile computes p50 and p95 accurately', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 100);
  assert.equal(percentile([], 95), 0);
});

test('computeMemoryBreakdown separates scalar words and array collections', () => {
  const wordsKeys = ['D0', 'D10', 'COUNT'];
  for (let i = 0; i < 300; i++) wordsKeys.push(`BUF[${i}]`);
  for (let i = 0; i < 40; i++) wordsKeys.push(`HIST[${i}]`);

  const mem = computeMemoryBreakdown({
    bitsKeys: ['M0', 'M1000', 'Y0'],
    prevBitsCount: 3,
    edgeStatesCount: 1,
    wordsKeys,
    forcedBitsCount: 1,
    forcedWordsCount: 0,
    timersCount: 1,
    countersCount: 0,
    symbolsCount: 4,
    dutFieldsCount: 0,
    traceBufferLength: 10,
    traceSampleValueKeysCount: 40,
    lastRungTraceCount: 2,
    lastStTraceCount: 1,
    scanHistoryLength: 10,
    rawIspBytes: 4096,
  });

  assert.equal(mem.entries.scalar_words, 3);
  assert.equal(mem.entries.array_elements, 340);
  assert.equal(mem.entries.words_total, 343);
  assert.deepEqual(mem.array_collections[0], { name: 'BUF', element_count: 300 });
  assert.deepEqual(mem.array_collections[1], { name: 'HIST', element_count: 40 });
  assert.ok(mem.estimated_bytes.total_simulator_state > 4096);
});

test('analyzeSimulationDiagnostics detects OVER_BUDGET, loop caps, jump caps, and memory bloat', () => {
  const wordsKeys = Array.from({ length: 650 }, (_, i) => `LOG[${i}]`);
  const mem = computeMemoryBreakdown({
    bitsKeys: ['M1000'],
    prevBitsCount: 1,
    edgeStatesCount: 0,
    wordsKeys,
    forcedBitsCount: 0,
    forcedWordsCount: 0,
    timersCount: 0,
    countersCount: 0,
    symbolsCount: 2,
    dutFieldsCount: 0,
    traceBufferLength: 5,
    traceSampleValueKeysCount: 10,
    lastRungTraceCount: 1,
    lastStTraceCount: 1,
    scanHistoryLength: 3,
    rawIspBytes: 2048,
  });

  const report = analyzeSimulationDiagnostics({
    scanIntervalMs: 10,
    slowThresholdMs: 5,
    totalScansProfiled: 3,
    overrunCount: 2,
    slowScanCount: 3,
    totalScanExecMs: 42,
    minScanMs: 8,
    maxScanMs: 20,
    recentScans: [
      { scan_count: 1, duration_ms: 8, budget_ms: 10, over_budget: false, words_count: 100, bits_count: 1, heap_used_bytes: 10_000_000, pou_timings: [] },
      { scan_count: 2, duration_ms: 14, budget_ms: 10, over_budget: true, words_count: 400, bits_count: 1, heap_used_bytes: 10_500_000, pou_timings: [] },
      { scan_count: 3, duration_ms: 20, budget_ms: 10, over_budget: true, words_count: 650, bits_count: 1, heap_used_bytes: 11_000_000, pou_timings: [] },
    ],
    pouMetrics: [
      {
        pou: 'HeavySt',
        lang: 'ST',
        executions: 3,
        total_ms: 40,
        avg_ms: 13.333,
        max_ms: 19,
        instructions_executed: 0,
        statements_executed: 30000,
        loop_iterations: 30000,
        loop_cap_hits: 3,
        jump_cap_hits: 0,
        call_depth_max: 1,
      },
      {
        pou: 'SpinLd',
        lang: 'LD',
        executions: 3,
        total_ms: 2,
        avg_ms: 0.667,
        max_ms: 1,
        instructions_executed: 1200,
        statements_executed: 0,
        loop_iterations: 0,
        loop_cap_hits: 0,
        jump_cap_hits: 1,
        call_depth_max: 6,
      },
    ],
    networkMetrics: [],
    memory: mem,
    baselineWordsCount: 0,
    baselineBitsCount: 1,
    baselineStateBytes: 2048,
    baselineHeapUsedBytes: 10_000_000,
    currentHeapUsedBytes: 11_000_000,
    currentHeapTotalBytes: 20_000_000,
    currentRssBytes: 40_000_000,
    currentExternalBytes: 1_000_000,
  });

  assert.equal(report.health_status, 'OVER_BUDGET');
  assert.equal(report.pou_breakdown[0].pou, 'HeavySt');
  assert.ok(report.recommendations.some((r) => r.area === 'loop_safety' && r.pou === 'HeavySt'));
  assert.ok(report.recommendations.some((r) => r.area === 'control_flow' && r.pou === 'SpinLd'));
  assert.ok(report.recommendations.some((r) => r.area === 'memory'));
  assert.ok(report.recommendations.some((r) => r.area === 'scan_budget'));
});

test('live Soft-PLC simulator profiles sluggish ST loop + array bloat vs clean project', () => {
  seedDefaultWorkspace();
  const sampleEs2Path = path.posix.join(DEFAULT_WORK_DIR, 'sample_es2.isp');
  const tmpVirtualPath = path.posix.join(DEFAULT_WORK_DIR, `diag-test-${Date.now()}.isp`);

  try {
    const built = buildProjectFromBundle({
      model: 'ES2',
      tasks: [
        { id: 0, name: 'Task0', type: 0, interval_ms: 25, priority: 1, active: true, program: 'FastLd' },
        { id: 1, name: 'Task1', type: 0, interval_ms: 25, priority: 2, active: true, program: 'SluggishSt' },
      ],
      global_vars: [
        { identifier: 'gRun', type: 'BOOL', initial_value: 'TRUE' },
        { identifier: 'gDone', type: 'BOOL', initial_value: 'FALSE' },
      ],
      pous: [
        {
          name: 'FastLd',
          language: 'LD',
          networks: [{ il: 'LD M1000\nOUT Y0' }],
        },
        {
          name: 'SluggishSt',
          language: 'ST',
          code: [
            'FOR i := 0 TO 350 DO',
            '  gBuf[i] := i * 2;',
            'END_FOR;',
            'WHILE gRun DO',
            '  D10 := D10 + 1;',
            'END_WHILE;',
            'gDone := TRUE;',
          ].join('\n'),
        },
      ],
    });
    writeFileBuffer(tmpVirtualPath, built.ispBytes, true);

    const sess = startSimulatorSession(tmpVirtualPath, 25);
    const diag = profileSimulatorSession(sess.session_id, {
      sample_cycles: 3,
      slow_threshold_ms: 1,
      include_recent_scans: true,
    });

    assert.equal(diag.success, true);
    assert.equal(diag.benchmark_executed?.cycles_executed, 3);
    assert.equal(diag.recent_scans?.length, 3);
    assert.ok(['SLUGGISH', 'OVER_BUDGET'].includes(diag.health_status));

    const stPou = diag.pou_breakdown.find((p) => p.pou === 'SluggishSt');
    assert.ok(stPou);
    assert.equal(stPou.loop_cap_hits, 3);
    assert.ok(stPou.loop_iterations > 30_000);
    assert.equal(diag.memory.array_collections[0]?.name, 'GBUF');
    assert.equal(diag.memory.array_collections[0]?.element_count, 351);
    assert.ok(diag.recommendations.some((r) => r.area === 'loop_safety' && r.pou === 'SluggishSt'));

    controlSimulator(sess.session_id, 'CLOSE');

    // Now test clean sample_es2.isp
    const cleanSess = startSimulatorSession(sampleEs2Path, 100);
    const cleanDiag = profileSimulatorSession(cleanSess.session_id, {
      reset_metrics: true,
      sample_cycles: 5,
      include_recent_scans: true,
    });
    assert.equal(cleanDiag.health_status, 'OPTIMAL');
    assert.equal(cleanDiag.timing.scans_profiled, 5);
    assert.equal(cleanDiag.recent_scans?.length, 5);
    assert.equal(cleanDiag.timing.overrun_count, 0);
    assert.ok(cleanDiag.hot_networks.length >= 1);
    controlSimulator(cleanSess.session_id, 'CLOSE');
  } finally {
    deleteWorkspaceFile(tmpVirtualPath);
  }
});
