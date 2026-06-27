// sim/run-bot.mjs — 设 sim env 后拉起真实 bot(= 带 sim 配置的 `npm run dev`)。
// 跨平台避 Windows env 设置地狱。前提:已装依赖、claude/openclaude 在 PATH、chromium 可用。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const welinkCli = join(__dirname, 'welink-cli.mjs')

// bot 经 welink-channel.ts 调 sim 的 CLI:execFile(node, [welink-cli.mjs, im, ...])
// 注意:不设 WELINK_SIM_STATE → CLI 默认用 sim/state.json,与 GUI 共享同一份消息。
const env = {
  ...process.env,
  WELINK_CLI_BIN: process.env.WELINK_CLI_BIN ?? process.execPath, // node 二进制
  WELINK_CLI_SCRIPT: process.env.WELINK_CLI_SCRIPT ?? welinkCli,  // sim CLI 脚本
  WELINK_GROUP_IDS: process.env.WELINK_GROUP_IDS ?? process.env.WELINK_GROUP_ID ?? '100001',
  WELINK_ACCOUNT: process.env.WELINK_ACCOUNT ?? 'bot01',
  // 图片信封 URL 前缀,须指向 sim:gui 的地址(默认本机 3000);GUI 改端口时同步改此。
  SIM_BASE_URL: process.env.SIM_BASE_URL ?? 'http://localhost:3000',
}

console.log('[sim run-bot] 启动真实 bot,channel=welink(sim)')
console.log(`  WELINK_CLI_BIN=${env.WELINK_CLI_BIN}`)
console.log(`  WELINK_CLI_SCRIPT=${env.WELINK_CLI_SCRIPT}`)
console.log(`  WELINK_GROUP_IDS=${env.WELINK_GROUP_IDS}  WELINK_ACCOUNT=${env.WELINK_ACCOUNT}`)
console.log('  先确保 sim:gui 已启动(echo 关),否则 bot 无状态文件可读')

// 直接用 node 跑 tsx 的 CLI(避开 Windows npm 是 .cmd 需 shell 的问题 + DEP0190 警告)。
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const child = spawn(process.execPath, [tsxCli, join(projectRoot, 'src', 'index.ts')], {
  cwd: projectRoot, env, stdio: 'inherit',
})
child.on('exit', code => process.exit(code ?? 0))
