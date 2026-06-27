// 入口 / 组合根:零配置 `runAssistant()` 接真实 welink-cli im 群 + Claude + Puppeteer。
// 支持多群:WELINK_GROUP_IDS(逗号分隔)→ 每群一个 Assistant 实例,各自独立 loop/会话/水位,共享优雅退出。
// 默认适配器在 assistant.ts 内懒加载,这里只负责启动与优雅退出。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAssistant, type AssistantHandle } from './assistant.js'

async function main(): Promise<void> {
  const idsRaw = process.env.WELINK_GROUP_IDS ?? process.env.WELINK_GROUP_ID
  if (!idsRaw) {
    console.error('[bot] 缺少环境变量 WELINK_GROUP_IDS(逗号分隔的群 ID 列表)或 WELINK_GROUP_ID')
    process.exit(1)
  }
  const groupIds = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
  if (groupIds.length === 0) {
    console.error('[bot] 群 ID 列表为空')
    process.exit(1)
  }

  // 旧版单文件 state.json 已被每群独立文件取代(无法按群归属迁移 sessionIds);若仍存在,提示一次。
  const stateDir = process.env.BOT_STATE_DIR ?? join(homedir(), '.claude-bot')
  if (existsSync(join(stateDir, 'state.json'))) {
    console.warn(`[bot] 检测到旧版 ${join(stateDir, 'state.json')}:已改用每群独立文件 state-<groupId>.json,旧文件不再读取(可手动备份后删除)。`)
  }

  console.log(`[bot] 启动 ${groupIds.length} 个客服助手(群 ${groupIds.join(', ')};welink-cli im + Claude + 截图 + 持久化水位/只触发一次)...`)
  const pollIntervalMs = process.env.BOT_POLL_INTERVAL_MS ? Number(process.env.BOT_POLL_INTERVAL_MS) : undefined
  const handles: AssistantHandle[] = []
  for (const gid of groupIds) {
    try {
      const h = await runAssistant({ groupId: gid, pollIntervalMs })
      handles.push(h)
      console.log(`[bot] 群 ${gid} 已启动`)
    } catch (err) {
      console.error(`[bot] 群 ${gid} 启动失败:`, err instanceof Error ? err.message : err)
      // 继续启动其他群;若无任何 handle 成功则最后退出
    }
  }
  if (handles.length === 0) {
    console.error('[bot] 没有任何群成功启动,退出')
    process.exit(1)
  }

  let stopping = false
  const shutdown = (sig: string): void => {
    if (stopping) return
    stopping = true
    console.log(`\n[bot] 收到 ${sig},正在停止 ${handles.length} 个助手...`)
    for (const h of handles) h.stop()
    // 给后台循环一个让出窗口后退出(在途 tick 自然结束或被 kill 触发 reject)
    setTimeout(() => process.exit(0), 500)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[bot] 启动失败:', err)
  process.exit(1)
})
