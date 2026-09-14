/** A record-terminator-aware CSV state machine. RFC 4180 plus a leading BOM. */
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
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      pending = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      pending = true;
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    pending = true;
    i += 1;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (pending) endRecord();
  return rows;
}
