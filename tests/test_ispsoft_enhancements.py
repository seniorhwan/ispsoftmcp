"""Unit tests covering Milestone 3 architectural enhancements and defect fixes for ISPSoft MCP.

Covers:
1. Modbus 32-bit counter word addresses (C200-C255) in dvp_modbus.py.
2. CRLF normalization and IL parser whitespace/negative constants (K-5) in containers.py and dvp.py.
3. Optimistic Concurrency Control (content_hash) across read and mutation tools.
4. Uniform dry_run mode across all mutation and compile tools with zero disk side effects.
5. Standardized error envelopes and failure categories (state_changed, validation_error, binding_conflict).
6. Value budgeting and whole-value omission in limits.py.
7. Diagnostic doctor subsystem (ispsoft_doctor tool and CLI flag).
"""
from __future__ import annotations

import json
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import ispsoft_mcp_server as server
from ispsoft_mcp import containers, dvp, dvp_modbus, limits, packages
from ispsoft_mcp.limits import (
    MAX_ITEM_CHARS,
    MAX_RESPONSE_CHARS,
    budget_payload,
    compute_content_hash,
    enforce_value_budget,
)


ES2_TEST_SOURCE = """<PROJECT>
Active_CodePage=1252
Prj_ISPVer=3.24
Prj_DT=ES2
Prj_C_SourceCodeLocked=FALSE
</PROJECT>
[DEVICE_CMT_START]
M0::Start request
X0::Input sensor
[DEVICE_CMT_END]
<SYSTEM_VAR>
[BIT_RANGE]
<M>0-999
[STEP_RANGE]
<S>0-911
[TIMER_RANGE]
<T>0-127
</SYSTEM_VAR>
<POU>
P_Name=MainProgram
P_Lang=2
P_type=0
<LOCAL_VAR>
VAR
count : INT := 0 {VAR};
END_VAR
</LOCAL_VAR>
<IL_ST_CODE>
count := count + 1;
Y0 := X0;
</IL_ST_CODE>
</POU>
""".replace("\n", "\r\r\n")


def make_es2_container(source: str = ES2_TEST_SOURCE, trailer: bytes = b"OPAQUE-TRAILER") -> bytes:
    raw = source.encode("cp1252")
    compressor = zlib.compressobj(level=9, wbits=-15)
    compressed = compressor.compress(raw) + compressor.flush()
    pointer = 0xA4
    end = pointer + 6 + len(compressed)
    header = bytearray(pointer)
    struct.pack_into("<II", header, 0x0C, 1020, 8)
    struct.pack_into("<I", header, 0x58, end)
    struct.pack_into("<I", header, 0x7C, len(raw))
    struct.pack_into("<I", header, 0x94, end - pointer)
    struct.pack_into("<I", header, 0x98, pointer)
    return bytes(header) + struct.pack("<HI", 8, zlib.crc32(raw) & 0xFFFFFFFF) + compressed + trailer


def make_ld_container() -> bytes:
    network = """<NETWORK_START>
<PROPERTIES_START>
NetworkID=1
<PROPERTIES_END>
<ROOTLINK_START>
[LD_NODE]
TYPE=1
DEV_NAME=X0
[END_LD_NODE]
<ROOTLINK_END>
<OUTLINK_START>
[LD_NODE]
TYPE=13
DEV_NAME=Y0
[END_LD_NODE]
<OUTLINK_END>
<NETWORK_END>
"""
    source = ES2_TEST_SOURCE.replace("P_Lang=2", "P_Lang=1").replace(
        "</POU>", network + "</POU>"
    )
    return make_es2_container(source)


