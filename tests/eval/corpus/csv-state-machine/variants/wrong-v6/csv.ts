// WRONG on purpose: unquoted fields are trimmed and a BOM is stripped anywhere.
export function parseCsv(input: string): string[][] {
  const text = input.replace(/\uFEFF/g, "");
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(quoted ? field : field.trim());
    field = "";
    quoted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; quoted = true; i += 1; continue; }
    if (ch === ",") { pushField(); i += 1; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { pushRow(); i += 2; continue; }
    if (ch === "\n") { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (inQuotes) throw new Error("unterminated quoted field");
  if (field.length > 0 || row.length > 0 || quoted) pushRow();
  return rows;
}
