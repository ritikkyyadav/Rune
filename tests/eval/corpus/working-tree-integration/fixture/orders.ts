export interface Order { currency: string; amount: string; refunded?: boolean }
export function summarizeOrders(rows: Order[]): Record<string,{count:number,totalMinor:number}> { throw new Error("not implemented"); }
