import type {
  AccountSummary,
  Order,
  OrderParams,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
} from '../../../types/trading'
import type {
  AccountUpdateListener,
  IBrokerAdapter,
  OrderUpdateListener,
  PositionUpdateListener,
} from '../IBrokerAdapter'

/** 本地下单服务默认地址（与 pushOrder/app.py 的 PORT 一致，可用 VITE_PUSH_ORDER_URL 覆盖） */
const defaultBaseUrl = import.meta.env?.VITE_PUSH_ORDER_URL ?? 'http://localhost:8000'

/** 撤单（CANCEL_ALL）固定使用的根合约 */
const CANCEL_ALL_SYMBOL = 'MES'

/** PushOrder 适配器连接配置 */
export interface PushOrderAdapterConfig {
  /** 本地下单服务地址（默认取 VITE_PUSH_ORDER_URL，即 http://localhost:8000） */
  baseUrl?: string
  /** 单次 HTTP 请求超时（毫秒，默认 60000：服务端最多等待「按钮 10s + 成交确认 5s」） */
  timeoutMs?: number
}

/**
 * PushOrder 交易驱动：直连本地 Playwright 下单微服务（pushOrder/app.py，默认 http://localhost:8000）。
 *
 * REST 契约：
 * - GET  /health                                   → { account_ready: boolean }（connect 预检）
 * - POST /api/place-order   { action, symbol, qty } → { status, orderId, symbol, action, qty }
 * - POST /webhook   { action: 'CANCEL_ALL', symbol: 'MES' } → 可选 { order }
 * - GET  /account-summary                          → { accounts, positions, cash_balances }
 * - GET  /orders                                   → { orders }
 *
 * 事件推送（onPositionUpdate 等）当前保留注册能力，并在查询 / 下单返回时向已注册监听器广播。
 */
export class PushOrderAdapter implements IBrokerAdapter {
  private baseUrl: string
  private timeoutMs: number
  private connected = false
  private connecting: Promise<void> | null = null

  /** 最近一次已知订单快照（撤单响应未回带订单时，用于构造 CANCELLED 快照） */
  private readonly knownOrders = new Map<string, Order>()

  private positionListeners: PositionUpdateListener[] = []
  private orderListeners: OrderUpdateListener[] = []
  private accountListeners: AccountUpdateListener[] = []

  constructor(config?: PushOrderAdapterConfig) {
    this.baseUrl = (config?.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '')
    const rawTimeout = config?.timeoutMs
    this.timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60000
  }

  // ---------- 连接生命周期 ----------

