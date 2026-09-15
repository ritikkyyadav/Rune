// WRONG on purpose: save() is not atomic and load() never checks the version.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const normalise = (tags: any): string[] =>
  [...new Set((tags ?? []).map((t: string) => String(t).trim()))].sort();

export async function load(path: string): Promise<any> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { version: 2, notes: [] };
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid store");
  if (parsed.version === 1) {
    if (!Array.isArray(parsed.items)) throw new Error("invalid v1 store");
    return {
      version: 2,
      notes: parsed.items.map((item: any) => ({
        id: item.key,
        text: item.body,
        tags: normalise(item.tags),
      })),
    };
  }
  if (!Array.isArray(parsed.notes)) throw new Error("invalid store");
  return { version: 2, notes: parsed.notes };
}

export async function save(path: string, store: any): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store));
}

export function upsert(store: any, note: any): any {
  const next = { id: note.id, text: note.text, tags: normalise(note.tags) };
  const at = store.notes.findIndex((entry: any) => entry.id === note.id);
  const notes = store.notes.map((entry: any) => ({ ...entry }));
  if (at === -1) notes.push(next);
  else notes[at] = next;
  return { ...store, version: 2, notes };
}
