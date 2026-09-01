import type { AccountSummary, Order, OrderParams, Position } from '../../types/trading'

/** 持仓变更回调（开仓 / 平仓 / 数量变化推送） */
export type PositionUpdateListener = (position: Position) => void
/** 订单状态变更回调（新建 / 成交 / 取消 / 拒绝推送） */
export type OrderUpdateListener = (order: Order) => void
/** 账户资金变更回调 */
export type AccountUpdateListener = (account: AccountSummary) => void

/**
 * 交易 Broker 统一抽象接口（前端镜像）。
 * 屏蔽 Mock / Tradovate / IBKR 的差异，所有实现必须：
 * - 实现 connect / disconnect / placeOrder / cancelOrder / getPositions / getOrders / getAccountSummary；
 * - 通过回调注册方式广播 onPositionUpdate / onOrderUpdate / onAccountUpdate 事件（注册返回退订函数）。
 */
export interface IBrokerAdapter {
  /**
   * 建立与经纪商的连接（含鉴权）。
   * @param config 各 Broker 专用配置（Mock 初始资金 / Tradovate 网关地址等），结构由实现类自行定义
   */
  connect(config?: any): Promise<void>
  /** 断开连接并释放资源（退订全部推送、关闭 WebSocket 等） */
  disconnect(): Promise<void>
  /** 下单，返回 Broker 确认后的订单快照 */
  placeOrder(params: OrderParams): Promise<Order>
  /** 撤销订单，返回撤销后的订单快照（status 为 CANCELLED） */
  cancelOrder(orderId: string): Promise<Order>
  /** 查询当前全部持仓 */
  getPositions(): Promise<Position[]>
  /** 查询当前全部订单（含未完成与近期已完成） */
  getOrders(): Promise<Order[]>
  /** 查询账户资金汇总 */
  getAccountSummary(): Promise<AccountSummary>

  /** 订阅持仓变更；返回退订函数 */
  onPositionUpdate(listener: PositionUpdateListener): () => void
  /** 订阅订单状态变更；返回退订函数 */
  onOrderUpdate(listener: OrderUpdateListener): () => void
  /** 订阅账户资金变更；返回退订函数 */
  onAccountUpdate(listener: AccountUpdateListener): () => void
}
