from __future__ import annotations

import json
import os
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

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
        }.issubset(names))

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

    def test_online_tools_fail_closed_without_contacting_controller(self) -> None:
        self.assertEqual(json.loads(server.ispsoft_connect("DVP32ES2T", "COM1"))["device_contacted"], False)
        uploaded = json.loads(server.ispsoft_upload_from_plc("DVP32ES2T", "COM1", "backup.isp"))
        self.assertEqual(uploaded["status"], "TRANSPORT_NOT_QUALIFIED")
        monitor = json.loads(server.ispsoft_start_monitor("ES2", "COM1"))
        self.assertFalse(monitor["monitoring"])
        invalid_read = json.loads(server.ispsoft_runtime_read("ES2", ["X999999"]))
        self.assertEqual(invalid_read["status"], "TRANSPORT_NOT_QUALIFIED")
        invalid_syntax = json.loads(server.ispsoft_runtime_read("ES2", ["Y bad"]))
        self.assertEqual(invalid_syntax["status"], "REJECTED_BEFORE_IO")

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
