import WebSocket from 'ws'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { TradovateAuthRequest, TradovateAuthResponse, TradovateSubscribeVariant } from '../types/tradovate'
import { config } from '../utils/config'
import { logger } from '../utils/logger'

/** `a` 帧内的单个响应/事件对象（运行期解构，字段均为可选） */
export interface TradovateFrame {
  i?: number
  s?: number
  e?: string
  d?: unknown
  errorText?: string
}

interface Subscription {
  requestId: number
  operation: string
  body: Record<string, unknown>
  unsubOperation?: string
  unsubBody?: Record<string, unknown>
  onData: (payload: Record<string, unknown>, event?: string) => void
}

/**
 * Tradovate 数据源底层客户端：
 * 1) REST 鉴权：POST /auth/accesstokenrequest 获取 accessToken + mdAccessToken，过期前自动刷新；
 * 2) Market Data WebSocket：authorize → 心跳 → 订阅/取消（quote / dom / chart），事件按请求号路由；
 * 3) 断线指数退避重连，重连后自动恢复全部订阅。
 *
 * 现行 WebSocket 协议（官方 demo/live 端）：
 * - 帧：首字符为类型 `o`(open) / `h`(server heartbeat) / `a`(JSON 数组) / `c`(close)；
 * - 请求：`operation\n<id>\n<query>\n<body>`（换行分隔的纯文本）；
 * - 心跳：客户端每 ~2.5s 发送 `[]` 保持连接；
 * - 响应/事件：`a` + JSON 数组 `[{ i, s, d }]`（直接响应）或 `[{ e, i, d }]`（事件推送），`i` 用于关联。
 */
export class TradovateClient {
  // ---------- 鉴权状态（内存 Token 缓存） ----------
  private accessToken: string | null = null
  private mdAccessToken: string | null = null
  /** mdAccessToken 过期时间戳 (ms)；0 表示尚未鉴权 */
  private tokenExpiration = 0
  private authPromise: Promise<void> | null = null
  private connectPromise: Promise<void> | null = null
  /** 鉴权失败后的冷却期：避免反复请求打爆 live 的每小时 5 次限流 */
  private authBlockedUntil = 0
  private authBlockedMessage = ''