class IspsoftEnhancementsTests(unittest.TestCase):
    """Test suite covering the 8 Milestone 3 defects and enhancements."""

    # -------------------------------------------------------------------------
    # 1. Modbus 32-bit Counter Word Address Calculation (DEF-MODBUS-01)
    # -------------------------------------------------------------------------
    def test_modbus_32bit_counter_address_calculation(self) -> None:
        """Verify 32-bit counter word addresses use (number - 200) * 2."""
        # 16-bit counters: 1 word each at 0xE00 + number
        c0 = dvp_modbus.map_device("C0")["accesses"]
        self.assertEqual(c0[0]["pdu_address"], 0xE00)  # bit
        self.assertEqual(c0[1]["pdu_address"], 0xE00)  # word

        c199 = dvp_modbus.map_device("C199")["accesses"]
        self.assertEqual(c199[0]["pdu_address"], 0xE00 + 199)
        self.assertEqual(c199[1]["pdu_address"], 0xE00 + 199)

        # 32-bit counters: 2 words each at 0x700 + (number - 200) * 2
        c200 = dvp_modbus.map_device("C200")["accesses"]
        self.assertEqual(c200[0]["pdu_address"], 0xEC8)  # bit: 0xEC8 + (200 - 200)
        self.assertEqual(c200[1]["pdu_address"], 0x700)  # word: 0x700 + 0 * 2

        c201 = dvp_modbus.map_device("C201")["accesses"]
        self.assertEqual(c201[0]["pdu_address"], 0xEC9)
        self.assertEqual(c201[1]["pdu_address"], 0x702)  # word: 0x700 + 1 * 2 = 0x702

        c202 = dvp_modbus.map_device("C202")["accesses"]
        self.assertEqual(c202[1]["pdu_address"], 0x704)  # word: 0x700 + 2 * 2 = 0x704

        c210 = dvp_modbus.map_device("C210")["accesses"]
        self.assertEqual(c210[1]["pdu_address"], 0x714)  # word: 0x700 + 10 * 2 = 0x714

        c255 = dvp_modbus.map_device("C255")["accesses"]
        self.assertEqual(c255[0]["pdu_address"], 0xEFF)  # bit: 0xEC8 + 55
        self.assertEqual(c255[1]["pdu_address"], 0x76E)  # word: 0x700 + 55 * 2 = 0x76E

    # -------------------------------------------------------------------------
    # 2. IL Parser Whitespace Splitting & Negative Constant Support (DEF-IL-01)
    # -------------------------------------------------------------------------
    def test_il_parser_accepts_whitespace_separation(self) -> None:
        """Verify IL parser accepts standard whitespace/tab separated instructions."""
        listing = "LD X0\nAND X1\nOUT Y0\n"
        instructions = dvp.parse_il(listing)
        self.assertEqual(instructions, [
            ("LD", ["X0"]),
            ("AND", ["X1"]),
            ("OUT", ["Y0"]),
        ])

    def test_il_parser_accepts_negative_decimal_and_k_constants(self) -> None:
        """Verify IL parser accepts negative constants such as K-5 and -10."""
        listing = "MOV D0 K-5\nMOV D1 -10\nMOV D2 K10\n"
        instructions = dvp.parse_il(listing)
        self.assertEqual(instructions, [
            ("MOV", ["D0", "K-5"]),
            ("MOV", ["D1", "-10"]),
            ("MOV", ["D2", "K10"]),
        ])

    def test_il_to_mpu_and_mpu_to_il_roundtrip_with_negative_constants(self) -> None:
        """Verify full roundtrip serialization with negative constant K-5."""
        prog = "LD X0\nMOV D0 K-5\nOUT Y0\n"
        mpu_data, report = dvp.il_to_mpu(prog, "MainProgram", "cp1252")
        self.assertGreater(report["network_count"], 0)
        back_il, detail = dvp.mpu_to_il(mpu_data, "cp1252")
        self.assertIn("K-5", back_il)
        self.assertIn("OUT", back_il)

    # -------------------------------------------------------------------------
    # 3. CRLF Normalization in Container Network Replacement (DEF-IO-01)
    # -------------------------------------------------------------------------
    def test_crlf_normalization_prevents_double_carriage_returns(self) -> None:
        """Verify replace_ld_pou_networks normalizes CRLF without producing \r\r\n."""
        original_container = make_ld_container()
        decoded = containers.decode(original_container)
        source = decoded.source.decode(decoded.encoding)

        # Network text with explicit \r\n line endings
        replacement_net = (
            "<NETWORK_START>\r\n"
            "<PROPERTIES_START>\r\n"
            "NET_ID=1\r\n"
            "NET_ACTIVE=TRUE\r\n"
            "NET_LABEL=\r\n"
            "NET_BOOKMARK=TRUE\r\n"
            "NET_NAME=\r\n"
            "NET_DESC=\r\n"
            "<PROPERTIES_END>\r\n"
            "<ROOTLINK_START>\r\n"
            "[LD_NODE]\r\n"
            "TYPE=1\r\n"
            "DEV_NAME=X1\r\n"
            "[END_LD_NODE]\r\n"
            "<ROOTLINK_END>\r\n"
            "<OUTLINK_START>\r\n"
            "[LD_NODE]\r\n"
            "TYPE=13\r\n"
            "DEV_NAME=Y1\r\n"
            "[END_LD_NODE]\r\n"
            "<OUTLINK_END>\r\n"
            "<NETWORK_END>"
        )

        updated_source = containers.replace_ld_pou_networks(
            source, "MainProgram", [replacement_net], "\r\n"
        )
        network_span = updated_source[updated_source.index("<NETWORK_START>"):updated_source.index("</POU>")]
        self.assertNotIn("\r\r\n", network_span)
        self.assertIn("DEV_NAME=X1", network_span)

    # -------------------------------------------------------------------------
    # 4. Optimistic Concurrency Control (OCC) & content_hash
    # -------------------------------------------------------------------------
    def test_compute_content_hash_format(self) -> None:
        """Verify content hash prefixing and sha256 output."""
        h1 = compute_content_hash("isp", b"test-content")
        self.assertTrue(h1.startswith("isp:sha256:"))
        self.assertEqual(len(h1), len("isp:sha256:") + 64)

        h2 = compute_content_hash("pou", "test-pou-body")
        self.assertTrue(h2.startswith("pou:sha256:"))

        h3 = compute_content_hash("network", "test-network")
        self.assertTrue(h3.startswith("network:sha256:"))

    def test_read_tools_emit_content_hashes(self) -> None:
        """Verify inspect, overview, pou, network, and comment read tools emit content hashes."""
        with tempfile.TemporaryDirectory() as temp:
            project_file = Path(temp) / "test.isp"
            project_file.write_bytes(make_ld_container())

            # 1. ispsoft_inspect_project
            inspect_res = json.loads(server.ispsoft_inspect_project(str(project_file)))
            self.assertTrue(inspect_res["success"])
            self.assertTrue(inspect_res["content_hash"].startswith("isp:sha256:"))

            # 2. ispsoft_read_project_source
            source_res = json.loads(server.ispsoft_read_project_source(str(project_file)))
            self.assertTrue(source_res["success"])
            self.assertTrue(source_res["content_hash"].startswith("isp:sha256:"))

            # 3. ispsoft_get_project_overview
            overview_res = json.loads(server.ispsoft_get_project_overview(str(project_file)))
            self.assertTrue(overview_res["success"])
            self.assertTrue(overview_res["content_hash"].startswith("isp:sha256:"))

            # 4. ispsoft_read_pou
            pou_res = json.loads(server.ispsoft_read_pou(str(project_file), "MainProgram"))
            self.assertTrue(pou_res["success"])
            self.assertTrue(pou_res["content_hash"].startswith("pou:sha256:"))
            self.assertTrue(pou_res["project_content_hash"].startswith("isp:sha256:"))

            # 5. ispsoft_read_ld_network
            net_res = json.loads(server.ispsoft_read_ld_network(str(project_file), "MainProgram", 1))
            self.assertTrue(net_res["success"])
            self.assertTrue(net_res["content_hash"].startswith("network:sha256:"))
            self.assertTrue(net_res["pou_content_hash"].startswith("pou:sha256:"))

            # 6. ispsoft_read_device_comments
            cmt_res = json.loads(server.ispsoft_read_device_comments(str(project_file)))
            self.assertTrue(cmt_res["success"])
            self.assertTrue(cmt_res["content_hash"].startswith("comments:sha256:"))

    def test_mutation_tools_reject_stale_content_hash(self) -> None:
        """Verify mutation tools reject stale expected_content_hash with state_changed."""
        with tempfile.TemporaryDirectory() as temp:
            project_file = Path(temp) / "test.isp"
            project_file.write_bytes(make_ld_container())
            stale_hash = "isp:sha256:0000000000000000000000000000000000000000000000000000000000000000"

            # 1. ispsoft_write_st_candidate
            st_res = json.loads(server.ispsoft_write_st_candidate(
                str(project_file), "MainProgram", "Y0 := X0;", "ES2",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(st_res["success"])
            self.assertEqual(st_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(st_res["failure_category"], "state_changed")

            # 2. ispsoft_write_local_variables_candidate
            var_res = json.loads(server.ispsoft_write_local_variables_candidate(
                str(project_file), "MainProgram", "VAR\nx: INT;\nEND_VAR", "ES2",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(var_res["success"])
            self.assertEqual(var_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(var_res["failure_category"], "state_changed")

            # 3. ispsoft_write_ld_network_candidate
            net_text = json.loads(server.ispsoft_read_ld_network(str(project_file), "MainProgram", 1))["network_text"]
            ld_net_res = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project_file), "MainProgram", 1, net_text, "ES2",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(ld_net_res["success"])
            self.assertEqual(ld_net_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(ld_net_res["failure_category"], "state_changed")

            # 4. ispsoft_write_ld_program
            ld_prog_res = json.loads(server.ispsoft_write_ld_program(
                str(project_file), "MainProgram", "LD X0\nOUT Y0\n", "ES2",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(ld_prog_res["success"])
            self.assertEqual(ld_prog_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(ld_prog_res["failure_category"], "state_changed")

            # 5. ispsoft_write_device_comment_candidate
            cmt_res = json.loads(server.ispsoft_write_device_comment_candidate(
                str(project_file), {"X0": "Modified Sensor"}, "ES2",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(cmt_res["success"])
            self.assertEqual(cmt_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(cmt_res["failure_category"], "state_changed")

            # 6. ispsoft_compile_and_check
            compile_res = json.loads(server.ispsoft_compile_and_check(
                str(project_file), "check",
                expected_content_hash=stale_hash
            ))
            self.assertFalse(compile_res["success"])
            self.assertEqual(compile_res["status"], "REJECTED_BEFORE_WRITE")
            self.assertEqual(compile_res["failure_category"], "state_changed")

    # -------------------------------------------------------------------------
    # 5. Uniform Dry-Run Mode Across Mutation Tools
    # -------------------------------------------------------------------------
    def test_dry_run_executes_validation_with_zero_disk_mutation(self) -> None:
        """Verify dry_run=True performs in-memory validation and writes zero files."""
        with tempfile.TemporaryDirectory() as temp:
            st_project_file = Path(temp) / "test_st.isp"
            st_project_file.write_bytes(make_es2_container())

            project_file = Path(temp) / "test.isp"
            project_file.write_bytes(make_ld_container())
            before_mtime = project_file.stat().st_mtime_ns

            out_st = Path(temp) / "out_st.isp"
            res_st = json.loads(server.ispsoft_write_st_candidate(
                str(st_project_file), "MainProgram", "count := 42;", "ES2",
                output_path=str(out_st), dry_run=True
            ))
            self.assertTrue(res_st["success"])
            self.assertEqual(res_st["status"], "DRY_RUN_PASSED")
            self.assertTrue(res_st["dry_run"])
            self.assertFalse(out_st.exists(), "Dry-run must not create candidate output file")

            out_vars = Path(temp) / "out_vars.isp"
            res_vars = json.loads(server.ispsoft_write_local_variables_candidate(
                str(st_project_file), "MainProgram", "VAR\nx : INT := 10 {VAR};\nEND_VAR", "ES2",
                output_path=str(out_vars), dry_run=True
            ))
            self.assertTrue(res_vars["success"])
            self.assertEqual(res_vars["status"], "DRY_RUN_PASSED")
            self.assertFalse(out_vars.exists())

            out_net = Path(temp) / "out_net.isp"
            net_text = json.loads(server.ispsoft_read_ld_network(str(project_file), "MainProgram", 1))["network_text"]
            res_net = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project_file), "MainProgram", 1, net_text, "ES2",
                output_path=str(out_net), dry_run=True
            ))
            self.assertTrue(res_net["success"])
            self.assertEqual(res_net["status"], "DRY_RUN_PASSED")
            self.assertFalse(out_net.exists())

            out_prog = Path(temp) / "out_prog.isp"
            res_prog = json.loads(server.ispsoft_write_ld_program(
                str(project_file), "MainProgram", "LD X0\nOUT Y0\n", "ES2",
                output_path=str(out_prog), dry_run=True
            ))
            self.assertTrue(res_prog["success"])
            self.assertEqual(res_prog["status"], "DRY_RUN_PASSED")
            self.assertTrue(res_prog["semantic_il_valid"])
            self.assertFalse(out_prog.exists())

            out_cmt = Path(temp) / "out_cmt.isp"
            res_cmt = json.loads(server.ispsoft_write_device_comment_candidate(
                str(project_file), {"X1": "Dry Run Sensor"}, "ES2",
                output_path=str(out_cmt), dry_run=True
            ))
            self.assertTrue(res_cmt["success"])
            self.assertEqual(res_cmt["status"], "DRY_RUN_PASSED")
            self.assertFalse(out_cmt.exists())

            res_compile = json.loads(server.ispsoft_compile_and_check(
                str(project_file), "check", dry_run=True
            ))
            self.assertTrue(res_compile["success"])
            self.assertEqual(res_compile["status"], "DRY_RUN_PASSED")

            # Source project file was never touched
            self.assertEqual(project_file.stat().st_mtime_ns, before_mtime)

    # -------------------------------------------------------------------------
    # 6. Value Budgeting & Whole-Value Omission
    # -------------------------------------------------------------------------
    def test_enforce_value_budget_omits_oversized_values(self) -> None:
        """Verify enforce_value_budget omits whole strings that exceed budget."""
        small_text = "A" * 50_000
        self.assertEqual(enforce_value_budget(small_text, name="small"), small_text)

        large_text = "B" * 70_000
        budgeted = enforce_value_budget(large_text, name="large", max_chars=60_000)
        self.assertIsInstance(budgeted, dict)
        self.assertTrue(budgeted["_omitted"])
        self.assertEqual(budgeted["field"], "large")
        self.assertEqual(budgeted["character_count"], 70_000)
        self.assertEqual(budgeted["budget_limit"], 60_000)
        self.assertIn("Query individual sections", budgeted["narrowing_guidance"])

    def test_budget_payload_protects_large_responses(self) -> None:
        """Verify budget_payload scans dict and enforces whole-value omission."""
        payload = {
            "name": "project",
            "normal_data": [1, 2, 3],
            "huge_source": "X" * 75_000,
        }
        budgeted = budget_payload(payload, max_item_chars=60_000)
        self.assertEqual(budgeted["name"], "project")
        self.assertEqual(budgeted["normal_data"], [1, 2, 3])
        self.assertIsInstance(budgeted["huge_source"], dict)
        self.assertTrue(budgeted["huge_source"]["_omitted"])

    # -------------------------------------------------------------------------
    # 7. Diagnostic Doctor Subsystem (ispsoft_doctor)
    # -------------------------------------------------------------------------
    def test_doctor_tool_returns_healthy_report(self) -> None:
        """Verify ispsoft_doctor tool returns complete environment diagnostics."""
        report_str = server.ispsoft_doctor()
        report = json.loads(report_str)
        self.assertTrue(report["success"])
        self.assertIn(report["health"], ("HEALTHY", "LIMITED_CAPABILITY"))
        self.assertIn("platform", report)
        self.assertIn("installations", report)
        self.assertIn("runtime_services", report)
        self.assertIn("limits", report)
        self.assertEqual(report["limits"]["max_item_chars"], 60_000)
        self.assertEqual(report["limits"]["max_response_chars"], 180_000)
        self.assertIn("qualified_workflows", report)
        self.assertIn("optimistic_concurrency_control", report["qualified_workflows"])
        self.assertIn("dry_run_validation", report["qualified_workflows"])

    def test_doctor_cli_flag(self) -> None:
        """Verify running ispsoft_mcp_server.py --doctor returns JSON report with exit 0."""
        python_exe = sys.executable
        server_path = str(Path(server.__file__).resolve())
        proc = subprocess.run(
            [python_exe, server_path, "--doctor"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(proc.returncode, 0, f"Doctor CLI failed: {proc.stderr}")
        data = json.loads(proc.stdout)
        self.assertTrue(data["success"])
        self.assertEqual(data["limits"]["max_item_chars"], 60_000)


if __name__ == "__main__":
    unittest.main()
