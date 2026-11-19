import { sections, propertyValue, escapeRegex } from './containers.js';
import { assertNoStructuralDelimiters } from './limits.js';
import { findExtensionModuleSpec } from './referenceCatalog.js';

export interface SerialPortConfig {
  port: 'COM1' | 'COM2' | 'COM3';
  baud_rate: number;
  data_bits: 7 | 8;
  parity: 'NONE' | 'EVEN' | 'ODD';
  stop_bits: 1 | 2;
  protocol: 'MODBUS_RTU' | 'MODBUS_ASCII' | 'PLC_LINK' | 'USER_DEFINED';
  station_address: number;
  timeout_ms: number;
}

export interface EthernetConfig {
  enabled: boolean;
  ip_address: string;
  subnet_mask: string;
  gateway: string;
  modbus_tcp_port: number;
  modbus_tcp_enabled: boolean;
  ethernet_ip_enabled: boolean;
  dhcp: boolean;
}

export interface CpuParamConfig {
  watchdog_ms: number;
  constant_scan_ms: number;
  run_stop_input: string | null;
  retain_outputs_on_stop: boolean;
  input_filter_ms: number;
  comment: string;
}

export interface ExtensionModuleConfig {
  slot: number;
  model: string;
  description?: string;
  x_start?: string | null;
  x_points?: number;
  y_start?: string | null;
  y_points?: number;
  cr_init?: Record<string, number>;
}

export interface HwConfigDocument {
  cpu: CpuParamConfig;
  serial_ports: SerialPortConfig[];
  ethernet: EthernetConfig;
  modules: ExtensionModuleConfig[];
}

export interface RetainZone {
  area: 'M' | 'S' | 'T' | 'C' | 'D';
  start: number;
  end: number;
}

export interface RetainConfigDocument {
  zones: RetainZone[];
}

export interface DeviceInitEntry {
  device: string;
  data_type: 'BOOL' | 'INT' | 'WORD' | 'DINT' | 'DWORD' | 'REAL' | 'STRING';
  value: number | boolean | string;
  comment?: string;
}

export interface DataExchangeRow {
  index: number;
  enabled: boolean;
  interface: 'COM2' | 'COM3' | 'ETHERNET';
  slave_id: number;
  slave_ip?: string;
  function_code: 1 | 2 | 3 | 4 | 5 | 6 | 15 | 16;
  remote_address: string;
  local_device: string;
  length: number;
  poll_interval_ms: number;
  comment?: string;
}

export function defaultHwConfig(model = 'ES2'): HwConfigDocument {
  const isAs = model.toUpperCase().startsWith('AS') || model.toUpperCase().startsWith('AH');
  const hasEth = isAs || ['ES2-E', 'ES3', 'EX3', 'SE'].includes(model.toUpperCase());
  return {
    cpu: {
      watchdog_ms: 200,
      constant_scan_ms: 0,
      run_stop_input: null,
      retain_outputs_on_stop: false,
      input_filter_ms: 10,
      comment: '',
    },
    serial_ports: [
      {
        port: 'COM1',
        baud_rate: 9600,
        data_bits: 7,
        parity: 'EVEN',
        stop_bits: 1,
        protocol: 'MODBUS_ASCII',
        station_address: 1,
        timeout_ms: 1000,
      },
      {
        port: 'COM2',
        baud_rate: 9600,
        data_bits: 8,
        parity: 'NONE',
        stop_bits: 1,
        protocol: 'MODBUS_RTU',
        station_address: 1,
        timeout_ms: 1000,
      },
    ],
    ethernet: {
      enabled: hasEth,
      ip_address: '192.168.1.5',
      subnet_mask: '255.255.255.0',
      gateway: '192.168.1.1',
      modbus_tcp_port: 502,
      modbus_tcp_enabled: hasEth,
      ethernet_ip_enabled: isAs,
      dhcp: false,
    },
    modules: [],
  };
}

