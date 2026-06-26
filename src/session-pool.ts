// 按用户隔离的会话池 + LRU。
// 纯编排逻辑(取/建会话、touch、淘汰、resume),通过注入 spawn 工厂与 load/save 回调,
// 可完全脱离真实子进程单测(in-process)。
import type { Reply, UserContent } from './types.js'

/** 一个用户会话的最小契约(ClaudeSession 实现它;测试用假实现)。 */
export interface Session {
  /** 该用户的会话上下文内提问,等完整回复后 resolve。 */
  send(content: UserContent): Promise<Reply>
  /** 关闭会话子进程(LRU 淘汰/停止时调用)。 */
  kill(): void
  /** 运行期切模型(经 set_model control_request);无状态会话可不实现。 */
  setModel?(model: string): void
  /** Claude 分配的会话 ID(用于持久化 + 下次 --resume)。 */
  claudeSessionId?: string
}

export interface SessionPoolDeps {
  cwd: string
  systemPrompt: string
  maxSessions: number
  /** 新建会话。生产=ClaudeSession.spawn;测试=返回记录 resumeId 的假会话。 */
  spawn: (opts: { cwd: string; systemPrompt: string; resumeId?: string }) => Promise<Session>
  /** 读该用户上次会话 ID(默认接 state.ts)。 */
  loadSessionId?: (userId: string) => Promise<string | undefined>
  /** 存该用户会话 ID(默认接 state.ts)。 */
  saveSessionId?: (userId: string, id: string) => Promise<void>
}

export class SessionPool {
  /** Map 保持插入顺序;访问时 delete+set 把最近用者移到末尾,淘汰从头部取 → 即 LRU。 */
  private readonly live = new Map<string, Session>()
  private readonly loadSessionId: (u: string) => Promise<string | undefined>
  private readonly saveSessionId: (u: string, id: string) => Promise<void>

  constructor(private readonly deps: SessionPoolDeps) {
    this.loadSessionId = deps.loadSessionId ?? (async () => undefined)
    this.saveSessionId = deps.saveSessionId ?? (async () => undefined)
  }

  /** 取该用户的活跃会话;无则按持久化的 resumeId 续接/新建,并持久化新会话 ID。 */
  async acquire(userId: string): Promise<Session> {
    const existing = this.live.get(userId)
    if (existing) {
      this.touch(userId, existing)
      return existing
    }
    const resumeId = await this.loadSessionId(userId)
    const session = await this.deps.spawn({
      cwd: this.deps.cwd,
      systemPrompt: this.deps.systemPrompt,
      resumeId,
    })
    if (session.claudeSessionId) {
      await this.saveSessionId(userId, session.claudeSessionId)
    }
    this.live.set(userId, session)
    this.evictIfNeeded()
    return session
  }

  /**
   * 为该用户新建会话(**不续接历史**):先清掉旧活跃会话,再不带 resumeId spawn,
   * 入池 + 持久化新 id + 淘汰。供 @开启 用(用户要求每次开启都是全新会话)。
   */
  async startFresh(userId: string): Promise<Session> {
    const existing = this.live.get(userId)
    if (existing) {
      this.live.delete(userId)
      existing.kill()
    }
    const session = await this.deps.spawn({
      cwd: this.deps.cwd,
      systemPrompt: this.deps.systemPrompt,
      // 故意不传 resumeId:每次开启都是全新会话,不续接
    })
    if (session.claudeSessionId) {
      await this.saveSessionId(userId, session.claudeSessionId)
    }
    this.live.set(userId, session)
    this.evictIfNeeded()
    return session
  }

  /** 移出该用户的活跃会话(不 kill,调用方取 claudeSessionId 后自行 kill)。无则 undefined。 */
  release(userId: string): Session | undefined {
    const session = this.live.get(userId)
    if (session) this.live.delete(userId)
    return session
  }

  /**
   * 运行期切该用户当前活跃会话的模型(经 set_model control_request)。
   * 无活跃会话(已退出/未开启)或会话不支持 setModel 时返 false;有则委托并返 true。
   * 供 @bot <alias> 开启时切模型:startSession 后立即调用,命中刚入池的新会话。
   */
  setModel(userId: string, model: string): boolean {
    const session = this.live.get(userId)
    if (!session?.setModel) return false
    session.setModel(model)
    return true
  }

  /** 该用户是否在池中有活跃会话。 */
  has(userId: string): boolean {
    return this.live.has(userId)
  }

  /** 关闭并清空所有活跃会话(进程退出时调用)。 */
  stopAll(): void {
    for (const s of this.live.values()) s.kill()
    this.live.clear()
  }

  get size(): number {
    return this.live.size
  }

  private touch(userId: string, session: Session): void {
    this.live.delete(userId)
    this.live.set(userId, session)
  }

  private evictIfNeeded(): void {
    while (this.live.size > this.deps.maxSessions) {
      const oldest = this.live.keys().next().value
      if (oldest === undefined) break
      const evicted = this.live.get(oldest)
      this.live.delete(oldest)
      evicted?.kill()
    }
  }
}
