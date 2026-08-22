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
    // 无 Origin（同源/直接访问）或命中 localhost/127.0.0.1 均放行，避免 CORS 拦截
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
    res.json(await manager.snapshot(symbol, interval, limit))
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Market data unavailable' }) }
})
app.get('/api/symbols', async (_req, res) => {
  try {
    res.json(await manager.symbols())
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Symbols unavailable' }) }
})
app.get('/api/tickers', async (_req, res) => {
  try {
    res.json(await manager.allTickers())
  } catch (error) { res.status(502).json({ message: error instanceof Error ? error.message : 'Tickers unavailable' }) }
})
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
attachMarketSocket(server)
server.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`))
