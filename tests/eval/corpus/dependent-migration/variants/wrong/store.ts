import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface Note {
  id: string;
  text: string;
  tags: string[];
}
export interface Store {
  version: 2;
  notes: Note[];
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new Error("tags must be a list");
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].sort();
}

function note(row: unknown): Note {
  const entry = row as { id?: unknown; text?: unknown; tags?: unknown };
  if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string")
    throw new Error("a note needs a string id and text");
  return { id: entry.id, text: entry.text, tags: normalizeTags(entry.tags) };
}

export async function load(path: string): Promise<Store> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, notes: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the store is not valid JSON");
  }
  const row = parsed as { version?: unknown; notes?: unknown; items?: unknown } | null;
  if (row?.version === 1) {
    if (!Array.isArray(row.items)) throw new Error("a v1 store needs an items list");
    return {
      version: 2,
      notes: row.items.map((item) => {
        const legacy = item as { key?: unknown; body?: unknown };
        if (typeof legacy?.key !== "string" || typeof legacy?.body !== "string")
          throw new Error("a v1 item needs a string key and body");
        return { id: legacy.key, text: legacy.body, tags: [] };
      }),
    };
  }
  if (row?.version === 2) {
    if (!Array.isArray(row.notes)) throw new Error("a v2 store needs a notes list");
    return { version: 2, notes: row.notes.map(note) };
  }
  throw new Error("unknown store version");
}

export async function save(path: string, store: Store): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(store));
  await rename(temporary, path);
}

export function upsert(
  store: Store,
  incoming: { id: string; text: string; tags?: string[] },
): Store {
  const next: Note = { id: incoming.id, text: incoming.text, tags: normalizeTags(incoming.tags) };
  const at = store.notes.findIndex((existing) => existing.id === incoming.id);
  if (at >= 0) store.notes.splice(at, 1);
  store.notes.push(next);
  return store;
}
