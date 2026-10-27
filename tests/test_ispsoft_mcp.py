from __future__ import annotations

import ctypes
import inspect
import json
import os
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import Mock, patch

import ispsoft_mcp_server as server
from ispsoft_mcp import containers, dvp, limits


AS_SOURCE = """<PROJECT>
Active_CodePage=1252
Prj_ISPVer=3.19
Prj_DT=AS228T
Prj_C_SourceCodeLocked=FALSE
</PROJECT>
<POU>
P_Name=MainProgram
P_Lang=2
P_type=0
<LOCAL_VAR>
END_VAR
</LOCAL_VAR>
<IL_ST_CODE>
Value := Value + 1;
</IL_ST_CODE>
</POU>
""".replace("\n", "\r\n")


def as_container(source: str = AS_SOURCE, prefix: bytes = b"COMPILED_PREFIX") -> bytes:
    raw = source.encode("cp1252")
    compressor = zlib.compressobj(level=9, wbits=-15)
    compressed = compressor.compress(raw) + compressor.flush()
    header = bytearray(0xA4)
    struct.pack_into("<II", header, 0x0C, 1020, 3010)
    struct.pack_into("<I", header, 0x7C, len(raw))
    struct.pack_into("<I", header, 0x94, len(compressed) + 6)
    struct.pack_into("<I", header, 0x98, len(header) + len(prefix))
    struct.pack_into("<I", header, 0x9C, len(prefix))
    return bytes(header) + prefix + struct.pack("<HI", 8, zlib.crc32(raw) & 0xFFFFFFFF) + compressed


ES2_SOURCE = """<PROJECT>
Active_CodePage=1252
Prj_ISPVer=3.24
Prj_DT=ES2
Prj_C_SourceCodeLocked=FALSE
</PROJECT>
[DEVICE_CMT_START]
M0::Start request
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
</LOCAL_VAR>
<IL_ST_CODE>
Value := 1;
Y0 := X0;
</IL_ST_CODE>
</POU>
""".replace("\n", "\r\r\n")


def es2_v8_container(source: str = ES2_SOURCE, trailer: bytes = b"OPAQUE-TRAILER") -> bytes:
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