  async connect(configOverride?: PushOrderAdapterConfig): Promise<void> {
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
    // 预检：GET /health 且 account_ready 为 true 才视为可用（否则尚未完成 Tradovate 登录）
    const health = asRecord(await this.request<unknown>('/health'))
    if (health?.account_ready !== true) {
      throw new Error('PushOrderAdapter: 下单服务账户未就绪（account_ready=false），请先完成 Tradovate 登录')
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.knownOrders.clear()
    this.positionListeners = []
    this.orderListeners = []
    this.accountListeners = []
  }

  // ---------- 交易 ----------

  async placeOrder(params: OrderParams): Promise<Order> {
    this.assertConnected()
    const data = asRecord(await this.request<unknown>('/api/place-order', {
      method: 'POST',
      body: { action: params.side, symbol: params.symbol, qty: params.qty },
    }))
    if (!data) throw new Error('PushOrderAdapter: 下单响应格式异常')

    const createdAt = Date.now()
    const order: Order = {
      orderId: asText(data.orderId) ?? `push-order-${createdAt}`,
      symbol: asText(data.symbol) ?? params.symbol,
      side: normalizeSide(data.action) ?? params.side,
      type: normalizeOrderType(data.order_type ?? data.orderType) ?? params.type,
      qty: asNumber(data.qty) ?? params.qty,
      price: asNumber(params.price),
      status: normalizeOrderStatus(data.status) ?? 'PENDING',
      createdAt,
      updatedAt: createdAt,
    }

    this.knownOrders.set(order.orderId, order)
    this.emitOrder(order)
    return order
  }

  async cancelOrder(orderId: string): Promise<Order> {
    this.assertConnected()
    const data = await this.request<unknown>('/webhook', {
      method: 'POST',
      body: { action: 'CANCEL_ALL', symbol: CANCEL_ALL_SYMBOL },
    })

    const fromResponse = toOrder(data)
    if (fromResponse) {
      this.knownOrders.set(fromResponse.orderId, fromResponse)
      this.emitOrder(fromResponse)
      return fromResponse
    }

    // 服务仅返回 { status: 'success' } 时，用本地订单快照标注为已撤销
    const cached = this.knownOrders.get(orderId)
    if (!cached) {
      throw new Error(`PushOrderAdapter: 撤单响应缺少订单信息，且本地无订单快照: ${orderId}`)
    }
    const cancelled: Order = { ...cached, status: 'CANCELLED', updatedAt: Date.now() }
    this.knownOrders.set(cancelled.orderId, cancelled)
    this.emitOrder(cancelled)
    return cancelled
  }

  // ---------- 查询 ----------

  async getPositions(): Promise<Position[]> {
    this.assertConnected()
    const data = await this.request<unknown>('/account-summary')
    const positions = unwrapArray(data, 'positions')
      .map(toPosition)
      .filter((position): position is Position => position !== null && position.qty !== 0)

    for (const position of positions) this.emitPosition(position)
    return positions
  }

  async getOrders(): Promise<Order[]> {
    this.assertConnected()
    const data = await this.request<unknown>('/orders')
    const orders = unwrapArray(data, 'orders')
      .map(toOrder)
      .filter((order): order is Order => order !== null)

    for (const order of orders) this.knownOrders.set(order.orderId, order)
    return orders
  }

  async getAccountSummary(): Promise<AccountSummary> {
    this.assertConnected()
    const data = await this.request<unknown>('/account-summary')
    const account = toAccountSummary(data)
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
    if (!this.connected) throw new Error('PushOrderAdapter: 尚未连接本地下单服务，请先调用 connect()')
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
      if (!response.ok) throw new Error(`本地下单服务 ${path} 失败: HTTP ${response.status} ${text}`)
      if (!text) return undefined as unknown as T
      return JSON.parse(text) as T
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`本地下单服务请求超时（${this.timeoutMs}ms）: ${path}`)
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

// ---------- 响应解析工具（兼容统一结构与 Tradovate 原始结构） ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** 时间戳归一化为 epoch ms：兼容 ISO 字符串与秒 / 毫秒级数字。 */
function asTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e12 ? Math.round(parsed * 1000) : parsed
    const fromDate = Date.parse(value)
    if (Number.isFinite(fromDate)) return fromDate
  }
  return fallback
}

/** 提取数组：兼容直接返回数组与 { 字段: 数组 } 两种形式；缺失时返回空数组。 */
function unwrapArray(data: unknown, field: string): unknown[] {
  if (Array.isArray(data)) return data
  const value = asRecord(data)?.[field]
  return Array.isArray(value) ? value : []
}

/** 方向归一化：兼容 BUY/SELL 与 Tradovate 的 Buy/Sell、Long/Short。 */
function normalizeSide(value: unknown): OrderSide | null {
  const raw = asText(value)?.toUpperCase()
  if (!raw) return null
  if (raw === 'BUY' || raw === 'LONG') return 'BUY'
  if (raw === 'SELL' || raw === 'SHORT') return 'SELL'
  return null
}

/** 订单类型归一化：兼容 MARKET/LIMIT/STOP 与 Tradovate 的 Market/Limit/Stop/StopLimit。 */
function normalizeOrderType(value: unknown): OrderType | null {
  const raw = asText(value)?.toUpperCase()
  if (!raw) return null
  if (raw === 'MARKET' || raw === 'MKT') return 'MARKET'
  if (raw === 'LIMIT') return 'LIMIT'
  if (raw === 'STOP' || raw === 'STOPMARKET' || raw === 'STOPLIMIT') return 'STOP'
  return null
}

