// sim/store.mjs — 消息 store:共享状态文件 + 锁 + 原子写 + 信封构造/解析。零依赖。
// 被 welink-cli.mjs(CLI 子进程,每次调用一个进程)与 gui/server.mjs(in-process)共用。
// 真实 bot 也经 CLI 子进程写同一文件 → 多写者,故有锁(区别于生产 src/state.ts 的单写者无锁)。
import { open, rename, unlink, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, basename } from 'node:path'
import {
  WELINK_SIM_STATE, WELINK_SIM_ACCOUNT, SIM_MSG_ID_BASE, SIM_BASE_URL,
  SIM_LOCK_STALE_MS, SIM_LOCK_RETRY_MS, SIM_LOCK_MAX_RETRIES,
} from './config.mjs'

const STATE_FILE = WELINK_SIM_STATE
const LOCK_FILE = `${STATE_FILE}.lock`
const STATE_DIR = dirname(STATE_FILE)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ─── 锁(多写者) ──────────────────────────────────────────────────────────
// 用 O_EXCL('wx')独占创建锁文件;EEXIST 则判断是否 stale(>5s 视为持锁进程已死,删除重试)。
async function tryAcquireLock() {
  try {
    const fh = await open(LOCK_FILE, 'wx')
    return async () => { try { await fh.close() } catch { /* noop */ } try { await unlink(LOCK_FILE) } catch { /* noop */ } }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return null
  }
}

async function isLockStale() {
  try {
    const s = await stat(LOCK_FILE)
    return Date.now() - s.mtimeMs > SIM_LOCK_STALE_MS
  } catch {
    return false
  }
}

/** 临界区:fn 在持锁期间执行(整个读-改-写)。返回 fn 的返回值。 */
export async function withLock(fn) {
  await mkdir(STATE_DIR, { recursive: true }) // 保证锁文件目录存在
  for (let i = 0; i < SIM_LOCK_MAX_RETRIES; i++) {
    const release = await tryAcquireLock()
    if (release) {
      try {
        return await fn()
      } finally {
        await release()
      }
    }
    if (await isLockStale()) {
      try { await unlink(LOCK_FILE) } catch { /* noop */ }
      continue // stale,立即重试
    }
    await sleep(SIM_LOCK_RETRY_MS + Math.floor(Math.random() * 20)) // jitter 避免惊群
  }
  throw new Error(`sim store: lock busy after ${SIM_LOCK_MAX_RETRIES} retries (${LOCK_FILE})`)
}

// ─── 状态 I/O(原子) ────────────────────────────────────────────────────────
/** 读状态。文件缺失/损坏 → 静默恢复为空(同 src/state.ts 的容错范式)。 */
export async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const s = JSON.parse(raw)
    if (s && typeof s === 'object' && s.groups) return s
    return { groups: {} }
  } catch (err) {
    if (err.code === 'ENOENT') return { groups: {} }
    return { groups: {} } // 损坏 → 静默恢复
  }
}

/** 原子写:同目录 pid 后缀 tmp + rename(Windows rename 覆盖 = MoveFileEx REPLACE_EXISTING)。 */
export async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, STATE_FILE)
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────
function ensureGroup(state, groupId) {
  const key = String(groupId)
  if (!state.groups[key]) state.groups[key] = { messages: [], nextMsgId: SIM_MSG_ID_BASE }
  return state.groups[key]
}

/** 输出 groupId 为 number(安全整数时),否则 string(真实 welink groupId ~1e17 超 safe int)。 */
function toGroupIdValue(groupId) {
  const n = Number(groupId)
  if (String(groupId) === String(n) && Number.isSafeInteger(n)) return n
  return String(groupId)
}

// ─── 消息操作 ────────────────────────────────────────────────────────────────
/** 追加一条消息(持锁:load→assign msgId→push→save)。返回新消息(含分配的 msgId)。 */
export async function addMessage({ groupId, sender, contentType, content }) {
  return withLock(async () => {
    const state = await loadState()
    const group = ensureGroup(state, groupId)
    const msgId = group.nextMsgId++
    // 模拟真实 welink:文本里 @<bot 账号> → at=true + atAccountList(供 core 生命周期激活 "@开启")。
    const mentioned =
      contentType === 'TEXT_MSG' && typeof content === 'string' && content.includes(`@${WELINK_SIM_ACCOUNT}`)
    const msg = {
      msgId,
      contentType,
      content,
      sender: sender ?? WELINK_SIM_ACCOUNT,
      groupId: toGroupIdValue(groupId),
      groupType: 0,
      serverSendTime: Date.now(),
      at: mentioned,
      atAccountList: mentioned ? [WELINK_SIM_ACCOUNT] : [],
      receiver: '',
    }
    group.messages.push(msg)
    await saveState(state)
    return msg
  })
}

