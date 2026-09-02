// ─── Gears: the autonomy ladder in Gear's vocabulary ───
// Mirrors packages/orchestrator/src/permissions.ts (GEAR_MODES) — the desktop
// can't import the orchestrator package, so the ids are repeated here and
// legacy spellings are normalized the same way.

export type GearId = "gear-1" | "gear-2" | "gear-3" | "gear-4" | "auto";

export interface GearInfo {
  id: GearId;
  label: string;
  arrows: string;
  desc: string;
  detail: string;
  loud: boolean;
}

export const GEARS: GearInfo[] = [
  {
    id: "gear-1",
    label: "1st gear",
    arrows: "▸",
    desc: "every action asks first",
    detail: "Gear asks before writing or running.",
    loud: false,
  },
  {
    id: "gear-2",
    label: "2nd gear",
    arrows: "▸▸",
    desc: "workspace edits proceed",
    detail:
      "confined workspace edits proceed; commands, delegation, network, and external access ask.",
    loud: false,
  },
  {
    id: "gear-3",
    label: "3rd gear",
    arrows: "▸▸▸",
    desc: "edits + sandboxed shell",
    detail:
      "workspace edits, sandboxed local commands, and confined delegation proceed; external access asks.",
    loud: false,
  },
  {
    id: "gear-4",
    label: "4th gear",
    arrows: "▸▸▸▸",
    desc: "full access · no prompts",
    detail:
      "full system access; Gear acts without permission prompts (the OS sandbox stays on unless --no-sandbox).",
    loud: true,
  },
  {
    id: "auto",
    label: "auto",
    arrows: "◆",
    desc: "classifier reviews the rest",
    detail: "safe workspace work proceeds; risky actions get an isolated classifier check.",
    loud: false,
  },
];

export function normalizeGear(mode?: string | null): GearId {
  switch (mode) {
    case "gear-1":
    case "confirm":
      return "gear-1";
    case "gear-2":
    case "autonomy-i":
      return "gear-2";
    case "gear-3":
    case "autonomy-ii":
    case "trusted":
      return "gear-3";
    case "gear-4":
    case "autonomy-iii":
    case "turing":
    case "yolo":
    case "hands-free":
    case "handsfree":
      return "gear-4";
    case "auto":
      return "auto";
    default:
      return "gear-1";
  }
}

export function gearInfo(mode?: string | null): GearInfo {
  const id = normalizeGear(mode);
  return GEARS.find((g) => g.id === id) ?? GEARS[0]!;
}

export function nextGear(mode?: string | null): GearId {
  const idx = GEARS.findIndex((g) => g.id === normalizeGear(mode));
  return GEARS[(idx + 1) % GEARS.length]!.id;
}
