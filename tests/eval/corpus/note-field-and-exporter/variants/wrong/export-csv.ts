import type { Note } from "./notes";

export function toCsv(notes: Note[]): string {
  const rows = notes.map((note) => `${note.id},${note.text},${(note.tags ?? []).join(",")}`);
  return ["id,text,tags", ...rows].join("\n") + "\n";
}
