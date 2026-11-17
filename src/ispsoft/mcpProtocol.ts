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
  | 'MODBUS_ADDRESS_ERROR'
  | 'CONTAINER_CORRUPT'
  | 'SECURITY_BLOCKED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AUTH_UNAUTHORIZED'
  | 'PROTOCOL_PARSE_ERROR'
  | 'PROTOCOL_INVALID_REQUEST'
  | 'PROTOCOL_METHOD_NOT_FOUND'
  | 'PROTOCOL_INVALID_PARAMS'
  | 'PROTOCOL_RESOURCE_NOT_FOUND'
  | 'INTERNAL_ERROR';

export type ErrorDomain =
  | 'MCP_PROTOCOL'
  | 'AUTH'
  | 'VALIDATION'
  | 'WORKSPACE_IO'
  | 'PROJECT_CONTAINER'
  | 'AUTHORING_OCC'
  | 'COMPILER_SYNTAX'
  | 'MODBUS_COMM'
  | 'HARDWARE_TRANSPORT'
  | 'SIMULATOR'
  | 'QUOTA_LIMIT'
  | 'INTERNAL';

export type ErrorSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type RecoveryActionType =
  | 'RETRY_IMMEDIATE'
  | 'RETRY_WITH_BACKOFF'
  | 'REFRESH_STATE_AND_RETRY'
  | 'FIX_INPUT_PARAMETERS'
  | 'RUN_DIAGNOSTIC_OR_CHECK'
  | 'FALLBACK_TO_SIMULATOR'
  | 'FALLBACK_TO_TOOL'
  | 'CREATE_OR_LIST_RESOURCE'
  | 'CLOSE_IDLE_RESOURCES'
  | 'AUTHENTICATE'
  | 'NONE';

export interface RecoveryAction {
  action: RecoveryActionType;
  description: string;
  suggested_tool?: string;
  suggested_arguments?: Record<string, unknown>;
  automated: boolean;
  priority: number;
}

export interface StandardizedErrorEnvelope {
  schema_version: '1.0.0';
  error_code: StandardErrorCode;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  message: string;
  retryable: boolean;
  remediation: string;
  recovery_actions: RecoveryAction[];
  context?: Record<string, unknown>;
  timestamp: string;
  request_id?: string;
  tool?: string;
}

export const STANDARD_ERROR_CODES: readonly StandardErrorCode[] = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT_HASH_MISMATCH',
  'UNSUPPORTED_MODEL',
  'SYNTAX_ERROR',
  'RESOURCE_LIMIT',
  'SIM_SESSION_NOT_FOUND',
  'SIM_ASSERTION_FAILED',
  'HARDWARE_NOT_QUALIFIED',
  'MODBUS_ADDRESS_ERROR',
  'CONTAINER_CORRUPT',
  'SECURITY_BLOCKED',
  'IDEMPOTENCY_CONFLICT',
  'AUTH_UNAUTHORIZED',
  'PROTOCOL_PARSE_ERROR',
  'PROTOCOL_INVALID_REQUEST',
  'PROTOCOL_METHOD_NOT_FOUND',
  'PROTOCOL_INVALID_PARAMS',
  'PROTOCOL_RESOURCE_NOT_FOUND',
  'INTERNAL_ERROR',
];

export const ERROR_DOMAINS: readonly ErrorDomain[] = [
  'MCP_PROTOCOL',
  'AUTH',
  'VALIDATION',
  'WORKSPACE_IO',
  'PROJECT_CONTAINER',
  'AUTHORING_OCC',
  'COMPILER_SYNTAX',
  'MODBUS_COMM',
  'HARDWARE_TRANSPORT',
  'SIMULATOR',
  'QUOTA_LIMIT',
  'INTERNAL',
];

export const ERROR_SEVERITIES: readonly ErrorSeverity[] = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'];

export const RECOVERY_ACTION_TYPES: readonly RecoveryActionType[] = [
  'RETRY_IMMEDIATE',
  'RETRY_WITH_BACKOFF',
  'REFRESH_STATE_AND_RETRY',
  'FIX_INPUT_PARAMETERS',
  'RUN_DIAGNOSTIC_OR_CHECK',
  'FALLBACK_TO_SIMULATOR',
  'FALLBACK_TO_TOOL',
  'CREATE_OR_LIST_RESOURCE',
  'CLOSE_IDLE_RESOURCES',
  'AUTHENTICATE',
  'NONE',
];

