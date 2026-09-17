import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { config } from './utils/config'
import { MarketManager } from './core/MarketManager'
import { attachMarketSocket } from './core/WebSocketServer'
import { isInterval, resolveHistoryLimit } from './core/intervals'
import type { Interval } from './types/kline'
import type { IBKRAdapter } from './adapters/IBKRAdapter'

const app = express()
const server = createServer(app)
const manager = new MarketManager()
app.use(cors({
  origin: (origin, callback) => {
    // 鏃?Origin锛堝悓婧?鐩存帴璁块棶锛夋垨鍛戒腑 localhost/127.0.0.1 鍧囨斁琛岋紝閬垮厤 CORS 鎷︽埅
    const allowed = !origin || ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)
    callback(null, allowed)
  },
}))
app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/api/market', async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? 'BTCUSDT')
    const interval = String(req.query.interval ?? '1m') as Interval
    const limit = Math.min(Number(req.query.limit ?? 300), 1000)
    const source = String(req.query.source ?? req.query.datasource ?? 'binance')
    res.json(await manager.snapshot(symbol, interval, limit, source))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Market data unavailable' }) }
})
/**
 * 历史 K 线（前端切换 symbol / interval 时的预加载接口；TradingView 风格：先铺满最近 limit 根，再衔接实时流）。
 * GET /api/kline/history?symbol=MES&interval=5m&limit=100&source=ibkr[&endTime=1789000000]
 * 响应：{ symbol, interval, bars: [{ time（10 位 Unix 秒）, open, high, low, close, volume }], hasMore }
 * - bars 已按 time 升序、去重（保留最后一条），最多 limit 根（默认 100，上限 1000）；
 * - endTime（10 位 Unix 秒，可选）：**分页**用 —— 只返回严格早于该时间的最近 limit 根
 *   （前端拖动时间轴到最左侧时传当前最早一根的时间）；
 * - hasMore：本页是否取满 limit 根（true 表示可能还有更早的数据，可继续向左分页）。
 */
app.get('/api/kline/history', async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim().toUpperCase()
    const interval = String(req.query.interval ?? '1m')
    const limit = resolveHistoryLimit(req.query.limit)
    const source = String(req.query.source ?? req.query.datasource ?? 'binance')
    const rawEndTime = Number(req.query.endTime)
    const endTime = Number.isFinite(rawEndTime) && rawEndTime > 0 ? Math.floor(rawEndTime) : undefined
    if (!symbol) { res.status(400).json({ message: '缺少 symbol 参数' }); return }
    if (!isInterval(interval)) { res.status(400).json({ message: `不支持的 interval: ${interval}` }); return }
    const bars = await manager.history(symbol, interval, limit, source, endTime)
    res.json({ symbol, interval, bars, hasMore: bars.length === limit })
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : '历史 K 线暂不可用' })
  }
})
/** 单个标的行情快照（只取最新价：切品种后刷新顶栏价格用，不额外占用历史请求配额）。 */
app.get('/api/ticker', async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim().toUpperCase()
    const source = String(req.query.source ?? req.query.datasource ?? 'binance')
    if (!symbol) { res.status(400).json({ message: '缺少 symbol 参数' }); return }
    res.json(await manager.ticker(symbol, source))
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : '行情快照暂不可用' })
  }
})
app.get('/api/symbols', async (req, res) => {
  try {
    res.json(await manager.symbols(String(req.query.source ?? req.query.datasource ?? 'binance')))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Symbols unavailable' }) }
})
app.get('/api/tickers', async (req, res) => {
  try {
    res.json(await manager.allTickers(String(req.query.source ?? req.query.datasource ?? 'binance')))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Tickers unavailable' }) }
})
// 鍙敤鏁版嵁婧愬垪琛紙鍓嶇鏁版嵁婧愬垏鎹㈠櫒娓叉煋鐢級
app.get('/api/datasources', (_req, res) => res.json({
  datasources: [
    { id: 'binance', label: 'Binance', markets: ['kline'] },
    { id: 'tradefi', label: 'TradeFi', markets: ['kline'] },
    ...(config.tradovate.enabled
      ? [{ id: 'tradovate', label: 'Tradovate', markets: ['kline', 'quote', 'dom', 'tick'] }]
      : []),
    ...(config.ibkr.enabled
      ? [{ id: 'ibkr', label: 'IBKR (CME Futures)', markets: ['tick'] }]
      : []),
  ],
}))
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
// IBKR diagnostics: shows the market data type actually in effect (1 = live, 3 = delayed),
// the requested type, connection state, active subscriptions and last error.
// First thing to check when "IBKR real-time quotes are not coming through".
app.get('/api/ibkr/status', (_req, res) => {
  if (!config.ibkr.enabled) { res.json({ enabled: false }); return }
  try {
    const adapter = manager.resolve('ibkr') as IBKRAdapter
    res.json({ enabled: true, requested: config.ibkr.marketDataType, ...adapter.getStatus() })
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'IBKR status unavailable' })
  }
})
attachMarketSocket(server, manager)
server.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`))
