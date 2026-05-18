#!/usr/bin/env bun
import { runSuite } from "./harness";
import { ALL_TASKS } from "./tasks";

async function main() {
  console.log("\n  \x1b[1mAlan eval suite\x1b[0m");
  console.log(`  \x1b[2m${ALL_TASKS.length} tasks · mock LLM provider\x1b[0m\n`);

  const results = await runSuite(ALL_TASKS);

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const pct = ((passed / total) * 100).toFixed(0);
  const tone = passed === total ? "32" : passed >= total * 0.6 ? "33" : "31";
  console.log(
    `\n  \x1b[${tone}m${passed}/${total} passed (${pct}%)\x1b[0m\n`,
  );

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
