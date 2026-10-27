from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import unittest
from pathlib import Path

from mcp.shared.version import LATEST_PROTOCOL_VERSION


class McpStdioIntegrationTests(unittest.TestCase):
    def test_initialize_list_and_safe_call_over_stdio(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        server_path = repo_root / "ispsoft_mcp_server.py"
        process = subprocess.Popen(
            [sys.executable, str(server_path)],
            cwd=repo_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        output: queue.Queue[str | None] = queue.Queue()

        def drain_stdout() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                output.put(line)
            output.put(None)

        def drain_stderr() -> None:
            if process.stderr is not None:
                for _ in process.stderr:
                    pass

        stdout_thread = threading.Thread(target=drain_stdout, name="mcp-test-stdout", daemon=True)
        stderr_thread = threading.Thread(target=drain_stderr, name="mcp-test-stderr", daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        def send(message: dict) -> None:
            assert process.stdin is not None
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()

        def receive(request_id: int) -> dict:
            while True:
                try:
                    line = output.get(timeout=20)
                except queue.Empty as exc:
                    raise AssertionError(f"MCP response {request_id} timed out; exit={process.poll()}") from exc
                if line is None:
                    raise AssertionError(f"MCP exited before response {request_id}; exit={process.poll()}")
                message = json.loads(line)
                if message.get("id") == request_id:
                    return message

        try:
            send({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": LATEST_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "ispsoft-mcp-regression", "version": "1"},
                },
            })
            initialized = receive(1)
            self.assertEqual(initialized["result"]["serverInfo"]["name"], "ispsoft")

            send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            listed = receive(2)
            tool_names = {tool["name"] for tool in listed["result"]["tools"]}
            self.assertIn("ispsoft_write_local_variables_candidate", tool_names)
            self.assertIn("ispsoft_map_dvp_modbus_addresses", tool_names)
            self.assertIn("ispsoft_online_status", tool_names)

            send({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "ispsoft_online_status", "arguments": {"model": "ES2"}},
            })
            called = receive(3)
            result = json.loads(called["result"]["content"][0]["text"])
            self.assertEqual(result["status"], "TRANSPORT_NOT_QUALIFIED")
            self.assertIs(result["device_contacted"], False)

            send({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "ispsoft_map_dvp_modbus_addresses",
                           "arguments": {"model": "DVP32ES2T", "addresses": ["X0", "D7000"]}},
            })
            mapped = receive(4)
            mapping_result = json.loads(mapped["result"]["content"][0]["text"])
            self.assertEqual(mapping_result["status"], "MAPPED_OFFLINE_ONLY")
            self.assertEqual(mapping_result["mappings"][1]["accesses"][0]["pdu_address"], 0x9B58)
            self.assertIs(mapping_result["device_contacted"], False)
            self.assertIs(mapping_result["serial_port_opened"], False)
        finally:
            if process.stdin is not None:
                process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            stdout_thread.join(timeout=2)
            stderr_thread.join(timeout=2)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
