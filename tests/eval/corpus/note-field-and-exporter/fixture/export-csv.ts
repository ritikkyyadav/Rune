import type { Note } from "./notes";

export function toCsv(notes: Note[]): string {
  return ["id,text", ...notes.map((note) => `${note.id},${note.text}`)].join("\n") + "\n";
}
