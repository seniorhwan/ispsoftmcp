"""DVP file transforms backed by pinned upstream serializers, not a compiler."""
from __future__ import annotations

import re

from ._vendor import il2mpu, mpu2il, mpu_codec
from .limits import FileTransformError
from . import packages


def parse_il(text: str) -> list:
    instructions = []
    contacts = set(il2mpu.CONTACT_LD) | set(il2mpu.CONTACT_AND) | set(il2mpu.CONTACT_OR)
    arity = {op: 1 for op in contacts | set(il2mpu.COIL)}
    arity.update({op: 2 for op in il2mpu.CMP_SYMB})
    arity.update({op: sum(split) for op, split in il2mpu.OP_SPLIT.items()})
    arity['END'] = 0
    ended = False
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith(('#', ';', '//')):
            continue
        pieces = [x.strip() for x in line.split(',')]
        op, operands = pieces[0].upper(), pieces[1:]
        if op not in arity or len(operands) != arity[op] or any(not p for p in operands):
            raise FileTransformError(f'Unsupported opcode or operand count on IL line {number}: {op}')
        if ended:
            raise FileTransformError('Instructions after END would be discarded')
        if any(not re.fullmatch(r'(?:[A-Za-z_][A-Za-z_0-9]*|-?\d+)', p) for p in operands):
            raise FileTransformError(f'Unsupported operand syntax on IL line {number}')
        ended = op == 'END'
        instructions.append((op, operands))
    if not instructions or all(op == 'END' for op, _ in instructions):
        raise FileTransformError('No executable IL instructions')
    # The upstream flat network form puts OR contacts at the end of the input
    # group. Mixed OR then AND cannot be represented by that serializer.
    for net in il2mpu.split_nets(instructions):
        saw_or = False
        for op, _ in net['in']:
            if op in il2mpu.CONTACT_OR:
                saw_or = True
            elif saw_or:
                raise FileTransformError('OR followed by series logic requires a richer Ladder serializer')
        if not net['out']:
            raise FileTransformError('Network without an output is unsupported')
    return instructions


def il_to_mpu(text: str, pou_name: str, encoding: str) -> tuple[bytes, dict]:
    if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,63}', pou_name):
        raise FileTransformError('POU name must be an ASCII IEC identifier (maximum 64 characters)')
    instructions = parse_il(text)
    nets = il2mpu.split_nets(instructions)
    source = il2mpu.build_pou(nets, pou_name).encode(encoding)
    prefix = mpu_codec.prefill_prefix(0)
    data = packages.pack(prefix, {mpu_codec.ENTRY_NAME: source})
    return data, dict(network_count=len(nets), pou_name=pou_name, encoding=encoding,
                      warnings=['POU package only; CPU configuration, task assignment and vendor compilation are required.',
                                'END is omitted because ISPSoft adds it; output branches may become separate networks.'])


def _canonical(network: dict) -> tuple:
    groups = []
    for key in ('root', 'out'):
        groups.append(tuple((n['type'], n['dev'], n['symb'],
                             n['api'].group(1) if n['api'] else None,
                             tuple(n['vars']), n['lnk']) for n in network[key]))
    return tuple(groups)


def mpu_to_il(data: bytes, encoding: str) -> tuple[str, dict]:
    _, members = packages.unpack(data)
    if set(members) != {mpu_codec.ENTRY_NAME}:
        raise FileTransformError('Expected a single Unzipped.src member')
    source = members[mpu_codec.ENTRY_NAME].decode(encoding)
    if source.count('<POU>') != 1 or source.count('</POU>') != 1:
        raise FileTransformError('Expected exactly one POU in the package')
    if re.search(r'(?m)^P_Security=([^\r\n]+)', source):
        raise FileTransformError('Protected POU is unsupported')
    if re.search(r'(?m)^NET_ACTIVE=(?!TRUE\r?$)', source):
        raise FileTransformError('Inactive or unknown network state cannot be represented in flat IL')
    nets = mpu2il.parse_networks(source)
    if not nets or source.count('<NETWORK_START>') != len(nets) or source.count('<NETWORK_END>') != len(nets):
        raise FileTransformError('Missing or malformed Ladder networks')
    if source.count('[LD_NODE]') != sum(len(n['root']) + len(n['out']) for n in nets):
        raise FileTransformError('Malformed or unparsed Ladder nodes')
    lines = []
    for net in nets:
        values = mpu2il.net_to_il(net)
        text = '\n'.join(','.join([op, *operands]) for op, operands in values)
        parsed = parse_il(text)
        rebuilt = mpu2il.parse_networks(il2mpu.build_pou(il2mpu.split_nets(parsed)))
        if len(rebuilt) != 1 or _canonical(rebuilt[0]) != _canonical(net):
            raise FileTransformError('Network contains unsupported layout; conversion would lose nodes')
        lines.extend(','.join([op, *operands]) for op, operands in values)
    return '\n'.join(lines) + '\n', dict(network_count=len(nets), encoding=encoding,
                                           warnings=['Flattened instruction listing; comments, variables and project metadata are not represented in IL.'])
