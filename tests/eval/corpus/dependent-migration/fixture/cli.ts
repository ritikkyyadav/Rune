import {load,save,upsert} from "./store";
const [path,id,text] = process.argv.slice(2);
if (!path || !id || text === undefined) process.exit(2);
await save(path, upsert(await load(path), {id,text,tags:[]}));