class ContainerTests(unittest.TestCase):
    def test_project_discovery_reports_parsing_and_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "good.isp"
            project.write_bytes(es2_v8_container())
            (root / "bad.isp").write_text("not an ISPSoft project", encoding="ascii")
            result = json.loads(server.ispsoft_list_projects(str(root)))
            projects = {Path(row["path"]).name: row for row in result["projects"]}
            self.assertTrue(projects["good.isp"]["readable"])
            self.assertEqual(projects["good.isp"]["model"], "ES2")
            self.assertFalse(projects["bad.isp"]["readable"])

    def test_candidate_group_cleanup_when_companion_publish_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.isp"
            source.write_bytes(es2_v8_container())
            companion = source.with_suffix(".ini")
            companion.write_bytes(b"[PRJ_DATA]\r\n")
            target = root / "candidate.isp"
            real_write = server._write_new

            def fail_candidate_companion(path, data, inputs=()):
                if Path(path) == target.with_suffix(".ini"):
                    raise OSError("simulated companion publish failure")
                return real_write(path, data, inputs)

            with patch.object(server, "_write_new", side_effect=fail_candidate_companion):
                with self.assertRaises(OSError):
                    server._write_project_candidate_and_backup(source, target, source.read_bytes(), b"candidate")
            self.assertFalse(target.exists())
            self.assertFalse(target.with_name("candidate.before.isp").exists())
            self.assertFalse(target.with_suffix(".ini").exists())
            self.assertFalse(target.with_name("candidate.before.ini").exists())

    def test_create_project_from_template_preserves_model_and_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            template = root / "template.isp"
            output = root / "agent-project.isp"
            original = es2_v8_container()
            template.write_bytes(original)
            template.with_suffix(".ini").write_bytes(b"[PRJ_DATA]\r\nDEVICE_TYPE=1\r\n")
            result = json.loads(server.ispsoft_create_project_from_template(str(template), str(output)))
            self.assertEqual(result["status"], "CREATED_FROM_TEMPLATE_UNCOMPILED")
            self.assertTrue(result["readback_verified"])
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(output.with_suffix(".ini").read_bytes(), template.with_suffix(".ini").read_bytes())
            self.assertEqual(template.read_bytes(), original)

    def test_v3010_roundtrip_preserves_compiled_prefix(self) -> None:
        original = as_container()
        parsed = containers.decode(original)
        rebuilt = parsed.rebuild(parsed.source.replace(b"Value + 1", b"Value + 2"))
        self.assertEqual(rebuilt[0xA4:parsed.offset - 6], original[0xA4:parsed.offset - 6])
        self.assertIn(b"Value + 2", containers.decode(rebuilt).source)

    def test_ispsoft_324_pointer_layout_roundtrip_preserves_trailer(self) -> None:
        original = es2_v8_container()
        parsed = containers.decode(original)
        self.assertEqual(parsed.layout, "ispsoft-3.24-v8")
        self.assertEqual(containers.inspect(parsed)["project_model"], "ES2")
        rebuilt = parsed.rebuild(parsed.source.replace(b"Value := 1", b"Value := 2"))
        self.assertTrue(rebuilt.endswith(b"OPAQUE-TRAILER"))
        self.assertEqual(containers.decode(rebuilt).source, parsed.source.replace(b"Value := 1", b"Value := 2"))

    def test_installed_ispsoft_324_sample_is_readable_when_present(self) -> None:
        sample = Path.home() / "Downloads" / "Untitled0" / "Untitled0.isp"
        if sample.exists():
            original = sample.read_bytes()
            parsed = containers.read_container(sample)
            self.assertEqual(containers.inspect(parsed)["project_model"], "ES2")
            self.assertEqual(sample.read_bytes(), original)
            roundtrip = containers.decode(parsed.rebuild(parsed.source))
            self.assertEqual(roundtrip.source, parsed.source)
            comments = json.loads(server.ispsoft_read_device_comments(str(sample)))
            self.assertGreater(comments['count'], 0)

    def test_st_patch_candidate_does_not_modify_original(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original_path = root / "source.isp"
            original = as_container()
            original_path.write_bytes(original)
            companion = original_path.with_suffix('.ini')
            companion.write_bytes(b'[PRJ_DATA]\r\nDEVICE_TYPE=1\r\n')
            result = json.loads(server.ispsoft_write_st_candidate(
                str(original_path), "MainProgram", "Value := Value + 2;", "AS228T",
                str(root / "candidate.isp")))
            self.assertEqual(result["status"], "GENERATED_UNCOMPILED")
            self.assertEqual(original_path.read_bytes(), original)
            self.assertEqual(Path(result["backup"]).read_bytes(), original)
            self.assertEqual(Path(result['candidate_companion']).read_bytes(), companion.read_bytes())
            self.assertEqual(Path(result['backup']).with_suffix('.ini').read_bytes(), companion.read_bytes())
            candidate = containers.read_container(result["candidate"])
            self.assertIn(b"Value := Value + 2;", candidate.source)

    def test_st_patch_uses_ispsoft_324_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original_path = root / "es2.isp"
            original = es2_v8_container()
            original_path.write_bytes(original)
            result = json.loads(server.ispsoft_write_st_candidate(
                str(original_path), "MainProgram", "Value := 3;", "ES2", str(root / "candidate.isp")))
            self.assertEqual(result["status"], "GENERATED_UNCOMPILED")
            self.assertEqual(original_path.read_bytes(), original)
            self.assertEqual(containers.inspect(containers.read_container(result["candidate"]))["project_model"], "ES2")

    def test_local_variables_candidate_preserves_original_and_verifies_readback(self) -> None:
        local_variables = "<VAR>\n{\nH87 : WORD :=  [@D7000@] {VAR}\n(*\nStart request\n*)\n}\n</VAR>\n"
        source = ES2_SOURCE.replace("<LOCAL_VAR>\r\r\n</LOCAL_VAR>",
                                    "<LOCAL_VAR>\r\r\n" + local_variables.replace("\n", "\r\r\n") +
                                    "</LOCAL_VAR>")
        original = es2_v8_container(source)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "es2.isp"
            project.write_bytes(original)
            companion = project.with_suffix(".ini")
            companion.write_bytes(b"[PRJ_DATA]\r\nDEVICE_TYPE=1\r\n")
            candidate_path = root / "candidate.isp"
            result = json.loads(server.ispsoft_write_local_variables_candidate(
                str(project), "MainProgram", local_variables, "DVP32ES2T", str(candidate_path)))
            self.assertEqual(result["status"], "GENERATED_UNCOMPILED", result)
            self.assertTrue(result["readback_verified"])
            self.assertEqual(project.read_bytes(), original)
            self.assertEqual(Path(result["backup"]).read_bytes(), original)
            self.assertEqual(Path(result["candidate_companion"]).read_bytes(), companion.read_bytes())
            candidate = containers.read_container(candidate_path)
            candidate_source = candidate.source.decode(candidate.encoding)
            candidate_pou = next(match.group(1) for match in containers.sections(candidate_source, "POU")
                                 if containers.property_value(match.group(1), "P_Name") == "MainProgram")
            self.assertEqual(containers.normalized(containers.sections(candidate_pou, "LOCAL_VAR")[0].group(1)),
                             containers.normalized(local_variables))

    def test_local_variables_candidate_rejects_project_delimiters_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "es2.isp"
            original = es2_v8_container()
            project.write_bytes(original)
            result = json.loads(server.ispsoft_write_local_variables_candidate(
                str(project), "MainProgram", "</TASK>", "ES2", str(root / "bad.isp")))
            self.assertEqual(result["status"], "CANDIDATE_FAILED")
            self.assertFalse((root / "bad.isp").exists())
            self.assertFalse((root / "bad.before.isp").exists())
            self.assertEqual(project.read_bytes(), original)

    def test_project_overview_and_pou_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / 'es2.isp'
            project.write_bytes(es2_v8_container())
            overview = json.loads(server.ispsoft_get_project_overview(str(project)))
            pou = json.loads(server.ispsoft_read_pou(str(project), 'MainProgram'))
            comments = json.loads(server.ispsoft_read_device_comments(str(project)))
            xrefs = json.loads(server.ispsoft_get_cross_references(str(project), 'MainProgram'))
            memory = json.loads(server.ispsoft_get_memory_usage_map(str(project)))
            self.assertEqual(overview['model'], 'ES2')
            self.assertEqual(overview['device_comment_count'], 1)
            self.assertIn('Value := 1;', pou['sections']['IL_ST_CODE'][0])
            self.assertEqual(comments['device_comments'], {'M0': 'Start request'})
            refs = {item['address']: item for item in xrefs['references']}
            self.assertTrue(refs['X0']['reads'])
            self.assertTrue(refs['Y0']['writes'])
            self.assertTrue(any(row['area'] == 'M' and row['end'] == 999 for row in memory['ranges']))

    def test_ld_pou_networks_are_read_as_raw_blocks(self) -> None:
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
TYPE=15
DEV_NAME=Y0
[END_LD_NODE]
<OUTLINK_END>
<NETWORK_END>
"""
        source = ES2_SOURCE.replace("P_Lang=2", "P_Lang=1").replace(
            "</POU>", network + network.replace("NetworkID=1", "NetworkID=2") + "</POU>")
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "ld.isp"
            project.write_bytes(es2_v8_container(source))
            pou = json.loads(server.ispsoft_read_pou(str(project), "MainProgram"))
            self.assertEqual(pou["network_count"], 2)
            self.assertEqual(len(pou["sections"]["LD_NETWORKS"]), 2)
            self.assertIn("DEV_NAME=X0", pou["sections"]["LD_NETWORKS"][0])
            first = json.loads(server.ispsoft_read_ld_network(str(project), "MainProgram", 1))
            self.assertEqual(first["status"], "READ_RAW_NETWORK")
            self.assertEqual(first["network_count"], 2)
            self.assertIn("DEV_NAME=Y0", first["network_text"])
            self.assertEqual(first["structure"]["properties"]["NetworkID"], "1")
            self.assertEqual(first["structure"]["root_nodes"][0]["fields"]["DEV_NAME"], "X0")
            self.assertEqual(first["structure"]["outlink_nodes"][0]["fields"]["DEV_NAME"], "Y0")
            structure = json.loads(server.ispsoft_get_ld_program_structure(str(project), "MainProgram"))
            self.assertEqual(structure["status"], "READ_RAW_STRUCTURE")
            self.assertEqual(structure["network_count"], 2)
            self.assertEqual(structure["node_type_counts"]["root"]["1"], 2)
            self.assertEqual(structure["node_type_counts"]["outlink"]["15"], 2)
            original = project.read_bytes()
            replacement = containers.ld_networks(source)[0].replace("DEV_NAME=Y0", "DEV_NAME=Y2")
            candidate_path = Path(temp) / "candidate.isp"
            candidate = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project), "MainProgram", 1, replacement, "ES2", str(candidate_path)))
            self.assertEqual(candidate["status"], "GENERATED_UNCOMPILED", candidate)
            self.assertTrue(candidate["readback_verified"])
            self.assertEqual(project.read_bytes(), original)
            self.assertEqual(Path(candidate["backup"]).read_bytes(), original)
            candidate_container = containers.read_container(candidate_path)
            candidate_source = candidate_container.source.decode(candidate_container.encoding)
            candidate_pou = next(match.group(1) for match in containers.sections(candidate_source, "POU")
                                 if containers.property_value(match.group(1), "P_Name") == "MainProgram")
            candidate_networks = containers.ld_networks(candidate_pou)
            self.assertIn("DEV_NAME=Y2", candidate_networks[0])
            self.assertEqual(candidate_networks[1], containers.ld_networks(source)[1])
            rejected = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project), "MainProgram", 1, "<BROKEN>", "ES2", str(Path(temp) / "invalid.isp")))
            self.assertEqual(rejected["status"], "REJECTED_BEFORE_WRITE")
            self.assertFalse((Path(temp) / "invalid.isp").exists())
            missing_type = replacement.replace("TYPE=1\n", "")
            rejected_node = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project), "MainProgram", 1, missing_type, "ES2", str(Path(temp) / "invalid-node.isp")))
            self.assertEqual(rejected_node["status"], "REJECTED_BEFORE_WRITE")
            self.assertTrue(any("missing TYPE" in error for error in rejected_node["validation_errors"]))
            self.assertFalse((Path(temp) / "invalid-node.isp").exists())
            wrong_model = json.loads(server.ispsoft_write_ld_network_candidate(
                str(project), "MainProgram", 1, replacement, "DVP12SE11R"))
            self.assertEqual(wrong_model["status"], "REJECTED_BEFORE_WRITE")
            out_of_range = json.loads(server.ispsoft_read_ld_network(str(project), "MainProgram", 3))
            self.assertEqual(out_of_range["status"], "NETWORK_INDEX_OUT_OF_RANGE")
            invalid_index = json.loads(server.ispsoft_read_ld_network(str(project), "MainProgram", 0))
            self.assertEqual(invalid_index["status"], "REJECTED_BEFORE_READ")

    def test_installed_station_project_exposes_ld_networks_when_available(self) -> None:
        project = Path(r"C:\Users\jethr\OneDrive\Dokumen\Reading material\TA\PLC programming\finished\STATION 3 PROCESSINGAAAAA\STATION 3 PROCESSINGAAAAA.isp")
        if not project.is_file():
            self.skipTest("User's ISPSoft station project is not present on this machine.")
        before = project.read_bytes()
        overview = json.loads(server.ispsoft_get_project_overview(str(project)))
        pou = json.loads(server.ispsoft_read_pou(str(project), "Prog0"))
        first_network = json.loads(server.ispsoft_read_ld_network(str(project), "Prog0", 1))
        structure = json.loads(server.ispsoft_get_ld_program_structure(str(project), "Prog0"))
        xrefs = json.loads(server.ispsoft_get_cross_references(str(project), "Prog0"))
        self.assertEqual(overview["model"], "ES2")
        self.assertGreater(pou["network_count"], 0)
        self.assertTrue(any("VAR_NODE_S" in network for network in pou["sections"]["LD_NETWORKS"]))
        self.assertEqual(first_network["structure"]["properties"]["NET_ID"], "1")
        self.assertEqual(first_network["structure"]["root_nodes"][0]["fields"]["DEV_NAME"], "M1002")
        self.assertEqual(first_network["structure"]["outlink_nodes"][0]["fields"]["DEV_NAME"], "M1143")
        self.assertEqual(structure["network_count"], 38)
        self.assertEqual(structure["networks"][0]["properties"]["NET_ID"], "1")
        refs = {row["address"]: row for row in xrefs["references"]}
        self.assertIn("M1002", refs)
        with tempfile.TemporaryDirectory() as temp:
            disposable_source = Path(temp) / project.name
            disposable_source.write_bytes(before)
            companion = project.with_suffix(".ini")
            if companion.is_file():
                disposable_source.with_suffix(".ini").write_bytes(companion.read_bytes())
            raw_network = pou["sections"]["LD_NETWORKS"][0]
            self.assertIn("NET_BOOKMARK=FALSE", raw_network)
            replacement = raw_network.replace("NET_BOOKMARK=FALSE", "NET_BOOKMARK=TRUE", 1)
            candidate_path = Path(temp) / "station-candidate.isp"
            candidate = json.loads(server.ispsoft_write_ld_network_candidate(
                str(disposable_source), "Prog0", 1, replacement, "ES2", str(candidate_path)))
            self.assertEqual(candidate["status"], "GENERATED_UNCOMPILED", candidate)
            self.assertTrue(candidate["readback_verified"])
            self.assertEqual(disposable_source.read_bytes(), before)
            self.assertEqual(Path(candidate["backup"]).read_bytes(), before)
            candidate_source = containers.read_container(candidate_path).source.decode("cp1252")
            candidate_pou = next(match.group(1) for match in containers.sections(candidate_source, "POU")
                                 if containers.property_value(match.group(1), "P_Name") == "Prog0")
            self.assertIn("NET_BOOKMARK=TRUE", containers.ld_networks(candidate_pou)[0])
        self.assertEqual(project.read_bytes(), before)

    def test_device_comment_candidate_merges_and_preserves_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / 'es2.isp'
            original = es2_v8_container()
            project.write_bytes(original)
            result = json.loads(server.ispsoft_write_device_comment_candidate(
                str(project), {'X0': 'Input sensor'}, 'ES2', str(root / 'comments.isp')))
            self.assertEqual(result['status'], 'GENERATED_UNCOMPILED')
            self.assertEqual(project.read_bytes(), original)
            self.assertEqual(json.loads(server.ispsoft_read_device_comments(result['candidate']))['device_comments'],
                             {'M0': 'Start request', 'X0': 'Input sensor'})


class DvpTests(unittest.TestCase):
    PROGRAM = "LD,X0\nAND,X1\nOUT,M0\nLD,M0\nOUT,Y0\n"

    def test_il_to_mpu_roundtrip(self) -> None:
        data, report = dvp.il_to_mpu(self.PROGRAM, "MainProgram", "cp1252")
        back, detail = dvp.mpu_to_il(data, "cp1252")
        self.assertEqual(report["network_count"], 2)
        self.assertIn("OUT,Y0", back)
        self.assertGreater(detail["network_count"], 0)

    def test_unsupported_instruction_is_rejected(self) -> None:
        with self.assertRaises(dvp.FileTransformError):
            dvp.parse_il("LD,X0\nTON,T0,K5\nOUT,Y0")

    def test_validation_requires_exact_dvp_model(self) -> None:
        result = json.loads(server.ispsoft_validate_il(self.PROGRAM, "MainProgram", "DVP12SE11R"))
        self.assertTrue(result["valid"], result)
        es2 = json.loads(server.ispsoft_validate_il(self.PROGRAM, "MainProgram", "ES2"))
        self.assertTrue(es2["valid"], es2)
        rejected = json.loads(server.ispsoft_validate_il(self.PROGRAM, "MainProgram", "DVP-UNKNOWN"))
        self.assertFalse(rejected["valid"])

    def test_generation_artifact_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "program.mpu"
            result = json.loads(server.ispsoft_generate_mpu(
                self.PROGRAM, "MainProgram", "DVP12SE11T", str(output)))
            self.assertEqual(result["status"], "SUCCESS_ARTIFACT_ONLY")
            self.assertTrue(result["roundtrip_verified"])
            self.assertEqual(json.loads(server.ispsoft_read_mpu(str(output), "DVP12SE11T"))["success"], True)


class AnalysisAndSafetyTests(unittest.TestCase):
    def test_mcp_registry_exposes_new_agent_workflow_tools(self) -> None:
        names = set(server.mcp._tool_manager._tools)
        self.assertTrue({
            "ispsoft_get_capabilities", "ispsoft_list_projects",
            "ispsoft_create_project_from_template", "ispsoft_connect",
            "ispsoft_upload_from_plc", "ispsoft_start_monitor", "ispsoft_stop_monitor",
            "ispsoft_get_ide_session", "ispsoft_start_ide", "ispsoft_read_ld_network",
            "ispsoft_get_ld_program_structure", "ispsoft_write_ld_network_candidate",
            "ispsoft_start_background_session", "ispsoft_get_background_sessions",
            "ispsoft_stop_background_session", "ispsoft_compile_and_check",
            "ispsoft_list_commgr_drivers", "ispsoft_list_serial_ports",
            "ispsoft_write_local_variables_candidate",
        }.issubset(names))

    def test_serial_port_inventory_does_not_claim_device_identity_or_contact(self) -> None:
        ports = [{"port": "COM9", "friendly_name": "USB Serial Port (COM9)"}]
        catalog = {"drivers": [{"targets": [{"transport": "serial", "port_number": "9"},
                                               {"transport": "serial", "port_number": "1"}]}]}
        with patch.object(server.sys, "platform", "win32"), \
             patch.object(server, "_enumerate_windows_serial_ports", return_value=ports), \
             patch.object(server, "_read_commgr_driver_catalog", return_value=catalog):
            result = json.loads(server.ispsoft_list_serial_ports())
        self.assertEqual(result["configured_ports_present"], ["COM9"])
        self.assertEqual(result["configured_ports_missing"], ["COM1"])
        self.assertFalse(result["device_contacted"])
        self.assertFalse(result["serial_port_opened"])
        self.assertFalse(result["identity_verified"])

    def test_native_compile_ocr_summary_accepts_vendor_zero_as_letter_o(self) -> None:
        result = server._parse_native_compile_diagnostics(
            "Project Compile Message V O Errors V O Warning")
        self.assertEqual(result, {"errors": 0, "warnings": 0,
                                  "compile_pane_detected": True})

    def test_capability_matrix_limits_native_compile_to_qualified_es2(self) -> None:
        matrix = server._capability_matrix()
        self.assertEqual(matrix["per_profile"]["ES2"]["native_compile_check"],
                         "QUALIFIED_LIMITED_ISPSOFT_3_24_ES2")
        self.assertEqual(matrix["native_compile_check"]["models"], ["ES2"])
        self.assertEqual(matrix["local_variable_candidate_generation"]["models"], ["ES2"])
        self.assertEqual(matrix["per_profile"]["ES2"]["local_variable_candidate_generation"],
                         "QUALIFIED_LIMITED")
        self.assertEqual(matrix["plc_connection"]["status"], "NOT_QUALIFIED")

    def test_native_compile_ocr_summary_reports_errors_and_missing_counts(self) -> None:
        errors = server._parse_native_compile_diagnostics(
            "Compile Message 2 Errors 1 Warning")
        self.assertEqual(errors["errors"], 2)
        self.assertEqual(errors["warnings"], 1)
        self.assertTrue(errors["compile_pane_detected"])
        missing = server._parse_native_compile_diagnostics("Compile Message")
        self.assertIsNone(missing["errors"])
        self.assertIsNone(missing["warnings"])
        self.assertTrue(missing["compile_pane_detected"])

    def test_native_compile_rejects_unknown_action_before_starting_ispsoft(self) -> None:
        with patch.object(server, "ispsoft_start_background_session") as start:
            result = json.loads(server.ispsoft_compile_and_check("not-a-project.isp", "download"))
        self.assertEqual(result["status"], "REJECTED_BEFORE_OPEN")
        self.assertEqual(result["vendor_compile"], "NOT_RUN")
        start.assert_not_called()

    def test_native_compile_rejects_non_string_action_and_invalid_timeout(self) -> None:
        with patch.object(server, "ispsoft_start_background_session") as start:
            action = json.loads(server.ispsoft_compile_and_check("ignored", ["compile"]))
            timeout = json.loads(server.ispsoft_compile_and_check("ignored", "check", True))
            idle_wait = json.loads(server.ispsoft_compile_and_check("ignored", "check", 120, True))
        self.assertEqual(action["status"], "REJECTED_BEFORE_OPEN")
        self.assertEqual(timeout["status"], "REJECTED_BEFORE_OPEN")
        self.assertEqual(idle_wait["status"], "REJECTED_BEFORE_OPEN")
        start.assert_not_called()

    def test_native_compile_rejects_unqualified_project_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "as-project.isp"
            project.write_bytes(as_container())
            with patch.object(server.sys, "platform", "win32"), \
                 patch.object(server, "ispsoft_start_background_session") as start:
                result = json.loads(server.ispsoft_compile_and_check(str(project), "check"))
        self.assertEqual(result["status"], "MODEL_NOT_QUALIFIED")
        self.assertEqual(result["qualified_models"], ["ES2"])
        start.assert_not_called()

    def test_native_compile_refuses_while_users_ispsoft_window_is_active(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "es2-project.isp"
            project.write_bytes(es2_v8_container())
            with patch.object(server.sys, "platform", "win32"), \
                 patch.object(server, "_process_ids", return_value=[7123]), \
                 patch.object(server, "_foreground_process_id", return_value=7123), \
                 patch.object(server, "ispsoft_start_background_session") as start:
                result = json.loads(server.ispsoft_compile_and_check(str(project), "compile", 120, 0))
        self.assertEqual(result["status"], "VISIBLE_ISPSOFT_ACTIVE")
        self.assertEqual(result["vendor_compile"], "NOT_RUN")
        self.assertEqual(result["active_process_id"], 7123)
        start.assert_not_called()

    def test_native_compile_idle_wait_ends_when_user_leaves_ispsoft_foreground(self) -> None:
        with patch.object(server, "_foreground_process_id", side_effect=[7123, 9000, 9000]), \
             patch.object(server.time, "monotonic", side_effect=[0.0, 0.0, 0.1, 0.61]), \
             patch.object(server.time, "sleep"):
            result = server._wait_for_user_ide_idle({7123}, 5)
        self.assertTrue(result["ready"])
        self.assertIsNone(result["active_process_id"])
        self.assertEqual(result["waited_seconds"], 0.61)

    def test_native_compile_idle_wait_times_out_without_starting_worker(self) -> None:
        with patch.object(server, "_foreground_process_id", return_value=7123):
            result = server._wait_for_user_ide_idle({7123}, 0)
        self.assertFalse(result["ready"])
        self.assertEqual(result["active_process_id"], 7123)

    def test_ide_session_reports_visible_window_evidence(self) -> None:
        window = {"handle": 42, "pid": 7, "title": "ISPSoft", "class_name": "Main",
                  "visible": True, "minimized": False}
        with patch.object(server, "_process_running", return_value=True), \
             patch.object(server, "_process_ids", return_value=[7]), \
             patch.object(server, "_ide_windows", return_value=[window]):
            session = server._ide_session()
        self.assertEqual(session["diagnosis"], "VISIBLE_WINDOW")
        self.assertEqual(session["visible_window_count"], 1)
        self.assertEqual(session["process_ids"], [7])

    def test_ide_session_hides_invisible_implementation_windows(self) -> None:
        windows = [
            {"handle": 42, "pid": 7, "title": "ISPSoft", "class_name": "Main",
             "visible": True, "minimized": False},
            {"handle": 43, "pid": 7, "title": "", "class_name": "Utility",
             "visible": False, "minimized": False},
        ]
        with patch.object(server, "_process_running", return_value=True), \
             patch.object(server, "_process_ids", return_value=[7]), \
             patch.object(server, "_ide_windows", return_value=windows):
            session = server._ide_session()
        self.assertEqual(len(session["windows"]), 1)
        self.assertEqual(session["window_count"], 2)
        self.assertEqual(session["hidden_window_count"], 1)

    def test_ide_session_separates_minimized_windows(self) -> None:
        window = {"handle": 42, "pid": 7, "title": "ISPSoft", "class_name": "Main",
                  "visible": True, "minimized": True}
        with patch.object(server, "_process_ids", return_value=[7]), \
             patch.object(server, "_ide_windows", return_value=[window]):
            session = server._ide_session()
        self.assertEqual(session["diagnosis"], "WINDOW_HIDDEN_OR_MINIMIZED")
        self.assertEqual(session["visible_window_count"], 0)
        self.assertEqual(session["minimized_window_count"], 1)
        self.assertEqual(session["windows"], [])

    def test_private_desktop_enumeration_treats_no_more_files_as_normal_end(self) -> None:
        user32 = Mock()
        user32.EnumDesktopWindows.return_value = False
        with patch.object(server.ctypes, "WinDLL", return_value=user32), \
             patch.object(server.ctypes, "get_last_error", return_value=18):
            self.assertEqual(server._ide_windows_on_desktop(555, 123), [])

    def test_native_check_restores_shared_compiler_sidecars(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sidecar = root / "CompiledCode.txt"
            prior = b"prior compile state"
            worker = b"worker compile state"
            sidecar.write_bytes(prior)
            snapshot = server._snapshot_compiler_sidecars(root)
            sidecar.write_bytes(worker)
            result = server._restore_compiler_sidecars(
                root, snapshot, {sidecar.name: server._sha(worker)})
            current = sidecar.read_bytes()
        self.assertTrue(result["success"])
        self.assertEqual(result["restored_files"], ["CompiledCode.txt"])
        self.assertEqual(current, prior)

    def test_native_check_preserves_concurrent_compiler_sidecar_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sidecar = root / "CompiledCode.txt"
            sidecar.write_bytes(b"prior compile state")
            snapshot = server._snapshot_compiler_sidecars(root)
            sidecar.write_bytes(b"worker compile state")
            expected_worker_hash = server._sha(sidecar.read_bytes())
            sidecar.write_bytes(b"concurrent user compile state")
            result = server._restore_compiler_sidecars(
                root, snapshot, {sidecar.name: expected_worker_hash})
            current = sidecar.read_bytes()
        self.assertFalse(result["success"])
        self.assertEqual(result["concurrent_change_files"], ["CompiledCode.txt"])
        self.assertEqual(current, b"concurrent user compile state")

    def test_user_activity_verifies_unchanged_compiler_sidecars_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sidecar = root / "CompiledCode.txt"
            sidecar.write_bytes(b"before")
            before = server._snapshot_compiler_sidecars(root)
            result = server._verify_compiler_sidecars_unchanged(root, before)
            current = sidecar.read_bytes()
        self.assertTrue(result["success"])
        self.assertEqual(result["status"], "UNCHANGED_DURING_USER_ACTIVITY")
        self.assertEqual(result["restored_files"], [])
        self.assertEqual(current, b"before")

    def test_user_activity_rejects_changed_compiler_sidecars_without_restoring(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sidecar = root / "CompiledCode.txt"
            sidecar.write_bytes(b"before")
            before = server._snapshot_compiler_sidecars(root)
            sidecar.write_bytes(b"concurrent change")
            result = server._verify_compiler_sidecars_unchanged(root, before)
            current = sidecar.read_bytes()
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "SKIPPED_DURING_USER_ACTIVITY")
        self.assertEqual(result["concurrent_change_files"], ["CompiledCode.txt"])
        self.assertEqual(current, b"concurrent change")

    def test_native_check_removes_worker_sidecars_that_did_not_exist_before(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            snapshot = server._snapshot_compiler_sidecars(root)
            sidecar = root / "CompiledCode.txt"
            worker = b"worker compile state"
            sidecar.write_bytes(worker)
            result = server._restore_compiler_sidecars(
                root, snapshot, {sidecar.name: server._sha(worker)})
            remains = sidecar.exists()
        self.assertTrue(result["success"])
        self.assertEqual(result["restored_files"], ["CompiledCode.txt"])
        self.assertFalse(remains)

    def test_start_ide_refuses_to_start_without_a_project(self) -> None:
        with patch.object(server, "_ide_session") as observe, \
             patch.object(server, "_configured_previous_project", return_value=None), \
             patch.object(server.subprocess, "Popen") as popen:
            result = json.loads(server.ispsoft_start_ide(""))
        self.assertEqual(result["status"], "PREVIOUS_PROJECT_NOT_CONFIGURED")
        self.assertFalse(result["success"])
        observe.assert_not_called()
        popen.assert_not_called()

    def test_start_ide_uses_ispsoft_configured_previous_project_without_cli_argument(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "station project.isp"
            project.write_bytes(es2_v8_container())
            settings = root / "Delta Industrial Automation" / "ISPSoft_New" / "ISPSoft.ini"
            settings.parent.mkdir(parents=True)
            settings.write_text(
                "[MainForm]\nloadPreviousPrj=1\n[Project]\nProjectName=" + str(project) + "\n",
                encoding="cp1252")
            session = {"windows": [{"handle": 42, "title": "station project - Delta ISPSoft",
                                    "visible": True, "minimized": False}]}
            with patch.dict(server.os.environ, {"APPDATA": str(root)}), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server, "_ide_session", side_effect=[{"windows": []}, session]), \
                 patch.object(server.subprocess, "Popen") as popen, \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_start_ide())
            self.assertEqual(result["status"], "PROJECT_WINDOW_TITLE_MATCH")
            self.assertEqual(result["project_path"], str(project.resolve()))
            self.assertEqual(result["launch_mode"], "ISPSoft_PREVIOUS_PROJECT_SETTING")
            self.assertEqual(popen.call_args.args[0], [str(Path("C:/Delta/NewISPSoft.exe"))])

    def test_open_project_reuses_matching_visible_ispsoft_window(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "station project.isp"
            project.write_bytes(es2_v8_container())
            session = {"process_running": True, "windows": [{
                "handle": 42, "title": "station project - Delta ISPSoft",
                "visible": True, "minimized": False}]}
            with patch.object(server, "_ide_session", return_value=session), \
                 patch.object(server.subprocess, "Popen") as popen, \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_open_project(str(project)))
            self.assertEqual(result["status"], "PROJECT_ALREADY_VISIBLE")
            self.assertTrue(result["already_open"])
            popen.assert_not_called()

    def test_background_session_uses_hidden_isolated_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "station project.isp"
            original = es2_v8_container()
            source.write_bytes(original)
            window = {"handle": 42, "pid": 123,
                      "title": "station project__MCP_123456789abc - Delta ISPSoft",
                      "class_name": "TMainFrm", "visible": True, "minimized": False}
            process = Mock()
            process.pid = 123
            process.poll.return_value = None
            process.windows.return_value = [window]
            with patch.object(server, "WORK_DIR", root / "work"), \
                 patch.dict(server.os.environ, {"APPDATA": str(root / "user-appdata")}), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server, "_ide_windows", return_value=[]), \
                 patch.object(server, "_create_private_desktop", return_value=555) as desktop, \
                 patch.object(server, "_create_private_desktop_process", return_value=process) as launch, \
                 patch.object(server.uuid, "uuid4", return_value=Mock(hex="123456789abc00000000000000000000")), \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_start_background_session(str(source), 1))
            self.assertEqual(result["status"], "BACKGROUND_PROJECT_OPEN_TITLE_MATCH")
            self.assertTrue(result["success"])
            self.assertTrue(result["hidden"])
            self.assertTrue(result["desktop_isolated"])
            self.assertTrue(result["hidden_from_user"])
            self.assertTrue(result["visible_on_private_desktop"])
            self.assertFalse(result["visible_to_user"])
            self.assertTrue(result["readback_verified"])
            self.assertEqual(result["priority_class"], "BELOW_NORMAL")
            self.assertEqual(Path(result["worker_project_path"]).read_bytes(), original)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(desktop.call_args.args[0], result["desktop_name"])
            args = launch.call_args.args
            self.assertEqual(args[0], Path("C:/Delta/NewISPSoft.exe"))
            self.assertEqual(args[1], Path(result["worker_project_path"]))
            self.assertEqual(args[2]["APPDATA"], result["profile_path"])
            self.assertEqual(args[3], result["desktop_name"])
            self.assertEqual(args[4], 555)

    def test_background_session_uses_configured_previous_project_when_path_is_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "previous station.isp"
            original = es2_v8_container()
            source.write_bytes(original)
            window = {"handle": 42, "pid": 123,
                      "title": "previous station__MCP_123456789abc - Delta ISPSoft",
                      "class_name": "TMainFrm", "visible": True, "minimized": False}
            process = Mock()
            process.pid = 123
            process.poll.return_value = None
            process.windows.return_value = [window]
            with patch.object(server, "WORK_DIR", root / "work"), \
                 patch.object(server, "_configured_previous_project", return_value=source) as previous, \
                 patch.dict(server.os.environ, {"APPDATA": str(root / "user-appdata")}), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server, "_ide_windows", return_value=[]), \
                 patch.object(server, "_create_private_desktop", return_value=555), \
                 patch.object(server, "_create_private_desktop_process", return_value=process) as launch, \
                 patch.object(server.uuid, "uuid4", return_value=Mock(hex="123456789abc00000000000000000000")), \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_start_background_session())
            previous.assert_called_once_with()
            self.assertTrue(result["success"])
            self.assertEqual(result["project_path"], str(source.resolve()))
            self.assertEqual(Path(result["worker_project_path"]).read_bytes(), original)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(launch.call_args.args[1], Path(result["worker_project_path"]))

    def test_background_session_refuses_blank_launch_without_saved_previous_project(self) -> None:
        with patch.object(server, "_configured_previous_project", return_value=None), \
             patch.object(server, "_exe") as executable, \
             patch.object(server.sys, "platform", "win32"):
            result = json.loads(server.ispsoft_start_background_session(""))
        self.assertEqual(result["status"], "PREVIOUS_PROJECT_NOT_CONFIGURED")
        self.assertFalse(result["success"])
        executable.assert_not_called()

    def test_background_session_default_wait_allows_ispsoft_cold_start(self) -> None:
        self.assertEqual(inspect.signature(server.ispsoft_start_background_session)
                         .parameters["wait_seconds"].default, 60)

    def test_background_session_reports_private_desktop_access_denial_without_visible_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "station project.isp"
            original = es2_v8_container()
            source.write_bytes(original)
            with patch.object(server, "WORK_DIR", root / "work"), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server, "_create_private_desktop", side_effect=ctypes.WinError(5)), \
                 patch.object(server, "_create_private_desktop_process") as launch, \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_start_background_session(str(source), 1))
            self.assertFalse(result["success"])
            self.assertEqual(result["status"], "BACKGROUND_ISOLATION_DENIED")
            self.assertEqual(result["stage"], "CREATING_PRIVATE_DESKTOP")
            self.assertFalse(result["visible_fallback_used"])
            self.assertTrue(result["created_paths_removed"])
            self.assertEqual(source.read_bytes(), original)
            launch.assert_not_called()

    def test_background_session_stops_only_its_owned_process(self) -> None:
        process = Mock()
        process.poll.return_value = None
        session_id = "session-123"
        record = {"session_id": session_id, "process": process, "process_id": 77,
                  "session_root": "C:/work/session-123", "worker_project_path": "C:/work/proj.isp"}
        with patch.dict(server._BACKGROUND_IDE_SESSIONS, {session_id: record}):
            result = json.loads(server.ispsoft_stop_background_session(session_id))
        self.assertEqual(result["status"], "STOPPED")
        self.assertTrue(result["original_project_untouched"])
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=10)

    def test_background_session_listing_uses_the_private_desktop_windows(self) -> None:
        process = Mock()
        process.pid = 77
        process.poll.return_value = None
        window = {"handle": 42, "pid": 77, "title": "station__MCP_test - Delta ISPSoft",
                  "class_name": "TMainFrm", "visible": True, "minimized": False}
        process.windows.return_value = [window]
        session_id = "session-123"
        record = {"session_id": session_id, "process": process, "process_id": 77,
                  "status": "BACKGROUND_PROJECT_OPEN_TITLE_MATCH", "isolated_desktop": True}
        with patch.dict(server._BACKGROUND_IDE_SESSIONS, {session_id: record}):
            result = json.loads(server.ispsoft_get_background_sessions())
        self.assertEqual(result["sessions"][0]["windows"], [window])
        self.assertTrue(result["sessions"][0]["hidden"])
        self.assertTrue(result["sessions"][0]["hidden_from_user"])
        self.assertTrue(result["sessions"][0]["visible_on_private_desktop"])
        self.assertFalse(result["sessions"][0]["visible_to_user"])

    def test_background_session_stops_worker_when_ispsoft_cannot_write_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "station project.isp"
            source.write_bytes(es2_v8_container())
            process = Mock()
            process.pid = 123
            process.poll.return_value = None
            dialog = {"handle": 77, "pid": 123, "title": "Delta ISPSoft",
                      "class_name": "#32770", "visible": False, "minimized": False}
            process.windows.return_value = [dialog]
            with patch.object(server, "WORK_DIR", root / "work"), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server, "_ide_windows", return_value=[]), \
                 patch.object(server, "_create_private_desktop", return_value=555), \
                 patch.object(server, "_create_private_desktop_process", return_value=process), \
                 patch.object(server, "_window_child_texts", return_value=[{
                     "class_name": "Static", "text": "Cannot create file C:\\Users\\User\\AppData\\Roaming\\Delta\\foldeStrList.txt."}]), \
                 patch.object(server.time, "monotonic", side_effect=[0, 2]), \
                 patch.object(server.time, "sleep"), \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_start_background_session(str(source), 1))
            self.assertFalse(result["success"])
            self.assertEqual(result["failure_reason"], "PROFILE_WRITE_DENIED")
            self.assertTrue(result["process_stopped"])
            process.terminate.assert_called_once()
            process.wait.assert_called_once_with(timeout=5)

    def test_open_project_reports_visible_filename_title_match(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "station project.isp"
            project.write_bytes(es2_v8_container())
            session = {"windows": [{"handle": 42, "title": "station project - Delta ISPSoft",
                                    "visible": True, "minimized": False}]}
            with patch.object(server, "_ide_session", side_effect=[{"windows": []}, session]), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server.subprocess, "Popen") as popen, \
                 patch.object(server.sys, "platform", "win32"):
                result = json.loads(server.ispsoft_open_project(str(project)))
            popen.assert_called_once()
            self.assertEqual(popen.call_args.args[0], [str(Path("C:/Delta/NewISPSoft.exe")), str(project.resolve())])
            self.assertEqual(result["status"], "PROJECT_WINDOW_TITLE_MATCH")
            self.assertTrue(result["title_match"])
            self.assertEqual(result["project_path"], str(project.resolve()))

    def test_open_project_does_not_claim_title_match_when_only_blank_window_is_visible(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "station project.isp"
            project.write_bytes(es2_v8_container())
            session = {"windows": [{"handle": 42, "title": "Delta ISPSoft",
                                    "visible": True, "minimized": False}]}
            with patch.object(server, "_ide_session", return_value=session), \
                 patch.object(server, "_exe", return_value=Path("C:/Delta/NewISPSoft.exe")), \
                 patch.object(server.subprocess, "Popen"), \
                 patch.object(server.sys, "platform", "win32"), \
                 patch.object(server.time, "monotonic", side_effect=[0.0, 16.0]), \
                 patch.object(server.time, "sleep"):
                result = json.loads(server.ispsoft_open_project(str(project)))
            self.assertEqual(result["status"], "OPEN_REQUESTED_UNVERIFIED")
            self.assertFalse(result["title_match"])

    def test_windows_safe_atomic_artifact_write_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "artifact.bin"
            limits.atomic_write(target, b"complete")
            self.assertEqual(target.read_bytes(), b"complete")
            with self.assertRaises(limits.FileTransformError):
                limits.atomic_write(target, b"replacement")
            self.assertEqual(target.read_bytes(), b"complete")

    def test_installed_device_catalog_is_separate_from_operation_qualification(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / "Network_Configuration" / "Devices" / "Devices.ini"
            config.parent.mkdir(parents=True)
            config.write_text("[PLC]**\n[DVP-Series]***\n[ES2\\ES2-C]****\n[AH-Series]***\n[CPU500-EN]****\n", encoding="cp1252")
            ddf = root / "DIACommission" / "DataTracer" / "DeviceData" / "DDF" / "Device.xml"
            ddf.parent.mkdir(parents=True)
            ddf.write_text('<Devices><Device ProdClass="PLC" ProdFuncName="CPU" ProdType="AS228T-A" /></Devices>', encoding="utf-8")
            with patch.object(server, "_ispsoft_root", return_value=root):
                catalog = server._installed_device_catalog()
            self.assertEqual(catalog["families"]["DVP"], ["ES2", "ES2-C"])
            self.assertEqual(catalog["families"]["AH"], ["CPU500-EN"])
            self.assertEqual(catalog["families"]["AS"], ["AS228T-A"])
            self.assertIn("not qualify", catalog["note"])

    def test_dvp32es2t_maps_to_es2_source_profile_but_not_live_qualification(self) -> None:
        canonical, error = server._model("DVP32ES2T")
        self.assertIsNone(error)
        self.assertEqual(canonical, "ES2")
        capabilities = json.loads(server.ispsoft_get_capabilities())
        self.assertEqual(capabilities["operations"]["runtime_device_read"]["status"], "NOT_QUALIFIED")
        self.assertEqual(capabilities["operations"]["online_monitor"]["status"], "NOT_QUALIFIED")
        self.assertEqual(capabilities["operations"]["ld_network_candidate_generation"]["models"], ["ES2"])

    def test_online_tools_fail_closed_without_contacting_controller(self) -> None:
        target = {"status": "SAVED_TARGET_FOUND", "driver": {"name": "COM1"},
                  "identity_verified": False}
        with patch.object(server, "_resolve_commgr_target", return_value=target):
            connected = json.loads(server.ispsoft_connect("DVP32ES2T", "COM1"))
            uploaded = json.loads(server.ispsoft_upload_from_plc("DVP32ES2T", "COM1", "backup.isp"))
            monitor = json.loads(server.ispsoft_start_monitor("ES2", "COM1"))
        self.assertFalse(connected["device_contacted"])
        self.assertEqual(uploaded["status"], "TRANSPORT_NOT_QUALIFIED")
        self.assertFalse(monitor["monitoring"])
        invalid_read = json.loads(server.ispsoft_runtime_read("ES2", ["X999999"]))
        self.assertEqual(invalid_read["status"], "TRANSPORT_NOT_QUALIFIED")
        invalid_syntax = json.loads(server.ispsoft_runtime_read("ES2", ["Y bad"]))
        self.assertEqual(invalid_syntax["status"], "REJECTED_BEFORE_IO")

    def test_connect_rejects_a_commgr_endpoint_shared_by_multiple_drivers(self) -> None:
        driver = {"name": "DVP_COM9", "targets": [{"transport": "serial",
                    "port_number": "9", "station": "3", "shared_endpoint": True,
                    "shared_driver_names": ["DVP_COM9", "Driver CUY"]}]}
        conflict = {"transport": "serial", "drivers": ["DVP_COM9", "Driver CUY"],
                    "port_number": "9"}
        with patch.object(server, "_read_commgr_driver_catalog", return_value={
                "status": "OK", "drivers": [driver], "target_conflicts": [conflict]}):
            result = json.loads(server.ispsoft_connect("ES2", "DVP_COM9"))
        self.assertEqual(result["status"], "TARGET_ENDPOINT_CONFLICT")
        self.assertFalse(result["connected"])
        self.assertFalse(result["device_contacted"])

    def test_commgr_target_resolution_requires_exact_saved_name(self) -> None:
        driver = {"name": "DVP_COM1", "targets": [{"transport": "serial",
                    "port_number": "1", "station": "2"}]}
        with patch.object(server, "_read_commgr_driver_catalog", return_value={
                "status": "OK", "drivers": [driver], "target_conflicts": []}), \
             patch.object(server, "_enumerate_windows_serial_ports", return_value=[{
                 "port": "COM1", "friendly_name": "USB Serial Port (COM1)"}]):
            exact = server._resolve_commgr_target("DVP_COM1")
            mismatched_case = server._resolve_commgr_target("dvp_com1")
        self.assertEqual(exact["status"], "SAVED_TARGET_FOUND")
        self.assertFalse(exact["identity_verified"])
        self.assertEqual(mismatched_case["status"], "DRIVER_NOT_FOUND")

    def test_commgr_target_resolution_rejects_missing_serial_port_without_opening_it(self) -> None:
        driver = {"name": "DVP_COM1", "targets": [{"transport": "serial",
                    "port_number": "1", "station": "2"}]}
        with patch.object(server, "_read_commgr_driver_catalog", return_value={
                "status": "OK", "drivers": [driver], "target_conflicts": []}), \
             patch.object(server, "_enumerate_windows_serial_ports", return_value=[]):
            result = server._resolve_commgr_target("DVP_COM1")
        self.assertEqual(result["status"], "TARGET_PORT_NOT_PRESENT")
        self.assertFalse(result["device_contacted"])
        self.assertFalse(result["serial_port_opened"])

    def test_commgr_driver_discovery_reads_config_without_contacting_device(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "DriverInfo.dri"
            config.write_text(
                '<DriverInfo><Driver DriverID="162" DriverName="DVP-serial" '
                'CommInterface="1" DriverStatus="1"><ComInfo PortNumber="1" '
                'PLCStationNum="2"/></Driver><Driver DriverID="7" DriverName="DVP-net" '
                'CommInterface="3" DriverStatus="2"><NetInfo StationID="0">'
                '<RemoteIP RemoteIPAddr="127.0.0.1" RemotePort="502" '
                'RemoteDeviceTypeStr="DVP-ES2"/></NetInfo></Driver></DriverInfo>',
                encoding="utf-8")
            result = server._read_commgr_driver_catalog(config)
        self.assertEqual(result["status"], "OK")
        self.assertFalse(result["device_contacted"])
        self.assertEqual(result["driver_count"], 2)
        self.assertEqual(result["drivers"][0]["targets"][0]["port_number"], "1")
        self.assertEqual(result["drivers"][1]["targets"][0]["configured_model"], "DVP-ES2")

    def test_commgr_driver_discovery_prefers_active_user_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            appdata = Path(temp) / "Roaming"
            active = appdata / "Delta Industrial Automation" / "COMMGR" / "DriverInfo.dri"
            active.parent.mkdir(parents=True)
            active.write_text('<DriverInfo/>', encoding="utf-8")
            installed_commgr = Path(temp) / "install" / "COMMGR.exe"
            installed_commgr.parent.mkdir()
            installed_commgr.touch()
            with patch.dict(os.environ, {"APPDATA": str(appdata)}), \
                 patch.object(server, "COMMGR_CANDIDATES", (installed_commgr,)):
                self.assertEqual(server._commgr_driver_config_path(), active)

    def test_commgr_driver_discovery_fails_closed_on_duplicate_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "DriverInfo.dri"
            config.write_text(
                '<DriverInfo><Driver DriverID="1" DriverName="same"/>'
                '<Driver DriverID="2" DriverName="SAME"/></DriverInfo>',
                encoding="utf-8")
            result = server._read_commgr_driver_catalog(config)
        self.assertEqual(result["status"], "CONFIG_AMBIGUOUS")
        self.assertFalse(result["device_contacted"])

    def test_commgr_driver_discovery_marks_shared_serial_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "DriverInfo.dri"
            driver = '<Driver DriverID="{id}" DriverName="{name}" CommInterface="1"><ComInfo PortNumber="9" PLCStationNum="3"/></Driver>'
            config.write_text('<DriverInfo>' + driver.format(id="1", name="first")
                              + driver.format(id="2", name="second") + '</DriverInfo>',
                              encoding="utf-8")
            result = server._read_commgr_driver_catalog(config)
        self.assertTrue(result["has_target_conflicts"])
        self.assertEqual(result["target_conflicts"][0]["drivers"], ["first", "second"])
        self.assertTrue(result["drivers"][0]["targets"][0]["shared_endpoint"])
        self.assertFalse(result["device_contacted"])

    def test_simulator_presence_is_discovered_but_never_means_connected(self) -> None:
        sim = Path(r"C:\Delta\DVPSimulator_ES2.exe")
        with patch.object(server, "_installed", side_effect=[sim, sim]), \
             patch.object(server, "_process_running", return_value=True):
            status = json.loads(server.ispsoft_get_status())
        self.assertTrue(status["dvp_es2_simulator_installed"])
        self.assertTrue(status["dvp_es2_simulator_running"])
        with patch.object(server, "_installed", return_value=sim), \
             patch.object(server, "_process_running", return_value=True):
            online = json.loads(server.ispsoft_online_status("ES2"))
        self.assertFalse(online["connected"])
        self.assertEqual(online["status"], "TRANSPORT_NOT_QUALIFIED")

    def test_cross_reference_detects_read_and_write(self) -> None:
        result = json.loads(server.ispsoft_analyze_source("LD X0\nOUT Y0\nMOV D0 D1"))
        refs = {item["address"]: item for item in result["devices"]}
        self.assertTrue(refs["X0"]["reads"])
        self.assertTrue(refs["Y0"]["writes"])
        self.assertTrue(refs["D1"]["writes"])

    def test_comment_map_rejects_duplicate_normalized_address(self) -> None:
        result = json.loads(server.ispsoft_validate_device_comments(
            {"X0": "Start", "x 0": "Duplicate"}, "DVP12SE11R"))
        self.assertFalse(result["valid"])

    def test_live_write_and_download_require_two_keys_and_remain_disabled(self) -> None:
        old = os.environ.pop(server.LIVE_WRITES_ENV, None)
        try:
            blocked = json.loads(server.ispsoft_runtime_write("DVP12SE11R", {"Y0": True}, True))
            self.assertEqual(blocked["status"], "BLOCKED")
            os.environ[server.LIVE_WRITES_ENV] = "1"
            still_disabled = json.loads(server.ispsoft_runtime_write("DVP12SE11R", {"Y0": True}, True))
            self.assertEqual(still_disabled["status"], "TRANSPORT_NOT_QUALIFIED")
            download = json.loads(server.ispsoft_download("project.isp", "DVP12SE11R", True))
            self.assertEqual(download["status"], "TRANSPORT_NOT_QUALIFIED")
        finally:
            if old is None:
                os.environ.pop(server.LIVE_WRITES_ENV, None)
            else:
                os.environ[server.LIVE_WRITES_ENV] = old


if __name__ == "__main__":
    unittest.main()
