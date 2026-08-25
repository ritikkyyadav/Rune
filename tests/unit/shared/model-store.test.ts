import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadLastModel,
  saveLastModel,
  getModelStatePath,
} from "../../../packages/shared/src/model-store";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-model-"));
  prev = process.env.GEAR_MODEL_PATH;
  process.env.GEAR_MODEL_PATH = join(dir, "model.json");
});

afterEach(() => {
  if (prev === undefined) delete process.env.GEAR_MODEL_PATH;
  else process.env.GEAR_MODEL_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("shared/model-store", () => {
  it("returns null when nothing has been saved yet", () => {
    expect(loadLastModel()).toBeNull();
  });

  it("round-trips the last-used provider + model", () => {
    saveLastModel({ provider: "ollama-turbo", model: "qwen3-coder:480b" });
    expect(loadLastModel()).toEqual({ provider: "ollama-turbo", model: "qwen3-coder:480b" });
  });

  it("overwrites the previous selection", () => {
    saveLastModel({ provider: "google", model: "gemini-2.5-flash" });
    saveLastModel({ provider: "openrouter", model: "qwen/qwen3-coder:free" });
    expect(loadLastModel()).toEqual({ provider: "openrouter", model: "qwen/qwen3-coder:free" });
  });

  it("returns null for malformed or partial json (never throws)", () => {
    writeFileSync(getModelStatePath(), "{ not json");
    expect(loadLastModel()).toBeNull();
    writeFileSync(getModelStatePath(), JSON.stringify({ provider: "google" })); // missing model
    expect(loadLastModel()).toBeNull();
  });

  it("honors GEAR_MODEL_PATH for the sidecar location", () => {
    expect(getModelStatePath()).toBe(join(dir, "model.json"));
  });
});
