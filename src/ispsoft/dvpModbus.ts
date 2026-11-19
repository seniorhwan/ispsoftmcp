export interface ModbusAccess {
  data_type: 'bit' | 'word';
  function_code: number;
  pdu_address: number;
  pdu_hex: string;
}

export interface ModbusMapping {
  device: string;
  model?: string;
  accesses: ModbusAccess[];
}

export interface ModbusReverseMatch {
  model: string;
  function_code: number;
  pdu_address: number;
  pdu_hex: string;
  device: string;
  data_type: 'bit' | 'word';
}

function formatAccess(dataType: 'bit' | 'word', functionCode: number, pduAddress: number): ModbusAccess {
  return {
    data_type: dataType,
    function_code: functionCode,
    pdu_address: pduAddress,
    pdu_hex: `0x${pduAddress.toString(16).toUpperCase().padStart(4, '0')}`,
  };
}

export function mapDevice(address: string, model = 'ES2'): ModbusMapping {
  if (typeof address !== 'string') {
    throw new Error('device address must be text');
  }
  const upperModel = (model || 'ES2').trim().toUpperCase();
  if (upperModel.startsWith('AS') || upperModel.startsWith('AH')) {
    return mapAsSeriesDevice(address, upperModel);
  }
  return mapDvpDevice(address, upperModel);
}

function mapDvpDevice(address: string, model: string): ModbusMapping {
  const match = /^\s*(X|Y|M|S|T|C|D)\s*(\d+)\s*$/i.exec(address);
  if (!match) {
    throw new Error('supported devices are X, Y, M, S, T, C and D');
  }
  const area = match[1].toUpperCase();
  const rawNumber = match[2];
  let number: number;
  if (area === 'X' || area === 'Y') {
    if (!/^[0-7]+$/.test(rawNumber)) {
      throw new Error(`${area} device addresses must use octal digits 0-7`);
    }
    number = parseInt(rawNumber, 8);
  } else {
    number = parseInt(rawNumber, 10);
  }
  const original = `${area}${rawNumber.toUpperCase()}`;

  const maxD = ['ES3', 'EX3', 'EH3', 'SV2', 'SE'].includes(model) ? 11999 : 9999;

  if (area === 'X' || area === 'Y') {
    if (number > 0o377) {
      throw new Error(`${original} is outside the documented octal 000-377 range`);
    }
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', area === 'X' ? 2 : 1, (area === 'X' ? 0x400 : 0x500) + number)],
    };
  }
  if (area === 'S') {
    if (number > 1023) {
      throw new Error(`${original} is outside the documented S0-S1023 range`);
    }
    return { device: original, model, accesses: [formatAccess('bit', 1, number)] };
  }
  if (area === 'M') {
    if (number > 4095) {
      throw new Error(`${original} is outside the documented M0-M4095 range`);
    }
    const pduAddress = number <= 1535 ? 0x800 + number : 0xb000 + number - 1536;
    return { device: original, model, accesses: [formatAccess('bit', 1, pduAddress)] };
  }
  if (area === 'T') {
    if (number > 255) {
      throw new Error(`${original} is outside the documented T0-T255 range`);
    }
    const addressValue = 0x600 + number;
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', 1, addressValue), formatAccess('word', 3, addressValue)],
    };
  }
  if (area === 'C') {
    if (number > 255) {
      throw new Error(`${original} is outside the documented C0-C255 range`);
    }
    const bitAddress = number <= 199 ? 0xe00 + number : 0xec8 + number - 200;
    const wordAddress = number <= 199 ? 0xe00 + number : 0x700 + (number - 200) * 2;
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', 1, bitAddress), formatAccess('word', 3, wordAddress)],
    };
  }
  if (number > maxD) {
    throw new Error(`${original} is outside the documented D0-D${maxD} range for ${model}`);
  }
  const pduAddress = number <= 4095 ? 0x1000 + number : 0x9000 + number - 4096;
  return { device: original, model, accesses: [formatAccess('word', 3, pduAddress)] };
}

