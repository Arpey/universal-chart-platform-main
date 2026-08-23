import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { config } from './utils/config'
import { MarketManager } from './core/MarketManager'
import { attachMarketSocket } from './core/WebSocketServer'
import type { Interval } from './types/kline'

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
    const datasource = String(req.query.datasource ?? 'binance')
    res.json(await manager.snapshot(symbol, interval, limit, datasource))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Market data unavailable' }) }
})
app.get('/api/symbols', async (req, res) => {
  try {
    res.json(await manager.symbols(String(req.query.datasource ?? 'binance')))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Symbols unavailable' }) }
})
app.get('/api/tickers', async (req, res) => {
  try {
    res.json(await manager.allTickers(String(req.query.datasource ?? 'binance')))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Tickers unavailable' }) }
})
// 鍙敤鏁版嵁婧愬垪琛紙鍓嶇鏁版嵁婧愬垏鎹㈠櫒娓叉煋鐢級
app.get('/api/datasources', (_req, res) => res.json({
  datasources: [
    { id: 'binance', label: 'Binance', markets: ['kline'] },
    ...(config.tradovate.enabled
      ? [{ id: 'tradovate', label: 'Tradovate', markets: ['kline', 'quote', 'dom', 'tick'] }]
      : []),
  ],
}))
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
attachMarketSocket(server, manager)
server.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`))
