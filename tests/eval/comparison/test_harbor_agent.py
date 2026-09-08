import asyncio
import json
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest

from harbor.models.agent.context import AgentContext
from harbor_agent import RuneAgent
from harbor_run import selected_tasks


class FakeEnvironment:
    def __init__(self):
        self.calls = []
        self.files = {}

    async def exec(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return SimpleNamespace(return_code=0, stdout="/workspace\n" if command == "pwd" else "Rune test\n")

    async def upload_file(self, source_path, target_path):
        self.files[target_path] = Path(source_path).read_bytes()

    async def download_file(self, source_path, target_path):
        if source_path.endswith(".db") or source_path.endswith("-wal"):
            raise FileNotFoundError(source_path)
        Path(target_path).write_text("private log\n")


class HarborAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_interface_safe_prompt_transfer_and_explicit_containment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("rune", "rune-tools"):
                (root / name).write_bytes(b"\x7fELFfixture-not-executed")
            agent = RuneAgent(logs_dir=root / "logs", model_name="model", extra_env={
                "RUNE_BENCH_BUNDLE": str(root), "OPENAI_API_KEY": "unit-test-key"})
            env = FakeEnvironment()
            await agent.setup(env)
            context = AgentContext()
            prompt = "Keep literal $(touch /should-not-exist) and `quotes`\nSecond line"
            await agent.run(prompt, env, context)
            command, kwargs = env.calls[-1]
            self.assertNotIn(prompt, command)
            self.assertIn(prompt.encode(), env.files.values())
            tokens = shlex.split(command)
            self.assertTrue(tokens[tokens.index("-P") + 1].startswith("$(cat "))
            self.assertIn("--no-sandbox", tokens)  # Harbor owns the outer environment.
            self.assertEqual(kwargs["cwd"], "/workspace")
            self.assertEqual(kwargs["env"]["OPENAI_API_KEY"], "unit-test-key")
            self.assertNotIn("unit-test-key", command)
            self.assertNotIn("unit-test-key", (root / "logs/rune-provenance.json").read_text())
            self.assertIsNone(context.cost_usd)
            self.assertEqual((root / "logs/events.jsonl").stat().st_mode & 0o777, 0o600)

    async def test_missing_linux_bundle_never_executes_on_host_or_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = RuneAgent(logs_dir=Path(tmp), extra_env={"RUNE_BENCH_BUNDLE": tmp})
            env = FakeEnvironment()
            with self.assertRaisesRegex(ValueError, "Linux ELF"):
                await agent.setup(env)
            self.assertEqual(env.calls, [])

    def test_dataset_mismatch_cannot_silently_shrink_the_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); anchor = root / "anchor.json"
            anchor.write_text(json.dumps({"task_ids": ["one", "two"]}))
            (root / "one").mkdir(); (root / "one/task.toml").write_text("version = 1")
            with self.assertRaisesRegex(ValueError, "missing: two"):
                selected_tasks(root, anchor)
            (root / "two").mkdir(); (root / "two/task.toml").write_text("version = 1")
            self.assertEqual(selected_tasks(root, anchor), ["one", "two"])


if __name__ == "__main__":
    unittest.main()
