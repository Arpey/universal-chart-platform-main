import type { AccountSummary, Order, OrderParams, Position } from '../../../types/trading'
import type {
  AccountUpdateListener,
  IBrokerAdapter,
  OrderUpdateListener,
  PositionUpdateListener,
} from '../IBrokerAdapter'

/**
 * IBKR 交易驱动（占位）。
 * 仅保留 IBrokerAdapter 契约与事件注册能力：
 * - 交易类方法（connect / placeOrder / cancelOrder）暂抛错；
 * - 查询类方法返回空 / 占位数据，便于前端先行开发空态 UI；
 * 待后端开放 IBKR 交易网关后替换为真实 HTTP 实现。
 */
export class IBKRAdapter implements IBrokerAdapter {
  private connected = false

  private positionListeners: PositionUpdateListener[] = []
  private orderListeners: OrderUpdateListener[] = []
  private accountListeners: AccountUpdateListener[] = []

  async connect(): Promise<void> {
    throw new Error('IBKR Adapter not implemented yet')
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.positionListeners = []
    this.orderListeners = []
    this.accountListeners = []
  }

  async placeOrder(_params: OrderParams): Promise<Order> {
    throw new Error('IBKR Adapter not implemented yet')
  }

  async cancelOrder(_orderId: string): Promise<Order> {
    throw new Error('IBKR Adapter not implemented yet')
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  async getOrders(): Promise<Order[]> {
    return []
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return {
      balance: 0,
      equity: 0,
      marginUsed: 0,
      freeMargin: 0,
      currency: 'USD',
      brokerId: 'IBKR',
      updatedAt: Date.now(),
    }
  }

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
}
