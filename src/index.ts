// 入口 / 组合根:零配置 `runAssistant()` 接真实 link CLI + Claude + Puppeteer。
// 默认适配器在 assistant.ts 内懒加载,这里只负责启动与优雅退出。
import { runAssistant } from './assistant.js'

async function main(): Promise<void> {
  console.log('[bot] 启动客服助手(零配置:link CLI + Claude + 截图)...')
  const handle = await runAssistant()

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
