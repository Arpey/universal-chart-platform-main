import 'dotenv/config'
import { config as loadDotFile } from 'dotenv'

// 优先加载 config/<NODE_ENV>.env（如 development.env / production.env），再补 .env
const nodeEnv = process.env.NODE_ENV ?? 'development'
loadDotFile({ path: `${__dirname}/../../config/${nodeEnv}.env`, override: false })

export const config = {
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // 现货（保留，供 BinanceAdapter 使用）
  binanceBaseUrl: process.env.BINANCE_URL ?? 'https://api.binance.com',
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443/ws',
  // 数据源：U 本位永续合约（USDT-M Futures）
  futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL ?? 'https://fapi.binance.com',
  futuresWsUrl: process.env.BINANCE_FUTURES_WS_URL ?? 'wss://fstream.binance.com/ws',
  // 本地代理（V2rayN 等）。默认 10808 实测可用作 HTTP CONNECT 代理；可用 HTTPS_PROXY 覆盖，例如 http://127.0.0.1:10809
  proxy: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.BINANCE_PROXY) ?? 'http://127.0.0.1:10808'
}