export function defaultRetainConfig(model = 'ES2'): RetainConfigDocument {
  const upper = model.toUpperCase();
  if (upper.startsWith('AS') || upper.startsWith('AH')) {
    return {
      zones: [
        { area: 'M', start: 2048, end: 4095 },
        { area: 'S', start: 512, end: 1023 },
        { area: 'T', start: 256, end: 511 },
        { area: 'C', start: 256, end: 511 },
        { area: 'D', start: 5000, end: 29999 },
      ],
    };
  }
  return {
    zones: [
      { area: 'M', start: 512, end: 999 },
      { area: 'M', start: 2000, end: 4095 },
      { area: 'S', start: 500, end: 1023 },
      { area: 'T', start: 200, end: 255 },
      { area: 'C', start: 100, end: 255 },
      { area: 'D', start: 200, end: 999 },
      { area: 'D', start: 2000, end: 9999 },
    ],
  };
}

function upsertCustomSection(source: string, tag: string, jsonPayload: unknown, newline = '\r\n'): string {
  const body = JSON.stringify(jsonPayload, null, 2).replace(/\n/g, newline);
  assertNoStructuralDelimiters(body, tag);
  const block = `<${tag}>${newline}${body}${newline}</${tag}>`;
  const existing = sections(source, tag);
  if (existing.length > 0) {
    return source.slice(0, existing[0].start) + block + source.slice(existing[0].end);
  }
  const closeIdx = source.lastIndexOf('</PROJECT>');
  if (closeIdx !== -1) {
    return source.slice(0, closeIdx) + block + newline + source.slice(closeIdx);
  }
  return source + newline + block + newline;
}

function readCustomSection<T>(source: string, tag: string): T | null {
  const found = sections(source, tag);
  if (!found.length) return null;
  try {
    return JSON.parse(found[0].inner.trim()) as T;
  } catch {
    return null;
  }
}

function formatIoAddress(prefix: 'X' | 'Y', index: number, isOctal: boolean): string {
  return isOctal ? `${prefix}${index.toString(8)}` : `${prefix}0.${index}`;
}

export function allocateModuleIoSlots(
  modules: ExtensionModuleConfig[],
  model = 'ES2',
): ExtensionModuleConfig[] {
  const isAs = model.toUpperCase().startsWith('AS') || model.toUpperCase().startsWith('AH');
  // Base CPU typically occupies X0..X17 / Y0..Y17 (octal 0o20 = 16 points) on DVP, so extension starts at X20/Y20
  let nextX = isAs ? 0 : 0o20;
  let nextY = isAs ? 0 : 0o20;

  return modules
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((mod, idx) => {
      const spec = findExtensionModuleSpec(mod.model);
      const xPts = mod.x_points ?? spec?.x_points ?? 0;
      const yPts = mod.y_points ?? spec?.y_points ?? 0;
      const xStart =
        xPts > 0 ? mod.x_start ?? (isAs ? `X${idx + 1}.0` : formatIoAddress('X', nextX, true)) : null;
      const yStart =
        yPts > 0 ? mod.y_start ?? (isAs ? `Y${idx + 1}.0` : formatIoAddress('Y', nextY, true)) : null;
      if (!isAs) {
        if (xPts > 0) nextX = Math.ceil((nextX + xPts) / 8) * 8;
        if (yPts > 0) nextY = Math.ceil((nextY + yPts) / 8) * 8;
      }
      const crDefaults: Record<string, number> = {};
      if (spec) {
        for (const cr of spec.cr_map) {
          crDefaults[String(cr.cr)] = cr.default_value;
        }
      }
      const mergedCr: Record<string, number> = { ...crDefaults, ...(mod.cr_init ?? {}) };
      return {
        slot: mod.slot,
        model: mod.model.trim().toUpperCase(),
        description: mod.description ?? spec?.description ?? 'Custom extension module',
        x_start: xStart,
        x_points: xPts,
        y_start: yStart,
        y_points: yPts,
        cr_init: mergedCr,
      };
    });
}

