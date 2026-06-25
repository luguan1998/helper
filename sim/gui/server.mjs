// sim/gui/server.mjs — 零依赖 Node http 聊天服务 + echo 自动回复。
// 展示走 store 直读(快);客户发消息/上传/echo 回复/echo 轮询都经 CLI 子进程(execFile,忠实测试 sim 的 send/query)。
// /file 路由(仅本机)给浏览器展示与 bot 下载图片。
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { listMessages, parseContent } from '../store.mjs'
import { SIM_DIR, WELINK_SIM_ACCOUNT } from '../config.mjs'

const execFileAsync = promisify(execFile)

const PORT = Number(process.env.PORT ?? 3000)
// CLI 子进程(welink-cli.mjs)从 env 读 SIM_BASE_URL 构造图片信封 URL;未显式设置时对齐本服务端口,
// 否则 PORT 改了信封 URL 仍指向 3000 → bot/浏览器下载图片会失败。
if (!process.env.SIM_BASE_URL) process.env.SIM_BASE_URL = `http://localhost:${PORT}`
const SIM_GROUP_ID = process.env.SIM_GROUP_ID ?? '100001'
const UPLOADS_DIR = join(SIM_DIR, 'uploads')
const WELINK_CLI_SCRIPT = join(SIM_DIR, 'welink-cli.mjs')
const ECHO_INTERVAL_MS = Number(process.env.SIM_ECHO_INTERVAL_MS ?? 2000)

let echoEnabled = (process.env.SIM_ECHO ?? '1') !== '0'
let echoInitialized = false
let lastSeenMaxMsgId = 0

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
}

// ─── 调 sim CLI 子进程(忠实测试 CLI 的 send/query) ─────────────────────────
async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [WELINK_CLI_SCRIPT, 'im', ...args], {
    cwd: SIM_DIR,
    maxBuffer: 10 * 1024 * 1024,
  })
  return JSON.parse(stdout.trim())
}

// ─── echo bot 循环(每 2s:query 找新客户消息 → send 回复) ─────────────────────
async function echoTick() {
  if (!echoEnabled) return
  try {
    const res = await runCli(['query-history-message', '--group-id', SIM_GROUP_ID, '--query-count', '50'])
    if (res.resultCode !== '0') return
    const chatInfo = res.respData?.chatInfo ?? []
    const maxMsgId = res.respData?.maxMsgId ?? 0
    if (!echoInitialized) {
      // 首次:建基线,不回历史
      echoInitialized = true
      lastSeenMaxMsgId = maxMsgId
      return
    }
    const newCustomerMsgs = chatInfo
      .filter(m => m.msgId > lastSeenMaxMsgId && m.sender !== WELINK_SIM_ACCOUNT)
      .sort((a, b) => a.msgId - b.msgId) // old→new,按序回
    for (const m of newCustomerMsgs) {
      if (m.contentType !== 'TEXT_MSG') continue // echo 只回文本
      await runCli(['send-to-group', '--group-id', SIM_GROUP_ID, '--sender', WELINK_SIM_ACCOUNT, '--text', `echo: ${m.content}`])
    }
    lastSeenMaxMsgId = maxMsgId
  } catch (err) {
    console.error('[sim echo] tick failed:', err.message)
  }
}

// ─── HTTP 工具 ───────────────────────────────────────────────────────────────
function sendJson(res, obj, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })
}

// ─── 路由处理器 ───────────────────────────────────────────────────────────────
async function serveIndex(res) {
  const html = await readFile(join(SIM_DIR, 'gui', 'index.html'), 'utf8')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

async function handleApiMessages(res, url) {
  const groupId = url.searchParams.get('groupId') || SIM_GROUP_ID
  const sinceId = Number(url.searchParams.get('sinceId') || 0)
  const msgs = await listMessages(groupId)
  const enriched = msgs
    .filter(m => m.msgId > sinceId) // old→new
    .map(m => ({ ...m, ...parseContent(m.contentType, m.content) }))
  sendJson(res, { messages: enriched })
}

async function handleApiSend(res, body) {
  const gid = body.groupId || SIM_GROUP_ID
  const sender = body.sender || 'user01'
  const r = await runCli(['send-to-group', '--group-id', gid, '--sender', sender, '--text', body.text ?? ''])
  sendJson(res, { ok: r.resultCode === '0', msgId: r.respData?.msgId })
}

async function handleApiUpload(res, body) {
  const gid = body.groupId || SIM_GROUP_ID
  const sender = body.sender || 'user01'
  const name = `${Date.now()}-${body.name || 'upload'}`
  const dest = join(UPLOADS_DIR, name)
  await mkdir(UPLOADS_DIR, { recursive: true })
  await writeFile(dest, Buffer.from(body.data ?? '', 'base64'))
  const flag = body.kind === 'file' ? '--file' : '--image'
  const r = await runCli(['send-to-group', '--group-id', gid, '--sender', sender, flag, dest])
  sendJson(res, { ok: r.resultCode === '0', msgId: r.respData?.msgId, path: dest })
}

async function handleApiConfigGet(res) {
  sendJson(res, { echo: echoEnabled, groupId: SIM_GROUP_ID, botAccount: WELINK_SIM_ACCOUNT })
}

async function handleApiConfigPost(res, body) {
  if (typeof body.echo === 'boolean') {
    echoEnabled = body.echo
    if (echoEnabled && !echoInitialized) {
      // 重新开启时,下次 tick 会建基线(不回历史)
      echoInitialized = false
    }
  }
  sendJson(res, { echo: echoEnabled, groupId: SIM_GROUP_ID, botAccount: WELINK_SIM_ACCOUNT })
}

async function handleFile(req, res, url) {
  // 仅本机(测试工具,勿暴露网络)
  const addr = req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    res.statusCode = 403
    res.end('localhost only')
    return
  }
  const p = url.searchParams.get('path')
  if (!p) { res.statusCode = 400; res.end('missing path'); return }
  try {
    const buf = await readFile(p)
    res.setHeader('Content-Type', MIME[extname(p).toLowerCase()] || 'application/octet-stream')
    res.end(buf)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

// ─── 启动 ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') return await serveIndex(res)
    if (req.method === 'GET' && url.pathname === '/api/messages') return await handleApiMessages(res, url)
    if (req.method === 'GET' && url.pathname === '/api/config') return await handleApiConfigGet(res)
    if (req.method === 'GET' && url.pathname === '/file') return await handleFile(req, res, url)
    if (req.method === 'POST' && url.pathname === '/api/send') return await handleApiSend(res, await readBody(req))
    if (req.method === 'POST' && url.pathname === '/api/upload') return await handleApiUpload(res, await readBody(req))
    if (req.method === 'POST' && url.pathname === '/api/config') return await handleApiConfigPost(res, await readBody(req))
    res.statusCode = 404
    res.end('not found')
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

server.listen(PORT, () => {
  console.log(`[sim gui] http://localhost:${PORT}  (group=${SIM_GROUP_ID}, bot=${WELINK_SIM_ACCOUNT}, echo=${echoEnabled})`)
  console.log(`[sim gui] state: ${join(SIM_DIR, 'state.json')}`)
  console.log('[sim gui] 接入真实 bot 时请关闭 echo(POST /api/config {"echo":false})')
  setInterval(echoTick, ECHO_INTERVAL_MS)
})
