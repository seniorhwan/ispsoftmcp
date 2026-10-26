# -*- coding: utf-8 -*-
"""把台达 DVP 指令表（IL）脚本转成 ISPSoft 可一键导入的 .mpu 程序包。

输入：一个或多个 ``.il`` 文本文件，每行一条指令，格式 ``助记符,操作数1,操作数2,...``
      例：``DPLSY,D52,K0,Y0`` / ``LDI,M30`` / ``LD=,D500,K0`` / ``STL,S0``

输出：``.mpu``（可直接用 ISPSoft「工具 → 导入/导出 → 导入程序」载入）

用法::

    python il2mpu.py --src .\\src --out program.mpu
    python il2mpu.py --src part1.il part2.il --out test.mpu --only 10   # 只取前 10 个网络
    python il2mpu.py --src .\\src --out x.mpu --show                    # 顺便打印网络结构

关键规则（都是实测得来，详见 references/mpu-format.md）：
  * 常量必须写纯数字：IL 里的 ``K1`` -> ``VAR_NAME=1``。写成 K1 会报「找不到变量」。
  * 梯形图分支必须拆成独立网络：一个网络只能有一条支路（ISPSoft 梯形图不支持 MPS/MRD/MPP）。
    因此 ``LDI M30 -> TMR Tn -> 串接点 -> DPLSY`` 会被切成两个网络，否则定时器会自锁。
  * ``END`` 不生成（ISPSoft 编译器自动加，手工输入会被判「无效指令」）。
"""

import argparse
import os
import re
import sys

from . import mpu_codec

CRLF = "\r\n"

# --- ISPSoft 侧的 API 编号（注意：与台达官方手册的 API 编号不是同一套！）---------
API_NUM = {
    "MOV": 28, "DADD": 62, "DSUB": 66, "DMUL": 70, "INC": 76,
    "ZRST": 130, "DPLSY": 170, "TMR": 257, "STL": 264, "RET": 265,
    # 以下为常见补充项，未实测，首次用到请用真实导出样本校准后再启用：
    # "DDIV": 74, "ALT": 98, "MPS": 273, ...
}

# 每条应用指令的操作数分配：(源操作数个数, 目标操作数个数)
# 实测规律：源操作数 S 放 TYPE=11（输入区），目标操作数 D 放 TYPE=12（输出区）
OP_SPLIT = {
    "MOV": (1, 1), "DADD": (2, 1), "DSUB": (2, 1), "DMUL": (2, 1),
    "INC": (0, 1), "ZRST": (2, 0), "TMR": (2, 0), "DPLSY": (2, 1),
    "STL": (1, 0), "RET": (0, 0),
}

# 节点类型编码
CONTACT_LD = {"LD": 1, "LDI": 2, "LDP": 3, "LDF": 4}     # 起新支路（接母线）
CONTACT_AND = {"AND": 1, "ANI": 2, "ANDP": 3, "ANDF": 4}  # 串联
CONTACT_OR = {"OR": 1, "ORI": 2, "ORP": 3, "ORF": 4}      # 并联
DEV_TYPE_LD, DEV_TYPE_AND, DEV_TYPE_OR = 1, 2, 3
CMP_SYMB = {"LD=": "=", "LD<=": "<=", "LD>": ">", "LD<": "<",
            "AND=": "=", "AND<=": "<=", "AND>": ">", "AND<": "<"}
COIL = {"OUT": 13, "SET": 15, "RST": 16}
T_COIL, T_LNK_OR, T_LNK_OUT = 13, 6, 29

STARTERS = set(CONTACT_LD) | {k for k in CMP_SYMB if k.startswith("LD")}
SEQ_CMPS = {"AND=", "AND<=", "AND>", "AND<"}


def nv(v):
    """操作数归一化：常量必须写纯数字。K1 -> 1，K0 -> 0，K200 -> 200。

    写成 ``K1`` ISPSoft 会当成变量名去查声明，报错误码 240「找不到变量K1的定义」。
    """
    s = str(v).strip()
    if s[:1] in ("K", "k") and s[1:].lstrip("-").isdigit():
        return s[1:]
    return s


