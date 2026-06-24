// 会话池单测:注入假 spawn 工厂 + 内存 load/save,验证 acquire/续接/复用/LRU。
import { describe, it, expect } from 'vitest'
import { SessionPool, type Session } from '../src/session-pool.js'
import type { Reply, UserContent } from '../src/types.js'

/** 假会话工厂:每次 spawn 计数 +1,记录是否传了 resumeId,kill 时记入 killed。 */
function makeFakeSpawn(killed: string[], resumes: Array<string | undefined>) {
  let counter = 0
  return async (opts: { resumeId?: string }): Promise<Session> => {
    counter += 1
    const id = `sess-${counter}`
    resumes.push(opts.resumeId)
    const session: Session = {
      claudeSessionId: id,
      async send(content: UserContent): Promise<Reply> {
        return { markdown: `reply(${content.kind})` }
      },
      kill() { killed.push(id) },
    }
    return session
  }
}

const base = { cwd: '.', systemPrompt: 'p' }

describe('SessionPool', () => {
  it('新用户 → 新建会话;持久化新 claudeSessionId', async () => {
    const killed: string[] = []
    const resumes: Array<string | undefined> = []
    const saved: Record<string, string> = {}
    const pool = new SessionPool({
      ...base, maxSessions: 8,
      spawn: makeFakeSpawn(killed, resumes),
      saveSessionId: async (u, id) => { saved[u] = id },
    })
    const s = await pool.acquire('alice')
    expect(s.claudeSessionId).toBe('sess-1')
    expect(saved.alice).toBe('sess-1')
    expect(resumes[0]).toBeUndefined() // 全新,无 resume
  })

  it('已知用户 → 用持久化 sessionId 做 --resume 续接', async () => {
    const resumes: Array<string | undefined> = []
    const pool = new SessionPool({
      ...base, maxSessions: 8,
      spawn: makeFakeSpawn([], resumes),
      loadSessionId: async () => 'old-session-xyz',
    })
    await pool.acquire('bob')
    expect(resumes[0]).toBe('old-session-xyz')
  })

  it('活跃用户重复 acquire → 复用同一会话,不再 spawn', async () => {
    const resumes: Array<string | undefined> = []
    const pool = new SessionPool({
      ...base, maxSessions: 8,
      spawn: makeFakeSpawn([], resumes),
    })
    const a1 = await pool.acquire('alice')
    const a2 = await pool.acquire('alice')
    expect(a1).toBe(a2)
    expect(resumes).toHaveLength(1)
  })

  it('超 maxSessions → LRU 淘汰最久未用会话(kill)', async () => {
    const killed: string[] = []
    const resumes: Array<string | undefined> = []
    const pool = new SessionPool({
      ...base, maxSessions: 2,
      spawn: makeFakeSpawn(killed, resumes),
    })
    await pool.acquire('a') // sess-1
    await pool.acquire('b') // sess-2
    await pool.acquire('a') // touch:a 最近;b 最久
    await pool.acquire('c') // sess-3 → 淘汰 b(sess-2)
    expect(killed).toEqual(['sess-2'])
    expect(pool.size).toBe(2)
  })

  it('stopAll → 关闭并清空全部活跃会话', async () => {
    const killed: string[] = []
    const resumes: Array<string | undefined> = []
    const pool = new SessionPool({
      ...base, maxSessions: 8,
      spawn: makeFakeSpawn(killed, resumes),
    })
    await pool.acquire('a')
    await pool.acquire('b')
    pool.stopAll()
    expect(killed).toHaveLength(2)
    expect(pool.size).toBe(0)
  })
})