  // ---------- WebSocket 状态 ----------
  private socket: WebSocket | null = null
  private seq = 0
  private connected = false
  private stopped = true
  private authorizeResolved = false
  private pendingRequests = new Map<number, { resolve: (m: TradovateFrame) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  private subscriptions = new Map<number, Subscription>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private lastDataAt = 0
  /** 供外部检查的最近一次错误（如鉴权失败、订阅被拒） */
  lastError = ''

  // ---------- REST 鉴权 ----------

  /** 获取 accessToken / mdAccessToken；有效期内复用已缓存 Token，过期前自动刷新。 */
  async ensureAuth(force = false): Promise<void> {
    // 限流/凭据错误的冷却期内直接抛错，不再请求 live，避免打爆每小时限流
    if (this.authBlockedUntil > Date.now()) {
      const err = new Error(this.authBlockedMessage || 'Tradovate 鉴权暂被限流，请稍后重试')
      this.lastError = err.message
      throw err
    }
    // 内存 Token 缓存命中：mdAccessToken 存在且距过期还有 1 分钟以上 → 直接复用，
    // 严禁重新发起 POST /auth/accesstokenrequest
    if (!force && this.mdAccessToken && this.tokenExpiration > 0 && Date.now() < this.tokenExpiration - 60_000) return
    if (this.authPromise) return this.authPromise
    this.authPromise = this.requestAccessToken().finally(() => { this.authPromise = null })
    return this.authPromise
  }

  /** 鉴权失败后的冷却：rate-limit 用其 p-time（至少 60s）；凭据错误等用 30s。 */
  private blockAuth(message: string, seconds: number): void {
    this.authBlockedUntil = Date.now() + Math.max(seconds, 30) * 1000
    this.authBlockedMessage = message
    this.lastError = message
  }

  private async requestAccessToken(): Promise<void> {
    // Tradovate 报 "The app is not registered"：显式携带 cid / sec（appId 需与配套的 cid/sec 注册才能被信任），
    // 并按官方样例回退默认值；name/password 用 String(...) 规范化后 trim。
    const payload: TradovateAuthRequest = {
      name: String(process.env.TRADOVATE_USER || '').trim(),
      password: String(process.env.TRADOVATE_PASSWORD || '').trim(),
      appId: process.env.TRADOVATE_APP_ID || 'Sample App',
      appVersion: process.env.TRADOVATE_APP_VERSION || '1.0',
      cid: Number(process.env.TRADOVATE_CID || 0),
      sec: process.env.TRADOVATE_SEC || ''
    }

    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    // live 环境要求 tm-usr（设备标识）头；demo 不强制
    if (config.tradovate.env === 'live') headers['tm-usr'] = this.generateDeviceId()

    // 鉴权端点与运行环境强绑定：live 固定命中 live.tradovateapi.com，demo 固定命中 demo.tradovateapi.com
    const authUrl = config.tradovate.env === 'live'
      ? 'https://live.tradovateapi.com/v1/auth/accesstokenrequest'
      : 'https://demo.tradovateapi.com/v1/auth/accesstokenrequest'

    const dispatcher = config.tradovate.proxy ? new ProxyAgent(config.tradovate.proxy) : undefined
    // 发送前打印请求 Payload（密码隐藏），便于核对 appId / cid / sec 排查 "The app is not registered"
    console.log('[Tradovate Auth Payload]:', { ...payload, password: '***' })
    let response: Awaited<ReturnType<typeof undiciFetch>>
    try {
      response = await undiciFetch(authUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        dispatcher,
      })
    } catch (err) {
      // 网络层异常（未收到 HTTP 响应）：打印详细信息便于排查
      console.error('[Tradovate Auth Error Status]:', '网络请求异常（未收到 HTTP 响应）')
      console.error('[Tradovate Auth Error Data]:', err instanceof Error ? err.message : err)
      const message = `Tradovate 鉴权请求失败(网络): ${err instanceof Error ? err.message : String(err)}`
      this.blockAuth(message, 30)
      throw new Error(message)
    }
    if (!response.ok) {
      // 打印 HTTP 状态码 + Response Body，避免只看到外围抛出的 Error
      const text = await response.text().catch(() => '')
      console.error('[Tradovate Auth Error Status]:', response.status)
      console.error('[Tradovate Auth Error Data]:', text)
      const message = `Tradovate 鉴权请求失败: HTTP ${response.status} ${text}`
      this.blockAuth(message, 30)
      throw new Error(message)
    }
    const data = await response.json() as TradovateAuthResponse & {
      'p-ticket'?: string
      'p-time'?: number
      'p-captcha'?: boolean
      'p-message'?: string
    }
    // Tradovate 时间惩罚（限流）：每小时最多 5 次 accesstokenrequest；
    // p-captcha=true 时需人工验证码，无法自动重试，按 p-time 冷却。
    if (data['p-ticket'] || data['p-message']) {
      const waitSec = Math.max(data['p-time'] ?? 60, 60)
      const minutes = Math.ceil(waitSec / 60)
      const message = data['p-captcha']
        ? `Tradovate 鉴权被限流（需人工验证码，约 ${minutes} 分钟后可重试）：${data['p-message'] ?? 'Rate limit exceeded'}`
        : `Tradovate 鉴权被限流（约 ${minutes} 分钟后可重试）：${data['p-message'] ?? 'Rate limit exceeded'}`
      this.blockAuth(message, waitSec)
      throw new Error(message)
    }
    if (data.errorText || !data.accessToken || !data.mdAccessToken) {
      const message = `Tradovate 鉴权失败: ${data.errorText ?? 'accessToken / mdAccessToken 缺失'}`
      this.blockAuth(message, 30)
      throw new Error(message)
    }
    this.accessToken = data.accessToken
    this.mdAccessToken = data.mdAccessToken
    // expirationTime 为 ISO 字符串，解析为毫秒时间戳写入 tokenExpiration
    this.tokenExpiration = data.expirationTime ? new Date(data.expirationTime).getTime() : Date.now() + 60 * 60_000
    this.lastError = ''
    this.authBlockedUntil = 0
    logger.info(`[Tradovate] 鉴权成功 (${config.tradovate.env})，accessToken / mdAccessToken 已保存（mdAccessToken 用于 MD WebSocket ${config.tradovate.mdWsUrl}），token 有效期至 ${data.expirationTime}`)
  }

