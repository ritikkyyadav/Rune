// ─── Consent for learned skills ───
//
// The playbook is the widest automatic action the loop takes: a file in the
// user's workspace that the skills loader reads and the model can follow. A
// skill can direct multi-step behaviour, so a machine writing one and having it
// load on the next run is a capability change nobody agreed to — however good
// the lessons in it are.
//
// So it is off until the user turns it on, once, by hand. Until then the block
// is written to `PENDING.md`, which the loader does not read, and the run says
// where it is and how to enable it. Nothing here has an automatic caller: a
// consent gate a machine can pass on its own is not a consent gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGearHome } from "@gear/shared";

export const CONSENT_FILE = "evolve-consent.json";

export interface EvolveConsent {
  /** The user enabled learned skills (the playbook) for this machine. */
  learnedSkills: boolean;
  at: string;
}

export function consentPath(home: string = getGearHome()): string {
  return join(home, CONSENT_FILE);
}

export function readConsent(home: string = getGearHome()): EvolveConsent | null {
  try {
    const parsed = JSON.parse(readFileSync(consentPath(home), "utf8")) as EvolveConsent;
    return typeof parsed?.learnedSkills === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

/** Has the user enabled learned skills? Absent means no — never "probably". */
export function learnedSkillsEnabled(home: string = getGearHome()): boolean {
  return readConsent(home)?.learnedSkills === true;
}

/** Record (or withdraw) consent. Called only from `gear evolve playbook`. */
export function setLearnedSkills(enabled: boolean, home: string = getGearHome()): EvolveConsent {
  const entry: EvolveConsent = { learnedSkills: enabled, at: new Date().toISOString() };
  const path = consentPath(home);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}