/**
 * 查询历史(只读,无需锁——rename 原子写保证读到的是一致的整文件)。
 * 默认返回最新 N 条(new→old);带 messageId:queryDirection 0=更旧(msgId<ID)、1=更新(>ID)。
 * 返回 { chatInfo, maxMsgId, minMsgId, msgTotalCount }(对齐 trueapi.md)。
 */
export async function queryHistory({ groupId, queryCount, messageId, queryDirection }) {
  const state = await loadState()
  const group = state.groups[String(groupId)]
  const all = group ? group.messages : []
  let pool = all
  if (messageId !== undefined && messageId !== null && messageId !== '') {
    const id = Number(messageId)
    if (Number.isFinite(id)) {
      // queryDirection 来自 argv 是字符串;强制数值比较(1=更新 msgId>ID,其它=更旧 msgId<ID)。
      const newer = Number(queryDirection) === 1
      pool = all.filter(m => (newer ? m.msgId > id : m.msgId < id))
    }
  }
  const newToOld = pool.slice().reverse() // new→old
  const want = Number(queryCount)
  const slice = Number.isFinite(want) && want > 0 ? newToOld.slice(0, want) : newToOld
  return {
    chatInfo: slice,
    maxMsgId: slice.length ? slice[0].msgId : 0,
    minMsgId: slice.length ? slice[slice.length - 1].msgId : 0,
    msgTotalCount: slice.length,
  }
}

/** 列出群组全部消息(old→new)。GUI 展示用(in-process,快)。非 trueapi 操作。 */
export async function listMessages(groupId) {
  const state = await loadState()
  const group = state.groups[String(groupId)]
  return group ? group.messages.slice() : []
}

// ─── 信封构造/解析(对齐 trueapi.md §2.4) ──────────────────────────────────
/** 构造 IMAGESPAN_MSG 的 content 信封。md5 用 node:crypto 算真 hash;dim 0;0(sim 不解析尺寸)。 */
export async function buildImageEnvelope(localPath) {
  const buf = await readFile(localPath)
  const size = buf.length
  const fileName = basename(localPath)
  const md5 = createHash('md5').update(buf).digest('hex')
  const url = `${SIM_BASE_URL}/file?path=${encodeURIComponent(localPath)}`
  const meta = `isOriginalImg: 0;md5:${md5};isCrossInstance:0;emotionId:;objectId:;cdnUrl:`
  return `/:um_begin{${url}|Img|${size}|${fileName}|0;0|${meta}}/:um_end`
}

/** 构造 FILE_MSG 的 content 信封(第 4 段 0,标识 File)。 */
export async function buildFileEnvelope(localPath) {
  const buf = await readFile(localPath)
  const size = buf.length
  const fileName = basename(localPath)
  const md5 = createHash('md5').update(buf).digest('hex')
  const url = `${SIM_BASE_URL}/file?path=${encodeURIComponent(localPath)}`
  const meta = `isOriginalImg: 0;md5:${md5};isCrossInstance:0;emotionId:;objectId:;cdnUrl:`
  return `/:um_begin{${url}|File|${size}|${fileName}|0|${meta}}/:um_end`
}

/**
 * 解析 content 为 GUI 友好结构。
 * 返回 { kind:'text'|'image'|'file'|'card', caption?, imageUrl?, fileUrl?, fileName?, card? }。
 * 信封用 indexOf('/:um_begin{') / indexOf('/:um_end') 切分;URL/fileName 已 encodeURIComponent,
 * 不会含裸 |,故按 | 分段安全。
 */
export function parseContent(contentType, content) {
  if (contentType === 'TEXT_MSG') return { kind: 'text', caption: content }
  if (contentType === 'CARD_MSG') {
    let card = null
    try { card = JSON.parse(content) } catch { /* 非 JSON */ }
    const replyText = card?.cardContext?.replyMsg?.content ?? ''
    return { kind: 'card', card, caption: replyText }
  }
  const beginTag = '/:um_begin{'
  const endTag = '/:um_end'
  const bi = content.indexOf(beginTag)
  const ei = bi === -1 ? -1 : content.indexOf(endTag, bi + beginTag.length)
  if (bi === -1 || ei === -1) return { kind: 'text', caption: content } // 兜底
  const inner = content.slice(bi + beginTag.length, ei)
  const caption = content.slice(ei + endTag.length)
  const segments = inner.split('|')
  const url = segments[0] ?? ''
  const fileName = segments[3] ?? ''
  if (contentType === 'IMAGESPAN_MSG') return { kind: 'image', imageUrl: url, fileName, caption }
  if (contentType === 'FILE_MSG') return { kind: 'file', fileUrl: url, fileName, caption }
  return { kind: 'text', caption: content }
}
