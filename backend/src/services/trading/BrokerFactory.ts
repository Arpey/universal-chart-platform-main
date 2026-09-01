import type { BrokerType } from '../../types/trading'
import type { IBrokerAdapter } from './IBrokerAdapter'
import { MockAdapter } from './adapters/MockAdapter'
import { TradovateAdapter } from './adapters/TradovateAdapter'
import { IBKRAdapter } from './adapters/IBKRAdapter'

/**
 * Broker 适配器工厂。
 * 依据类型创建统一的交易适配器实例：
 * - MOCK:      内存模拟盘，用于前端 UI 开发与联调；
 * - TRADOVATE: 经本地 Playwright 下单服务执行真实下单 / 撤单 / 查询；
 * - IBKR:      占位实现（接口已就位，真实接入待后续步骤）。
 */
export class BrokerFactory {
  /** 创建指定类型的 Broker 适配器 */
  static createAdapter(type: BrokerType): IBrokerAdapter {
    switch (type) {
      case 'TRADOVATE':
        return new TradovateAdapter()
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