export const ISPSOFT_ERROR_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'ispsoft://schemas/error',
  title: 'ISPSoftStandardizedError',
  description:
    'Machine-readable fault envelope emitted for all ISPSoft MCP communication, transport, protocol, authoring, Modbus, and Soft-PLC simulation errors, with prioritized recovery actions for AI agents.',
  type: 'object',
  required: [
    'schema_version',
    'error_code',
    'domain',
    'severity',
    'message',
    'retryable',
    'remediation',
    'recovery_actions',
    'timestamp',
  ],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'string', enum: ['1.0.0'] },
    error_code: { type: 'string', enum: [...STANDARD_ERROR_CODES] },
    domain: { type: 'string', enum: [...ERROR_DOMAINS] },
    severity: { type: 'string', enum: [...ERROR_SEVERITIES] },
    message: { type: 'string', minLength: 1 },
    retryable: { type: 'boolean' },
    remediation: { type: 'string', minLength: 1 },
    recovery_actions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['action', 'description', 'automated', 'priority'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...RECOVERY_ACTION_TYPES] },
          description: { type: 'string', minLength: 1 },
          suggested_tool: { type: 'string' },
          suggested_arguments: { type: 'object', additionalProperties: { description: 'Pre-filled tool argument value' } },
          automated: { type: 'boolean' },
          priority: { type: 'integer', minimum: 1 },
        },
      },
    },
    context: {
      type: 'object',
      additionalProperties: { description: 'Structured diagnostic context fields (hashes, paths, device addresses, rpc codes)' },
    },
    timestamp: { type: 'string', minLength: 1 },
    request_id: { type: 'string' },
    tool: { type: 'string' },
  },
};