function mapAsSeriesDevice(address: string, model: string): ModbusMapping {
  // AS-Series Delta Modbus mapping (per Delta AS Series Programming Manual):
  // D0..D29999 -> 0x0000..0x752F (FC03/06/16)
  // SR0..SR2047 -> 0xD000..0xD7FF (FC03/06/16)
  // T0..T511 -> word 0xE000..0xE1FF (FC03), bit 0xE000..0xE1FF (FC01)
  // C0..C511 -> word 0xE200..0xE3FF (FC03), bit 0xE200..0xE3FF (FC01)
  // HC0..HC255 -> dword 0xEC00..0xEDFF (2 words each, FC03), bit 0xFC00..0xFCFF (FC01)
  // M0..M8191 -> bit 0x0000..0x1FFF (FC01/05/15)
  // SM0..SM2047 -> bit 0x4000..0x47FF (FC01/05/15)
  // S0..S2047 -> bit 0x5000..0x57FF (FC01/05/15)
  // X0.0..X63.15 -> bit 0x6000..0x63FF (FC02) | X0..X1023 flat
  // Y0.0..Y63.15 -> bit 0xA000..0xA3FF (FC01/05/15) | Y0..Y1023 flat
  const dotMatch = /^\s*(X|Y)\s*(\d+)\.(\d+)\s*$/i.exec(address);
  if (dotMatch) {
    const area = dotMatch[1].toUpperCase();
    const word = parseInt(dotMatch[2], 10);
    const bit = parseInt(dotMatch[3], 10);
    if (word > 63 || bit > 15) {
      throw new Error(`${address.trim()} is outside AS-series ${area}0.0-${area}63.15 range`);
    }
    const offset = word * 16 + bit;
    const base = area === 'X' ? 0x6000 : 0xa000;
    return {
      device: `${area}${word}.${bit}`,
      model,
      accesses: [formatAccess('bit', area === 'X' ? 2 : 1, base + offset)],
    };
  }

  const match = /^\s*(SM|SR|HC|X|Y|M|S|T|C|D)\s*(\d+)\s*$/i.exec(address);
  if (!match) {
    throw new Error('supported AS-series devices are X, Y, M, SM, S, T, C, HC, D, and SR');
  }
  const area = match[1].toUpperCase();
  const number = parseInt(match[2], 10);
  const original = `${area}${number}`;

  if (area === 'D') {
    if (number > 29999) throw new Error(`${original} exceeds AS-series D0-D29999`);
    return { device: original, model, accesses: [formatAccess('word', 3, number)] };
  }
  if (area === 'SR') {
    if (number > 2047) throw new Error(`${original} exceeds AS-series SR0-SR2047`);
    return { device: original, model, accesses: [formatAccess('word', 3, 0xd000 + number)] };
  }
  if (area === 'M') {
    if (number > 8191) throw new Error(`${original} exceeds AS-series M0-M8191`);
    return { device: original, model, accesses: [formatAccess('bit', 1, number)] };
  }
  if (area === 'SM') {
    if (number > 2047) throw new Error(`${original} exceeds AS-series SM0-SM2047`);
    return { device: original, model, accesses: [formatAccess('bit', 1, 0x4000 + number)] };
  }
  if (area === 'S') {
    if (number > 2047) throw new Error(`${original} exceeds AS-series S0-S2047`);
    return { device: original, model, accesses: [formatAccess('bit', 1, 0x5000 + number)] };
  }
  if (area === 'X' || area === 'Y') {
    if (number > 1023) throw new Error(`${original} exceeds AS-series ${area}0-${area}1023`);
    const base = area === 'X' ? 0x6000 : 0xa000;
    return { device: original, model, accesses: [formatAccess('bit', area === 'X' ? 2 : 1, base + number)] };
  }
  if (area === 'T') {
    if (number > 511) throw new Error(`${original} exceeds AS-series T0-T511`);
    const addr = 0xe000 + number;
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', 1, addr), formatAccess('word', 3, addr)],
    };
  }
  if (area === 'C') {
    if (number > 511) throw new Error(`${original} exceeds AS-series C0-C511`);
    const addr = 0xe200 + number;
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', 1, addr), formatAccess('word', 3, addr)],
    };
  }
  if (area === 'HC') {
    if (number > 255) throw new Error(`${original} exceeds AS-series HC0-HC255`);
    return {
      device: original,
      model,
      accesses: [formatAccess('bit', 1, 0xfc00 + number), formatAccess('word', 3, 0xec00 + number * 2)],
    };
  }
  throw new Error(`Unsupported AS-series device ${original}`);
}

