"""Harbor 0.22.0 custom agent. Execution happens in Harbor's environment.

Supply a prebuilt Linux bundle directory containing rune and rune-tools through
RUNE_BENCH_BUNDLE. No host execution fallback or automatic installer downloads.
This adapter is pristine; Harbor's verifier alone assigns the task reward.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import sqlite3
import tempfile
import uuid

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class RuneAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "rune"

    def version(self) -> str:
        return "adapter-1-harbor-0.22.0"

    def setting(self, key: str, default: str = "") -> str:
        return self.extra_env.get(key, os.environ.get(key, default))

    async def setup(self, environment: BaseEnvironment) -> None:
        bundle = Path(self.setting("RUNE_BENCH_BUNDLE"))
        self.remote = f"/tmp/rune-harbor-{uuid.uuid4().hex}"
        self.bundle_hashes = {}
        for name in ("rune", "rune-tools"):
            path = bundle / name
            if not path.is_file() or path.read_bytes()[:4] != b"\x7fELF":
                raise ValueError(f"RUNE_BENCH_BUNDLE must contain Linux ELF {name}; host binaries are not compatible")
            self.bundle_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        result = await environment.exec(f"mkdir -p {shlex.quote(self.remote)}", timeout_sec=30)
        if result.return_code != 0:
            raise RuntimeError("Cannot create isolated Rune install directory")
        for name in ("rune", "rune-tools"):
            await environment.upload_file(bundle / name, f"{self.remote}/{name}")
        result = await environment.exec(
            f"chmod 700 {shlex.quote(self.remote)}/rune {shlex.quote(self.remote)}/rune-tools && {shlex.quote(self.remote)}/rune --version",
            timeout_sec=30,
        )
        if result.return_code != 0:
            raise RuntimeError("Linux Rune bundle failed its environment version probe; check CPU architecture and libraries")
        self.binary_version = result.stdout.strip()

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not getattr(self, "remote", None):
            raise RuntimeError("Rune setup did not complete")
        budget = float(self.setting("RUNE_BENCH_BUDGET_USD", "2"))
        timeout = int(self.setting("RUNE_BENCH_TIMEOUT_SECONDS", "600"))
        if not math.isfinite(budget) or budget <= 0 or timeout <= 0:
            raise ValueError("Benchmark budget and timeout must be positive")
        model = self.model_name or self.setting("RUNE_BENCH_MODEL")
        if not model:
            raise ValueError("Harbor --model is required")
        provider = self.setting("RUNE_BENCH_PROVIDER", "openai")
        workspace = self.setting("RUNE_BENCH_WORKSPACE")
        if not workspace:
            result = await environment.exec("pwd", timeout_sec=30)
            if result.return_code != 0:
                raise RuntimeError("Could not discover task working directory")
            workspace = result.stdout.strip()
        if not workspace.startswith("/") or "\n" in workspace:
            raise ValueError("Task workspace must be an absolute Linux path")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        # Prompt and config travel as files, never interpolated into shell text.
        with tempfile.TemporaryDirectory(prefix="rune-harbor-input-") as scratch:
            prompt = Path(scratch) / "prompt.txt"
            prompt.write_text(instruction)
            config = Path(scratch) / "config.toml"
            config.write_text(f'[cost]\nmaxSessionUsd = {budget}\n[llm]\nreasoningEffort = "high"\neffortRouting = "off"\n[reliability]\nmaxTurns = 48\nsecondWinds = 0\n[notebook]\nenabled = false\n[evolve]\nplaybook = false\n')
            await environment.upload_file(prompt, f"{self.remote}/prompt.txt")
            await environment.upload_file(config, f"{self.remote}/config.toml")
        env = {"RUNE_HOME": f"{self.remote}/profile", "RUNE_CONFIG_PATH": f"{self.remote}/config.toml",
               "RUNE_DB_PATH": f"{self.remote}/rune.db", "PATH": f"{self.remote}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY"):
            value = self.setting(key)
            if value:
                env[key] = value
        # Harbor owns the outer container. Native nested sandboxing is explicitly
        # disabled here; this setting never changes the user's installed config.
        args = [f"{self.remote}/rune", "--workspace", workspace, "--provider", provider,
                "--model", model, "--gear", "auto", "--auto-approve", "--pristine", "--stream-json", "--no-browser", "--no-sandbox"]
        command = shlex.join(args) + f' -P "$(cat {shlex.quote(self.remote + "/prompt.txt")})" > {shlex.quote(self.remote + "/events.jsonl")} 2> {shlex.quote(self.remote + "/stderr.log")}'
        result = None
        try:
            result = await environment.exec(command, cwd=workspace, env=env, timeout_sec=timeout)
        finally:
            for name in ("events.jsonl", "stderr.log", "rune.db", "rune.db-wal"):
                try:
                    await environment.download_file(f"{self.remote}/{name}", self.logs_dir / name)
                    (self.logs_dir / name).chmod(0o600)
                except Exception:
                    pass  # The original execution/timeout error remains authoritative.
        context.metadata = {"adapter": self.version(), "binary": self.binary_version,
                            "bundle_sha256": self.bundle_hashes, "provider": provider, "model": model,
                            "budget_usd": budget, "exit_code": result.return_code if result else None,
                            "cost_source": "unavailable; adapter does not invent token counts from prose"}
        database = self.logs_dir / "rune.db"
        if database.exists():
            try:
                with sqlite3.connect(database) as db:
                    entries = [json.loads(row[0])["payload"] for row in db.execute(
                        "SELECT payload_json FROM events WHERE json_extract(payload_json, '$.type')='cost'"
                    )]
                if entries:
                    context.n_input_tokens = sum(e.get("inputTokens", 0) + e.get("cacheReadTokens", 0) + e.get("cacheCreationTokens", 0) for e in entries)
                    context.n_cache_tokens = sum(e.get("cacheReadTokens", 0) for e in entries)
                    context.n_output_tokens = sum(e.get("outputTokens", 0) for e in entries)
                    context.metadata["cost_source"] = "Rune gateway ledger including helpers; list equivalent, not invoice"
                    context.metadata["estimated_rates"] = any(e.get("estimated") for e in entries)
                    if all(e.get("priced") for e in entries):
                        context.cost_usd = sum(e["listCostUsd"] for e in entries)
                        context.metadata["on_budget"] = context.cost_usd <= budget
            except (sqlite3.Error, ValueError, KeyError):
                context.metadata["cost_source"] = "ledger unavailable or incomplete"
        (self.logs_dir / "rune-provenance.json").write_text(json.dumps(context.metadata, indent=2))
        if result is not None and result.return_code != 0:
            raise RuntimeError(f"Rune exited {result.return_code}; see private agent logs")
