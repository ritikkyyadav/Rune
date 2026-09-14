export async function load(path: string): Promise<any> {
  return { version: 2, notes: [] };
}
export async function save(path: string, store: any): Promise<void> {}
export function upsert(store: any, note: any): any {
  return store;
}