# --------------------------------------------------------------------------
# 节点构造
# --------------------------------------------------------------------------
def node(t, var=None, lnk=None):
    a = ["[LD_NODE]", "TYPE=%d" % t]
    if var is not None:
        if isinstance(var, (list, tuple)):
            a += ["<VAR_NODE_S>"] + ["VAR_NAME=%s" % nv(v) for v in var] + ["<VAR_NODE_E>"]
        else:
            a.append("DEV_NAME=%s" % nv(var))
    if lnk is not None:
        a += ["LNK_C=%d" % lnk[0], "LNK_L=%d" % lnk[1]]
    a.append("[END_LD_NODE]")
    return a


def api_node(symb, ops):
    ns, nd = OP_SPLIT[symb]
    s_ops, d_ops = list(ops[:ns]), list(ops[ns:ns + nd])
    a = node(11, var=s_ops if s_ops else None)
    a += ["[LD_NODE]", "TYPE=9", "SYMB=%s" % symb, "DEV_NAME=",
          "API_NUM=%d" % API_NUM[symb], "[END_LD_NODE]"]
    a += node(12, var=d_ops if d_ops else None)
    a += node(7)
    return a


def cmp_node(symb, ops):
    """比较接点：TYPE=11(两操作数) -> TYPE=10(SYMB=运算符, API_NUM=-1) -> TYPE=12 -> TYPE=7"""
    a = node(11, var=list(ops))
    a += ["[LD_NODE]", "TYPE=10", "SYMB=%s" % symb, "DEV_NAME=",
          "API_NUM=-1", "[END_LD_NODE]"]
    a += node(12)
    a += node(7)
    return a


# --------------------------------------------------------------------------
# IL -> 网络切分
# --------------------------------------------------------------------------
def parse_il(paths):
    """读 .il 文件（目录则按文件名排序取其中的 *.il）-> [(助记符, [操作数]), ...]"""
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p))
                      if f.lower().endswith(".il")]
        else:
            files.append(p)
    ins = []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith(("#", ";", "//")):
                    continue
                parts = [x.strip() for x in line.split(",")]
                mn = parts[0].upper()
                if not mn:
                    continue
                ins.append((mn, [x for x in parts[1:] if x != ""]))
    return ins, files


def split_nets(ins):
    """把 IL 切成梯形图网络。

    规则：
      * ``STL`` / ``RET`` 各自独占一个网络（步进指令是母线段）
      * ``LD``/``LDI``/``LDP``/``LD=``… 起新网络
      * 串联接点 / 比较接点：若前面**已经出现过输出**，说明这是同一条件的
        第二条支路 —— 另起网络并**重写前面的条件**（梯形图里必须这样画）
      * 其余（OUT/SET/RST/应用指令）作为输出挂到当前网络的输出区
    """
    nets, cur_in, cur_out = [], [], []

    def flush():
        nonlocal cur_in, cur_out
        if cur_in or cur_out:
            nets.append({"in": cur_in, "out": cur_out})
        cur_in, cur_out = [], []

    for mn, ops in ins:
        if mn in ("STL", "RET"):
            flush()
            nets.append({"in": [], "out": [(mn, ops)]})
            continue
        if mn == "END":
            continue
        if mn in STARTERS:
            flush()
            cur_in = [(mn, ops)]
        elif mn in CONTACT_AND or mn in CONTACT_OR or mn in SEQ_CMPS:
            if cur_out:
                prev = list(cur_in)
                flush()
                cur_in = prev + [(mn, ops)]
            else:
                cur_in.append((mn, ops))
        else:
            cur_out.append((mn, ops))
    flush()
    return nets


def build_net(nid, net):
    root, out, n_or, n_out = [], [], 0, 0
    for mn, ops in net["in"]:
        if mn in CONTACT_LD:
            root += node(CONTACT_LD[mn], var=ops[0])
        elif mn in CONTACT_AND:
            root += node(CONTACT_AND[mn], var=ops[0])
        elif mn in CONTACT_OR:
            root += node(CONTACT_OR[mn], var=ops[0])
            n_or += 1
        elif mn in CMP_SYMB:
            root += cmp_node(CMP_SYMB[mn], ops)
        else:
            raise ValueError("未处理的输入侧指令: %s %s" % (mn, ops))
    for mn, ops in net["out"]:
        if mn in COIL:
            out += node(COIL[mn], var=ops[0])
            n_out += 1
        elif mn in API_NUM:
            out += api_node(mn, ops)
            n_out += 1
        else:
            raise ValueError("未处理的输出侧指令: %s %s（若为新指令，需先取 API_NUM）" % (mn, ops))
    if n_or:
        root += node(T_LNK_OR, lnk=(n_or + 1, n_or))
    if n_out > 1:
        out += node(T_LNK_OUT, lnk=(n_out, n_out - 1))
    return (["<NETWORK_START>", "<PROPERTIES_START>", "NET_ID=%d" % nid,
             "NET_LABEL=", "NET_ACTIVE=TRUE", "NET_BOOKMARK=FALSE",
             "NET_MODIFY=TRUE", "NET_FOLD=FALSE", "(", "", "*)",
             "<PROPERTIES_END>", "<ROOTLINK_START>"] + root
            + ["<ROOTLINK_END>", "<OUTLINK_START>"] + out
            + ["<OUTLINK_END>", "<NETWORK_END>"])