export function reverseMapModbus(
  pduAddress: number,
  functionCode: number,
  model = 'ES2',
): ModbusReverseMatch | null {
  const upperModel = (model || 'ES2').trim().toUpperCase();
  const isBit = [1, 2, 5, 15].includes(functionCode);
  const pduHex = `0x${pduAddress.toString(16).toUpperCase().padStart(4, '0')}`;

  if (upperModel.startsWith('AS') || upperModel.startsWith('AH')) {
    if (isBit) {
      if (pduAddress <= 0x1fff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `M${pduAddress}`, data_type: 'bit' };
      if (pduAddress >= 0x4000 && pduAddress <= 0x47ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `SM${pduAddress - 0x4000}`, data_type: 'bit' };
      if (pduAddress >= 0x5000 && pduAddress <= 0x57ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `S${pduAddress - 0x5000}`, data_type: 'bit' };
      if (pduAddress >= 0x6000 && pduAddress <= 0x63ff) {
        const off = pduAddress - 0x6000;
        return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `X${Math.floor(off / 16)}.${off % 16}`, data_type: 'bit' };
      }
      if (pduAddress >= 0xa000 && pduAddress <= 0xa3ff) {
        const off = pduAddress - 0xa000;
        return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `Y${Math.floor(off / 16)}.${off % 16}`, data_type: 'bit' };
      }
      if (pduAddress >= 0xe000 && pduAddress <= 0xe1ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `T${pduAddress - 0xe000}`, data_type: 'bit' };
      if (pduAddress >= 0xe200 && pduAddress <= 0xe3ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${pduAddress - 0xe200}`, data_type: 'bit' };
      if (pduAddress >= 0xfc00 && pduAddress <= 0xfcff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `HC${pduAddress - 0xfc00}`, data_type: 'bit' };
      return null;
    }
    if (pduAddress <= 29999) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `D${pduAddress}`, data_type: 'word' };
    if (pduAddress >= 0xd000 && pduAddress <= 0xd7ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `SR${pduAddress - 0xd000}`, data_type: 'word' };
    if (pduAddress >= 0xe000 && pduAddress <= 0xe1ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `T${pduAddress - 0xe000}`, data_type: 'word' };
    if (pduAddress >= 0xe200 && pduAddress <= 0xe3ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${pduAddress - 0xe200}`, data_type: 'word' };
    if (pduAddress >= 0xec00 && pduAddress <= 0xedfe && (pduAddress - 0xec00) % 2 === 0) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `HC${(pduAddress - 0xec00) / 2}`, data_type: 'word' };
    return null;
  }

  // DVP reverse mapping
  if (isBit) {
    if (pduAddress >= 0x0000 && pduAddress <= 0x03ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `S${pduAddress}`, data_type: 'bit' };
    if (pduAddress >= 0x0400 && pduAddress <= 0x04ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `X${(pduAddress - 0x0400).toString(8)}`, data_type: 'bit' };
    if (pduAddress >= 0x0500 && pduAddress <= 0x05ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `Y${(pduAddress - 0x0500).toString(8)}`, data_type: 'bit' };
    if (pduAddress >= 0x0600 && pduAddress <= 0x06ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `T${pduAddress - 0x0600}`, data_type: 'bit' };
    if (pduAddress >= 0x0800 && pduAddress <= 0x0dff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `M${pduAddress - 0x0800}`, data_type: 'bit' };
    if (pduAddress >= 0x0e00 && pduAddress <= 0x0ec7) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${pduAddress - 0x0e00}`, data_type: 'bit' };
    if (pduAddress >= 0x0ec8 && pduAddress <= 0x0eff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${200 + (pduAddress - 0x0ec8)}`, data_type: 'bit' };
    if (pduAddress >= 0xb000 && pduAddress <= 0xb9ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `M${1536 + (pduAddress - 0xb000)}`, data_type: 'bit' };
    return null;
  }

  if (pduAddress >= 0x0600 && pduAddress <= 0x06ff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `T${pduAddress - 0x0600}`, data_type: 'word' };
  if (pduAddress >= 0x0700 && pduAddress <= 0x076e && (pduAddress - 0x0700) % 2 === 0) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${200 + (pduAddress - 0x0700) / 2}`, data_type: 'word' };
  if (pduAddress >= 0x0e00 && pduAddress <= 0x0ec7) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `C${pduAddress - 0x0e00}`, data_type: 'word' };
  if (pduAddress >= 0x1000 && pduAddress <= 0x1fff) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `D${pduAddress - 0x1000}`, data_type: 'word' };
  if (pduAddress >= 0x9000 && pduAddress <= 0xaf0f) return { model: upperModel, function_code: functionCode, pdu_address: pduAddress, pdu_hex: pduHex, device: `D${4096 + (pduAddress - 0x9000)}`, data_type: 'word' };
  return null;
}

function modbusCrc16(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

export function planModbusRequest(options: {
  device: string;
  model?: string;
  operation: 'read' | 'write';
  slave_id?: number;
  count?: number;
  value?: number;
  transaction_id?: number;
}) {
  const mapped = mapDevice(options.device, options.model ?? 'ES2');
  const access = mapped.accesses[mapped.accesses.length - 1];
  const slaveId = Math.max(1, Math.min(247, options.slave_id ?? 1));
  const count = Math.max(1, Math.min(125, options.count ?? 1));
  const pduHi = (access.pdu_address >>> 8) & 0xff;
  const pduLo = access.pdu_address & 0xff;

  let fc: number;
  let pduBytes: number[];
  if (options.operation === 'read') {
    fc = access.function_code;
    pduBytes = [fc, pduHi, pduLo, (count >>> 8) & 0xff, count & 0xff];
  } else if (access.data_type === 'bit') {
    fc = 5;
    const coilVal = options.value ? 0xff00 : 0x0000;
    pduBytes = [fc, pduHi, pduLo, (coilVal >>> 8) & 0xff, coilVal & 0xff];
  } else {
    fc = 6;
    const regVal = (options.value ?? 0) & 0xffff;
    pduBytes = [fc, pduHi, pduLo, (regVal >>> 8) & 0xff, regVal & 0xff];
  }

  const rtuNoCrc = [slaveId, ...pduBytes];
  const crc = modbusCrc16(rtuNoCrc);
  const rtuFrame = [...rtuNoCrc, crc & 0xff, (crc >>> 8) & 0xff];

  const txId = (options.transaction_id ?? 1) & 0xffff;
  const mbapLen = 1 + pduBytes.length;
  const tcpFrame = [
    (txId >>> 8) & 0xff,
    txId & 0xff,
    0x00,
    0x00,
    (mbapLen >>> 8) & 0xff,
    mbapLen & 0xff,
    slaveId,
    ...pduBytes,
  ];

  const toHex = (arr: number[]) => arr.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

  return {
    device: mapped.device,
    model: mapped.model ?? (options.model ?? 'ES2'),
    operation: options.operation,
    function_code: fc,
    pdu_address: access.pdu_address,
    pdu_hex: access.pdu_hex,
    slave_id: slaveId,
    rtu_hex: toHex(rtuFrame),
    tcp_hex: toHex(tcpFrame),
  };
}
