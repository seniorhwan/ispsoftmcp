export type HealthStatus = 'OPTIMAL' | 'ELEVATED' | 'SLUGGISH' | 'OVER_BUDGET';

export interface PouTimingSummary {
  pou: string;
  lang: 'LD' | 'ST';
  executions: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  instructions_executed: number;
  statements_executed: number;
  loop_iterations: number;
  loop_cap_hits: number;
  jump_cap_hits: number;
  call_depth_max: number;
}

export interface NetworkTimingSummary {
  pou: string;
  network_index: number;
  net_id: string;
  label?: string;
  executions: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  instruction_count: number;
}

export interface ScanSample {
  scan_count: number;
  duration_ms: number;
  budget_ms: number;
  over_budget: boolean;
  words_count: number;
  bits_count: number;
  heap_used_bytes: number;
  pou_timings: Array<{
    pou: string;
    lang: 'LD' | 'ST';
    duration_ms: number;
    work_units: number;
  }>;
}

export interface SimulatorMemoryInput {
  bitsKeys: string[];
  prevBitsCount: number;
  edgeStatesCount: number;
  wordsKeys: string[];
  forcedBitsCount: number;
  forcedWordsCount: number;
  timersCount: number;
  countersCount: number;
  symbolsCount: number;
  dutFieldsCount: number;
  traceBufferLength: number;
  traceSampleValueKeysCount: number;
  lastRungTraceCount: number;
  lastStTraceCount: number;
  scanHistoryLength: number;
  rawIspBytes: number;
}

export interface MemoryBreakdown {
  entries: {
    bits: number;
    prev_bits: number;
    edge_states: number;
    words_total: number;
    scalar_words: number;
    array_elements: number;
    timers: number;
    counters: number;
    forced_bits: number;
    forced_words: number;
    symbols: number;
    dut_fields: number;
    trace_buffer_samples: number;
    last_rung_trace: number;
    last_st_trace: number;
    scan_history_samples: number;
    total_tracked_entries: number;
  };
  array_collections: Array<{ name: string; element_count: number }>;
  estimated_bytes: {
    bit_and_edge_maps: number;
    word_map: number;
    timers_and_counters: number;
    symbols_and_duts: number;
    trace_and_history_buffers: number;
    raw_isp_project: number;
    total_simulator_state: number;
  };
  estimated_simulator_state_kb: number;
}

export interface DiagnosticRecommendation {
  severity: 'info' | 'warning' | 'critical';
  area: 'execution_speed' | 'loop_safety' | 'control_flow' | 'memory' | 'scan_budget';
  pou?: string;
  issue: string;
  suggestion: string;
}

