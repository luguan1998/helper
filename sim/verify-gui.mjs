// sim/verify-gui.mjs — 验证运行中的 sim:gui 服务是否完整匹配 doc/trueapi.md 的
// im query-history-message 通用响应结构(§1 信封 + §2 respData/chatInfo + §2.4 content 信封)。
//
// 与 selftest.mjs 互补:selftest 测 CLI 隔离(独立 state);本脚本测"运行中的 GUI 服务"——
// 经其 HTTP send/upload API 写入消息(服务内部走 CLI 子进程)→ 经服务 echo 轮询所用的同一 CLI
// 路径查询 → 断言完整 trueapi 结构;外加 echo 行为回环(证明服务确经 CLI 消费该结构)+
// /api/messages 展示 API 保留 chatInfo 全原始字段。
//
// 用 tmp state + 随机空闲端口,不污染 sim/state.json。运行:node sim/verify-gui.mjs
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER = join(__dirname, 'gui', 'server.mjs')
const CLI = join(__dirname, 'welink-cli.mjs')
const UPLOADS = join(__dirname, 'uploads')
const MARK = '__verifygui__' // 上传文件名标记,便于测后清理
const STATE = join(tmpdir(), `welink-sim-verify-gui-${process.pid}.json`)
const tmp = join(tmpdir(), `welink-sim-verify-gui-${process.pid}`)
const G = '100001'
const BOT = 'bot01'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 找一个空闲端口(listen 0 → 读取 → close)。极小竞争窗口可接受。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

let PORT = 0
let BASE = ''
let env = {}
let serverProc = null
let failures = 0

function assert(cond, msg) {
  if (cond) console.log('  \x1b[32m✓\x1b[0m', msg)
  else { console.error('  \x1b[31m✗\x1b[0m', msg); failures++ }
}

async function http(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const res = await fetch(url, opts)
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

/** 调 sim CLI(与 GUI 服务 echo 轮询所走的是同一脚本 + 同一 state + 同一 env)。 */
async function cli(...args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'im', ...args], { env, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.trim())
}

async function sendText(sender, text) {
  return http('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender, text }) })
}
async function upload(sender, name, dataB64, kind) {
  return http('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender, name, data: dataB64, kind }) })
}

async function waitReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await http('/api/config'); if (r.status === 200) return } catch { /* 待启 */ }
    await sleep(100)
  }
  throw new Error(`server not ready on port ${PORT}`)
}

/** 清理本脚本在 sim/uploads 留下的上传文件(GUI 的 /api/upload 写死 uploads 目录,无 env 覆盖)。 */
async function cleanUploads() {
  try {
    for (const f of await readdir(UPLOADS)) {
      if (f.includes(MARK)) await rm(join(UPLOADS, f), { force: true })
    }
  } catch { /* 目录不存在,忽略 */ }
}

async function cleanup() {
  if (serverProc) { try { serverProc.kill() } catch { /* noop */ } ; serverProc = null }
  await cleanUploads()
  await rm(STATE, { force: true })
  await rm(tmp, { recursive: true, force: true })
}

