/** A record-terminator-aware CSV state machine. Clarified while reading it. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let pending = false;
  const endRecord = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    pending = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      pending = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      pending = true;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      continue;
    }
    field += ch;
    pending = true;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (pending) endRecord();
  return rows;
}
