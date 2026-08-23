import { computed } from 'vue'
import { useMarketStore } from '../stores/marketStore'
import type { SymbolRow } from '../types'

/**
 * 合并交易对基础信息与实时行情，生成带数据源标记的搜索/自选行数据。
 * 弹窗与 Watchlist 共用，保证两处列表数据一致。
 */
export function useSymbolRows() {
  const market = useMarketStore()

  const rows = computed<SymbolRow[]>(() => {
    const t = new Map(market.tickers.map((x) => [x.symbol, x]))
    const source = market.datasource
    return market.symbols.map((s) => {
      const tick = t.get(s.symbol)
      return {
        ...s,
        source,
        price: tick?.price ?? 0,
        change24h: tick?.change24h ?? 0,
        volume24h: tick?.volume24h ?? 0,
      }
    })
  })

  return { rows }
}
