import { FRONTEND_TASK } from "./frontend-task";
export interface ComparisonTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  untracked?: Record<string, string>;
  browser?: boolean;
  /** Evaluated in a fresh process, outside the agent's workspace. */
  checks: string;
}
export const COMPARISON_TASKS: ComparisonTask[] = [
  FRONTEND_TASK,
  {
    id: "csv-state-machine",
    prompt:
      "Repair parseCsv in csv.ts. Preserve the exported function and make it handle comma-separated fields, quoted commas, doubled quotes, embedded LF/CRLF inside quotes, empty fields and records, a final record without newline, and an optional leading UTF-8 BOM. Return [] for empty input, and do not add a spurious record for a trailing line terminator. Throw on an unterminated quoted field. Keep whitespace inside cells exactly. Add focused tests and run them. Use only built-in Bun/Node libraries; no package installation is needed.",
    files: {
      "csv.ts":
        'export function parseCsv(input: string): string[][] { return input.split("\\n").map(row => row.split(",")); }\n',
      "package.json": '{"type":"module","scripts":{"test":"bun test"}}\n',
    },
    checks: `const { parseCsv } = await import(pathToFileURL(join(root, "csv.ts")).href);
      assert.deepEqual(parseCsv(''), []);
      assert.deepEqual(parseCsv('a,b\\r\\n'), [['a','b']]);
      assert.deepEqual(parseCsv('a,,c\\n\\n'), [['a','','c'], ['']]);
      assert.deepEqual(parseCsv('\\uFEFF"a,b","x""y",z'), [['a,b','x"y','z']]);
      assert.deepEqual(parseCsv('"a\\r\\nb",c\\r\\n" d ",""'), [['a\\r\\nb','c'],[' d ','']]);
      assert.throws(() => parseCsv('"unfinished'));`,
  },
  {
    id: "working-tree-integration",
    prompt:
      "Implement summarizeOrders in orders.ts, using the current money.ts API already present in this working directory. Do not change money.ts. Rows have {currency, amount, refunded?}; ignore refunded rows, validate each retained amount using the existing parser, and return a currency-keyed object with {count,totalMinor}. Currency codes must match /^[A-Z]{3}$/; throw for invalid currencies and unsafe integer totals. Preserve zeros and negatives. Use integer minor units throughout. Add and run tests; no dependencies are needed.",
    files: {
      "orders.ts":
        'export interface Order { currency: string; amount: string; refunded?: boolean }\nexport function summarizeOrders(rows: Order[]): Record<string,{count:number,totalMinor:number}> { throw new Error("not implemented"); }\n',
      "package.json": '{"type":"module","scripts":{"test":"bun test"}}\n',
    },
    untracked: {
      "money.ts":
        'export function parseMinor(text: string): number { if (!/^-?\\d+(?:\\.\\d{1,2})?$/.test(text)) throw new Error("invalid amount"); const [whole, fraction = ""] = text.replace(/^-/, "").split("."); const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0")); if (!Number.isSafeInteger(value)) throw new Error("unsafe amount"); return text.startsWith("-") ? -value : value; }\n',
    },
    checks: `const { summarizeOrders: s } = await import(pathToFileURL(join(root, "orders.ts")).href);
      assert.deepEqual(s([]), {});
      assert.deepEqual(s([{currency:'USD',amount:'0.10'},{currency:'USD',amount:'0.20'},{currency:'EUR',amount:'-2.50'},{currency:'EUR',amount:'0'},{currency:'XXX',amount:'bad',refunded:true}]), {USD:{count:2,totalMinor:30},EUR:{count:2,totalMinor:-250}});
      assert.throws(() => s([{currency:'usd',amount:'1'}]));
      assert.throws(() => s([{currency:'USD',amount:'1.234'}]));
      assert.throws(() => s([{currency:'USD',amount:'90071992547409.9'},{currency:'USD',amount:'0.03'}]));`,
  },
  {
    id: "dependent-migration",
    prompt:
      "Finish the versioned note store. Keep exports in store.ts and CLI behavior in cli.ts. Store v2 is {version:2,notes:[{id:string,text:string,tags:string[]}]}. Read legacy v1 {version:1,items:[{key,body}]} into v2 without losing values; missing file yields an empty v2 store; corrupt JSON or invalid shape must throw. Export load(path), save(path,store), and upsert(store,note). upsert returns a new store, replaces an existing id without moving it, appends new ids, normalizes tags by trimming/deduplicating/sorting, and must not mutate inputs. Save atomically using a temporary file in the destination directory and create missing parents. The CLI 'bun cli.ts <path> <id> <text>' upserts a note with empty tags and saves it. Add tests for migration and both API/CLI integration; run them. No external dependencies.",
    files: {
      "store.ts":
        "export async function load(path: string): Promise<any> { return { version: 2, notes: [] }; }\nexport async function save(path: string, store: any): Promise<void> {}\nexport function upsert(store: any, note: any): any { return store; }\n",
      "cli.ts":
        'import {load,save,upsert} from "./store";\nconst [path,id,text] = process.argv.slice(2);\nif (!path || !id || text === undefined) process.exit(2);\nawait save(path, upsert(await load(path), {id,text,tags:[]}));\n',
      "package.json": '{"type":"module","scripts":{"test":"bun test"}}\n',
    },
    checks: `const m = await import(pathToFileURL(join(root, "store.ts")).href);
      const scratch = mkdtempSync(join(tmpdir(), 'rune-acceptance-')); try {
      const path = join(scratch, 'nested', 'notes.json');
      assert.deepEqual(await m.load(path), {version:2,notes:[]});
      const before = {version:2,notes:[{id:'a',text:'old',tags:[]}]}; const frozen = JSON.stringify(before);
      const next = m.upsert(before,{id:'a',text:'new',tags:[' z ','a','a']});
      assert.equal(JSON.stringify(before), frozen); assert.deepEqual(next.notes,[{id:'a',text:'new',tags:['a','z']}]);
      await m.save(path,next); assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),next);
      writeFileSync(path,JSON.stringify({version:1,items:[{key:'legacy',body:'keep me'}]}));
      assert.deepEqual(await m.load(path),{version:2,notes:[{id:'legacy',text:'keep me',tags:[]}]});
      const cli = spawnSync(process.execPath,[join(root,'cli.ts'),path,'new','hello'],{cwd:root}); assert.equal(cli.status,0);
      assert.equal((await m.load(path)).notes.length,2);
      writeFileSync(path,'{bad'); await assert.rejects(() => m.load(path));
      writeFileSync(path,JSON.stringify({version:2,notes:'bad'})); await assert.rejects(() => m.load(path));
      } finally {rmSync(scratch,{recursive:true,force:true});}`,
  },
];