async function main() {
  await rm(STATE, { force: true })
  await mkdir(tmp, { recursive: true })

  PORT = await freePort()
  BASE = `http://localhost:${PORT}`
  env = {
    ...process.env,
    WELINK_SIM_STATE: STATE,
    PORT: String(PORT),
    SIM_BASE_URL: BASE,      // 信封 URL 指向本测试端口
    SIM_GROUP_ID: G,
    WELINK_SIM_ACCOUNT: BOT,
    SIM_ECHO: '0',           // 先关 echo,由脚本控制(避免回历史/干扰结构断言)
    SIM_ECHO_INTERVAL_MS: '300', // 加快 echo 回环
  }

  serverProc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  serverProc.stdout.on('data', d => process.stderr.write(`[server] ${d}`))
  serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  try {
    await waitReady()
    console.log(`# sim:gui 已起:${BASE} (state=${STATE})\n`)

    console.log('# 1. 空群 query-history-message 通用响应结构(§1 信封 + §2.1 respData)')
    let r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
    assert(r.resultCode === '0', 'resultCode="0"')
    assert(r.resultContext === 'Operate Success', 'resultContext="Operate Success"')
    assert(r.sno === null, 'sno=null')
    assert(Array.isArray(r.respData?.chatInfo) && r.respData.chatInfo.length === 0, 'respData.chatInfo 为空数组')
    assert(r.respData?.maxMsgId === 0 && r.respData?.minMsgId === 0, '空群 maxMsgId=minMsgId=0')
    assert(r.respData?.msgTotalCount === 0, 'msgTotalCount=0')

    console.log('# 2. 经 GUI /api/send 写文本 → CLI 查询 TEXT_MSG(§2.2 全字段)')
    let s = await sendText('user01', 'Hello')
    assert(s.json?.ok === true, '/api/send ok=true')
    assert(typeof s.json?.msgId === 'number', '/api/send 返回 msgId(number)')
    r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
    const m0 = r.respData.chatInfo[0]
    assert(m0.contentType === 'TEXT_MSG', 'contentType=TEXT_MSG')
    assert(m0.content === 'Hello', 'content="Hello"')
    assert(m0.sender === 'user01', 'sender="user01"')
    assert(typeof m0.msgId === 'number' && m0.msgId > 0, 'msgId number >0')
    assert(typeof m0.groupId === 'number' && m0.groupId === Number(G), 'groupId number =100001')
    assert(m0.groupType === 0, 'groupType=0')
    assert(typeof m0.serverSendTime === 'number' && m0.serverSendTime > 0, 'serverSendTime 为 ms 时间戳')
    assert(m0.at === false, 'at=false')
    assert(Array.isArray(m0.atAccountList) && m0.atAccountList.length === 0, 'atAccountList=[]')
    assert(m0.receiver === '', 'receiver=""')
    // 字段集合精确对齐 §2.2 的十字段(无多余、无缺失)
    const expectedKeys = ['msgId', 'contentType', 'content', 'sender', 'groupId', 'groupType', 'serverSendTime', 'at', 'atAccountList', 'receiver']
    assert(JSON.stringify(Object.keys(m0).sort()) === JSON.stringify([...expectedKeys].sort()), 'chatInfo 元素字段集合 = §2.2 十字段(无多余/缺失)')
    assert(r.respData.maxMsgId === m0.msgId && r.respData.minMsgId === m0.msgId, 'maxMsgId=minMsgId=msgId')
    assert(r.respData.msgTotalCount === 1, 'msgTotalCount=1')

    console.log('# 3. 经 GUI /api/upload 上传图片 → CLI 查询 IMAGESPAN_MSG(§2.4 信封)')
    const pngHex = '89504e470d0a1a0a0000000049454e44ae426082' // 最小 PNG
    let u = await upload('user01', `${MARK}img.png`, Buffer.from(pngHex, 'hex').toString('base64'), 'image')
    assert(u.json?.ok === true, '/api/upload(image) ok=true')
    r = await cli('query-history-message', '--group-id', G, '--query-count', '1')
    const mi = r.respData.chatInfo[0]
    assert(mi.contentType === 'IMAGESPAN_MSG', 'contentType=IMAGESPAN_MSG')
    assert(mi.content.startsWith('/:um_begin{') && mi.content.includes('/:um_end'), 'content 为 /:um_begin{...}/:um_end 信封')
    assert(mi.content.includes('|Img|'), '信封含 |Img| 标识(§2.4 段1)')
    assert(mi.content.includes(';md5:'), '信封含 ;md5: 元数据')
    assert(mi.content.includes(`${BASE}/file?path=`), `信封 URL 指向 ${BASE}/file 路由`)

    console.log('# 4. 经 GUI /api/upload 上传文件 → CLI 查询 FILE_MSG(§2.4 信封)')
    u = await upload('user01', `${MARK}file.txt`, Buffer.from('hello file').toString('base64'), 'file')
    assert(u.json?.ok === true, '/api/upload(file) ok=true')
    r = await cli('query-history-message', '--group-id', G, '--query-count', '1')
    const mf = r.respData.chatInfo[0]
    assert(mf.contentType === 'FILE_MSG', 'contentType=FILE_MSG')
    assert(mf.content.includes('|File|'), '信封含 |File| 标识(§2.4 段1)')

    console.log('# 5. chatInfo 顺序 new→old(§2.1 倒序)')
    r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
    const order = r.respData.chatInfo.map(m => m.msgId)
    assert(order.length === 3, `共 3 条(got ${order.length})`)
    assert(order[0] > order[1] && order[1] > order[2], `new→old 严格递减(got ${order.join(',')})`)

    console.log('# 6. 分页 --message-id --query-direction(sim 解释:0=更旧 msgId<ID,1=更新 >ID)')
    const newest = order[0], oldest = order[2]
    r = await cli('query-history-message', '--group-id', G, '--query-count', '20', '--message-id', String(newest), '--query-direction', '0')
    const d0 = r.respData.chatInfo.map(m => m.msgId).sort((a, b) => a - b)
    assert(d0.length === 2 && d0.every(id => id < newest), `direction 0 from ${newest} → 全更旧(got ${d0.join(',')})`)
    r = await cli('query-history-message', '--group-id', G, '--query-count', '20', '--message-id', String(oldest), '--query-direction', '1')
    const d1 = r.respData.chatInfo.map(m => m.msgId).sort((a, b) => a - b)
    assert(d1.length === 2 && d1.every(id => id > oldest), `direction 1 from ${oldest} → 全更新(got ${d1.join(',')})`)

    console.log('# 7. echo 行为回环:证明 GUI 服务经 CLI 消费 query-history-message 结构')
    await http('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ echo: true }) })
    await sleep(800) // 等一个 echo tick 建基线(不回历史)
    await sendText('user01', 'ping')
    let echoFound = false
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await sleep(300)
      const mm = await http('/api/messages?sinceId=0')
      const found = (mm.json?.messages || []).some(m => m.sender === BOT && m.caption === 'echo: ping')
      if (found) { echoFound = true; break }
    }
    assert(echoFound, 'echo bot 回复 "echo: ping"(服务经 CLI query→send 回环消费结构)')
    await http('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ echo: false }) })

    console.log('# 8. GUI 展示 API /api/messages 保留 chatInfo 全原始字段(§2.2)')
    const mm = await http('/api/messages?sinceId=0')
    const msgs = mm.json?.messages || []
    assert(msgs.length >= 3, `/api/messages 返回 ≥3 条(共 ${msgs.length})`)
    const t = msgs.find(m => m.contentType === 'TEXT_MSG' && m.content === 'Hello')
    assert(!!t && expectedKeys.every(k => k in t), '/api/messages 文本消息保留 §2.2 全原始字段(经 ...m 展开)')
    assert(!!t && t.kind === 'text', '/api/messages 额外附 GUI 友好字段 kind=text(展示用,非 trueapi)')

  } finally {
    await cleanup()
  }

  if (failures === 0) { console.log('\n\x1b[32m✅ sim:gui 完整匹配 trueapi query-history-message 通用响应结构\x1b[0m'); process.exit(0) }
  console.error(`\n\x1b[31m❌ ${failures} 项失败\x1b[0m`)
  process.exit(1)
}

main().catch(async err => {
  console.error('verify-gui 异常:', err)
  await cleanup()
  process.exit(1)
})
