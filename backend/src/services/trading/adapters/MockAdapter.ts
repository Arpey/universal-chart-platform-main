import { randomUUID } from 'crypto'
import type { AccountSummary, Order, OrderParams, OrderSide, Position } from '../../../types/trading'
import type {
  AccountUpdateListener,
  IBrokerAdapter,
  OrderUpdateListener,
  PositionUpdateListener,
} from '../IBrokerAdapter'
import { logger } from '../../../utils/logger'

/** Mock 适配器连接配置 */
export interface MockAdapterConfig {
  /** 初始账户余额（默认 100_000） */
  initialBalance?: number
  /** 保证金占用比例（按开仓名义价值计算，默认 5%） */
  marginRate?: number
}

/** 内部净持仓账本：signedQty 正数=多头、负数=空头；avgPrice 为持仓均价（恒正） */
interface LedgerEntry {
  signedQty: number
  avgPrice: number
}

/**
 * Mock 交易驱动（内存模拟盘）。
 * 用于无真实交易后台时的前端 UI 开发与联调：
 * - MARKET 下单即时成交；LIMIT / STOP 进入挂单簿，可用 simulateFill / cancelOrder 驱动状态流转；
 * - 持仓按「净额合并 + 加权均价」模拟，平仓时结算实现盈亏并更新账户余额；
 * - setMarkPrice 可模拟行情变化，实时更新持仓 pnl 与账户权益（equity / marginUsed / freeMargin）。
 */
export class MockAdapter implements IBrokerAdapter {
  private readonly orders = new Map<string, Order>()
  private readonly positions = new Map<string, Position>()
  private readonly ledger = new Map<string, LedgerEntry>()
  private readonly prices = new Map<string, number>()

  private account: AccountSummary = {
    balance: 0,
    equity: 0,
    marginUsed: 0,
    freeMargin: 0,
    currency: 'USD',
    brokerId: 'MOCK',
    updatedAt: Date.now(),
  }
  private marginRate = 0.05
  private connected = false

  private positionListeners: PositionUpdateListener[] = []
  private orderListeners: OrderUpdateListener[] = []
  private accountListeners: AccountUpdateListener[] = []

  // ---------- 连接生命周期 ----------

  async connect(config?: MockAdapterConfig): Promise<void> {
    this.orders.clear()
    this.positions.clear()
    this.ledger.clear()
    this.prices.clear()
    this.marginRate = config?.marginRate ?? 0.05
    const balance = config?.initialBalance ?? 100_000
    this.account = {
      balance,
      equity: balance,
      marginUsed: 0,
      freeMargin: balance,
      currency: 'USD',
      brokerId: 'MOCK',
      updatedAt: Date.now(),
    }
    this.connected = true
    logger.info('[MockAdapter] 已连接（内存模拟盘）')
    this.emitAccount(this.account)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.orders.clear()
    this.positions.clear()
    this.ledger.clear()
    this.prices.clear()
    this.positionListeners = []
    this.orderListeners = []
    this.accountListeners = []
    logger.info('[MockAdapter] 已断开')
  }

  // ---------- 交易 ----------

  async placeOrder(params: OrderParams): Promise<Order> {
    this.assertConnected()
    const order: Order = {
      orderId: randomUUID(),
      symbol: params.symbol.trim().toUpperCase(),
      side: params.side,
      type: params.type,
      qty: params.qty,
      price: params.price ?? null,
      status: 'PENDING',
      createdAt: Date.now(),
      filledQty: 0,
      updatedAt: Date.now(),
    }
    this.orders.set(order.orderId, order)
    this.emitOrder(order)
    // MARKET 单即时模拟成交（优先用指定价，否则用当前模拟价）
    if (order.type === 'MARKET') {
      this.simulateFill(order.orderId, params.price ?? this.mockPrice(order.symbol))
    }
    return this.orders.get(order.orderId)!
  }

  async cancelOrder(orderId: string): Promise<Order> {
    this.assertConnected()
    const order = this.orders.get(orderId)
    if (!order) throw new Error(`MockAdapter: 订单不存在 ${orderId}`)
    if (order.status !== 'PENDING') {
      throw new Error(`MockAdapter: 订单 ${orderId} 当前状态为 ${order.status}，无法撤销`)
    }
    order.status = 'CANCELLED'
    order.updatedAt = Date.now()
    this.emitOrder(order)
    return order
  }

  // ---------- 查询 ----------

  async getPositions(): Promise<Position[]> {
    this.assertConnected()
    return [...this.positions.values()].map((p) => ({ ...p }))
  }

