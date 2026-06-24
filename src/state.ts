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
}

async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return { sessionIds: parsed.sessionIds ?? {} }
  } catch {
    return { sessionIds: {} }
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
