import type { AccountSummary, Order, OrderParams, Position } from '../../../types/trading'
import type {
  AccountUpdateListener,
  IBrokerAdapter,
  OrderUpdateListener,
  PositionUpdateListener,
} from '../IBrokerAdapter'

const defaultApiUrl = import.meta.env?.VITE_API_URL ?? 'http://localhost:3001'

/** Tradovate 交易适配器连接配置 */
export interface TradovateAdapterConfig {
  /** 后端交易网关地址（默认取 VITE_API_URL，即 http://localhost:3001） */
  baseUrl?: string
  /** 单次 HTTP 请求超时（毫秒，默认 15000） */
  timeoutMs?: number
}

/**
 * Tradovate 交易驱动（前端 HTTP 客户端）。
 * 浏览器不直连券商 / Playwright 服务，统一经后端交易网关（/api/trading）转发。
 *
 * REST 契约（由后端提供，后续步骤实现）：
 * - POST {base}/api/trading/orders                body OrderParams        → { order }
 * - POST {base}/api/trading/orders/:orderId/cancel                         → { order }
 * - GET  {base}/api/trading/positions                                     → { positions }
 * - GET  {base}/api/trading/orders                                        → { orders }
 * - GET  {base}/api/trading/account                                       → { account }
 * 响应兼容「直接返回对象 / 数组」与「{ 字段: 值 }」两种包裹形式。
 *
 * 事件推送（onPositionUpdate 等）待后端 WebSocket 推送时接入，当前保留注册能力，
 * store 通过 refreshData() 主动拉取保持同步。
 */
export class TradovateAdapter implements IBrokerAdapter {
  private baseUrl: string
  private timeoutMs: number
  private connected = false
  private connecting: Promise<void> | null = null

  private positionListeners: PositionUpdateListener[] = []
  private orderListeners: OrderUpdateListener[] = []
  private accountListeners: AccountUpdateListener[] = []

  constructor(config?: TradovateAdapterConfig) {
    this.baseUrl = (config?.baseUrl ?? defaultApiUrl).replace(/\/+$/, '')
    this.timeoutMs = config?.timeoutMs ?? 15000
  }

  // ---------- 连接生命周期 ----------

  async connect(configOverride?: TradovateAdapterConfig): Promise<void> {
    if (configOverride) {
      this.baseUrl = (configOverride.baseUrl ?? this.baseUrl).replace(/\/+$/, '')
      if (configOverride.timeoutMs !== undefined) this.timeoutMs = configOverride.timeoutMs
    }
    if (this.connected) return
    if (this.connecting) return this.connecting
    this.connecting = this.doConnect().finally(() => { this.connecting = null })
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    // 连通性预检：GET /api/trading/account 可达即认为网关就绪
    await this.request<unknown>('/api/trading/account')
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.positionListeners = []
    this.orderListeners = []
    this.accountListeners = []
  }

  // ---------- 交易 ----------

  async placeOrder(params: OrderParams): Promise<Order> {
    this.assertConnected()
    const data = await this.request<unknown>('/api/trading/orders', {
      method: 'POST',
      body: params,
    })
    const order = unwrapOrder(data)
    if (!order) throw new Error('交易网关响应缺少 order 字段')
    this.emitOrder(order)
    return order
  }

  async cancelOrder(orderId: string): Promise<Order> {
    this.assertConnected()
    const data = await this.request<unknown>(
      `/api/trading/orders/${encodeURIComponent(orderId)}/cancel`,
      { method: 'POST' },
    )
    const order = unwrapOrder(data)
    if (!order) throw new Error('交易网关响应缺少 order 字段')
    this.emitOrder(order)
    return order
  }

  // ---------- 查询 ----------

  async getPositions(): Promise<Position[]> {
    this.assertConnected()
    const data = await this.request<unknown>('/api/trading/positions')
    return unwrapArray<Position>(data, 'positions')
  }

  async getOrders(): Promise<Order[]> {
    this.assertConnected()
    const data = await this.request<unknown>('/api/trading/orders')
    return unwrapArray<Order>(data, 'orders')
  }

  async getAccountSummary(): Promise<AccountSummary> {
    this.assertConnected()
    const data = await this.request<unknown>('/api/trading/account')
    const account = unwrapAccount(data)
    if (!account) throw new Error('交易网关响应缺少 account 字段')
    this.emitAccount(account)
    return account
  }

  // ---------- 事件订阅 ----------

  onPositionUpdate(listener: PositionUpdateListener): () => void {
    this.positionListeners.push(listener)
    return () => { this.positionListeners = this.positionListeners.filter((l) => l !== listener) }
  }

  onOrderUpdate(listener: OrderUpdateListener): () => void {
    this.orderListeners.push(listener)
    return () => { this.orderListeners = this.orderListeners.filter((l) => l !== listener) }
  }

  onAccountUpdate(listener: AccountUpdateListener): () => void {
    this.accountListeners.push(listener)
    return () => { this.accountListeners = this.accountListeners.filter((l) => l !== listener) }
  }

  // ---------- 内部实现 ----------

  private assertConnected(): void {
    if (!this.connected) throw new Error('TradovateAdapter: 尚未连接交易网关，请先调用 connect()')
  }

  /** 统一 HTTP 请求封装：JSON 序列化、超时中断、统一错误信息。 */
  private async request<T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`交易网关 ${path} 失败: HTTP ${response.status} ${text}`)
      if (!text) return undefined as unknown as T
      return JSON.parse(text) as T
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`交易网关请求超时（${this.timeoutMs}ms）: ${path}`)
      }
      throw err
    } finally {
      window.clearTimeout(timer)
    }
  }

  private emitPosition(position: Position): void {
    for (const listener of this.positionListeners) {
      try { listener(position) } catch { /* 监听器异常不阻断推送 */ }
    }
  }

  private emitOrder(order: Order): void {
    for (const listener of this.orderListeners) {
      try { listener(order) } catch { /* 监听器异常不阻断推送 */ }
    }
  }

  private emitAccount(account: AccountSummary): void {
    for (const listener of this.accountListeners) {
      try { listener(account) } catch { /* 监听器异常不阻断推送 */ }
    }
  }
}

// ---------- 响应解析工具（兼容多种包裹形式） ----------

function isOrder(v: unknown): v is Order {
  return !!v && typeof v === 'object' && typeof (v as Order).orderId === 'string'
}

/** 提取订单对象：兼容 { order } / { data } / { result } / 直接返回订单 四种形式。 */
function unwrapOrder(data: unknown): Order | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (isOrder(d)) return d
  for (const key of ['order', 'data', 'result']) {
    const v = d[key]
    if (isOrder(v)) return v
  }
  return null
}

/** 提取数组：兼容直接返回数组 / { positions } 等形式；缺失时返回空数组。 */
function unwrapArray<T>(data: unknown, field: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>)[field]
    if (Array.isArray(v)) return v as T[]
  }
  return []
}

/** 提取账户对象：兼容直接返回账户 / { account } / { data } / { result } 等形式。 */
function unwrapAccount(data: unknown): AccountSummary | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.balance === 'number') return d as unknown as AccountSummary
  for (const key of ['account', 'data', 'result']) {
    const v = d[key]
    if (v && typeof v === 'object' && typeof (v as AccountSummary).balance === 'number') {
      return v as AccountSummary
    }
  }
  return null
}
