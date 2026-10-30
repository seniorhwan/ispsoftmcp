"""Offline DVP device-to-Modbus PDU address translation.

The address regions follow Delta's DVP-PLC Application Manual, section 2.12.
This module only translates addresses; it does not open serial ports or prove
that a specific CPU/port has Modbus enabled.
"""
from __future__ import annotations

import re


def map_device(address: str) -> dict[str, str | int | list[dict[str, str | int]]]:
    """Map one documented DVP device to a Modbus function and zero-based PDU address."""
    if not isinstance(address, str):
        raise ValueError("device address must be text")
    match = re.fullmatch(r"\s*(X|Y|M|S|T|C|D)\s*(\d+)\s*", address, re.I)
    if not match:
        raise ValueError("supported devices are X, Y, M, S, T, C and D")
    area, raw_number = match.groups()
    area = area.upper()
    if area in {"X", "Y"}:
        try:
            number = int(raw_number, 8)
        except ValueError as exc:
            raise ValueError(f"{area} device addresses must use octal digits 0-7") from exc
    else:
        number = int(raw_number, 10)
    original = f"{area}{raw_number.upper()}"

    if area in {"X", "Y"}:
        if number > 0o377:
            raise ValueError(f"{original} is outside the documented octal 000-377 range")
        return {
            "device": original,
            "accesses": [{
                "data_type": "bit",
                "function_code": 2 if area == "X" else 1,
                "pdu_address": (0x400 if area == "X" else 0x500) + number,
            }],
        }
    if area == "S":
        if number > 1023:
            raise ValueError(f"{original} is outside the documented S0-S1023 range")
        return {"device": original, "accesses": [{"data_type": "bit", "function_code": 1,
                                                   "pdu_address": number}]}
    if area == "M":
        if number > 4095:
            raise ValueError(f"{original} is outside the documented M0-M4095 range")
        pdu_address = 0x800 + number if number <= 1535 else 0xB000 + number - 1536
        return {"device": original, "accesses": [{"data_type": "bit", "function_code": 1,
                                                   "pdu_address": pdu_address}]}
    if area == "T":
        if number > 255:
            raise ValueError(f"{original} is outside the documented T0-T255 range")
        address_value = 0x600 + number
        return {"device": original, "accesses": [
            {"data_type": "bit", "function_code": 1, "pdu_address": address_value},
            {"data_type": "word", "function_code": 3, "pdu_address": address_value},
        ]}
    if area == "C":
        if number > 255:
            raise ValueError(f"{original} is outside the documented C0-C255 range")
        bit_address = 0xE00 + number if number <= 199 else 0xEC8 + number - 200
        word_address = 0xE00 + number if number <= 199 else 0x700 + (number - 200) * 2
        return {"device": original, "accesses": [
            {"data_type": "bit", "function_code": 1, "pdu_address": bit_address},
            {"data_type": "word", "function_code": 3, "pdu_address": word_address},
        ]}
    if number > 9999:
        raise ValueError(f"{original} is outside the documented D0-D9999 range")
    pdu_address = 0x1000 + number if number <= 4095 else 0x9000 + number - 4096
    return {"device": original, "accesses": [{"data_type": "word", "function_code": 3,
                                               "pdu_address": pdu_address}]}