export function validateHwConfig(config: HwConfigDocument): string[] {
  const errors: string[] = [];
  if (config.cpu.watchdog_ms < 10 || config.cpu.watchdog_ms > 10000) {
    errors.push(`CPU watchdog_ms (${config.cpu.watchdog_ms}) must be between 10 and 10000 ms.`);
  }
  if (config.cpu.constant_scan_ms < 0 || config.cpu.constant_scan_ms > 2000) {
    errors.push(`CPU constant_scan_ms (${config.cpu.constant_scan_ms}) must be between 0 and 2000 ms.`);
  }
  if (config.ethernet.enabled) {
    const ipRe = /^(?:\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRe.test(config.ethernet.ip_address)) {
      errors.push(`Invalid Ethernet IP address: ${config.ethernet.ip_address}`);
    }
    if (!ipRe.test(config.ethernet.subnet_mask)) {
      errors.push(`Invalid Ethernet subnet mask: ${config.ethernet.subnet_mask}`);
    }
    if (config.ethernet.modbus_tcp_port < 1 || config.ethernet.modbus_tcp_port > 65535) {
      errors.push(`Invalid Modbus TCP port: ${config.ethernet.modbus_tcp_port}`);
    }
  }
  const seenSlots = new Set<number>();
  for (const mod of config.modules) {
    if (!Number.isInteger(mod.slot) || mod.slot < 0 || mod.slot > 31) {
      errors.push(`Extension module slot ${mod.slot} must be an integer 0..31.`);
    }
    if (seenSlots.has(mod.slot)) {
      errors.push(`Duplicate extension module slot ${mod.slot}.`);
    }
    seenSlots.add(mod.slot);
  }
  for (const port of config.serial_ports) {
    if (port.station_address < 1 || port.station_address > 254) {
      errors.push(`${port.port} station_address (${port.station_address}) must be 1..254.`);
    }
  }
  return errors;
}

export function readHwConfigFromSource(source: string): HwConfigDocument {
  const model = propertyValue(source, 'Prj_DT') ?? 'ES2';
  const stored = readCustomSection<HwConfigDocument>(source, 'HWCONFIG');
  if (!stored) return defaultHwConfig(model);
  const base = defaultHwConfig(model);
  return {
    cpu: { ...base.cpu, ...(stored.cpu ?? {}) },
    serial_ports: Array.isArray(stored.serial_ports) && stored.serial_ports.length ? stored.serial_ports : base.serial_ports,
    ethernet: { ...base.ethernet, ...(stored.ethernet ?? {}) },
    modules: allocateModuleIoSlots(Array.isArray(stored.modules) ? stored.modules : [], model),
  };
}

export function writeHwConfigToSource(source: string, config: HwConfigDocument, newline = '\r\n'): string {
  const model = propertyValue(source, 'Prj_DT') ?? 'ES2';
  const normalizedConfig: HwConfigDocument = {
    ...config,
    modules: allocateModuleIoSlots(config.modules, model),
  };
  return upsertCustomSection(source, 'HWCONFIG', normalizedConfig, newline);
}

export function readRetainConfigFromSource(source: string): RetainConfigDocument {
  const model = propertyValue(source, 'Prj_DT') ?? 'ES2';
  const stored = readCustomSection<RetainConfigDocument>(source, 'RETAIN_RANGE');
  if (!stored || !Array.isArray(stored.zones)) {
    return defaultRetainConfig(model);
  }
  return stored;
}

export function writeRetainConfigToSource(source: string, config: RetainConfigDocument, newline = '\r\n'): string {
  return upsertCustomSection(source, 'RETAIN_RANGE', config, newline);
}

export function isDeviceRetained(device: string, config: RetainConfigDocument): boolean {
  const m = /^([MSTCD])(\d+)$/i.exec(device.trim());
  if (!m) return false;
  const area = m[1].toUpperCase() as RetainZone['area'];
  const num = parseInt(m[2], 10);
  return config.zones.some((z) => z.area === area && num >= z.start && num <= z.end);
}

export function readDeviceInitFromSource(source: string): DeviceInitEntry[] {
  const stored = readCustomSection<{ entries: DeviceInitEntry[] }>(source, 'DEVICE_INIT');
  return stored && Array.isArray(stored.entries) ? stored.entries : [];
}

export function writeDeviceInitToSource(source: string, entries: DeviceInitEntry[], newline = '\r\n'): string {
  return upsertCustomSection(source, 'DEVICE_INIT', { entries }, newline);
}

export function readDataExchangeFromSource(source: string): DataExchangeRow[] {
  const stored = readCustomSection<{ rows: DataExchangeRow[] }>(source, 'DATA_EXCHANGE');
  return stored && Array.isArray(stored.rows) ? stored.rows : [];
}

export function writeDataExchangeToSource(source: string, rows: DataExchangeRow[], newline = '\r\n'): string {
  return upsertCustomSection(source, 'DATA_EXCHANGE', { rows }, newline);
}