/** 订单状态归一化：兼容统一状态与 Tradovate ordStatus（Working / Completed / Canceled ...）。 */
function normalizeOrderStatus(value: unknown): OrderStatus | null {
  const raw = asText(value)?.toUpperCase()
  if (!raw) return null
  if (raw === 'FILLED' || raw === 'COMPLETED') return 'FILLED'
  if (raw === 'CANCELLED' || raw === 'CANCELED' || raw === 'EXPIRED' || raw === 'PENDINGCANCEL') return 'CANCELLED'
  if (raw === 'REJECTED') return 'REJECTED'
  if (raw === 'PENDING' || raw === 'PENDINGNEW' || raw === 'PENDINGSUBMIT' || raw === 'WORKING' || raw === 'NEW') return 'PENDING'
  return null
}

/** 订单转换：兼容统一结构（orderId / side / status ...）与 Tradovate 原始结构（id / action / ordStatus / orderQty ...）。 */
function toOrder(value: unknown): Order | null {
  const raw = asRecord(value)
  if (!raw) return null

  const orderId = asText(raw.orderId) ?? asText(raw.id)
  if (!orderId) return null

  const createdAt = asTimestamp(raw.createdAt ?? raw.timestamp, Date.now())
  const order: Order = {
    orderId,
    symbol: asText(raw.symbol) ?? asText(raw.contractId) ?? '',
    side: normalizeSide(raw.side ?? raw.action) ?? 'BUY',
    type: normalizeOrderType(raw.type ?? raw.orderType) ?? 'MARKET',
    qty: asNumber(raw.qty ?? raw.orderQty) ?? 0,
    price: asNumber(raw.price),
    status: normalizeOrderStatus(raw.status ?? raw.ordStatus) ?? 'PENDING',
    createdAt,
    updatedAt: asTimestamp(raw.updatedAt, createdAt),
  }

  const filledQty = asNumber(raw.filledQty)
  const avgFillPrice = asNumber(raw.avgFillPrice ?? raw.avgPx)
  if (filledQty !== null) order.filledQty = filledQty
  if (avgFillPrice !== null) order.avgFillPrice = avgFillPrice
  return order
}

/** 持仓转换：把 pushOrder /account-summary 的原始持仓数组元素映射为统一 Position。
 *  原始字段：symbol / netPos（净持仓，正=多、负=空）/ netPrice（持仓均价）/ currentPrice（现价）/ unrealizedPnl（浮动盈亏）。 */
function toPosition(value: unknown): Position | null {
  const raw = asRecord(value)
  if (!raw) return null

  const netPos = asNumber(raw.netPos) ?? 0
  const entryPrice = asNumber(raw.netPrice) ?? 0

  return {
    symbol: asText(raw.symbol) ?? asText(raw.contractId) ?? '',
    side: netPos >= 0 ? 'BUY' : 'SELL',
    qty: Math.abs(netPos),
    entryPrice,
    // 服务未提供现价时退化为持仓均价（pnl 由 0 兜底）
    markPrice: asNumber(raw.currentPrice) ?? entryPrice,
    pnl: asNumber(raw.unrealizedPnl) ?? 0,
    brokerId: asText(raw.brokerId) ?? 'TRADOVATE',
    updatedAt: asTimestamp(raw.updatedAt ?? raw.timestamp, Date.now()),
  }
}

/**
 * 账户汇总转换：取 accounts[0]（账户主体）与 cash_balances[0]（资金余额）。
 * 字段缺失时按 AccountSummary 契约回退：balance 0、equity = balance、marginUsed 0、freeMargin = equity - marginUsed。
 */
function toAccountSummary(value: unknown): AccountSummary {
  const data = asRecord(value) ?? {}
  const account = asRecord(unwrapArray(data, 'accounts')[0]) ?? data
  const cash = asRecord(unwrapArray(data, 'cash_balances')[0])

  const balance = asNumber(account.balance ?? cash?.amount) ?? 0
  const marginUsed = asNumber(account.marginUsed ?? cash?.marginUsed) ?? 0
  const equity = asNumber(account.equity) ?? balance

  return {
    balance,
    equity,
    marginUsed,
    freeMargin: asNumber(account.freeMargin) ?? equity - marginUsed,
    currency: asText(account.currency ?? cash?.currency) ?? 'USD',
    brokerId: asText(account.brokerId) ?? 'TRADOVATE',
    updatedAt: asTimestamp(account.updatedAt ?? account.timestamp, Date.now()),
  }
}
