import type { BrokerType } from '../../types/trading'
import type { IBrokerAdapter } from './IBrokerAdapter'
import { MockAdapter } from './adapters/MockAdapter'
import { TradovateAdapter } from './adapters/TradovateAdapter'
import { IBKRAdapter } from './adapters/IBKRAdapter'
import { PushOrderAdapter } from './adapters/PushOrderAdapter'

/**
 * Broker 适配器工厂（前端）。
 * 依据类型创建统一的交易适配器实例：
 * - MOCK:                  内存模拟盘，用于前端 UI 开发与联调；
 * - TRADOVATE:             经后端交易网关（/api/trading）执行下单 / 撤单 / 查询；
 * - TRADOVATE_PLAYWRIGHT:  直连本地 Playwright 下单微服务（默认 http://localhost:8000）；
 * - IBKR:                  占位实现（真实接入待后端网关开放）。
 */
export class BrokerFactory {
  /** 创建指定类型的 Broker 适配器 */
  static createAdapter(type: BrokerType): IBrokerAdapter {
    switch (type) {
      case 'TRADOVATE':
        return new TradovateAdapter()
      case 'TRADOVATE_PLAYWRIGHT':
        return new PushOrderAdapter()
      case 'IBKR':
        return new IBKRAdapter()
      case 'MOCK':
        return new MockAdapter()
      default:
        // 联合类型已穷尽，此分支仅在扩展类型时触发
        throw new Error(`BrokerFactory: 不支持的 Broker 类型: ${String(type)}`)
    }
  }
}
