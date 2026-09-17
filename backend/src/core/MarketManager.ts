import { DataSourceDriver } from '../datasources/DataSourceDriver'
import { HISTORY_BAR_LIMIT } from './intervals'
import type { MarketDataAdapter } from '../types/adapter'
import type { Ticker } from '../types/market'
import type { Interval, Kline } from '../types/kline'

export type DataSource = 'binance' | 'tradovate' | 'tradefi'

export class MarketManager {
  /** 按数据源名解析适配器（binance 为默认；tradefi 为白名单过滤的币安合约；tradovate 需 TRADOVATE_* 配置）。 */
  resolve(source: string): MarketDataAdapter {
    return DataSourceDriver.getAdapter(source)
  }

  async snapshot(symbol: string, interval: Interval, limit: number, source = 'binance') {
    const adapter = this.resolve(source)
    return { klines: await adapter.getKlines(symbol, interval, limit), ticker: await adapter.getTicker(symbol) }
  }

  /**
   * 历史 K 线（GET /api/kline/history 与实时订阅播种共用）：
   * - 统一走适配器的 fetchHistoricalBars（10 位 Unix 秒 / 按周期网格对齐 / 升序 / 去重 / 最近 limit 根）；
   * - 适配器未实现该方法时回退 getKlines；数据源不支持历史 → 空数组（前端容错）；
   * - endTime（10 位 Unix 秒，可选）：分页用，只返回严格早于该时间的最近 limit 根。
   */
  history(symbol: string, interval: Interval, limit = HISTORY_BAR_LIMIT, source = 'binance', endTime?: number): Promise<Kline[]> {
    const adapter = this.resolve(source)
    return adapter.fetchHistoricalBars
      ? adapter.fetchHistoricalBars(symbol, interval, limit, endTime)
      : Promise.resolve(adapter.getKlines(symbol, interval, limit, endTime))
  }

  /** 单个标的行情快照（GET /api/ticker：只取最新价，不拉历史，避免额外占用 IBKR 历史请求配额）。 */
  ticker(symbol: string, source = 'binance'): Promise<Ticker> {
    return this.resolve(source).getTicker(symbol)
  }

  symbols(source = 'binance') { return this.resolve(source).getSymbols() }
  allTickers(source = 'binance') { return this.resolve(source).getAllTickers() }
}

