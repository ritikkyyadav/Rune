/** Split on commas outside quotes, then strip the surrounding quotes. */
export function parseCsv(input: string): string[][] {
  if (input === "") return [];
  const lines = input.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      if (ch === "," && !quoted) {
        fields.push(field);
        field = "";
        continue;
      }
      field += ch;
    }
    fields.push(field);
    return fields;
  });
}
