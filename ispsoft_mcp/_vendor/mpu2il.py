# -*- coding: utf-8 -*-
"""反向：把 .mpu 还原成人能读的清单，用于核对/审查。

用途：
  * 拿到别人给的 .mpu（或自己生成的），想确认里面到底是什么逻辑
  * 与参考 IL 逐网络对照

用法::

    python mpu2il.py 程序.mpu              # 按网络列出「条件 -> 输出」
    python mpu2il.py 程序.mpu --il         # 输出扁平 IL（可另存为 .il 再用 il2mpu 回灌）
    python mpu2il.py 程序.mpu --raw        # 输出原始文本（Unzipped.src）
"""

import argparse
import os
import re
import sys

from . import mpu_codec

TYPE_CONTACT = {1: "open", 2: "nc", 3: "pulse", 4: "fall"}
LD_MN = {"open": "LD", "nc": "LDI", "pulse": "LDP", "fall": "LDF"}
AND_MN = {"open": "AND", "nc": "ANI", "pulse": "ANDP", "fall": "ANDF"}
OR_MN = {"open": "OR", "nc": "ORI", "pulse": "ORP", "fall": "ORF"}
COIL_MN = {13: "OUT", 15: "SET", 16: "RST"}


def parse_networks(text):
    nets = []
    for blk in re.findall(r"<NETWORK_START>(.*?)<NETWORK_END>", text, re.S):
        nid = re.search(r"NET_ID=(\d+)", blk)
        root = re.search(r"<ROOTLINK_START>(.*?)<ROOTLINK_END>", blk, re.S)
        out = re.search(r"<OUTLINK_START>(.*?)<OUTLINK_END>", blk, re.S)
        nets.append({
            "id": int(nid.group(1)) if nid else -1,
            "root": parse_nodes(root.group(1) if root else ""),
            "out": parse_nodes(out.group(1) if out else ""),
        })
    return nets


def parse_nodes(seg):
    nodes = []
    for blk in re.findall(r"\[LD_NODE\](.*?)\r?\n\[END_LD_NODE\]", seg, re.S):
        t = re.search(r"TYPE=(\d+)", blk)
        n = {
            "type": int(t.group(1)) if t else -1,
            "dev": re.search(r"DEV_NAME=([^\r\n]*)", blk),
            "symb": re.search(r"SYMB=([^\r\n]*)", blk),
            "api": re.search(r"API_NUM=(-?\d+)", blk),
            "vars": re.findall(r"VAR_NAME=([^\r\n]*)", blk),
            "lnk": None,
        }
        n["dev"] = n["dev"].group(1) if n["dev"] else None
        n["symb"] = n["symb"].group(1) if n["symb"] else None
        m = re.search(r"LNK_C=(\d+)\r?\nLNK_L=(\d+)", blk)
        if m:
            n["lnk"] = (int(m.group(1)), int(m.group(2)))
        nodes.append(n)
    return nodes


def as_k(v):
    """纯数字还原成 K 形式，便于与源 IL 对照。"""
    return "K" + v if re.fullmatch(r"-?\d+", v or "") else v


def net_to_il(net):
    """一个网络 -> [(助记符, [操作数]), ...]（条件在前、输出在后）"""
    root, out = net["root"], net["out"]
    lines = []

    # 找出并联支路：末尾的 TYPE=6 节点给出并联个数
    or_n = 0
    body = root
    if root and root[-1]["type"] == 6 and root[-1]["lnk"]:
        or_n = root[-1]["lnk"][1]
        body = root[:-1]
    or_idx = set(range(len(body) - or_n, len(body))) if or_n else set()

    first = True
    i = 0
    while i < len(body):
        nd = body[i]
        if nd["type"] in TYPE_CONTACT:
            kind = TYPE_CONTACT[nd["type"]]
            if i in or_idx:
                mn = OR_MN[kind]
            elif first:
                mn = LD_MN[kind]
            else:
                mn = AND_MN[kind]
            lines.append((mn, [nd["dev"]]))
            first = False
        elif nd["type"] == 11:
            # 应用指令组：TYPE=11 -> TYPE=9/10 -> TYPE=12 -> TYPE=7
            nxt = body[i + 1] if i + 1 < len(body) else None
            ops = [as_k(v) for v in nd["vars"]]
            if nxt and nxt["type"] == 9:
                j = i + 2
                while j < len(body) and body[j]["type"] not in (12,):
                    j += 1
                if j < len(body):
                    ops += [as_k(v) for v in body[j]["vars"]]
                lines.append((nxt["symb"], ops))
                i = j
            elif nxt and nxt["type"] == 10:
                mn = ("LD" if first else "AND") + nxt["symb"]
                j = i + 2
                while j < len(body) and body[j]["type"] != 12:
                    j += 1
                if j < len(body):
                    ops += [as_k(v) for v in body[j]["vars"]]
                lines.append((mn, ops))
                first = False
                i = j
        i += 1

    i = 0
    while i < len(out):
        nd = out[i]
        if nd["type"] in COIL_MN:
            lines.append((COIL_MN[nd["type"]], [nd["dev"]]))
        elif nd["type"] == 11:
            nxt = out[i + 1] if i + 1 < len(out) else None
            ops = [as_k(v) for v in nd["vars"]]
            if nxt and nxt["type"] == 9:
                j = i + 2
                while j < len(out) and out[j]["type"] != 12:
                    j += 1
                if j < len(out):
                    ops += [as_k(v) for v in out[j]["vars"]]
                lines.append((nxt["symb"], ops))
                i = j
        i += 1
    return lines


def main():
    ap = argparse.ArgumentParser(description=".mpu -> 可读清单")
    ap.add_argument("mpu")
    ap.add_argument("--il", action="store_true", help="输出扁平 IL（一行一条指令）")
    ap.add_argument("--raw", action="store_true", help="输出原始文本")
    ap.add_argument("--net", type=int, help="只看某一个网络号")
    a = ap.parse_args()

    text = mpu_codec.extract(a.mpu)
    if a.raw:
        sys.stdout.write(text)
        return
    nets = parse_networks(text)
    if a.net:
        nets = [n for n in nets if n["id"] == a.net]

    if a.il:
        for net in nets:
            for mn, ops in net_to_il(net):
                print("%s,%s" % (mn, ",".join(ops)))
        return

    print("== %s ==  共 %d 个网络" % (os.path.basename(a.mpu), len(nets)))
    COND = {"LD", "LDI", "LDP", "LDF", "AND", "ANI", "ANDP", "ANDF",
            "OR", "ORI", "ORP", "ORF"}
    for net in nets:
        lines = net_to_il(net)

        def is_cond(mn):
            return mn in COND or (len(mn) > 2 and mn[:2] in ("LD", "AN", "OR"))

        def fmt(items):
            return " ".join(("%s %s" % (mn, " ".join(ops))).strip() for mn, ops in items)

        cond = fmt([x for x in lines if is_cond(x[0])])
        outp = fmt([x for x in lines if not is_cond(x[0])])
        print("网络 %-3d  条件: %-44s 输出: %s"
              % (net["id"], cond or "—（直接接母线）", outp))


if __name__ == "__main__":
    main()
