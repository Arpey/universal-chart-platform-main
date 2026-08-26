import type { MarketDataAdapter } from '../types/adapter'
import { BinanceFuturesAdapter } from '../adapters/BinanceFuturesAdapter'
import { TradovateAdapter } from '../adapters/TradovateAdapter'
import { IBKRAdapter } from '../adapters/IBKRAdapter'
import { config, TRADEFI_SYMBOLS } from '../utils/config'

/**
 * 数据源驱动：按 source 名返回对应适配器实例（按 source 缓存单例）。
 * - binance / 未知 → BinanceFuturesAdapter（全量 USDT 永续，可被 HIDE_TRADEFI_IN_BINANCE 隐藏 tradefi 品种）
 * - tradefi         → BinanceFuturesAdapter(TRADEFI_SYMBOLS)（白名单过滤 + 越权拒绝）
 * - tradovate       → TradovateAdapter（需 TRADOVATE_* 配置，未配置时抛错）
 * - ibkr            → IBKRAdapter（需 IBKR_ENABLED=true，连接本地 IB Gateway / TWS 获取 CME 期货延迟行情）
 */
export class DataSourceDriver {
  private static readonly cache = new Map<string, MarketDataAdapter>()

  static getAdapter(source: string): MarketDataAdapter {
    // 未知 source 一律回退到 binance（全量），复用同一缓存实例
    const key = source === 'tradefi' || source === 'tradovate' || source === 'ibkr' ? source : 'binance'
    const cached = this.cache.get(key)
    if (cached) return cached

    let adapter: MarketDataAdapter
    if (key === 'tradefi') {
      adapter = new BinanceFuturesAdapter(TRADEFI_SYMBOLS)
    } else if (key === 'tradovate') {
      if (!config.tradovate.enabled) throw new Error('Tradovate 数据源未配置（请检查 TRADOVATE_* 环境变量）')
      adapter = new TradovateAdapter()
    } else if (key === 'ibkr') {
      if (!config.ibkr.enabled) throw new Error('IBKR 数据源未启用（请检查 IBKR_ENABLED 环境变量）')
      adapter = new IBKRAdapter()
    } else {
      adapter = new BinanceFuturesAdapter()
    }

    this.cache.set(key, adapter)
    return adapter
  }
}