def build_pou(nets, pou_name="Prog0"):
    head = ["<GroupPOUFolder>", "<ProgramFolder>", "<FolderContent>", "ContentType=0",
            "ContentName=%s [PRG,LD]" % pou_name,
            "ContentPath=Program/%s [PRG,LD]" % pou_name,
            "</FolderContent>", "</ProgramFolder>", "</GroupPOUFolder>", "<POU>",
            "P_Name=%s" % pou_name, "P_En_Eno=TRUE", "P_Last_Chg=", "P_type=0",
            "P_Rtn_Type=", "P_Lang=1", "P_Step=0", "P_Version=1.00",
            "P_DeltaFB=FALSE", "P_Security=", "P_Active=TRUE", "P_Priority=9999",
            "P_DFBName=", "(", "", "*)",
            "<LOCAL_VAR>", "</LOCAL_VAR>",          # 必须为空：常量写数字，
            "<VAR_EXTERN>", "</VAR_EXTERN>",        # 不需要任何局部变量声明
            "<VAR_EXTERN_C>", "</VAR_EXTERN_C>"]
    body = []
    for i, net in enumerate(nets, start=1):
        body += build_net(i, net)
    return CRLF.join(head + body + ["</POU>"]) + CRLF


def describe(nets):
    """打印网络结构摘要（人眼核对用）。"""
    lines = []
    for i, net in enumerate(nets, start=1):
        cin = " ".join("%s%s" % (mn, (" " + ",".join(ops)) if ops else "")
                       for mn, ops in net["in"]) or "—（直接接母线）"
        cout = " ".join("%s%s" % (mn, (" " + ",".join(ops)) if ops else "")
                        for mn, ops in net["out"])
        lines.append("网络 %-3d 条件: %-46s 输出: %s" % (i, cin, cout))
    return lines


def main():
    ap = argparse.ArgumentParser(description="IL -> ISPSoft .mpu")
    ap.add_argument("--src", nargs="+", required=True,
                    help=".il 文件，或包含 part*.il 的目录（目录内按文件名排序）")
    ap.add_argument("--out", required=True, help="输出的 .mpu 路径")
    ap.add_argument("--pou", default="Prog0", help="POU 名称（默认 Prog0）")
    ap.add_argument("--only", type=int, default=0, help="只生成前 N 个网络（调试用）")
    ap.add_argument("--show", action="store_true", help="打印网络结构摘要")
    ap.add_argument("--template", help="用作 152 字节前缀模板的现有 .mpu")
    args = ap.parse_args()

    ins, files = parse_il(args.src)
    nets = split_nets(ins)
    if args.only:
        nets = nets[:args.only]
    print("源文件: %s" % ", ".join(os.path.basename(f) for f in files))
    print("IL 指令数 = %d   网络数 = %d" % (len(ins), len(nets)))
    if args.show:
        for line in describe(nets):
            print("   " + line)

    tmpl = None
    if args.template:
        with open(args.template, "rb") as f:
            tmpl = f.read()[:mpu_codec.PREFIX_LEN]

    text = build_pou(nets, args.pou)
    size = mpu_codec.pack_file(text, args.out, prefix_template=tmpl)
    print("已生成: %s  (%d 字节)" % (args.out, size))

    # 自检：解回来比对
    back = mpu_codec.extract(args.out)
    ok = back.replace("\r\n", "\n") == text.replace("\r\n", "\n")
    print("自检: 解包回读一致 = %s，网络数 = %d" % (ok, back.count("<NETWORK_START>")))
    if not ok:
        raise SystemExit("!! 打包/解包不一致，请勿使用该文件")


if __name__ == "__main__":
    main()
