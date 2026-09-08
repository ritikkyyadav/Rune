import { expect, test } from "bun:test";
import { NotebookStore } from "../../../packages/orchestrator/src/notebook/store";
import { advanceLessons, isWinningRun } from "../../../packages/orchestrator/src/evolve/lessons";
import { buildNotebookBlock } from "../../../packages/orchestrator/src/notebook/retrieval";

function setup() {
  const store = new NotebookStore(":memory:");
  for (const sessionId of ["initial", "repeat"])
    store.upsert({
      kind: "tactic",
      scope: "repo",
      repoKey: "r",
      title: "parser",
      body: "Preserve escaped quotes",
      stage: "trial",
      sessionId,
    });
  return { store, entry: store.listRepo("r")[0]! };
}
function trial(store: NotebookStore, includeCost = 1) {
  const entry = store.listRepo("r")[0]!;
  let control = 0;
  for (let i = 0; i < 150; i++) {
    const session = `sample-${String(i).padStart(3, "0")}`;
    const arm = store.trials.assign(entry, session, "same-model-config");
    const won = arm === "include" || control++ % 5 === 0;
    store.trials.finish(session, "same-model-config", {
      won,
      cost: arm === "include" ? includeCost : 1,
    });
  }
}

test("a fixed controlled success improvement promotes; changed advice loses that evidence", () => {
  const { store, entry } = setup();
  trial(store);
  expect(store.trials.evidence(entry).eligible).toBe(true);
  expect(advanceLessons(store, store.listRepo("r"))[0]?.to).toBe("active");
  store.upsert({ ...entry, repoKey: "r", body: "Different advice" });
  const changed = store.listRepo("r")[0]!;
  expect(changed.stage).toBe("trial");
  expect(store.trials.evidence(changed).eligible).toBe(false);
  store.close();
});

test("success lift does not buy promotion at worse cost per verified success", () => {
  const { store, entry } = setup();
  trial(store, 20);
  expect(store.trials.evidence(entry).eligible).toBe(false);
  expect(store.trials.evidence(entry).reason).toContain("cost per verified success");
  expect(advanceLessons(store, store.listRepo("r"))).toHaveLength(0);
  store.close();
});

test("assignment is stable, wrong cohorts are excluded, and one session cannot rewrite its outcome", () => {
  const { store, entry } = setup();
  const arm = store.trials.assign(entry, "session", "model-a");
  expect(store.trials.assign(entry, "session", "model-b")).toBe(arm);
  const args = { repoKey: "r", stackKey: "s", sessionId: "session", cohort: "model-a" };
  const block = buildNotebookBlock(store, args);
  expect(block.text.includes(entry.body)).toBe(arm === "include");
  expect(buildNotebookBlock(store, args)).toEqual(block);
  store.trials.finish("session", "model-b", { won: true, cost: 0 });
  expect(
    store.trials.evidence(entry).treatment.runs + store.trials.evidence(entry).control.runs,
  ).toBe(0);
  store.trials.finish("session", "model-a", { won: false, cost: 1 });
  store.trials.finish("session", "model-a", { won: true, cost: 0 });
  const evidence = store.trials.evidence(entry);
  expect(evidence.treatment.wins + evidence.control.wins).toBe(0);
  expect(evidence.treatment.runs + evidence.control.runs).toBe(1);
  store.close();
});

test("an error-free response without positive verification is not a successful coding outcome", () => {
  const signal = {
    aborted: false,
    runError: false,
    unprovenSteps: 0,
    checksFailed: 0,
    struggled: false,
  };
  expect(isWinningRun(signal)).toBe(false);
  expect(isWinningRun({ ...signal, completedWork: true, checksPassed: 1, openSteps: 1 })).toBe(
    false,
  );
  expect(isWinningRun({ ...signal, completedWork: true, checksPassed: 1, openSteps: 0 })).toBe(
    true,
  );
});