export interface DiagnosticsInput {
  scanIntervalMs: number;
  slowThresholdMs: number;
  totalScansProfiled: number;
  overrunCount: number;
  slowScanCount: number;
  totalScanExecMs: number;
  minScanMs: number | null;
  maxScanMs: number;
  recentScans: ScanSample[];
  pouMetrics: PouTimingSummary[];
  networkMetrics: NetworkTimingSummary[];
  memory: MemoryBreakdown;
  baselineWordsCount: number;
  baselineBitsCount: number;
  baselineStateBytes: number;
  baselineHeapUsedBytes: number;
  currentHeapUsedBytes: number;
  currentHeapTotalBytes: number;
  currentRssBytes: number;
  currentExternalBytes: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

export function computeMemoryBreakdown(input: SimulatorMemoryInput): MemoryBreakdown {
  let scalarWords = 0;
  let arrayElements = 0;
  const arrayBuckets = new Map<string, number>();

  for (const key of input.wordsKeys) {
    const arrMatch = /^([A-Z0-9_]+)\[(-?\d+)\]$/.exec(key);
    if (arrMatch) {
      arrayElements += 1;
      const arrName = arrMatch[1];
      arrayBuckets.set(arrName, (arrayBuckets.get(arrName) ?? 0) + 1);
    } else {
      scalarWords += 1;
    }
  }

  const arrayCollections = [...arrayBuckets.entries()]
    .map(([name, element_count]) => ({ name, element_count }))
    .sort((a, b) => b.element_count - a.element_count)
    .slice(0, 20);

  // Conservative JS V8 Map/entry footprint estimates (key string + Map slot + payload)
  const bitAndEdgeBytes =
    (input.bitsKeys.length + input.prevBitsCount + input.edgeStatesCount + input.forcedBitsCount) * 72;
  const wordBytes = (input.wordsKeys.length + input.forcedWordsCount) * 80;
  const timersAndCountersBytes = input.timersCount * 168 + input.countersCount * 128;
  const symbolsAndDutsBytes = input.symbolsCount * 192 + input.dutFieldsCount * 128;
  const traceAndHistoryBytes =
    input.traceBufferLength * 96 +
    input.traceSampleValueKeysCount * 64 +
    input.lastRungTraceCount * 240 +
    input.lastStTraceCount * 180 +
    input.scanHistoryLength * 220;
  const totalSimulatorState =
    bitAndEdgeBytes +
    wordBytes +
    timersAndCountersBytes +
    symbolsAndDutsBytes +
    traceAndHistoryBytes +
    input.rawIspBytes;

  const totalTrackedEntries =
    input.bitsKeys.length +
    input.prevBitsCount +
    input.edgeStatesCount +
    input.wordsKeys.length +
    input.timersCount +
    input.countersCount +
    input.forcedBitsCount +
    input.forcedWordsCount +
    input.symbolsCount +
    input.traceBufferLength;

  return {
    entries: {
      bits: input.bitsKeys.length,
      prev_bits: input.prevBitsCount,
      edge_states: input.edgeStatesCount,
      words_total: input.wordsKeys.length,
      scalar_words: scalarWords,
      array_elements: arrayElements,
      timers: input.timersCount,
      counters: input.countersCount,
      forced_bits: input.forcedBitsCount,
      forced_words: input.forcedWordsCount,
      symbols: input.symbolsCount,
      dut_fields: input.dutFieldsCount,
      trace_buffer_samples: input.traceBufferLength,
      last_rung_trace: input.lastRungTraceCount,
      last_st_trace: input.lastStTraceCount,
      scan_history_samples: input.scanHistoryLength,
      total_tracked_entries: totalTrackedEntries,
    },
    array_collections: arrayCollections,
    estimated_bytes: {
      bit_and_edge_maps: bitAndEdgeBytes,
      word_map: wordBytes,
      timers_and_counters: timersAndCountersBytes,
      symbols_and_duts: symbolsAndDutsBytes,
      trace_and_history_buffers: traceAndHistoryBytes,
      raw_isp_project: input.rawIspBytes,
      total_simulator_state: totalSimulatorState,
    },
    estimated_simulator_state_kb: round2(totalSimulatorState / 1024),
  };
}

export function analyzeSimulationDiagnostics(input: DiagnosticsInput) {
  const count = input.totalScansProfiled;
  const avgScanMs = count > 0 ? input.totalScanExecMs / count : 0;
  const lastScan = input.recentScans.length > 0 ? input.recentScans[input.recentScans.length - 1] : null;
  const sortedDurations = input.recentScans.map((s) => s.duration_ms).sort((a, b) => a - b);
  const p50ScanMs = percentile(sortedDurations, 50);
  const p95ScanMs = percentile(sortedDurations, 95);
  const budgetMs = Math.max(1, input.scanIntervalMs);
  const avgUtilizationPct = (avgScanMs / budgetMs) * 100;
  const peakUtilizationPct = (input.maxScanMs / budgetMs) * 100;
  const estimatedScansPerSec = avgScanMs > 0 ? Math.round(1000 / avgScanMs) : null;

  const totalPouMs = input.pouMetrics.reduce((acc, p) => acc + p.total_ms, 0);
  const pouBreakdown = [...input.pouMetrics]
    .sort((a, b) => b.total_ms - a.total_ms)
    .map((p) => ({
      ...p,
      total_ms: round3(p.total_ms),
      avg_ms: round3(p.executions > 0 ? p.total_ms / p.executions : 0),
      max_ms: round3(p.max_ms),
      avg_statements_per_exec: round2(p.executions > 0 ? p.statements_executed / p.executions : 0),
      avg_instructions_per_exec: round2(p.executions > 0 ? p.instructions_executed / p.executions : 0),
      avg_loop_iterations_per_exec: round2(p.executions > 0 ? p.loop_iterations / p.executions : 0),
      share_of_scan_pct: totalPouMs > 0 ? round2((p.total_ms / totalPouMs) * 100) : 0,
    }));

  const hotNetworks = [...input.networkMetrics]
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 10)
    .map((n) => ({
      ...n,
      total_ms: round3(n.total_ms),
      avg_ms: round3(n.executions > 0 ? n.total_ms / n.executions : 0),
      max_ms: round3(n.max_ms),
    }));