  /** REST GET（市场数据端点使用 mdAccessToken）。401 时强制刷新 token 后重试一次。 */
  async restGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    await this.ensureAuth()
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    const url = `${config.tradovate.baseUrl}${path}${qs.toString() ? `?${qs.toString()}` : ''}`
    const dispatcher = config.tradovate.proxy ? new ProxyAgent(config.tradovate.proxy) : undefined
    const response = await undiciFetch(url, {
      headers: { Authorization: `Bearer ${this.mdAccessToken ?? ''}`, Accept: 'application/json' },
      dispatcher,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) {
        await this.ensureAuth(true)
        return this.restGet<T>(path, params)
      }
      throw new Error(`Tradovate REST ${path} 失败: HTTP ${response.status} ${text}`)
    }
    return await response.json() as T
  }

  // ---------- Market Data WebSocket ----------

  /** 连接市场数据 WebSocket 并完成 authorize（幂等：已连接/正在连接时复用）。 */
  async connect(): Promise<void> {
    if (this.connected && this.socket) return
    if (this.connectPromise) return this.connectPromise
    await this.ensureAuth()
    this.stopped = false

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tradovate MD WebSocket 连接/授权超时')), 20_000)
      const ws = new WebSocket(
        config.tradovate.mdWsUrl,
        config.tradovate.proxy ? { agent: new HttpsProxyAgent(config.tradovate.proxy) } : undefined,
      )
      this.socket = ws

      ws.on('open', () => {
        logger.info(`[Tradovate] MD WebSocket 已连接: ${config.tradovate.mdWsUrl}`)
      })

      // 连接失败（网络不可达等）时快速失败，避免挂起 20s 才报错
      ws.on('error', (err) => {
        logger.error('[Tradovate] MD WebSocket 错误', err)
        if (!this.authorizeResolved) {
          clearTimeout(timeout)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })

      ws.on('message', (raw) => {
        const text = raw.toString()
        const type = text.slice(0, 1)
        if (type === 'o') {
          // 服务器发送 open 帧 → 立即 authorize（官方教程约定在该帧后授权）
          this.sendAuthorize(resolve, reject, timeout)
          return
        }
        if (type === 'h') return // 服务器心跳，客户端自行发送 `[]` 维持连接
        if (type === 'c') {
          this.connected = false
          ws.close()
          return
        }
        if (type === 'a') {
          this.lastDataAt = Date.now()
          try {
            const frames = JSON.parse(text.slice(1)) as TradovateFrame[]
            for (const frame of frames) this.handleFrame(frame)
          } catch (err) {
            logger.error('[Tradovate] MD 消息解析失败', err)
          }
          return
        }
        // 兜底：非帧格式（可能是经典纯文本响应），尝试按单条 JSON 处理
        try {
          this.handleFrame(JSON.parse(text) as TradovateFrame)
        } catch {
          logger.warn(`[Tradovate] 无法识别的 MD 消息: ${text.slice(0, 120)}`)
        }
      })

      ws.on('close', () => {
        clearTimeout(timeout)
        this.connected = false
        this.authorizeResolved = false
        this.clearHeartbeat()
        this.rejectAllPending(new Error('Tradovate MD WebSocket 已断开'))
        if (!this.stopped) this.scheduleReconnect()
      })
    }).finally(() => { this.connectPromise = null })
    return this.connectPromise
  }

  private sendAuthorize(
    resolve: () => void,
    reject: (e: Error) => void,
    timeout: ReturnType<typeof setTimeout>,
  ): void {
    if (this.authorizeResolved) return
    this.request('authorize', { name: this.mdAccessToken ?? '' })
      .then((resp) => {
        if (resp.s !== 200) throw new Error(resp.errorText ?? `authorize 失败: 状态 ${resp.s}`)
        this.connected = true
        this.authorizeResolved = true
        clearTimeout(timeout)
        this.startHeartbeat()
        logger.info('[Tradovate] MD WebSocket 授权成功，开始心跳')
        resolve()
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
        this.socket?.close()
      })
  }

  /** 发送订阅请求（按候选顺序尝试，成功返回取消函数）。 */
  async subscribe(
    variants: TradovateSubscribeVariant[],
    onData: (payload: Record<string, unknown>, event?: string) => void,
  ): Promise<() => Promise<void>> {
    await this.connect()
    let lastErr: Error | null = null
    for (const variant of variants) {
      const id = this.nextSeq()
      // 提前注册订阅：服务端可能把 ack 与首批数据（hist/初始快照）在同一 TCP 段送达，
      // 若等请求响应后再注册，首批数据会被事件路由丢弃。
      const sub: Subscription = {
        requestId: id,
        operation: variant.operation,
        body: variant.body,
        unsubOperation: variant.unsubOperation,
        unsubBody: variant.unsubBody,
        onData,
      }
      this.subscriptions.set(id, sub)
      try {
        const resp = await this.requestWithId(id, variant.operation, variant.body)
        if (resp.s === 200) {
          // 经典协议可能在直接响应里携带初始数据（hist / 初始快照）
          if (resp.d) this.deliver(sub, resp.d as Record<string, unknown>)
          logger.info(`[Tradovate] 订阅成功: ${variant.operation} ${JSON.stringify(variant.body)}`)
          return this.makeUnsubscribe(sub)
        }
        lastErr = new Error(resp.errorText ?? `${variant.operation} 返回状态 ${resp.s}`)
        this.subscriptions.delete(id)
      } catch (err) {
        this.subscriptions.delete(id)
        lastErr = err instanceof Error ? err : new Error(String(err))
      }
    }
    const message = lastErr?.message ?? 'Tradovate 订阅失败'
    this.lastError = message
    throw new Error(message)
  }

  /** 发送请求并等待关联响应（自动分配请求号）。 */
  request(operation: string, body?: unknown, query?: Record<string, string>): Promise<TradovateFrame> {
    return this.requestWithId(this.nextSeq(), operation, body, query)
  }

  /** 使用指定请求号发送（订阅流程需预知 id 以便预注册订阅）。发送前确保 socket 已就绪：authorize 只需连接打开，其余请求需已完成授权。 */
  private requestWithId(id: number, operation: string, body?: unknown, query?: Record<string, string>): Promise<TradovateFrame> {
    const ready = operation === 'authorize'
      ? this.waitSocketOpen(10_000)
      : this.waitReady(10_000)
    return ready.then(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Tradovate MD WebSocket 未连接')
      }
      const queryStr = query ? new URLSearchParams(query).toString() : ''
      const payload = `${operation}\n${id}\n${queryStr}\n${body !== undefined ? JSON.stringify(body) : ''}`

      return new Promise<TradovateFrame>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(id)
          reject(new Error(`Tradovate WS 请求超时: ${operation}`))
        }, 15_000)
        this.pendingRequests.set(id, { resolve, reject, timeout })
        try {
          socket.send(payload)
        } catch (err) {
          clearTimeout(timeout)
          this.pendingRequests.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  /** 等待 socket 打开（连接握手完成）。 */
  private waitSocketOpen(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        const s = this.socket
        if (s && s.readyState === WebSocket.OPEN) return resolve()
        if (s && (s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING)) {
          return reject(new Error('Tradovate MD WebSocket 已断开'))
        }
        if (Date.now() - start > timeoutMs) return reject(new Error('Tradovate MD WebSocket 等待就绪超时'))
        setTimeout(check, 20)
      }
      check()
    })
  }

  /** 等待连接完成授权（this.connected=true 且 socket 打开）。 */
  private waitReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) return resolve()
        if (Date.now() - start > timeoutMs) return reject(new Error('Tradovate MD WebSocket 未就绪（未授权）'))
        setTimeout(check, 20)
      }
      check()
    })
  }

  // ---------- 内部实现 ----------

  private handleFrame(frame: TradovateFrame): void {
    const id = frame.i
    // 1) 订阅事件推送：带 e 事件名 + 已注册订阅
    if (frame.e && id !== undefined && this.subscriptions.has(id)) {
      const sub = this.subscriptions.get(id)
      if (sub && typeof frame.d === 'object' && frame.d !== null) {
        this.deliver(sub, frame.d as Record<string, unknown>, frame.e)
      }
      return
    }
    // 2) 普通请求响应
    const pending = this.pendingRequests.get(id ?? -1)
    if (pending) {
      this.pendingRequests.delete(id ?? -1)
      clearTimeout(pending.timeout)
      pending.resolve(frame)
      return
    }
    // 3) 订阅请求的初始响应（经典协议：响应里直接带数据，无 e 字段）
    if (id !== undefined && this.subscriptions.has(id) && !frame.e && frame.d) {
      const sub = this.subscriptions.get(id)
      if (sub) this.deliver(sub, frame.d as Record<string, unknown>)
    }
  }

  private deliver(sub: Subscription, payload: Record<string, unknown>, event?: string): void {
    try {
      sub.onData(payload, event)
    } catch (err) {
      logger.error('[Tradovate] 订阅回调异常', err)
    }
  }

  private makeUnsubscribe(sub: Subscription): () => Promise<void> {
    return async () => {
      this.subscriptions.delete(sub.requestId)
      const socket = this.socket
      if (socket && socket.readyState === WebSocket.OPEN && sub.unsubOperation) {
        try {
          await this.request(sub.unsubOperation, sub.unsubBody ?? {})
        } catch { /* 取消失败可忽略 */ }
      }
    }
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    // 官方要求：约每 2.5s 发送一次客户端心跳（空数组帧）
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send('[]')
      }
    }, 2_500)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000) + Math.floor(Math.random() * 500)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        this.reconnectAttempts = 0
        await this.resubscribeAll()
      } catch (err) {
        logger.warn(`[Tradovate] MD WebSocket 重连失败: ${err instanceof Error ? err.message : String(err)}`)
        this.scheduleReconnect()
      }
    }, delay)
  }

  /** 重连成功后恢复全部订阅（md token 通常随连接失效，订阅需重发）。 */
  private async resubscribeAll(): Promise<void> {
    const subs = [...this.subscriptions.values()]
    this.subscriptions.clear()
    for (const sub of subs) {
      const id = this.nextSeq()
      // 与首次订阅一致：提前注册，避免重连后首批数据被丢弃
      this.subscriptions.set(id, sub)
      try {
        const resp = await this.requestWithId(id, sub.operation, sub.body)
        if (resp.s === 200) {
          this.subscriptions.set(id, { ...sub, requestId: id })
        } else {
          this.subscriptions.delete(id)
          logger.warn(`[Tradovate] 重连后恢复订阅失败: ${sub.operation} ${resp.errorText ?? resp.s}`)
        }
      } catch (err) {
        this.subscriptions.delete(id)
        logger.warn(`[Tradovate] 重连后恢复订阅失败: ${sub.operation} ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private generateDeviceId(): string {
    // live 环境 tm-usr 头需要稳定的设备标识
    return `ucp-${config.tradovate.cid ? config.tradovate.cid : `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`}`
  }

  /** 最近一次收到数据的时间（无数据看门狗用）。 */
  lastMessageAt(): number {
    return this.lastDataAt
  }

  /** 主动关闭连接（进程退出 / 测试用）。 */
  close(): void {
    this.stopped = true
    this.clearHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.rejectAllPending(new Error('Tradovate MD WebSocket 已关闭'))
    this.socket?.close()
    this.socket = null
  }
}

/**
 * 全局共享的 TradovateClient 单例：
 * 所有 TradovateAdapter / REST / WS 连接共用同一实例与内存 Token 缓存，
 * 避免多次实例化导致重复 POST /auth/accesstokenrequest 触发每小时 5 次限流。
 */
export const tradovateClient = new TradovateClient()