export function validateStandardizedError(payload: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Error envelope must be a JSON object'] };
  }
  const obj = payload as Record<string, unknown>;
  const allowedTop = new Set([
    'schema_version',
    'error_code',
    'domain',
    'severity',
    'message',
    'retryable',
    'remediation',
    'recovery_actions',
    'context',
    'timestamp',
    'request_id',
    'tool',
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowedTop.has(k)) errors.push(`Unexpected property '${k}'`);
  }
  if (obj.schema_version !== '1.0.0') errors.push('schema_version must be "1.0.0"');
  if (!STANDARD_ERROR_CODES.includes(obj.error_code as StandardErrorCode)) {
    errors.push(`Invalid error_code: ${String(obj.error_code)}`);
  }
  if (!ERROR_DOMAINS.includes(obj.domain as ErrorDomain)) {
    errors.push(`Invalid domain: ${String(obj.domain)}`);
  }
  if (!ERROR_SEVERITIES.includes(obj.severity as ErrorSeverity)) {
    errors.push(`Invalid severity: ${String(obj.severity)}`);
  }
  if (typeof obj.message !== 'string' || !obj.message.trim()) errors.push('message must be a non-empty string');
  if (typeof obj.retryable !== 'boolean') errors.push('retryable must be a boolean');
  if (typeof obj.remediation !== 'string' || !obj.remediation.trim()) {
    errors.push('remediation must be a non-empty string');
  }
  if (typeof obj.timestamp !== 'string' || !obj.timestamp.trim()) errors.push('timestamp must be a non-empty string');
  if (!Array.isArray(obj.recovery_actions) || obj.recovery_actions.length < 1) {
    errors.push('recovery_actions must be a non-empty array');
  } else {
    for (let i = 0; i < obj.recovery_actions.length; i++) {
      const ra = obj.recovery_actions[i] as Record<string, unknown>;
      if (!ra || typeof ra !== 'object' || Array.isArray(ra)) {
        errors.push(`recovery_actions[${i}] must be an object`);
        continue;
      }
      if (!RECOVERY_ACTION_TYPES.includes(ra.action as RecoveryActionType)) {
        errors.push(`recovery_actions[${i}].action invalid: ${String(ra.action)}`);
      }
      if (typeof ra.description !== 'string' || !ra.description.trim()) {
        errors.push(`recovery_actions[${i}].description must be non-empty string`);
      }
      if (typeof ra.automated !== 'boolean') errors.push(`recovery_actions[${i}].automated must be boolean`);
      if (typeof ra.priority !== 'number' || !Number.isInteger(ra.priority) || ra.priority < 1) {
        errors.push(`recovery_actions[${i}].priority must be integer >= 1`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

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

export interface ErrorClassification {
  error_code: StandardErrorCode;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  retryable: boolean;
  remediation: string;
  recovery_actions: RecoveryAction[];
}

export function buildStandardizedError(input: {
  error_code: StandardErrorCode;
  domain: ErrorDomain;
  severity?: ErrorSeverity;
  message: string;
  retryable: boolean;
  remediation: string;
  recovery_actions: RecoveryAction[];
  context?: Record<string, unknown>;
  request_id?: string;
  tool?: string;
}): StandardizedErrorEnvelope {
  const actions: RecoveryAction[] =
    input.recovery_actions.length > 0
      ? input.recovery_actions
      : [{ action: 'NONE', description: input.remediation, automated: false, priority: 1 }];
  const envelope: StandardizedErrorEnvelope = {
    schema_version: '1.0.0',
    error_code: input.error_code,
    domain: input.domain,
    severity: input.severity ?? 'ERROR',
    message: input.message || input.remediation,
    retryable: input.retryable,
    remediation: input.remediation,
    recovery_actions: actions,
    timestamp: new Date().toISOString(),
  };
  if (input.context && Object.keys(input.context).length > 0) envelope.context = input.context;
  if (input.request_id) envelope.request_id = input.request_id;
  if (input.tool) envelope.tool = input.tool;
  return envelope;
}

export function classifyToolError(
  output: Record<string, unknown>,
  meta?: { tool?: string; args?: Record<string, unknown>; request_id?: string },
): ErrorClassification & { error_detail: StandardizedErrorEnvelope } {
  const existingCode = typeof output.error_code === 'string' ? (output.error_code as StandardErrorCode) : undefined;
  const status = String(output.status ?? '').toUpperCase();
  const failureCategory = String(output.failure_category ?? '').toLowerCase();
  const rawMsg =
    (typeof output.error === 'string' && output.error) ||
    (Array.isArray(output.errors) && output.errors.length ? String(output.errors[0]) : '') ||
    (status ? `${status}` : 'Operation failed');
  const msg = rawMsg.toLowerCase();
  const toolName = meta?.tool ?? (typeof output.tool === 'string' ? output.tool : undefined);
  const projectPath = typeof meta?.args?.project_path === 'string' ? meta.args.project_path : undefined;
  const sessionId = typeof meta?.args?.session_id === 'string' ? meta.args.session_id : undefined;

  const context: Record<string, unknown> = {};
  if (status) context.status = status;
  if (failureCategory) context.failure_category = failureCategory;
  if (projectPath) context.project_path = projectPath;
  if (sessionId) context.session_id = sessionId;
  if (output.current_content_hash) context.current_content_hash = output.current_content_hash;
  if (output.pou_content_hash) context.pou_content_hash = output.pou_content_hash;
  if (output.validation_errors) context.validation_errors = output.validation_errors;
  if (output.model) context.model = output.model;

  const finalize = (c: ErrorClassification): ErrorClassification & { error_detail: StandardizedErrorEnvelope } => ({
    ...c,
    error_detail: buildStandardizedError({
      error_code: c.error_code,
      domain: c.domain,
      severity: c.severity,
      message: rawMsg,
      retryable: c.retryable,
      remediation: c.remediation,
      recovery_actions: c.recovery_actions,
      context,
      request_id: meta?.request_id,
      tool: toolName,
    }),
  });

  if (existingCode === 'IDEMPOTENCY_CONFLICT' || status === 'IDEMPOTENCY_CONFLICT') {
    return finalize({
      error_code: 'IDEMPOTENCY_CONFLICT',
      domain: 'MCP_PROTOCOL',
      severity: 'WARNING',
      retryable: false,
      remediation: 'Generate a fresh Idempotency-Key header or _meta.idempotency_key when changing tool arguments.',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Supply a new unique Idempotency-Key for distinct arguments, or omit Idempotency-Key for non-replayed calls.',
          automated: true,
          priority: 1,
        },
      ],
    });
  }

  if (
    existingCode === 'HARDWARE_NOT_QUALIFIED' ||
    status === 'TRANSPORT_NOT_QUALIFIED' ||
    status === 'WINDOWS_GUI_UNAVAILABLE' ||
    status === 'UNAVAILABLE_ON_LINUX' ||
    msg.includes('commgr') ||
    msg.includes('hardware connection')
  ) {
    return finalize({
      error_code: 'HARDWARE_NOT_QUALIFIED',
      domain: 'HARDWARE_TRANSPORT',
      severity: 'WARNING',
      retryable: false,
      remediation: 'Native Windows ISPSoft / COMMGR / physical PLC transport is unavailable in headless Linux mode. Use Soft-PLC simulator tools (ispsoft_sim_*) or offline static check tools.',
      recovery_actions: [
        {
          action: 'FALLBACK_TO_SIMULATOR',
          description: 'Run and monitor the PLC project in the isolated deterministic Soft-PLC simulator.',
          suggested_tool: 'ispsoft_sim_start',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 1,
        },
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'Verify logic and IEC/DVP compliance offline with static compile checks.',
          suggested_tool: 'ispsoft_static_check_and_compile',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'CONFLICT_HASH_MISMATCH' ||
    failureCategory === 'state_changed' ||
    status === 'REJECTED_BEFORE_COMPILE' ||
    (status === 'REJECTED_BEFORE_WRITE' && !output.validation_errors && !msg.includes('network_index') && !msg.includes('st not qualified') && !msg.includes('invalid model')) ||
    msg.includes('modified concurrently') ||
    msg.includes('hash mismatch')
  ) {
    return finalize({
      error_code: 'CONFLICT_HASH_MISMATCH',
      domain: 'AUTHORING_OCC',
      severity: 'WARNING',
      retryable: true,
      remediation: 'Re-read the project or POU to obtain the latest content_hash, then retry the mutation.',
      recovery_actions: [
        {
          action: 'REFRESH_STATE_AND_RETRY',
          description: 'Inspect the project to fetch the current content_hash before re-applying the edit.',
          suggested_tool: 'ispsoft_inspect_project',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 1,
        },
        {
          action: 'RETRY_IMMEDIATE',
          description: 'Re-submit the edit with expected_content_hash updated to current_content_hash.',
          suggested_tool: toolName,
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'UNSUPPORTED_MODEL' ||
    status === 'UNSUPPORTED_MODEL' ||
    status === 'MODEL_NOT_QUALIFIED' ||
    msg.includes('unsupported model') ||
    msg.includes('qualified only for dvp es2')
  ) {
    return finalize({
      error_code: 'UNSUPPORTED_MODEL',
      domain: 'VALIDATION',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Call ispsoft_list_supported_plc_types to select a qualified canonical Delta PLC model.',
      recovery_actions: [
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'List supported canonical Delta AS/DVP PLC models and capabilities.',
          suggested_tool: 'ispsoft_list_supported_plc_types',
          suggested_arguments: {},
          automated: true,
          priority: 1,
        },
      ],
    });
  }

  if (
    existingCode === 'MODBUS_ADDRESS_ERROR' ||
    toolName === 'ispsoft_map_dvp_modbus_addresses' ||
    msg.includes('octal digits') ||
    msg.includes('outside the documented') ||
    msg.includes('supported devices are x, y, m, s, t, c and d')
  ) {
    return finalize({
      error_code: 'MODBUS_ADDRESS_ERROR',
      domain: 'MODBUS_COMM',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Verify DVP ES2 device area and valid numbering (X/Y octal 000-377, S0-1023, M0-4095, T/C0-255, D0-9999).',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Correct out-of-range or non-octal X/Y addresses and supply 1-200 address strings.',
          automated: true,
          priority: 1,
        },
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'Inspect project SYSTEM_VAR device ranges to confirm valid memory boundaries.',
          suggested_tool: 'ispsoft_get_memory_usage_map',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'SECURITY_BLOCKED' ||
    status === 'BLOCKED' ||
    msg.includes('unsafe') ||
    msg.includes('traversal') ||
    msg.includes('must reside inside') ||
    msg.includes('reserved windows') ||
    msg.includes('blocked')
  ) {
    return finalize({
      error_code: 'SECURITY_BLOCKED',
      domain: 'WORKSPACE_IO',
      severity: 'CRITICAL',
      retryable: false,
      remediation: 'All file paths must remain strictly inside /workspace without traversal segments or reserved OS names.',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Rewrite path to a normalized /workspace/<name>.isp virtual path.',
          automated: true,
          priority: 1,
        },
        {
          action: 'CREATE_OR_LIST_RESOURCE',
          description: 'List permitted files currently inside /workspace.',
          suggested_tool: 'ispsoft_manage_workspace_files',
          suggested_arguments: { action: 'list' },
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (existingCode === 'SIM_ASSERTION_FAILED' || status === 'SEQUENCE_ASSERTION_FAILED') {
    return finalize({
      error_code: 'SIM_ASSERTION_FAILED',
      domain: 'SIMULATOR',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Inspect sequence step observed vs expected device states and adjust PLC logic or test stimulus.',
      recovery_actions: [
        {
          action: 'RUN_DIAGNOSTIC_OR_CHECK',
          description: 'Inspect live Soft-PLC registers, forced bits, and scan trace to diagnose the assertion failure.',
          suggested_tool: 'ispsoft_sim_monitor',
          suggested_arguments: sessionId ? { session_id: sessionId } : undefined,
          automated: true,
          priority: 1,
        },
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'Read historical scan-by-scan data trace from the simulator watch table.',
          suggested_tool: 'ispsoft_sim_watch_table',
          suggested_arguments: sessionId ? { session_id: sessionId, action: 'trace' } : undefined,
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'SIM_SESSION_NOT_FOUND' ||
    msg.includes('unknown simulator session') ||
    status === 'SESSION_NOT_FOUND'
  ) {
    return finalize({
      error_code: 'SIM_SESSION_NOT_FOUND',
      domain: 'SIMULATOR',
      severity: 'ERROR',
      retryable: false,
      remediation: 'List active simulator sessions with ispsoft_sim_list or start a new session with ispsoft_sim_start.',
      recovery_actions: [
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'List currently active Soft-PLC simulator sessions.',
          suggested_tool: 'ispsoft_sim_list',
          suggested_arguments: {},
          automated: true,
          priority: 1,
        },
        {
          action: 'CREATE_OR_LIST_RESOURCE',
          description: 'Start a fresh Soft-PLC simulator session for the target .isp project.',
          suggested_tool: 'ispsoft_sim_start',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'CONTAINER_CORRUPT' ||
    msg.includes('deflate') ||
    msg.includes('crc') ||
    msg.includes('invalid container') ||
    msg.includes('invalid or truncated') ||
    msg.includes('unsupported container') ||
    msg.includes('missing <project>') ||
    msg.includes('invalid source encoding')
  ) {
    return finalize({
      error_code: 'CONTAINER_CORRUPT',
      domain: 'PROJECT_CONTAINER',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Verify .isp/.mpu container integrity or restore from the latest workspace backup.',
      recovery_actions: [
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'Restore the project from its latest pre-mutation backup (.latest.before.isp) if available.',
          suggested_tool: 'ispsoft_manage_workspace_files',
          suggested_arguments: projectPath ? { action: 'restore_backup', path: projectPath } : { action: 'list' },
          automated: true,
          priority: 1,
        },
        {
          action: 'CREATE_OR_LIST_RESOURCE',
          description: 'List valid project artifacts in /workspace.',
          suggested_tool: 'ispsoft_list_projects',
          suggested_arguments: {},
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'NOT_FOUND' ||
    msg.includes('file not found') ||
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('no pou named')
  ) {
    return finalize({
      error_code: 'NOT_FOUND',
      domain: 'WORKSPACE_IO',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Verify workspace file paths via ispsoft_list_projects or inspect project overview for POU/DUT names.',
      recovery_actions: [
        {
          action: 'CREATE_OR_LIST_RESOURCE',
          description: 'List all workspace files to locate the exact virtual path.',
          suggested_tool: 'ispsoft_manage_workspace_files',
          suggested_arguments: { action: 'list' },
          automated: true,
          priority: 1,
        },
        ...(projectPath
          ? [
              {
                action: 'FALLBACK_TO_TOOL' as const,
                description: 'Inspect the project overview to verify POU, task, and DUT names.',
                suggested_tool: 'ispsoft_get_project_overview',
                suggested_arguments: { project_path: projectPath },
                automated: true,
                priority: 2,
              },
            ]
          : []),
      ],
    });
  }

  if (
    existingCode === 'RESOURCE_LIMIT' ||
    msg.includes('limit') ||
    msg.includes('quota') ||
    msg.includes('maximum') ||
    msg.includes('exceeds')
  ) {
    return finalize({
      error_code: 'RESOURCE_LIMIT',
      domain: 'QUOTA_LIMIT',
      severity: 'WARNING',
      retryable: true,
      remediation: 'Reduce batch size, close idle simulator sessions, or clean up backup files before retrying.',
      recovery_actions: [
        {
          action: 'CLOSE_IDLE_RESOURCES',
          description: 'Clean up *.before.* backup files in /workspace to free storage quota.',
          suggested_tool: 'ispsoft_manage_workspace_files',
          suggested_arguments: { action: 'cleanup_backups' },
          automated: true,
          priority: 1,
        },
        {
          action: 'CLOSE_IDLE_RESOURCES',
          description: 'List active simulator sessions and close unused ones.',
          suggested_tool: 'ispsoft_sim_list',
          suggested_arguments: {},
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'SYNTAX_ERROR' ||
    status === 'TRANSACTION_ABORTED_COMPILE_ERROR' ||
    status === 'OFFLINE_STATIC_CHECK_FAILED' ||
    status === 'LD_PROGRAM_STATIC_CHECK_FAILED' ||
    msg.includes('unsupported opcode') ||
    msg.includes('syntax') ||
    msg.includes('parse')
  ) {
    return finalize({
      error_code: 'SYNTAX_ERROR',
      domain: 'COMPILER_SYNTAX',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Run ispsoft_validate_il or ispsoft_static_check_and_compile to inspect exact syntax or IEC check issues.',
      recovery_actions: [
        {
          action: 'RUN_DIAGNOSTIC_OR_CHECK',
          description: 'Run full offline static check and compiler verification to pinpoint failing POUs and rungs.',
          suggested_tool: 'ispsoft_static_check_and_compile',
          suggested_arguments: projectPath ? { project_path: projectPath } : undefined,
          automated: true,
          priority: 1,
        },
        {
          action: 'FALLBACK_TO_TOOL',
          description: 'Validate IL instruction syntax and operand formats directly.',
          suggested_tool: 'ispsoft_validate_il',
          automated: true,
          priority: 2,
        },
      ],
    });
  }

  if (
    existingCode === 'VALIDATION_ERROR' ||
    failureCategory === 'validation_error' ||
    status === 'REJECTED_BEFORE_READ' ||
    status === 'REJECTED_BEFORE_IO' ||
    status === 'NO_LD_NETWORKS' ||
    status === 'NETWORK_INDEX_OUT_OF_RANGE' ||
    status === 'REJECTED_BEFORE_WRITE' ||
    Array.isArray(output.validation_errors) ||
    msg.includes('required') ||
    msg.includes('invalid') ||
    msg.includes('must be') ||
    msg.includes('expected')
  ) {
    return finalize({
      error_code: 'VALIDATION_ERROR',
      domain: 'VALIDATION',
      severity: 'ERROR',
      retryable: false,
      remediation: 'Correct invalid or out-of-range arguments against the tool inputSchema and retry.',
      recovery_actions: [
        {
          action: 'FIX_INPUT_PARAMETERS',
          description: 'Update parameter types, required fields, or index ranges to match the tool schema.',
          automated: true,
          priority: 1,
        },
        ...(projectPath
          ? [
              {
                action: 'FALLBACK_TO_TOOL' as const,
                description: 'Inspect project structure before retrying with verified POU or network indices.',
                suggested_tool: 'ispsoft_get_project_overview',
                suggested_arguments: { project_path: projectPath },
                automated: true,
                priority: 2,
              },
            ]
          : []),
      ],
    });
  }

  return finalize({
    error_code: existingCode ?? 'INTERNAL_ERROR',
    domain: 'INTERNAL',
    severity: 'CRITICAL',
    retryable: false,
    remediation: 'Inspect error_detail.message and run ispsoft_doctor to verify environment and workspace health.',
    recovery_actions: [
      {
        action: 'RUN_DIAGNOSTIC_OR_CHECK',
        description: 'Run environment, workspace, and simulator health diagnostics.',
        suggested_tool: 'ispsoft_doctor',
        suggested_arguments: {},
        automated: true,
        priority: 1,
      },
    ],
  });
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