export interface CsvSymbolRow {
  scope: 'GLOBAL' | string;
  identifier: string;
  data_type: string;
  address: string;
  class_name: string;
  initial_value: string;
  comment: string;
}

export interface CsvCommentRow {
  device: string;
  comment: string;
}

function csvEscape(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

export function formatSymbolsCsv(rows: CsvSymbolRow[]): string {
  const header = 'Scope,Identifier,DataType,Address,Class,InitialValue,Comment';
  const body = rows.map((r) =>
    [r.scope, r.identifier, r.data_type, r.address, r.class_name, r.initial_value, r.comment]
      .map((c) => csvEscape(String(c ?? '')))
      .join(','),
  );
  return [header, ...body].join('\n') + '\n';
}

export function parseSymbolsCsv(csv: string): CsvSymbolRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const startIdx = /^scope\s*,/i.test(lines[0].trim()) ? 1 : 0;
  const rows: CsvSymbolRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 3) continue;
    const identifier = (cols[1] ?? '').trim();
    if (!identifier) continue;
    rows.push({
      scope: (cols[0] ?? 'GLOBAL').trim() || 'GLOBAL',
      identifier,
      data_type: (cols[2] ?? 'BOOL').trim() || 'BOOL',
      address: (cols[3] ?? '').trim().toUpperCase(),
      class_name: (cols[4] ?? 'VAR_GLOBAL').trim() || 'VAR_GLOBAL',
      initial_value: (cols[5] ?? '').trim(),
      comment: (cols[6] ?? '').trim(),
    });
  }
  return rows;
}

export function formatCommentsCsv(rows: CsvCommentRow[]): string {
  const header = 'Device,Comment';
  const body = rows.map((r) => `${csvEscape(r.device)},${csvEscape(r.comment)}`);
  return [header, ...body].join('\n') + '\n';
}

export function parseCommentsCsv(csv: string): CsvCommentRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const startIdx = /^device\s*,/i.test(lines[0].trim()) ? 1 : 0;
  const rows: CsvCommentRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const device = (cols[0] ?? '').trim().toUpperCase();
    if (!device) continue;
    rows.push({ device, comment: (cols[1] ?? '').trim() });
  }
  return rows;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function exportProjectToPlcopenXml(options: {
  projectName: string;
  model: string;
  pous: Array<{
    name: string;
    pouType: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION';
    language: 'LD' | 'ST' | 'IL' | 'SFC' | 'FBD';
    returnType?: string;
    variables: Array<{ identifier: string; type: string; class: string; address: string | null; initial_value: string; comment: string | null }>;
    bodyText: string;
  }>;
  duts?: Array<{ name: string; members: Array<{ name: string; type: string; initial?: string }> }>;
}): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    `  <fileHeader companyName="Delta Electronics (ISPSoft MCP)" productName="ISPSoft" productVersion="3.24" creationDateTime="${now}" />`,
    `  <contentHeader name="${xmlEscape(options.projectName)}" modificationDateTime="${now}">`,
    '    <coordinateInfo><fbd><scaling x="1" y="1" /></fbd><ld><scaling x="1" y="1" /></ld><sfc><scaling x="1" y="1" /></sfc></coordinateInfo>',
    `    <addData><data name="delta:model" handleUnknown="implementation"><model>${xmlEscape(options.model)}</model></data></addData>`,
    '  </contentHeader>',
    '  <types>',
    '    <dataTypes>',
  ];

  for (const dut of options.duts ?? []) {
    lines.push(`      <dataType name="${xmlEscape(dut.name)}">`);
    lines.push('        <baseType><struct>');
    for (const m of dut.members) {
      lines.push(`          <variable name="${xmlEscape(m.name)}"><type><derived name="${xmlEscape(m.type)}" /></type></variable>`);
    }
    lines.push('        </struct></baseType>');
    lines.push('      </dataType>');
  }

  lines.push('    </dataTypes>');
  lines.push('    <pous>');

  for (const pou of options.pous) {
    const pouTypeAttr = pou.pouType === 'FUNCTION_BLOCK' ? 'functionBlock' : pou.pouType === 'FUNCTION' ? 'function' : 'program';
    lines.push(`      <pou name="${xmlEscape(pou.name)}" pouType="${pouTypeAttr}">`);
    lines.push('        <interface>');
    if (pou.pouType === 'FUNCTION' && pou.returnType) {
      lines.push(`          <returnType><derived name="${xmlEscape(pou.returnType)}" /></returnType>`);
    }
    const groups: Record<string, typeof pou.variables> = {};
    for (const v of pou.variables) {
      const cls = v.class.toUpperCase();
      const tag =
        cls === 'VAR_INPUT'
          ? 'inputVars'
          : cls === 'VAR_OUTPUT'
            ? 'outputVars'
            : cls === 'VAR_IN_OUT'
              ? 'inOutVars'
              : 'localVars';
      (groups[tag] ??= []).push(v);
    }
    for (const [tag, vars] of Object.entries(groups)) {
      lines.push(`          <${tag}>`);
      for (const v of vars) {
        const addrAttr = v.address ? ` address="%${xmlEscape(v.address)}"` : '';
        lines.push(`            <variable name="${xmlEscape(v.identifier)}"${addrAttr}><type><derived name="${xmlEscape(v.type)}" /></type></variable>`);
      }
      lines.push(`          </${tag}>`);
    }
    lines.push('        </interface>');
    lines.push('        <body>');
    if (pou.language === 'ST') {
      lines.push(`          <ST><xhtml:p>${xmlEscape(pou.bodyText)}</xhtml:p></ST>`);
    } else if (pou.language === 'IL') {
      lines.push(`          <IL><xhtml:p>${xmlEscape(pou.bodyText)}</xhtml:p></IL>`);
    } else {
      lines.push(`          <ST><xhtml:p>(* Exported from ${pou.language} *)\n${xmlEscape(pou.bodyText)}</xhtml:p></ST>`);
    }
    lines.push('        </body>');
    lines.push('      </pou>');
  }

  lines.push('    </pous>');
  lines.push('  </types>');
  lines.push('</project>');
  return lines.join('\n') + '\n';
}

