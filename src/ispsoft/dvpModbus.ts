export interface ModbusAccess {
  data_type: 'bit' | 'word';
  function_code: number;
  pdu_address: number;
  pdu_hex: string;
}

export interface ModbusMapping {
  device: string;
  accesses: ModbusAccess[];
}

function formatAccess(dataType: 'bit' | 'word', functionCode: number, pduAddress: number): ModbusAccess {
  return {
    data_type: dataType,
    function_code: functionCode,
    pdu_address: pduAddress,
    pdu_hex: `0x${pduAddress.toString(16).toUpperCase().padStart(4, '0')}`,
  };
}

export function mapDevice(address: string): ModbusMapping {
  if (typeof address !== 'string') {
    throw new Error('device address must be text');
  }
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

  if (area === 'X' || area === 'Y') {
    if (number > 0o377) {
      throw new Error(`${original} is outside the documented octal 000-377 range`);
    }
    return {
      device: original,
      accesses: [formatAccess('bit', area === 'X' ? 2 : 1, (area === 'X' ? 0x400 : 0x500) + number)],
    };
  }
  if (area === 'S') {
    if (number > 1023) {
      throw new Error(`${original} is outside the documented S0-S1023 range`);
    }
    return { device: original, accesses: [formatAccess('bit', 1, number)] };
  }
  if (area === 'M') {
    if (number > 4095) {
      throw new Error(`${original} is outside the documented M0-M4095 range`);
    }
    const pduAddress = number <= 1535 ? 0x800 + number : 0xb000 + number - 1536;
    return { device: original, accesses: [formatAccess('bit', 1, pduAddress)] };
  }
  if (area === 'T') {
    if (number > 255) {
      throw new Error(`${original} is outside the documented T0-T255 range`);
    }
    const addressValue = 0x600 + number;
    return {
      device: original,
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
      accesses: [formatAccess('bit', 1, bitAddress), formatAccess('word', 3, wordAddress)],
    };
  }
  if (number > 9999) {
    throw new Error(`${original} is outside the documented D0-D9999 range`);
  }
  const pduAddress = number <= 4095 ? 0x1000 + number : 0x9000 + number - 4096;
  return { device: original, accesses: [formatAccess('word', 3, pduAddress)] };
}
