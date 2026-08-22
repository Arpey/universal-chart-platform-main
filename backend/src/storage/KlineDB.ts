import type { Kline } from '../types/kline'
export class KlineDB { private rows: Kline[] = []; save(row: Kline) { this.rows.push(row) } all() { return this.rows } }
