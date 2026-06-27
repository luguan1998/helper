// 状态持久化(每群独立文件):本群水位 + 本群内 userId→claudeSessionId(跨重启 --resume 续接)。
// 一适配器(JSON 文件读写),不开端口;路径可由 BOT_STATE_DIR 覆盖。
// 每群独立文件 → 消除跨群 userId 串号;单进程下每群 loop 串行写自己文件,无需锁。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = process.env.BOT_STATE_DIR ?? join(homedir(), '.claude-bot')

/** 某群的状态文件路径:groupId 仅保留 [A-Za-z0-9_-] 作文件名片段,防注入/非法字符。 */
function stateFileFor(groupId: string): string {
  const safe = String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(STATE_DIR, `state-${safe}.json`)
}

interface GroupState {
  /** 本群最后处理的 msgId(水位,跨重启去重,"只触发一次")。undefined=首次运行,核心据此排除历史。 */
  watermark?: string
  /** userId → claudeSessionId,本群内按用户 --resume 续接。 */
  sessionIds: Record<string, string>
}

async function loadGroupState(groupId: string): Promise<GroupState> {
  try {
    const raw = await readFile(stateFileFor(groupId), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      watermark: parsed.watermark,
      sessionIds: parsed.sessionIds ?? {},
    }
  } catch {
    return { sessionIds: {} }
  }
}

async function saveGroupState(groupId: string, state: GroupState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(stateFileFor(groupId), JSON.stringify(state, null, 2), 'utf-8')
}

export async function loadSessionId(groupId: string, userId: string): Promise<string | undefined> {
  return (await loadGroupState(groupId)).sessionIds[userId]
}

export async function saveSessionId(groupId: string, userId: string, sessionId: string): Promise<void> {
  const state = await loadGroupState(groupId)
  state.sessionIds[userId] = sessionId
  await saveGroupState(groupId, state)
}

/** 读取某群最后处理的 msgId(水位)。无记录返回 undefined → 首次运行,核心据此排除历史。 */
export async function loadLastMsgId(groupId: string): Promise<string | undefined> {
  return (await loadGroupState(groupId)).watermark
}

/** 持久化某群水位(每条消息处理前推进 → 崩溃至多重丢一条,绝不重复处理)。 */
export async function saveLastMsgId(groupId: string, msgId: string): Promise<void> {
  const state = await loadGroupState(groupId)
  state.watermark = msgId
  await saveGroupState(groupId, state)
}
