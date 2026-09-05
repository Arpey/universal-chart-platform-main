import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AccountSummary, BrokerType, Order, OrderParams, OrderPreset, OrderSide, Position } from '../types/trading'
import type { IBrokerAdapter } from '../services/trading/IBrokerAdapter'
import { BrokerFactory } from '../services/trading/BrokerFactory'

/**
 * 图表持仓线的止盈/止损 bracket 状态（keyed by symbol）。
 * 每个现仓最多维护两条 reduce-only 保护腿：
 * - 多头：SL = SELL STOP（止损触发价低于均价），TP = SELL LIMIT（止盈价高于均价）；
 * - 空头：SL = BUY STOP，TP = BUY LIMIT。
 * 腿订单通过适配器真实下单，orderId 在此登记以便改价/移除时精准撤单。
 */
export interface PositionBracket {
  stopLoss: number | null
  takeProfit: number | null
  slOrderId: string | null
  tpOrderId: string | null
  updatedAt: number
}

const EMPTY_BRACKET: PositionBracket = { stopLoss: null, takeProfit: null, slOrderId: null, tpOrderId: null, updatedAt: 0 }

/** 判断某现仓方向下 TP/SL 价格是否落在合理区间（防倒挂挂单）。 */
export function isBracketPriceValid(side: OrderSide, entryPrice: number, kind: 'tp' | 'sl', price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false
  if (side === 'BUY') return kind === 'tp' ? price > entryPrice : price < entryPrice
  return kind === 'tp' ? price < entryPrice : price > entryPrice
}

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
  /** 下单面板开关（默认折叠/隐藏；统一由顶栏按钮 / 快捷键 / 图表右键菜单读写，保证各入口状态同步） */
  const isOrderPanelOpen = ref(false)
  /** 下单面板外部预设（右键菜单价格 / TP/SL 等注入），OrderForm 消费后调用 consumeOrderPreset 清空。 */
  const orderPreset = ref<OrderPreset | null>(null)
  /** 各品种现仓的止盈/止损 bracket（含已下保护腿的订单号）。key = 合约 symbol。 */
  const positionBrackets = ref<Record<string, PositionBracket>>({})

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
    positionBrackets.value = {}
    orderPreset.value = null
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
      // 空仓即清理该品种残留的止盈/止损腿单登记（撤单失败静默）
      void clearPositionBracket(position.symbol).catch(() => undefined)
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
    const order = await submitOrder({ symbol, side, type: 'MARKET', qty: position.qty })
    // 平仓后清理该品种的止盈/止损 bracket 腿单，避免残留保护单孤悬
    try {
      await clearPositionBracket(symbol)
    } catch {
      // 撤腿失败不阻断平仓成功返回；错误已记录至 error
    }
    return order
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
    pruneClosedPositionBrackets()
  }

  /** 设置当前交易品种（由行情侧选中品种时调用，实现单向解耦）。 */
  function setActiveSymbol(symbol: string): void {
    activeSymbol.value = symbol
  }

  // ---------- 行情价格联动（MOCK 等需要实时估值的适配器） ----------

  /**
   * 将最新成交/标记价喂给支持实时估值的适配器（当前实现为 MOCK 模拟盘）。
   * - 使市价单成交价贴合真实行情（修正默认 100 的失真）；
   * - 实时刷新现仓 markPrice / pnl 与账户权益，驱动持仓线盈亏联动。
   * 适配器未实现 setMarkPrice 时静默跳过（真实 Broker 由券商侧估值）。
   */
  function feedMarkPrice(symbol: string, price: number): void {
    if (!adapter || !isConnected.value || !Number.isFinite(price) || price <= 0) return
    const maybe = adapter as unknown as { setMarkPrice?: (s: string, p: number) => void }
    if (typeof maybe.setMarkPrice === 'function') {
      try {
        maybe.setMarkPrice(symbol.trim().toUpperCase(), price)
      } catch {
        /* 估值失败不影响行情 */
      }
    }
  }

  // ---------- 现仓止盈/止损 bracket（持仓线 TP/SL 挂单） ----------

  type BracketLeg = 'sl' | 'tp'

  /** 读取某品种的 bracket 快照（无则返回空 bracket）。 */
  function getPositionBracket(symbol: string): PositionBracket {
    const key = symbol.trim().toUpperCase()
    const cur = positionBrackets.value[key]
    return cur ? { ...cur } : { ...EMPTY_BRACKET }
  }

  /** 撤掉一条已登记的腿单：仅当订单仍 PENDING 时撤销；已成交/取消/不存在视为已清理。 */
  async function cancelLegIfPending(orderId: string | null): Promise<void> {
    if (!orderId) return
    const o = orders.value.find((x) => x.orderId === orderId)
    if (o && o.status === 'PENDING') {
      try {
        await cancelOrder(orderId)
      } catch {
        /* 网关已撤 / 状态冲突时静默，防止撤腿失败击穿主流程 */
      }
    }
  }

  /** 同步单条保护腿：price 为空 → 撤旧腿；非空 → 撤旧腿并按下单。 */
  async function syncBracketLeg(
    symbol: string,
    pos: Position,
    leg: BracketLeg,
    price: number | null,
  ): Promise<{ orderId: string | null }> {
    const cur = getPositionBracket(symbol)
    const curId = leg === 'sl' ? cur.slOrderId : cur.tpOrderId
    // 目标价与现腿一致且腿单仍活跃 → 无需重新撤挂（拖拽落回原价时不产生冗余订单）
    if (price != null && curId) {
      const alive = orders.value.find((x) => x.orderId === curId && x.status === 'PENDING')
      if (alive && alive.price === price) return { orderId: curId }
    }
    await cancelLegIfPending(curId)
    if (price == null) return { orderId: null }
    const reduceSide: OrderSide = pos.side === 'BUY' ? 'SELL' : 'BUY'
    const params: OrderParams = {
      symbol: pos.symbol,
      side: reduceSide,
      type: leg === 'sl' ? 'STOP' : 'LIMIT',
      qty: pos.qty,
      price,
      reduceOnly: true,
    }
    const order = await submitOrder(params)
    return { orderId: order.orderId }
  }

  /** 设置（或清除）某现仓的止盈/止损 bracket：自动撤销旧腿并挂新腿。 */
  async function setPositionBracket(
    symbol: string,
    patch: { stopLoss?: number | null; takeProfit?: number | null },
  ): Promise<void> {
    const pos = positions.value.find((p) => p.symbol === symbol && p.qty > 0)
    if (!pos) throw new Error(`无 ${symbol} 的活跃持仓，无法设置止盈/止损`)
    const cur = getPositionBracket(symbol)
    const sl = patch.stopLoss !== undefined ? (patch.stopLoss ?? null) : cur.stopLoss
    const tp = patch.takeProfit !== undefined ? (patch.takeProfit ?? null) : cur.takeProfit
    if (sl != null && !isBracketPriceValid(pos.side, pos.entryPrice, 'sl', sl)) {
      throw new Error(`止损价 ${sl} 不合法：${pos.side === 'BUY' ? '多头止损应低于' : '空头止损应高于'}持仓均价 ${pos.entryPrice}`)
    }
    if (tp != null && !isBracketPriceValid(pos.side, pos.entryPrice, 'tp', tp)) {
      throw new Error(`止盈价 ${tp} 不合法：${pos.side === 'BUY' ? '多头止盈应高于' : '空头止盈应低于'}持仓均价 ${pos.entryPrice}`)
    }
    const [slRes, tpRes] = await Promise.allSettled([
      syncBracketLeg(symbol, pos, 'sl', sl),
      syncBracketLeg(symbol, pos, 'tp', tp),
    ])
    if (slRes.status === 'rejected') throw slRes.reason
    if (tpRes.status === 'rejected') throw tpRes.reason
    positionBrackets.value = {
      ...positionBrackets.value,
      [pos.symbol]: {
        stopLoss: sl,
        takeProfit: tp,
        slOrderId: slRes.value.orderId,
        tpOrderId: tpRes.value.orderId,
        updatedAt: Date.now(),
      },
    }
  }

  /** 撤销某品种全部 bracket 腿单并清空登记。 */
  async function clearPositionBracket(symbol: string): Promise<void> {
    const cur = getPositionBracket(symbol)
    if (!cur.slOrderId && !cur.tpOrderId && !positionBrackets.value[symbol]) return
    await cancelLegIfPending(cur.slOrderId)
    await cancelLegIfPending(cur.tpOrderId)
    const next = { ...positionBrackets.value }
    delete next[symbol]
    positionBrackets.value = next
  }

  /** 清理已不存在活跃持仓的品种 bracket（平仓 / 撤单 / 成交后状态同步）。 */
  function pruneClosedPositionBrackets(): void {
    const active = new Set(positions.value.filter((p) => p.qty > 0).map((p) => p.symbol))
    let dirty = false
    const next = { ...positionBrackets.value }
    for (const symbol of Object.keys(next)) {
      if (active.has(symbol)) continue
      // 异步撤腿（不阻塞本轮刷新），成功后从登记表移除
      const reg = next[symbol]
      void (async () => {
        await cancelLegIfPending(reg.slOrderId)
        await cancelLegIfPending(reg.tpOrderId)
        const fresh = { ...positionBrackets.value }
        delete fresh[symbol]
        positionBrackets.value = fresh
      })()
      delete next[symbol]
      dirty = true
    }
    if (dirty) positionBrackets.value = next
  }

  // ---------- 下单面板 UI 状态（集中管理，供任意入口调用） ----------

  /**
   * 打开下单面板，并注入可选的外部预设（图表右键价格 / 快捷止盈止损）。
   * @param preset 预填 OrderForm 的表单内容；不传则保留当前表单值。
   */
  function openOrderPanel(preset?: OrderPreset | null): void {
    orderPreset.value = preset ?? null
    isOrderPanelOpen.value = true
  }

  /** 消费（清空）当前下单预设：OrderForm 应用后调用，避免重复填充。 */
  function consumeOrderPreset(): void {
    orderPreset.value = null
  }

  /** 关闭下单面板。 */
  function closeOrderPanel(): void {
    isOrderPanelOpen.value = false
  }

  /** 切换下单面板开关（顶栏按钮 / 快捷键可调用）。 */
  function toggleOrderPanel(): void {
    isOrderPanelOpen.value = !isOrderPanelOpen.value
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
    isOrderPanelOpen,
    orderPreset,
    positionBrackets,
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
    feedMarkPrice,
    getPositionBracket,
    setPositionBracket,
    clearPositionBracket,
    openOrderPanel,
    closeOrderPanel,
    toggleOrderPanel,
    consumeOrderPreset,
  }
})
