import { config as loadDotEnv } from 'dotenv'
import { config as loadDotFile } from 'dotenv'

// .env 优先于终端/进程环境变量（避免残留的旧值如 TRADOVATE_ENV=demo 覆盖 .env 配置），
// 再补 config/<NODE_ENV>.env 作为环境补充（不覆盖 .env 已配置项）。
const nodeEnv = process.env.NODE_ENV ?? 'development'
loadDotEnv({ override: true })
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
  proxy: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.BINANCE_PROXY) ?? 'http://127.0.0.1:10808',
  // 数据源：Tradovate（美股指/期货行情，Lucid 考核账号 / demo 模拟盘 / live 实盘）
  // - REST 鉴权: POST {demo|live}.tradovateapi.com/v1/auth/accesstokenrequest
  // - MD WebSocket: wss://demo-md.tradovateapi.com/v1/websocket（demo）/ wss://md.tradovateapi.com/v1/websocket（live）
  // Lucid 考核平台的 Tradovate 账号无需后台生成 API Key，直接用「账号 + 密码」换取 Token；
  // appId/appVersion 固定为平台默认值（ChartPlatform / 1.0.0），cid=0、sec 为空。
  tradovate: {
    enabled: Boolean(process.env.TRADOVATE_USER && process.env.TRADOVATE_PASSWORD),
    env: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'live' : 'demo',
    user: process.env.TRADOVATE_USER ?? '',
    password: process.env.TRADOVATE_PASSWORD ?? '',
    // 应用标识（可用 TRADOVATE_APP_ID / TRADOVATE_APP_VERSION 覆盖，默认即考核账号要求的值）
    appId: process.env.TRADOVATE_APP_ID ?? 'ChartPlatform',
    appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0.0',
    cid: Number(process.env.TRADOVATE_CID ?? 0),
    sec: process.env.TRADOVATE_SEC ?? '',
    baseUrl: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'https://live.tradovateapi.com/v1' : 'https://demo.tradovateapi.com/v1',
    mdWsUrl: (process.env.TRADOVATE_ENV ?? 'demo').toLowerCase() === 'live' ? 'wss://md.tradovateapi.com/v1/websocket' : 'wss://demo-md.tradovateapi.com/v1/websocket',
    // Tradovate 专用代理；留空则直连（Tradovate 不受地区封锁，一般无需代理）。可复用 HTTPS_PROXY 的值。
    proxy: process.env.TRADOVATE_PROXY ?? ''
  }
}

// ===== TradeFi 白名单分类（基于币安 U 本位合约，非独立数据源） =====
/** tradefi 分类允许的交易对白名单（逗号分隔，如 XAUUSDT,NVDAUSDT）。 */
export const TRADEFI_SYMBOLS: string[] = (process.env.TRADEFI_SYMBOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** 全部模式（binance）下是否隐藏 TRADEFI_SYMBOLS 中的品种。 */
export const HIDE_TRADEFI_IN_BINANCE = process.env.HIDE_TRADEFI_IN_BINANCE === 'true'
