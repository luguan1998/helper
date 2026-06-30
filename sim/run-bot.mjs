// sim/run-bot.mjs — 设 sim env 后拉起真实 bot(= 带 sim 配置的 `npm run dev`)。
// 跨平台避 Windows env 设置地狱。前提:已装依赖、claude/openclaude 在 PATH、chromium 可用。
//
// 行为开关默认值与 start.ps1 的 CONFIG 块保持一致(groups/account/think/query/poll/debug),
// 使 sim 测试尽量复刻生产行为;任一均可用同名 env 覆盖。
// sim 专有(真实 welink 不需):WELINK_CLI_BIN/WELINK_CLI_SCRIPT(指向 sim 的 welink-cli.mjs)、SIM_BASE_URL(图片信封 URL 前缀)。
// 注:sim GUI 只展示单个群(SIM_GROUP_ID,默认 100001);100002 仍被轮询但不在 GUI 显示,
//     要看 100002 的消息/回复用 CLI(`send-to-group --group-id 100002 ...`)。
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

  // --- sim 适配器接缝(真实 welink 不需要这两项) ---
  WELINK_CLI_BIN: process.env.WELINK_CLI_BIN ?? process.execPath, // node 二进制
  WELINK_CLI_SCRIPT: process.env.WELINK_CLI_SCRIPT ?? welinkCli,  // sim CLI 脚本
  // 图片信封 URL 前缀,须指向 sim:gui 的地址(默认本机 3000);GUI 改端口时同步改此。
  SIM_BASE_URL: process.env.SIM_BASE_URL ?? 'http://localhost:3000',

  // --- 与 start.ps1 CONFIG 一致的行为开关(默认值同 start.ps1;env 覆盖优先) ---
  WELINK_GROUP_IDS: process.env.WELINK_GROUP_IDS ?? process.env.WELINK_GROUP_ID ?? '100001,100002',
  WELINK_ACCOUNT: process.env.WELINK_ACCOUNT ?? 'bot01',
  BOT_INCLUDE_THINKING: process.env.BOT_INCLUDE_THINKING ?? '1',
  WELINK_QUERY_COUNT: process.env.WELINK_QUERY_COUNT ?? '5',
  BOT_POLL_INTERVAL_MS: process.env.BOT_POLL_INTERVAL_MS ?? '2000',
  BOT_DEBUG: process.env.BOT_DEBUG ?? '1',
  // BOT_ADD_DIR / BOT_ALLOWED_USERS:空=不加目录(cwd)/全接受(同 start.ps1 默认);
  // 显式设 env 才生效,经 ...process.env 透传,此处不设默认。
  // BOT_ADD_DIR 直接作 Claude 的 cwd(vibe-ide 风格,不用 --add-dir;见 claude-client.ts)。
}

// 解析 add-dir(同 claude-client.ts parseAddDir:取首项、trim;BOT_ADD_DIR 优先,回退旧 BOT_ADD_DIRS 首项)。
function parseAddDir(v) {
  if (!v) return undefined
  const first = v.split(',')[0]?.trim()
  return first || undefined
}
const addDir = parseAddDir(process.env.BOT_ADD_DIR) ?? parseAddDir(process.env.BOT_ADD_DIRS)
const allowedUsers = process.env.BOT_ALLOWED_USERS

console.log('[sim run-bot] 启动真实 bot,channel=welink(sim)')
console.log(`  WELINK_CLI_BIN=${env.WELINK_CLI_BIN}`)
console.log(`  WELINK_CLI_SCRIPT=${env.WELINK_CLI_SCRIPT}`)
console.log(`  account=${env.WELINK_ACCOUNT} groups=${env.WELINK_GROUP_IDS} think=${env.BOT_INCLUDE_THINKING} query=${env.WELINK_QUERY_COUNT} poll=${env.BOT_POLL_INTERVAL_MS}ms debug=${env.BOT_DEBUG}`)
if (addDir) console.log(`  add-dir(cwd)=${addDir}`)
if (allowedUsers) console.log(`  allowed-users=${allowedUsers}`)
console.log('  先确保 sim:gui 已启动(echo 关),否则 bot 无状态文件可读')
console.log('  注:GUI 只显示 100001;100002 用 CLI send-to-group --group-id 100002 查看')

// 直接用 node 跑 tsx 的 CLI(避开 Windows npm 是 .cmd 需 shell 的问题 + DEP0190 警告)。
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const child = spawn(process.execPath, [tsxCli, join(projectRoot, 'src', 'index.ts')], {
  cwd: projectRoot, env, stdio: 'inherit',
})
child.on('exit', code => process.exit(code ?? 0))
