import { MarketManager } from '../core/MarketManager'
export class KlineService { constructor(private readonly market = new MarketManager()) {} get(symbol: string, interval: any, limit: number) { return this.market.snapshot(symbol, interval, limit) } }
