// sim/selftest.mjs — 跑 sim CLI 并断言 stdout JSON 契合 doc/trueapi.md。
// 用独立 state 文件(在系统 tmpdir),不污染 GUI 的 sim/state.json。运行:`node sim/selftest.mjs`
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, 'welink-cli.mjs')
const STATE = join(tmpdir(), 'welink-sim-selftest-state.json')
const env = { ...process.env, WELINK_SIM_STATE: STATE }

async function cli(...args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, 'im', ...args], { env, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.trim())
}

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('  [32m✓[0m', msg)
  else { console.error('  [31m✗[0m', msg); failures++ }
}

async function main() {
  await rm(STATE, { force: true })
  const G = '100001'
  const tmp = join(tmpdir(), 'welink-sim-selftest')
  await mkdir(tmp, { recursive: true })

  console.log('# 1. 空群 query-history-message')
  let r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
  assert(r.resultCode === '0', 'resultCode="0"')
  assert(r.resultContext === 'Operate Success', 'resultContext="Operate Success"')
  assert(Array.isArray(r.respData.chatInfo) && r.respData.chatInfo.length === 0, 'respData.chatInfo 为空数组')
  assert(r.respData.msgTotalCount === 0, 'respData.msgTotalCount=0')
  assert(r.sno === null, 'sno=null')

  console.log('# 2. send-to-group --text')
  r = await cli('send-to-group', '--group-id', G, '--sender', 'user01', '--text', 'Hello')
  assert(r.resultCode === '0', 'resultCode="0"')
  assert(r.respData.msgId === 1000, `respData.msgId=1000 (got ${r.respData?.msgId})`)

  console.log('# 3. query 含 TEXT_MSG(字段对齐 trueapi §2.2)')
  r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
  const m0 = r.respData.chatInfo[0]
  assert(m0.contentType === 'TEXT_MSG', 'contentType=TEXT_MSG')
  assert(m0.content === 'Hello', 'content="Hello"')
  assert(m0.sender === 'user01', 'sender="user01"')
  assert(m0.msgId === 1000, 'msgId=1000')
  assert(typeof m0.serverSendTime === 'number' && m0.serverSendTime > 0, 'serverSendTime 为 ms 时间戳')
  assert(m0.at === false && Array.isArray(m0.atAccountList) && m0.atAccountList.length === 0, 'at=false, atAccountList=[]')
  assert(m0.receiver === '' && m0.groupType === 0, 'receiver="", groupType=0')
  assert(r.respData.maxMsgId === 1000 && r.respData.minMsgId === 1000, 'maxMsgId=minMsgId=1000')
  assert(r.respData.msgTotalCount === 1, 'msgTotalCount=1')

  console.log('# 4. send-to-group --image(构造 IMAGESPAN_MSG 信封,trueapi §2.4)')
  const imgPath = join(tmp, 'selftest.png')
  await writeFile(imgPath, Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')) // 最小 PNG
  r = await cli('send-to-group', '--group-id', G, '--sender', 'user01', '--image', imgPath)
  assert(r.resultCode === '0' && r.respData.msgId === 1001, `image send msgId=1001 (got ${r.respData?.msgId})`)
  r = await cli('query-history-message', '--group-id', G, '--query-count', '1')
  const mi = r.respData.chatInfo[0]
  assert(mi.contentType === 'IMAGESPAN_MSG', 'contentType=IMAGESPAN_MSG')
  assert(mi.content.startsWith('/:um_begin{') && mi.content.includes('/:um_end'), 'content 为 /:um_begin{...}/:um_end 信封')
  assert(mi.content.includes('|Img|'), '信封含 |Img| 标识')
  assert(mi.content.includes(';md5:'), '信封含 ;md5: 元数据')
  assert(mi.content.includes('http://localhost:3000/file?path='), '信封 URL 指向 /file 路由')

  console.log('# 5. send-to-group --file(构造 FILE_MSG 信封)')
  const filePath = join(tmp, 'selftest.txt')
  await writeFile(filePath, 'hello file')
  r = await cli('send-to-group', '--group-id', G, '--sender', 'user01', '--file', filePath)
  assert(r.resultCode === '0' && r.respData.msgId === 1002, `file send msgId=1002 (got ${r.respData?.msgId})`)
  r = await cli('query-history-message', '--group-id', G, '--query-count', '1')
  const mf = r.respData.chatInfo[0]
  assert(mf.contentType === 'FILE_MSG', 'contentType=FILE_MSG')
  assert(mf.content.includes('|File|'), '信封含 |File| 标识')

  console.log('# 6. 分页 --message-id --query-direction(sim 解释:0=更旧,1=更新)')
  // 消息:1000(text) 1001(img) 1002(file)
  r = await cli('query-history-message', '--group-id', G, '--query-count', '20', '--message-id', '1002', '--query-direction', '0')
  let ids = r.respData.chatInfo.map(m => m.msgId).sort((a, b) => a - b)
  assert(ids.join(',') === '1000,1001', `direction 0 (from 1002) 返回 1000,1001 (got ${ids.join(',')})`)
  r = await cli('query-history-message', '--group-id', G, '--query-count', '20', '--message-id', '1000', '--query-direction', '1')
  ids = r.respData.chatInfo.map(m => m.msgId).sort((a, b) => a - b)
  assert(ids.join(',') === '1001,1002', `direction 1 (from 1000) 返回 1001,1002 (got ${ids.join(',')})`)

  console.log('# 7. chatInfo 顺序 new→old')
  r = await cli('query-history-message', '--group-id', G, '--query-count', '20')
  const order = r.respData.chatInfo.map(m => m.msgId)
  assert(order.join(',') === '1002,1001,1000', `chatInfo 为 new→old (got ${order.join(',')})`)

  await rm(STATE, { force: true })
  await rm(tmp, { recursive: true, force: true })

  if (failures === 0) { console.log('\n[32m✅ 全部通过[0m'); process.exit(0) }
  console.error(`\n[31m❌ ${failures} 项失败[0m`)
  process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
