import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AccountSummary, BrokerType, Order, OrderParams, OrderSide, Position } from '../types/trading'
import type { IBrokerAdapter } from '../services/trading/IBrokerAdapter'
import { BrokerFactory } from '../services/trading/BrokerFactory'

/**
 * 交易状态管理中心（Pinia，setup 风格）。
 * 与行情模块（marketStore / wsService）彻底解耦：
 * - 所有券商网络 / 协议细节封装在 IBrokerAdapter 实现内部，本 store 只面向标准化接口；
 * - 组件通过本 store 的标准方法下单 / 平仓 / 撤单 / 刷新，无需感知当前是 Mock / Tradovate / IBKR；
 * - 行情侧仅通过 setActiveSymbol 单向传入当前交易品种，无反向依赖。
 */
export const useTradingStore = defineStore('trading', () => {
  // ---------- state ----------
  const currentBrokerType = ref<BrokerType>('MOCK')
  const isConnected = ref(false)
  const positions = ref<Position[]>([])
  const orders = ref<Order[]>([])
  const accountSummary = ref<AccountSummary>()
  /** 当前交易品种（由外部行情侧调用 setActiveSymbol 同步） */
  const activeSymbol = ref('')
  /** 最近一次操作错误信息（供 UI 提示） */
  const error = ref('')

  /** 当前 Broker 适配器实例（非响应式内部状态） */
  let adapter: IBrokerAdapter | null = null
  /** 已绑定事件的退订函数集合，切换 Broker 时统一清理 */
  const unsubscribeFns: Array<() => void> = []

  // ---------- Adapter 生命周期管理 ----------

  /** 为指定 Adapter 绑定三组更新回调（推送 → store state）。 */
  function bindAdapter(next: IBrokerAdapter): void {
    unsubscribeFns.push(next.onPositionUpdate(onPositionUpdate))
    unsubscribeFns.push(next.onOrderUpdate(onOrderUpdate))
    unsubscribeFns.push(next.onAccountUpdate(onAccountUpdate))
  }

  /** 销毁当前 Adapter：退订回调 → 异步断开 → 清空交易状态。 */
  function disposeAdapter(): void {
    while (unsubscribeFns.length > 0) unsubscribeFns.pop()?.()
    if (adapter) {
      void adapter.disconnect().catch(() => { /* 断开失败静默，状态已重置 */ })
      adapter = null
    }
    isConnected.value = false
    positions.value = []
    orders.value = []
    accountSummary.value = undefined
    error.value = ''
  }

  /** 取当前 Adapter，未选择 / 未连接时抛错。 */
  function assertAdapter(): IBrokerAdapter {
    if (!adapter) throw new Error('未选择 Broker，请先调用 switchBroker()')
    if (!isConnected.value) throw new Error('Broker 未连接，请先调用 connectBroker()')
    return adapter
  }

  // ---------- 初始化：默认 MOCK 模拟盘，开箱即用 ----------
  adapter = BrokerFactory.createAdapter('MOCK')
  bindAdapter(adapter)

  // ---------- Adapter 事件 → store state（内部回调） ----------

  /** qty <= 0 表示该品种已平仓（空仓事件），从列表移除；否则新增或原地更新。 */
  function onPositionUpdate(position: Position): void {
    if (position.qty <= 0) {
      positions.value = positions.value.filter((p) => p.symbol !== position.symbol)
      return
    }
    const idx = positions.value.findIndex((p) => p.symbol === position.symbol)
    if (idx >= 0) positions.value[idx] = position
    else positions.value.push(position)
  }

  function onOrderUpdate(order: Order): void {
    const idx = orders.value.findIndex((o) => o.orderId === order.orderId)
    if (idx >= 0) orders.value[idx] = order
    else orders.value.unshift(order)
  }

  function onAccountUpdate(account: AccountSummary): void {
    accountSummary.value = account
  }

  // ---------- getters ----------

  /** 全部持仓未实现盈亏总和（正数为整体盈利）。 */
  const totalUnrealizedPnL = computed(() => positions.value.reduce((sum, p) => sum + (p.pnl ?? 0), 0))
  /** 当前交易品种的持仓（无则 undefined）。 */
  const currentSymbolPosition = computed(() => positions.value.find((p) => p.symbol === activeSymbol.value))

  // ---------- actions ----------

  /**
   * 切换 Broker：销毁旧 Adapter（退订 + 断开）、创建新 Adapter 并绑定更新回调。
   * 切换后交易状态清空，需重新 connectBroker()。
   */
  async function switchBroker(type: BrokerType): Promise<void> {
    if (type === currentBrokerType.value && adapter) return // 同类型切换幂等
    disposeAdapter()
    currentBrokerType.value = type
    adapter = BrokerFactory.createAdapter(type)
    bindAdapter(adapter)
  }

  /** 连接当前 Broker 并拉取初始持仓 / 订单 / 账户。 */
  async function connectBroker(config?: any): Promise<void> {
    if (!adapter) throw new Error('未选择 Broker，请先调用 switchBroker()')
    error.value = ''
    try {
      await adapter.connect(config)
      isConnected.value = true
      await refreshData()
    } catch (e) {
      isConnected.value = false
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /** 提交订单（市价 / 限价 / 止损），成交后自动刷新持仓与挂单列表。 */
  async function submitOrder(params: OrderParams): Promise<Order> {
    const target = assertAdapter()
    error.value = ''
    try {
      const order = await target.placeOrder(params)
      await refreshData()
      return order
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /** 快速对冲平仓：对指定品种下与持仓方向相反的同量市价单。 */
  async function closePosition(symbol: string): Promise<Order> {
    const position = positions.value.find((p) => p.symbol === symbol)
    if (!position) throw new Error(`未找到 ${symbol} 的持仓，无法平仓`)
    if (position.qty <= 0) throw new Error(`持仓 ${symbol} 数量为 0，无法平仓`)
    const side: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY'
    return submitOrder({ symbol, side, type: 'MARKET', qty: position.qty })
  }

  /** 撤销指定订单并刷新列表。 */
  async function cancelOrder(orderId: string): Promise<Order> {
    const target = assertAdapter()
    error.value = ''
    try {
      const order = await target.cancelOrder(orderId)
      await refreshData()
      return order
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  /** 主动拉取持仓 / 订单 / 账户（任一失败不影响其余两项，store 状态保持各自最新）。 */
  async function refreshData(): Promise<void> {
    if (!adapter || !isConnected.value) return
    const [pos, ords, acc] = await Promise.allSettled([
      adapter.getPositions(),
      adapter.getOrders(),
      adapter.getAccountSummary(),
    ])
    if (pos.status === 'fulfilled') positions.value = pos.value
    if (ords.status === 'fulfilled') orders.value = ords.value
    if (acc.status === 'fulfilled') accountSummary.value = acc.value
  }

  /** 设置当前交易品种（由行情侧选中品种时调用，实现单向解耦）。 */
  function setActiveSymbol(symbol: string): void {
    activeSymbol.value = symbol
  }

  return {
    // state
    currentBrokerType,
    isConnected,
    positions,
    orders,
    accountSummary,
    activeSymbol,
    error,
    // getters
    totalUnrealizedPnL,
    currentSymbolPosition,
    // actions
    switchBroker,
    connectBroker,
    submitOrder,
    closePosition,
    cancelOrder,
    refreshData,
    setActiveSymbol,
  }
})
