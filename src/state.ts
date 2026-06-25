// 状态持久化:每用户的 claudeSessionId(跨重启 --resume 续接)。
// 一适配器(JSON 文件读写),不开端口;路径可由 BOT_STATE_DIR 覆盖。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = process.env.BOT_STATE_DIR ?? join(homedir(), '.claude-bot')
const STATE_FILE = join(STATE_DIR, 'state.json')

interface BotState {
  /** userId → claudeSessionId,用于 --resume 续接。 */
  sessionIds: Record<string, string>
  /** groupId → 最后处理的 msgId(水位,跨重启去重,"只触发一次")。 */
  lastMsgIds: Record<string, string>
}

async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      sessionIds: parsed.sessionIds ?? {},
      lastMsgIds: parsed.lastMsgIds ?? {},
    }
  } catch {
    return { sessionIds: {}, lastMsgIds: {} }
  }
}

async function saveState(state: BotState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

export async function loadSessionId(userId: string): Promise<string | undefined> {
  return (await loadState()).sessionIds[userId]
}

export async function saveSessionId(userId: string, sessionId: string): Promise<void> {
  const state = await loadState()
  state.sessionIds[userId] = sessionId
  await saveState(state)
}

/** 读取某群最后处理的 msgId(水位)。无记录返回 undefined → 首次运行,核心据此排除历史。 */
export async function loadLastMsgId(groupId: string): Promise<string | undefined> {
  return (await loadState()).lastMsgIds[groupId]
}

/** 持久化某群水位(每条消息处理前推进 → 崩溃至多重丢一条,绝不重复处理)。 */
export async function saveLastMsgId(groupId: string, msgId: string): Promise<void> {
  const state = await loadState()
  state.lastMsgIds[groupId] = msgId
  await saveState(state)
}