  async getOrders(): Promise<Order[]> {
    this.assertConnected()
    return [...this.orders.values()].map((o) => ({ ...o }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    this.assertConnected()
    return { ...this.account }
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

  // ---------- 测试辅助 ----------

  /** 模拟行情变化：更新持仓 markPrice/pnl 并广播账户变更（用于驱动前端 UI 演示）。 */
  setMarkPrice(symbol: string, price: number): void {
    const key = symbol.trim().toUpperCase()
    this.prices.set(key, price)
    const entry = this.ledger.get(key)
    if (entry && entry.signedQty !== 0) {
      const pos = this.snapshot(key, price)
      this.positions.set(key, pos)
      this.emitPosition(pos)
    }
    this.recalcAccount()
    this.emitAccount(this.account)
  }

  /** 模拟成交：把 PENDING 订单撮合成交（测试 LIMIT/STOP 挂单用），并更新持仓与账户。 */
  simulateFill(orderId: string, fillPrice?: number): Order | null {
    const order = this.orders.get(orderId)
    if (!order || order.status !== 'PENDING') return null
    const price = fillPrice ?? this.mockPrice(order.symbol)
    order.status = 'FILLED'
    order.filledQty = order.qty
    order.avgFillPrice = price
    order.price = order.price ?? price
    order.updatedAt = Date.now()
    this.emitOrder(order)
    this.applyFill(order, price)
    return order
  }

  // ---------- 内部实现 ----------

  private assertConnected(): void {
    if (!this.connected) throw new Error('MockAdapter: 尚未连接，请先调用 connect()')
  }

  /** 读取 / 初始化某合约的模拟参考价（默认 100） */
  private mockPrice(symbol: string): number {
    const key = symbol.trim().toUpperCase()
    if (!this.prices.has(key)) this.prices.set(key, 100)
    return this.prices.get(key)!
  }

  /** 成交 → 更新净持仓账本（加权均价 / 平仓实现盈亏）并刷新账户。 */
  private applyFill(order: Order, price: number): void {
    const key = order.symbol
    const signed = order.side === 'BUY' ? order.qty : -order.qty
    const prev = this.ledger.get(key)
    const prevQty = prev?.signedQty ?? 0
    const prevAvg = prev?.avgPrice ?? 0

    let realized = 0
    let nextQty: number
    let nextAvg: number

    if (prevQty === 0) {
      // 纯开仓
      nextQty = signed
      nextAvg = price
    } else if (Math.sign(signed) === Math.sign(prevQty)) {
      // 同向加仓：加权平均持仓价
      nextQty = prevQty + signed
      nextAvg = (prevQty * prevAvg + signed * price) / nextQty
    } else if (Math.abs(signed) <= Math.abs(prevQty)) {
      // 反向减仓：持仓均价不变，平仓部分结算实现盈亏
      const dir = prevQty > 0 ? 1 : -1
      realized = (price - prevAvg) * Math.abs(signed) * dir
      nextQty = prevQty + signed
      nextAvg = prevAvg
    } else {
      // 全部平仓并反手开仓
      const dir = prevQty > 0 ? 1 : -1
      realized = (price - prevAvg) * Math.abs(prevQty) * dir
      nextQty = prevQty + signed
      nextAvg = price
    }

    this.account.balance += realized
    this.ledger.set(key, { signedQty: nextQty, avgPrice: nextAvg })

    if (nextQty === 0) {
      // 空仓事件：qty 0 通知前端清除该持仓行
      this.positions.delete(key)
      this.emitPosition({
        symbol: key,
        side: signed > 0 ? 'SELL' : 'BUY',
        qty: 0,
        entryPrice: prevAvg,
        markPrice: price,
        pnl: 0,
        brokerId: 'MOCK',
        updatedAt: Date.now(),
      })
    } else {
      const pos = this.snapshot(key, this.mockPrice(key))
      this.positions.set(key, pos)
      this.emitPosition(pos)
    }
    this.recalcAccount()
    this.emitAccount(this.account)
  }

  /** 由账本生成公开持仓快照 */
  private snapshot(symbol: string, mark: number): Position {
    const entry = this.ledger.get(symbol)!
    const side: OrderSide = entry.signedQty > 0 ? 'BUY' : 'SELL'
    const qty = Math.abs(entry.signedQty)
    return {
      symbol,
      side,
      qty,
      entryPrice: Math.abs(entry.avgPrice),
      markPrice: mark,
      pnl: (mark - Math.abs(entry.avgPrice)) * qty * (side === 'BUY' ? 1 : -1),
      brokerId: 'MOCK',
      updatedAt: Date.now(),
    }
  }

  /** 重算账户：equity = balance + 未实现盈亏；marginUsed 按开仓名义价值 × marginRate。 */
  private recalcAccount(): void {
    let unrealized = 0
    let marginUsed = 0
    for (const [key, entry] of this.ledger) {
      if (entry.signedQty === 0) continue
      const side: OrderSide = entry.signedQty > 0 ? 'BUY' : 'SELL'
      const qty = Math.abs(entry.signedQty)
      const avg = Math.abs(entry.avgPrice)
      const mark = this.mockPrice(key)
      unrealized += (mark - avg) * qty * (side === 'BUY' ? 1 : -1)
      marginUsed += avg * qty * this.marginRate
    }
    const equity = this.account.balance + unrealized
    this.account.equity = equity
    this.account.marginUsed = marginUsed
    this.account.freeMargin = equity - marginUsed
    this.account.updatedAt = Date.now()
  }

  private emitPosition(position: Position): void {
    for (const listener of this.positionListeners) {
      try { listener(position) } catch (err) { logger.error('[MockAdapter] position listener 异常', err) }
    }
  }

  private emitOrder(order: Order): void {
    for (const listener of this.orderListeners) {
      try { listener(order) } catch (err) { logger.error('[MockAdapter] order listener 异常', err) }
    }
  }

  private emitAccount(account: AccountSummary): void {
    for (const listener of this.accountListeners) {
      try { listener(account) } catch (err) { logger.error('[MockAdapter] account listener 异常', err) }
    }
  }
}
