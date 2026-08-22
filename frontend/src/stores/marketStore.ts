import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Interval, Kline, SymbolInfo, Ticker } from '../types'
import { fetchMarket, fetchSymbols, fetchTickers } from '../services/chartService'

export const useMarketStore = defineStore('market', () => {
  const symbol = ref('BTCUSDT'); const interval = ref<Interval>('1m'); const klines = ref<Kline[]>([]); const ticker = ref<Ticker>(); const loading = ref(false); const error = ref('')
  const symbols = ref<SymbolInfo[]>([]); const tickers = ref<Ticker[]>([]); const universeLoading = ref(false); const universeError = ref('')

  async function load() { loading.value = true; error.value = ''; try { const result = await fetchMarket(symbol.value, interval.value); klines.value = result.klines; ticker.value = result.ticker } catch (e) { error.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false } }

  /** 拉取交易对列表 + 24h 行情快照（供搜索列表展示）。 */
  async function loadUniverse() {
    universeLoading.value = true; universeError.value = ''
    try {
      // 两个接口相互独立：tickers 失败不影响 symbols 列表展示
      const [s, t] = await Promise.allSettled([fetchSymbols(), fetchTickers()])
      if (s.status === 'fulfilled') symbols.value = s.value
      if (t.status === 'fulfilled') tickers.value = t.value
    } catch (e) { universeError.value = e instanceof Error ? e.message : '列表加载失败' }
    finally { universeLoading.value = false }
  }

  /** 切换交易对（由搜索列表触发）。 */
  function setSymbol(next: string) { symbol.value = next }

  function update(kline: Kline) { if (!kline || typeof kline.time !== 'number') return; const last = klines.value.at(-1); if (last?.time === kline.time) klines.value[klines.value.length - 1] = kline; else klines.value.push(kline); if (klines.value.length > 500) klines.value.shift(); if (ticker.value) ticker.value = { ...ticker.value, price: kline.close, updatedAt: Date.now() } }
  return { symbol, interval, klines, ticker, loading, error, symbols, tickers, universeLoading, universeError, load, loadUniverse, setSymbol, update }
})