export function exportProjectToIecStText(options: {
  projectName: string;
  model: string;
  pous: Array<{
    name: string;
    pouType: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION';
    language: 'LD' | 'ST' | 'IL' | 'SFC' | 'FBD';
    returnType?: string;
    variables: Array<{ identifier: string; type: string; class: string; address: string | null; initial_value: string; comment: string | null }>;
    bodyText: string;
  }>;
}): string {
  const out: string[] = [
    `(* Delta ISPSoft IEC 61131-3 Export *)`,
    `(* Project: ${options.projectName} | Model: ${options.model} *)`,
    '',
  ];
  for (const pou of options.pous) {
    const kw = pou.pouType === 'FUNCTION_BLOCK' ? 'FUNCTION_BLOCK' : pou.pouType === 'FUNCTION' ? 'FUNCTION' : 'PROGRAM';
    const ret = pou.pouType === 'FUNCTION' && pou.returnType ? ` : ${pou.returnType}` : '';
    out.push(`${kw} ${pou.name}${ret}`);
    const byClass = new Map<string, typeof pou.variables>();
    for (const v of pou.variables) {
      const cls = v.class.toUpperCase() || 'VAR';
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls)!.push(v);
    }
    for (const [cls, vars] of byClass.entries()) {
      out.push(cls);
      for (const v of vars) {
        const at = v.address ? ` AT %${v.address}` : '';
        const cleanInit = v.initial_value.replace(/\[@[^\]]+@\]/g, '').trim();
        const init = cleanInit && cleanInit !== '0' ? ` := ${cleanInit}` : '';
        const cmt = v.comment ? ` (* ${v.comment} *)` : '';
        out.push(`  ${v.identifier}${at} : ${v.type}${init};${cmt}`);
      }
      out.push('END_VAR');
    }
    out.push(pou.bodyText.trimEnd());
    out.push(`END_${kw}`);
    out.push('');
  }
  return out.join('\n');
}

export function setIniKeySafe(text: string, key: string, value: string, newline = '\r\n'): string {
  const re = new RegExp(`^${escapeRegex(key)}=[^\\r\\n]*`, 'm');
  if (re.test(text)) {
    return text.replace(re, `${key}=${value}`);
  }
  return `${key}=${value}${newline}${text}`;
}
