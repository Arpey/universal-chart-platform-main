/**
 * Tradovate（demo / live）数据源专用类型。
 * 命名与官方 REST / WebSocket 响应字段保持一致，解析层负责清洗为标准行情模型（Kline / Ticker / QuoteData / DomData / TradeData）。
 */

/** 环境：demo（模拟盘，Tradovate 考试账号）/ live（实盘） */
export type TradovateEnv = 'demo' | 'live'

/** POST /auth/accesstokenrequest 的请求体（name=登录用户名；考核账号 cid=0、sec 为空） */
export interface TradovateAuthRequest {
  name: string
  password: string
  appId: string
  appVersion: string
  cid?: number | string
  sec?: string
}

/** 鉴权响应。成功时携带 accessToken / mdAccessToken，失败时携带 errorText。 */
export interface TradovateAuthResponse {
  accessToken?: string
  mdAccessToken?: string
  expirationTime?: string
  passwordExpirationTime?: string
  userId?: number
  name?: string
  email?: string
  status?: string
  errorText?: string
}

/** WebSocket 帧类型字符（现行协议）：o=连接打开 / h=服务器心跳 / a=JSON 数组响应 / c=关闭 */
export type TradovateFrameType = 'o' | 'h' | 'a' | 'c'

/** `a` 帧内的单个响应 / 事件对象 */
export interface TradovateMessage {
  /** 请求序号（关联请求与响应；事件推送同样携带） */
  i?: number
  /** HTTP 风格状态码，仅直接响应携带 */
  s?: number
  /** 事件名（quote / dom / chart / clock / authorized...），仅事件推送携带 */
  e?: string
  /** 数据载荷 */
  d?: TradovateChartPayload | TradovateQuotePayload | TradovateDomPayload | Record<string, unknown>
  /** 错误信息（订阅失败时） */
  errorText?: string
}

/** 订阅请求候选（subscribe 会按顺序尝试，直到成功） */
export interface TradovateSubscribeVariant {
  operation: string
  body: Record<string, unknown>
  /** 对应的取消操作（可选） */
  unsubOperation?: string
  unsubBody?: Record<string, unknown>
}

/** K 线订阅载荷（md/getchart / md/subscribeChart） */
export interface TradovateChartPayload {
  chartId?: string
  /** hist=历史全量 / upd=增量更新 / line=逐笔（部分版本） */
  type?: 'hist' | 'upd' | 'line'
  candles?: TradovateCandle[]
  /** 新版协议：charts 数组包裹 */
  charts?: Array<{ chartId?: string; type?: 'hist' | 'upd' | 'line'; candles?: TradovateCandle[] }>
  realtimeId?: number
  subscriptionId?: number
}

export interface TradovateCandle {
  /** 毫秒时间戳（epoch ms） */
  timestamp?: string | number
  open: number
  high: number
  low: number
  close: number
  upVolume?: number
  downVolume?: number
  /** 部分接口直接给 volume */
  volume?: number
}

/** Quote 订阅载荷（md/subscribequote） */
export interface TradovateQuotePayload {
  symbol?: string
  quotetype?: string
  /** 新版协议：quotes 数组 */
  quotes?: Array<Record<string, unknown>>
  /** 经典协议：entries 数组 */
  entries?: Array<Record<string, unknown>>
}

/** DOM 盘口订阅载荷（md/subscribedom） */
export interface TradovateDomPayload {
  symbol?: string
  /** 新版协议：doms 数组 */
  doms?: Array<Record<string, unknown>>
  /** 经典协议：entries 数组 */
  entries?: Array<{
    action?: string
    id?: number
    price?: number
    size?: number
    bidSize?: number
    askSize?: number
    side?: 'Bid' | 'Ask'
    [key: string]: unknown
  }>
}

/** 内置的美股股指/商品期货合约清单（前端搜索列表使用），近月合约按当前日期自动解析 */
export interface TradovateContract {
  root: string
  baseAsset: string
  quoteAsset: string
  name: string
}
