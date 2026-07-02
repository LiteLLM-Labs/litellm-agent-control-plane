from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


def load_server(temp_root: Path) -> ModuleType:
    os.environ["DB_PATH"] = str(temp_root / "agents.db")
    os.environ["OPENCLAW_CONFIG_PATH"] = str(temp_root / "openclaw.json")
    os.environ["OPENCLAW_MANAGED_MCP_PATH"] = str(temp_root / "managed-mcp.json")
    os.environ["OPENCLAW_MCP_RELOAD_COMMAND"] = "0"
    server_path = Path(__file__).resolve().parents[1] / "src" / "server.py"
    spec = importlib.util.spec_from_file_location("openclaw_test_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {server_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ManagedMcpConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp_dir.name)
        cls.server = load_server(cls.root)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp_dir.cleanup()

    def setUp(self) -> None:
        self.case_dir = self.root / self._testMethodName
        self.case_dir.mkdir()
        self.config_path = self.case_dir / "openclaw.json"
        self.managed_path = self.case_dir / "managed-mcp.json"
        self.server.OPENCLAW_CONFIG_PATH = str(self.config_path)
        self.server.OPENCLAW_MANAGED_MCP_PATH = str(self.managed_path)
        self.server.OPENCLAW_MCP_RELOAD_COMMAND = "0"

    def write_config(self, value: dict) -> None:
        self.server.write_json_file(self.config_path, value)

    def read_config(self) -> dict:
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def agent(self, mcp_servers: list[dict]) -> dict:
        return {
            "id": "agent_test",
            "mcp_servers": json.dumps(mcp_servers),
        }

    def managed_marker(self) -> dict:
        return {
            self.server.BRIDGE_CONFIG_KEY: {
                self.server.MANAGED_BY_CONFIG_KEY: self.server.BRIDGE_MANAGED_BY
            }
        }

    def test_migrates_inline_metadata_out_of_openclaw_config(self) -> None:
        self.write_config(
            {
                self.server.BRIDGE_CONFIG_KEY: {
                    self.server.MANAGED_MCP_CONFIG_KEY: ["managed", "stale"]
                },
                "mcp": {
                    "servers": {
                        "managed": {
                            "url": "https://old.example/mcp",
                            **self.managed_marker(),
                        },
                        "operator": {"url": "https://operator.example/mcp"},
                        "stale": {
                            "url": "https://stale.example/mcp",
                            **self.managed_marker(),
                        },
                    }
                },
            }
        )

        self.server.sync_openclaw_mcp_config(
            self.agent([{"name": "managed", "url": "https://new.example/mcp"}])
        )

        config = self.read_config()
        self.assertNotIn(self.server.BRIDGE_CONFIG_KEY, config)
        self.assertEqual(
            config["mcp"]["servers"],
            {
                "managed": {
                    "transport": "streamable-http",
                    "url": "https://new.example/mcp",
                },
                "operator": {"url": "https://operator.example/mcp"},
            },
        )
        self.assertEqual(
            config["tools"],
            {
                "allow": ["group:openclaw", "bundle-mcp"],
                "sandbox": {"tools": {"alsoAllow": ["bundle-mcp"]}},
            },
        )
        self.assertEqual(
            json.loads(self.managed_path.read_text(encoding="utf-8")),
            ["managed"],
        )

    def test_sidecar_tracks_stale_names_without_touching_operator_servers(self) -> None:
        self.write_config(
            {
                "mcp": {
                    "servers": {
                        "managed": {"url": "https://managed.example/mcp"},
                        "operator": {"url": "https://operator.example/mcp"},
                    }
                }
            }
        )
        self.server.write_json_file(self.managed_path, ["managed"])

        self.server.sync_openclaw_mcp_config(self.agent([]))

        self.assertEqual(
            self.read_config()["mcp"]["servers"],
            {"operator": {"url": "https://operator.example/mcp"}},
        )
        self.assertEqual(
            json.loads(self.managed_path.read_text(encoding="utf-8")),
            [],
        )

    def test_rejects_operator_owned_name_collision(self) -> None:
        original = {
            "mcp": {
                "servers": {
                    "operator": {"url": "https://operator.example/mcp"},
                }
            }
        }
        self.write_config(original)

        with self.assertRaisesRegex(
            ValueError,
            "mcp server operator conflicts with existing OpenClaw config",
        ):
            self.server.sync_openclaw_mcp_config(
                self.agent([{"name": "operator", "url": "https://new.example/mcp"}])
            )

        self.assertEqual(self.read_config(), original)
        self.assertFalse(self.managed_path.exists())


if __name__ == "__main__":
    unittest.main()
