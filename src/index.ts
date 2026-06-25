// 入口 / 组合根:零配置 `runAssistant()` 接真实 welink-cli im 群 + Claude + Puppeteer。
// 默认适配器在 assistant.ts 内懒加载,这里只负责启动与优雅退出。
import { runAssistant } from './assistant.js'

async function main(): Promise<void> {
  const groupId = process.env.WELINK_GROUP_ID
  if (!groupId) {
    console.error('[bot] 缺少环境变量 WELINK_GROUP_ID(要监控的群 ID)')
    process.exit(1)
  }
  console.log(`[bot] 启动客服助手(welink-cli im 群 ${groupId} + Claude + 截图 + 持久化水位/只触发一次)...`)
  const handle = await runAssistant({ groupId })

  let stopping = false
  const shutdown = (sig: string): void => {
    if (stopping) return
    stopping = true
    console.log(`\n[bot] 收到 ${sig},正在停止...`)
    handle.stop()
    // 给后台循环一个让出窗口后退出
    setTimeout(() => process.exit(0), 200)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[bot] 启动失败:', err)
  process.exit(1)
})
