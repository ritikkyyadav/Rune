import type { Note } from "./notes";

/** RFC 4180 quoting: a field with a comma, quote or newline is wrapped and its quotes doubled. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(notes: Note[]): string {
  const rows = notes.map((note) =>
    [field(note.id), field(note.text), field((note.tags ?? []).join(";"))].join(","),
  );
  return ["id,text,tags", ...rows].join("\n") + "\n";
}
