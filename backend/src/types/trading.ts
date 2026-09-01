/**
 * 交易模块基础类型定义。
 * 与行情侧的 MarketDataAdapter（types/adapter.ts）平行，
 * 为 Tradovate / IBKR / Mock 三类 Broker 提供统一的订单、持仓与账户模型。
 */

/** 支持的经纪商类型 */
export type BrokerType = 'TRADOVATE' | 'IBKR' | 'MOCK'

/** 订单方向 */
export type OrderSide = 'BUY' | 'SELL'

/** 订单类型 */
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP'

/** 订单状态 */
export type OrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED'

/** 下单参数（各 Broker 实现类消费，字段含义保持统一） */
export interface OrderParams {
  /** 合约/交易对标识（如 MES、MNQ、BTCUSDT） */
  symbol: string
  side: OrderSide
  type: OrderType
  /** 下单数量（合约张数 / 币数量） */
  qty: number
  /** 委托价：LIMIT 为限价，STOP 为触发价，MARKET 可省略 */
  price?: number
  /** 止损价（可选；随订单下发到 Broker 的 OCO/条件单，或由上层自行管理） */
  stopLoss?: number
  /** 止盈价（可选） */
  takeProfit?: number
  /** 经纪商侧订单号（可选；缺省时由适配器生成或由 Broker 返回） */
  brokerId?: string
  /** 有效时间（可选，如 GTC / IOC / FOK） */
  timeInForce?: string
  /** 仅减仓（可选，对冲模式下避免意外开仓） */
  reduceOnly?: boolean
}

/** 持仓 */
export interface Position {
  symbol: string
  side: OrderSide
  qty: number
  entryPrice: number
  /** 最新标记价（用于计算 pnl） */
  markPrice: number
  /** 浮动盈亏（按标记价计算，正数为盈利） */
  pnl: number
  /** 所属经纪商/账户标识（TRADOVATE 账户 ID 等） */
  brokerId: string
  /** 最近一次更新时间（epoch ms） */
  updatedAt: number
}

/** 订单（成交回报 / 查询结果的统一结构） */
export interface Order {
  orderId: string
  symbol: string
  side: OrderSide
  type: OrderType
  qty: number
  /** 委托价；MARKET 市价单可能为 null */
  price: number | null
  status: OrderStatus
  /** 下单时间（epoch ms） */
  createdAt: number
  /** 已成交数量（可选，用于部分成交场景） */
  filledQty?: number
  /** 平均成交价（可选） */
  avgFillPrice?: number
  /** 最近一次状态变更时间（epoch ms） */
  updatedAt?: number
}

/** 账户资金汇总 */
export interface AccountSummary {
  /** 账户总余额（未计未实现盈亏） */
  balance: number
  /** 权益（余额 + 未实现盈亏） */
  equity: number
  /** 已占用保证金 */
  marginUsed: number
  /** 可用保证金（freeMargin = equity - marginUsed） */
  freeMargin: number
  /** 结算货币（可选，如 USD） */
  currency?: string
  /** 所属经纪商/账户标识 */
  brokerId?: string
  /** 更新时间（epoch ms） */
  updatedAt?: number
}
