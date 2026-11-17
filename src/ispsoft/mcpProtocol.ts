import crypto from 'node:crypto';

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type StandardErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT_HASH_MISMATCH'
  | 'UNSUPPORTED_MODEL'
  | 'SYNTAX_ERROR'
  | 'RESOURCE_LIMIT'
  | 'SIM_SESSION_NOT_FOUND'
  | 'SIM_ASSERTION_FAILED'
  | 'HARDWARE_NOT_QUALIFIED'
  | 'SECURITY_BLOCKED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeJsonValue<T>(value: T, depth = 0): T {
  if (depth > 32) {
    throw new Error('JSON payload exceeds maximum nesting depth (32)');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, depth + 1)) as unknown as T;
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    clean[k] = sanitizeJsonValue(v, depth + 1);
  }
  return clean as T;
}

function matchesJsonType(val: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof val === 'string';
    case 'number':
      return typeof val === 'number' && Number.isFinite(val);
    case 'integer':
      return typeof val === 'number' && Number.isInteger(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'array':
      return Array.isArray(val);
    case 'object':
      return val !== null && typeof val === 'object' && !Array.isArray(val);
    case 'null':
      return val === null;
    default:
      return true;
  }
}

export function validateToolArguments(
  schema: Record<string, unknown>,
  args: unknown,
): { valid: boolean; errors: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, errors: [{ field: '$', message: 'arguments must be a JSON object' }] };
  }
  const obj = args as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const reqKey of required) {
    const v = obj[reqKey];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim() && reqKey !== 'query' && reqKey !== 'code')) {
      errors.push({ field: reqKey, message: `Missing required parameter '${reqKey}'` });
    }
  }

  const props = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<
    string,
    Record<string, unknown>
  >;

  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined) continue;
    const val = obj[key];
    if (val === null) continue;

    const expectedType = propSchema.type;
    if (typeof expectedType === 'string') {
      if (!matchesJsonType(val, expectedType)) {
        errors.push({
          field: key,
          message: `Parameter '${key}' expected type '${expectedType}', got '${Array.isArray(val) ? 'array' : typeof val}'`,
        });
        continue;
      }
    } else if (Array.isArray(expectedType)) {
      const ok = expectedType.some((t) => typeof t === 'string' && matchesJsonType(val, t));
      if (!ok) {
        errors.push({
          field: key,
          message: `Parameter '${key}' expected one of [${expectedType.join(', ')}]`,
        });
        continue;
      }
    }

    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
      errors.push({
        field: key,
        message: `Parameter '${key}' must be one of [${propSchema.enum.map((x) => JSON.stringify(x)).join(', ')}]`,
      });
    }

    if (typeof val === 'number') {
      if (typeof propSchema.minimum === 'number' && val < propSchema.minimum) {
        errors.push({ field: key, message: `Parameter '${key}' must be >= ${propSchema.minimum}` });
      }
      if (typeof propSchema.maximum === 'number' && val > propSchema.maximum) {
        errors.push({ field: key, message: `Parameter '${key}' must be <= ${propSchema.maximum}` });
      }
    }

    if (Array.isArray(val) && propSchema.items && typeof propSchema.items === 'object') {
      const itemType = (propSchema.items as Record<string, unknown>).type;
      if (typeof itemType === 'string') {
        for (let i = 0; i < val.length; i++) {
          if (!matchesJsonType(val[i], itemType)) {
            errors.push({
              field: `${key}[${i}]`,
              message: `Element '${key}[${i}]' expected type '${itemType}'`,
            });
            break;
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function classifyToolError(
  output: Record<string, unknown>,
): { error_code: StandardErrorCode; retryable: boolean; remediation: string } {
  const status = String(output.status ?? '').toUpperCase();
  const failureCategory = String(output.failure_category ?? '').toLowerCase();
  const msg = String(output.error ?? (Array.isArray(output.errors) ? output.errors[0] : '') ?? '').toLowerCase();

  if (status === 'REJECTED_BEFORE_WRITE' || failureCategory === 'state_changed' || msg.includes('hash')) {
    return {
      error_code: 'CONFLICT_HASH_MISMATCH',
      retryable: true,
      remediation: 'Re-read the project or POU to obtain the latest content_hash, then retry.',
    };
  }
  if (status === 'UNSUPPORTED_MODEL' || status === 'MODEL_NOT_QUALIFIED' || msg.includes('unsupported model')) {
    return {
      error_code: 'UNSUPPORTED_MODEL',
      retryable: false,
      remediation: 'Call ispsoft_list_supported_plc_types to pick a supported canonical model name.',
    };
  }
  if (status === 'TRANSPORT_NOT_QUALIFIED' || status === 'WINDOWS_GUI_UNAVAILABLE' || status === 'UNAVAILABLE_ON_LINUX') {
    return {
      error_code: 'HARDWARE_NOT_QUALIFIED',
      retryable: false,
      remediation: 'Use Soft-PLC simulator tools (ispsoft_sim_*) or offline project tools on Linux.',
    };
  }
  if (status === 'BLOCKED' || msg.includes('unsafe') || msg.includes('traversal') || msg.includes('blocked')) {
    return {
      error_code: 'SECURITY_BLOCKED',
      retryable: false,
      remediation: 'Check workspace path rules and live-write safety environment guards.',
    };
  }
  if (status === 'SEQUENCE_ASSERTION_FAILED') {
    return {
      error_code: 'SIM_ASSERTION_FAILED',
      retryable: false,
      remediation: 'Inspect sequence step observed vs expected values and adjust PLC logic or test stimulus.',
    };
  }
  if (msg.includes('unknown simulator session') || status === 'SESSION_NOT_FOUND') {
    return {
      error_code: 'SIM_SESSION_NOT_FOUND',
      retryable: false,
      remediation: 'Call ispsoft_sim_list or start a new session with ispsoft_sim_start.',
    };
  }
  if (msg.includes('file not found') || msg.includes('not found')) {
    return {
      error_code: 'NOT_FOUND',
      retryable: false,
      remediation: 'Call ispsoft_list_projects or inspect project overview to verify target paths and POU names.',
    };
  }
  if (msg.includes('limit') || msg.includes('quota') || msg.includes('maximum') || msg.includes('exceeds')) {
    return {
      error_code: 'RESOURCE_LIMIT',
      retryable: true,
      remediation: 'Reduce batch/file/session count or close idle simulator sessions and clean up backups.',
    };
  }
  if (
    status === 'TRANSACTION_ABORTED_COMPILE_ERROR' ||
    msg.includes('unsupported opcode') ||
    msg.includes('syntax') ||
    msg.includes('parse')
  ) {
    return {
      error_code: 'SYNTAX_ERROR',
      retryable: false,
      remediation: 'Run ispsoft_validate_il or ispsoft_static_check_and_compile to inspect exact syntax issues.',
    };
  }
  if (failureCategory === 'validation_error' || msg.includes('required') || msg.includes('invalid')) {
    return {
      error_code: 'VALIDATION_ERROR',
      retryable: false,
      remediation: 'Verify parameter types and values against the tool inputSchema.',
    };
  }
  return {
    error_code: 'INTERNAL_ERROR',
    retryable: false,
    remediation: 'Inspect the error message and validate inputs before retrying.',
  };
}

const READ_ONLY_PREFIXES = [
  'ispsoft_doctor',
  'ispsoft_get_',
  'ispsoft_list_',
  'ispsoft_read_',
  'ispsoft_inspect_',
  'ispsoft_export_',
  'ispsoft_render_',
  'ispsoft_validate_',
  'ispsoft_search_',
  'ispsoft_audit_',
  'ispsoft_project_',
  'ispsoft_diff_',
  'ispsoft_static_check_',
  'ispsoft_compile_and_check',
  'ispsoft_analyze_',
  'ispsoft_map_',
  'ispsoft_parse_',
  'ispsoft_translate_',
  'ispsoft_sim_list',
  'ispsoft_sim_monitor',
  'ispsoft_sim_memory_dump',
  'ispsoft_sim_diagnostics',
  'ispsoft_online_status',
  'ispsoft_server_telemetry',
];

const DESTRUCTIVE_NAMES = new Set([
  'ispsoft_manage_workspace_files',
  'ispsoft_manage_pou',
  'ispsoft_manage_dut',
  'ispsoft_sim_control',
  'ispsoft_sim_reload',
  'ispsoft_download',
  'ispsoft_runtime_write',
]);

export function deriveToolAnnotations(name: string): ToolAnnotations {
  const readOnly = READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
  const destructive = !readOnly && (DESTRUCTIVE_NAMES.has(name) || name.includes('delete') || name.includes('write'));
  const idempotent = readOnly || name === 'ispsoft_sim_watch_table';
  const openWorld =
    name.startsWith('ispsoft_connect') ||
    name.startsWith('ispsoft_upload_from_plc') ||
    name.startsWith('ispsoft_runtime_') ||
    name.startsWith('ispsoft_download') ||
    (name.includes('_monitor') && !name.includes('sim_monitor'));

  const title = name
    .replace(/^ispsoft_/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}

interface IdempotencyEntry {
  argsHash: string;
  expiresAt: number;
  response: Record<string, unknown>;
}

export class IdempotencyCache {
  private readonly entries = new Map<string, IdempotencyEntry>();
  constructor(
    private readonly maxEntries = 512,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  private hashArgs(args: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
  }

  get(
    toolName: string,
    key: string,
    args: Record<string, unknown>,
  ): { hit: true; conflict: boolean; response?: Record<string, unknown> } | { hit: false } {
    const composite = `${toolName}:${key}`;
    const entry = this.entries.get(composite);
    if (!entry) return { hit: false };
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(composite);
      return { hit: false };
    }
    const reqHash = this.hashArgs(args);
    if (entry.argsHash !== reqHash) {
      return { hit: true, conflict: true };
    }
    return { hit: true, conflict: false, response: entry.response };
  }

  set(toolName: string, key: string, args: Record<string, unknown>, response: Record<string, unknown>): void {
    const composite = `${toolName}:${key}`;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(composite, {
      argsHash: this.hashArgs(args),
      expiresAt: Date.now() + this.ttlMs,
      response,
    });
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface AuditEvent {
  timestamp: string;
  request_id: string;
  tool: string;
  duration_ms: number;
  is_error: boolean;
  error_code?: StandardErrorCode;
  idempotent_replay?: boolean;
}

interface ToolTelemetryBucket {
  calls: number;
  errors: number;
  total_ms: number;
  min_ms: number | null;
  max_ms: number;
  recent_ms: number[];
}

export class McpTelemetryTracker {
  private readonly startedAt = Date.now();
  private totalRpcRequests = 0;
  private totalToolCalls = 0;
  private totalErrors = 0;
  private totalValidationErrors = 0;
  private totalIdempotentReplays = 0;
  private readonly perTool = new Map<string, ToolTelemetryBucket>();
  private readonly auditLog: AuditEvent[] = [];

  recordRpcRequest(): void {
    this.totalRpcRequests += 1;
  }

  recordValidationError(): void {
    this.totalValidationErrors += 1;
    this.totalErrors += 1;
  }

  recordToolCall(event: AuditEvent): void {
    this.totalToolCalls += 1;
    if (event.is_error) this.totalErrors += 1;
    if (event.idempotent_replay) this.totalIdempotentReplays += 1;

    let bucket = this.perTool.get(event.tool);
    if (!bucket) {
      bucket = { calls: 0, errors: 0, total_ms: 0, min_ms: null, max_ms: 0, recent_ms: [] };
      this.perTool.set(event.tool, bucket);
    }
    bucket.calls += 1;
    if (event.is_error) bucket.errors += 1;
    bucket.total_ms += event.duration_ms;
    if (bucket.min_ms === null || event.duration_ms < bucket.min_ms) bucket.min_ms = event.duration_ms;
    if (event.duration_ms > bucket.max_ms) bucket.max_ms = event.duration_ms;
    bucket.recent_ms.push(event.duration_ms);
    if (bucket.recent_ms.length > 100) bucket.recent_ms.shift();

    this.auditLog.push(event);
    if (this.auditLog.length > 200) this.auditLog.shift();
  }

  getSummary(extra?: Record<string, unknown>) {
    const toolsSummary = [...this.perTool.entries()]
      .map(([name, b]) => {
        const sorted = [...b.recent_ms].sort((a, c) => a - c);
        const p95 = sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]
          : 0;
        return {
          tool: name,
          calls: b.calls,
          errors: b.errors,
          avg_ms: b.calls > 0 ? Math.round((b.total_ms / b.calls) * 1000) / 1000 : 0,
          p95_ms: Math.round(p95 * 1000) / 1000,
          max_ms: Math.round(b.max_ms * 1000) / 1000,
        };
      })
      .sort((a, b) => b.calls - a.calls);

    const mem = process.memoryUsage();
    return {
      success: true,
      server: 'ispsoft',
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      totals: {
        rpc_requests: this.totalRpcRequests,
        tool_calls: this.totalToolCalls,
        tool_errors: this.totalErrors,
        validation_errors: this.totalValidationErrors,
        idempotent_replays: this.totalIdempotentReplays,
        error_rate_pct: this.totalToolCalls > 0 ? Math.round((this.totalErrors / this.totalToolCalls) * 10000) / 100 : 0,
      },
      process_memory: {
        heap_used_mb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
        rss_mb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
      },
      top_tools: toolsSummary.slice(0, 25),
      recent_audit_events: this.auditLog.slice(-25),
      ...(extra ?? {}),
    };
  }

  toPrometheusText(extraGauges: Record<string, number> = {}): string {
    const lines: string[] = [
      '# HELP ispsoft_mcp_uptime_seconds Server uptime in seconds',
      '# TYPE ispsoft_mcp_uptime_seconds gauge',
      `ispsoft_mcp_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      '# HELP ispsoft_mcp_rpc_requests_total Total MCP JSON-RPC requests received',
      '# TYPE ispsoft_mcp_rpc_requests_total counter',
      `ispsoft_mcp_rpc_requests_total ${this.totalRpcRequests}`,
      '# HELP ispsoft_mcp_tool_calls_total Total MCP tool calls executed',
      '# TYPE ispsoft_mcp_tool_calls_total counter',
      `ispsoft_mcp_tool_calls_total ${this.totalToolCalls}`,
      '# HELP ispsoft_mcp_tool_errors_total Total MCP tool call errors',
      '# TYPE ispsoft_mcp_tool_errors_total counter',
      `ispsoft_mcp_tool_errors_total ${this.totalErrors}`,
      '# HELP ispsoft_mcp_validation_errors_total Total schema validation errors',
      '# TYPE ispsoft_mcp_validation_errors_total counter',
      `ispsoft_mcp_validation_errors_total ${this.totalValidationErrors}`,
      '# HELP ispsoft_mcp_idempotent_replays_total Total idempotent cache replays',
      '# TYPE ispsoft_mcp_idempotent_replays_total counter',
      `ispsoft_mcp_idempotent_replays_total ${this.totalIdempotentReplays}`,
      '# HELP ispsoft_mcp_heap_used_bytes Node.js heap used bytes',
      '# TYPE ispsoft_mcp_heap_used_bytes gauge',
      `ispsoft_mcp_heap_used_bytes ${process.memoryUsage().heapUsed}`,
    ];

    for (const [k, v] of Object.entries(extraGauges)) {
      const metric = `ispsoft_mcp_${k.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric} ${v}`);
    }

    lines.push('# HELP ispsoft_mcp_tool_duration_ms_sum Cumulative tool latency in ms');
    lines.push('# TYPE ispsoft_mcp_tool_duration_ms_sum counter');
    lines.push('# HELP ispsoft_mcp_tool_invocations_total Tool invocations by tool name');
    lines.push('# TYPE ispsoft_mcp_tool_invocations_total counter');
    for (const [tool, b] of this.perTool.entries()) {
      lines.push(`ispsoft_mcp_tool_invocations_total{tool="${tool}"} ${b.calls}`);
      lines.push(`ispsoft_mcp_tool_duration_ms_sum{tool="${tool}"} ${Math.round(b.total_ms * 1000) / 1000}`);
    }
    return lines.join('\n') + '\n';
  }
}

export const mcpTelemetry = new McpTelemetryTracker();
export const mcpIdempotency = new IdempotencyCache();