  const recommendations: DiagnosticRecommendation[] = [];

  for (const p of pouBreakdown) {
    if (p.loop_cap_hits > 0) {
      recommendations.push({
        severity: 'critical',
        area: 'loop_safety',
        pou: p.pou,
        issue: `POU "${p.pou}" hit the 10,000-iteration ST loop safety cap ${p.loop_cap_hits} time(s) (avg ${p.avg_loop_iterations_per_exec} iterations/scan).`,
        suggestion:
          'Check WHILE/REPEAT termination conditions or huge FOR bounds. Add an explicit EXIT guard or split heavy iteration across multiple scans using a state index.',
      });
    } else if (p.avg_loop_iterations_per_exec >= 200) {
      recommendations.push({
        severity: p.avg_loop_iterations_per_exec >= 1000 ? 'warning' : 'info',
        area: 'execution_speed',
        pou: p.pou,
        issue: `POU "${p.pou}" runs an average of ${p.avg_loop_iterations_per_exec} loop iterations every scan (${p.avg_ms} ms/scan, ${p.share_of_scan_pct}% of POU time).`,
        suggestion:
          'Gate initialization or batch-processing loops behind a one-shot/edge trigger (M1002 or rising edge) or move invariant calculations outside the loop.',
      });
    }

    if (p.jump_cap_hits > 0) {
      recommendations.push({
        severity: 'critical',
        area: 'control_flow',
        pou: p.pou,
        issue: `LD POU "${p.pou}" hit the 200-jump CJ per-scan safety cap ${p.jump_cap_hits} time(s).`,
        suggestion:
          'Verify backward CJ jump targets and ensure the jump condition clears cleanly to avoid tight spin-loops within a single scan.',
      });
    }

    if (p.call_depth_max >= 6) {
      recommendations.push({
        severity: 'warning',
        area: 'control_flow',
        pou: p.pou,
        issue: `POU "${p.pou}" reached nested call depth ${p.call_depth_max} (simulator limit is 8).`,
        suggestion:
          'Flatten deep CALL / FC chains or inspect for unintended recursive calls between POUs.',
      });
    }

    if (p.share_of_scan_pct >= 60 && p.avg_ms >= input.slowThresholdMs * 0.5 && pouBreakdown.length > 1) {
      recommendations.push({
        severity: 'warning',
        area: 'execution_speed',
        pou: p.pou,
        issue: `POU "${p.pou}" is the primary bottleneck, consuming ${p.share_of_scan_pct}% of active POU CPU time (${p.avg_ms} ms avg).`,
        suggestion:
          'Focus optimization on this POU first (reduce repeated expression evaluations inside loops or execute non-critical work in a slower periodic task).',
      });
    }
  }

  if (input.overrunCount > 0 || peakUtilizationPct >= 100) {
    recommendations.push({
      severity: 'critical',
      area: 'scan_budget',
      issue: `${input.overrunCount} scan(s) exceeded the ${budgetMs} ms scan_interval_ms budget (peak ${round3(input.maxScanMs)} ms = ${round2(peakUtilizationPct)}% utilization).`,
      suggestion:
        'Reduce per-scan work (loops, expressions, or hot LD networks) or increase scan_interval_ms if deterministic sub-cycle timing is not required.',
    });
  } else if (p95ScanMs > input.slowThresholdMs || avgUtilizationPct >= 60) {
    recommendations.push({
      severity: 'warning',
      area: 'scan_budget',
      issue: `p95 scan duration (${round3(p95ScanMs)} ms) exceeded slow threshold (${input.slowThresholdMs} ms) or utilization is elevated (${round2(avgUtilizationPct)}%).`,
      suggestion:
        'Consider gating heavy arithmetic/array sweeps behind a condition or rising edge so idle scans stay fast.',
    });
  }

  const wordsDelta = input.memory.entries.words_total - input.baselineWordsCount;
  const bitsDelta = input.memory.entries.bits - input.baselineBitsCount;
  const topArray = input.memory.array_collections[0];

  if (input.memory.entries.array_elements >= 500 || (topArray && topArray.element_count >= 256)) {
    recommendations.push({
      severity: input.memory.entries.array_elements >= 2000 ? 'critical' : 'warning',
      area: 'memory',
      issue: `Word memory holds ${input.memory.entries.array_elements} dynamically indexed array elements (largest: ${topArray ? `${topArray.name}[${topArray.element_count}]` : 'unknown'}).`,
      suggestion:
        'Bound array index ranges, reuse fixed-size ring buffers (idx := (idx + 1) MOD N), or avoid sparse high-index writes inside loops.',
    });
  } else if (wordsDelta >= 200 || bitsDelta >= 500) {
    recommendations.push({
      severity: 'warning',
      area: 'memory',
      issue: `Memory map grew significantly since baseline (+${wordsDelta} words, +${bitsDelta} bits).`,
      suggestion:
        'Check for monotonically increasing array indices or uncleaned dynamic device writes across scans.',
    });
  }

  let health_status: HealthStatus = 'OPTIMAL';
  if (input.overrunCount > 0 || recommendations.some((r) => r.severity === 'critical')) {
    health_status = input.overrunCount > 0 ? 'OVER_BUDGET' : 'SLUGGISH';
  } else if (
    input.slowScanCount > 0 ||
    p95ScanMs > input.slowThresholdMs ||
    recommendations.some((r) => r.severity === 'warning')
  ) {
    health_status = 'SLUGGISH';
  } else if (avgUtilizationPct >= 35 || input.memory.entries.array_elements >= 100) {
    health_status = 'ELEVATED';
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: 'info',
      area: 'execution_speed',
      issue: 'No execution bottlenecks, loop-cap hits, or memory bloat detected.',
      suggestion: 'Current PLC scan speed and memory footprint are well within budget.',
    });
  }

  return {
    health_status,
    timing: {
      scans_profiled: count,
      scan_budget_ms: budgetMs,
      slow_threshold_ms: input.slowThresholdMs,
      last_scan_ms: round3(lastScan?.duration_ms ?? 0),
      min_scan_ms: round3(input.minScanMs ?? 0),
      avg_scan_ms: round3(avgScanMs),
      p50_scan_ms: round3(p50ScanMs),
      p95_scan_ms: round3(p95ScanMs),
      max_scan_ms: round3(input.maxScanMs),
      total_exec_ms: round3(input.totalScanExecMs),
      avg_budget_utilization_pct: round2(avgUtilizationPct),
      peak_budget_utilization_pct: round2(peakUtilizationPct),
      overrun_count: input.overrunCount,
      slow_scan_count: input.slowScanCount,
      estimated_max_scans_per_sec: estimatedScansPerSec,
    },
    pou_breakdown: pouBreakdown,
    hot_networks: hotNetworks,
    memory: {
      ...input.memory,
      process: {
        heap_used_mb: round2(input.currentHeapUsedBytes / (1024 * 1024)),
        heap_total_mb: round2(input.currentHeapTotalBytes / (1024 * 1024)),
        rss_mb: round2(input.currentRssBytes / (1024 * 1024)),
        external_mb: round2(input.currentExternalBytes / (1024 * 1024)),
      },
      growth_since_baseline: {
        words_delta: wordsDelta,
        bits_delta: bitsDelta,
        simulator_state_kb_delta: round2((input.memory.estimated_bytes.total_simulator_state - input.baselineStateBytes) / 1024),
        heap_used_mb_delta: round2((input.currentHeapUsedBytes - input.baselineHeapUsedBytes) / (1024 * 1024)),
      },
    },
    recommendations,
  };
}
