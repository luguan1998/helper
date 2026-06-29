// 生产适配器:WelinkChannel —— welink-cli im 群的真-外部耦合点(对齐 doc/trueapi.md)。
// 真实 welink-cli 输出格式有变时,只需改此文件(locality 来自接缝)。
// 群组导向:构造时绑定 groupId,所有 send 固定发到该群;sendText/sendPicture 的 userId
// 形参仅为兼容端口签名(群模型下被忽略——回复一律发到构造时的群),核心仍传 sender 以备日志/回调。
// 用 execFileCmd(cross-spawn)调 welink-cli:Windows .cmd/.bat 自动解析底层 .exe/node、无 shell →
// 既解决 PATH 不搜的 ENOENT,又彻底避免 cmd 按空格/换行截断 --text、`"` 断引号、`%` 展开环境变量。
import { execFileCmd } from '../win-spawn.js'
import type { Channel } from './channel.js'
import type { IncomingMessage } from '../types.js'

const DEFAULT_BINARY = process.env.WELINK_CLI_BIN ?? 'welink-cli'
/** 可选:设则前缀到 args(供 `node <script>` 跑 sim;真实 welink 不需要)。 */
const DEFAULT_SCRIPT = process.env.WELINK_CLI_SCRIPT ?? ''
/** bot 自身账号(回环过滤的次要手段:按 sender 排除自身消息;需与 sim 的 WELINK_SIM_ACCOUNT 一致)。
 *  主要回环过滤按 sentIds(本通道 CLI 发出消息的 msgId),不依赖此账号匹配。真实 welink 未设时回落 'bot01',
 *  sender 过滤失效但 sentIds 仍生效(前提:send-to-group 响应含 msgId)。 */
const DEFAULT_ACCOUNT = process.env.WELINK_ACCOUNT ?? 'bot01'
const DEFAULT_QUERY_COUNT = Number(process.env.WELINK_QUERY_COUNT ?? 20)

/** welink-cli 信封:所有命令的 stdout 均为此结构(resultCode "0"=成功)。 */
interface Envelope<T = unknown> {
  resultCode: string
  resultContext: string
  respData: T
  sno?: string | null
}

/** chatInfo 元素(原始;msgId/maxMsgId/minMsgId 已在 parse 前引号化成 string,保精度)。 */
interface RawWelinkMessage {
  msgId: string
  contentType: string
  content: string
  sender: string
  groupId?: string | number
  serverSendTime?: number
  /** 当前登录用户(即 bot)是否被 @。 */
  at?: boolean
  atAccountList?: string[]
}

interface HistoryRespData {
  chatInfo?: RawWelinkMessage[]
  maxMsgId?: string
  minMsgId?: string
  msgTotalCount?: number
}

/**
 * 从 stdout 截取首个完整 JSON 对象。真实 welink-cli 的 send-to-group(--image/--file)在 JSON 前
 * 往 stdout 打印进度行("Getting user info..."/"Uploading file..."/"Creating share link..."/"Sending message...");
 * sim 与 --text 不打。截取首个 '{' 起、括号配平(尊重字符串/转义)的对象,容忍前导进度文本与尾部噪声。
 * 无 '{' → 抛错;未闭合 → 抛错。
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{')
  if (start < 0) throw new Error('welink-cli: stdout 无 JSON 对象')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  throw new Error('welink-cli: stdout JSON 对象未闭合')
}

/**
 * 解析 stdout 为信封,校验 resultCode,返回 respData。
 * 真实 welink-cli 的 send-to-group(--image/--file)在 JSON 前打印进度行到 stdout → 先 extractJsonObject
 * 截取首个完整对象(容忍前导/尾部噪声;否则 JSON.parse 撞上 "Getting user info..." 报 Unexpected token)。
 * msgId/maxMsgId/minMsgId 及 msgIds[] 元素都是 >2^53 的大整数(真实 ~8.9e16),JSON.parse 当 number 会
 * 丢精度 → 正则把这些字段的裸数字引号化成 string 再 parse,全程 string 携带、BigInt 比较。
 * (字段若已带引号则正则不匹配,原样保留,同样安全。)
 */
function parseEnvelope<T = unknown>(raw: string): T {
  const json = extractJsonObject(raw) // 容忍前导进度行(--image/--file 有)
  const safe = json
    .replace(/"msgId"\s*:\s*(\d+)/g, '"msgId":"$1"')
    .replace(/"maxMsgId"\s*:\s*(\d+)/g, '"maxMsgId":"$1"')
    .replace(/"minMsgId"\s*:\s*(\d+)/g, '"minMsgId":"$1"')
    // send-to-group 响应 respData.msgIds 是大整数数组(真实:[89135807002479166]);把裸数字元素引号化保精度。
    // 真实每条 send 返回单元素数组,故匹配 [ <裸数字> ];空数组/已带引号不匹配(原样保留,sim 不用此字段)。
    .replace(/"msgIds"\s*:\s*\[\s*(\d+)\s*\]/g, '"msgIds":["$1"]')
  const parsed = JSON.parse(safe) as Envelope<T>
  if (parsed.resultCode !== '0') {
    throw new Error(`welink-cli failed: ${parsed.resultCode} ${parsed.resultContext ?? ''}`.trim())
  }
  return parsed.respData as T
}

/**
 * 从 send-to-group 响应的 respData 取新消息的 msgId 列表(用于排除自身回环消息)。
 * 真实 welink:respData.msgIds(大整数数组,通常 1 个,parseEnvelope 已引号化成 string[]);
 * sim:respData.msgId(单值)。优先取 msgIds;无则回退 msgId/messageId/messageID/id。
 * 返回所有命中(去空);全空 → 空数组(调用方记警告,回退到 account 过滤)。
 */
function extractSentMsgIds(respData: unknown): string[] {
  if (!respData || typeof respData !== 'object') return []
  const r = respData as Record<string, unknown>
  const out: string[] = []
  const push = (v: unknown): void => {
    if (v !== null && v !== undefined && v !== '') out.push(String(v))
  }
  const ids = r.msgIds
  if (Array.isArray(ids)) ids.forEach(push)
  else if (ids !== undefined) push(ids) // 防御:msgIds 非数组但给了单值
  if (out.length === 0) {
    for (const k of ['msgId', 'messageId', 'messageID', 'id']) {
      const v = r[k]
      if (v !== null && v !== undefined && v !== '') { out.push(String(v)); break }
    }
  }
  return out
}

/** 从 IMAGESPAN_MSG/FILE_MSG 的 content 取 `/:um_begin{` 后到首个 `|` 的 URL(段 0)。 */
function extractUmUrl(content: string): string | undefined {
  const m = content.match(/\/:um_begin\{([^|]*)\|/)
  return m?.[1]
}

/** 取 `/:um_end` 之后的文本(图片附言 caption)。 */
function extractUmCaption(content: string): string | undefined {
  const i = content.indexOf('/:um_end')
  if (i < 0) return undefined
  const s = content.slice(i + '/:um_end'.length).trim()
  return s || undefined
}

/** 从 `/:um_begin{...}` 内取 fileName(管道段 3)。 */
function extractUmFileName(content: string): string | undefined {
  const m = content.match(/\/:um_begin\{([^}]*)\}/)
  if (!m) return undefined
  return m[1].split('|')[3]
}

/** 把 chatInfo 元素映射成 IncomingMessage。contentType 决定 type 与 content/pictureUrl。 */
function toIncoming(m: RawWelinkMessage): IncomingMessage {
  const id = String(m.msgId)
  const user = String(m.sender)
  const timestamp = m.serverSendTime ?? Date.now()
  switch (m.contentType) {
    case 'IMAGESPAN_MSG':
      // pictureUrl 必须可被 downloadImage 抓取——sim 用 http://localhost:PORT/file?path=... 服务本地文件
      return {
        id, type: 'picture', user, timestamp, at: m.at,
        pictureUrl: extractUmUrl(m.content),
        content: extractUmCaption(m.content),
      }
    case 'FILE_MSG': {
      const name = extractUmFileName(m.content) ?? '未知文件'
      return { id, type: 'text', user, timestamp, at: m.at, content: `[文件: ${name}]` }
    }
    case 'CARD_MSG': {
      // content 是被序列化一次的 JSON;取 replyMsg.content 作正文,可前缀引用上下文。
      let text = m.content
      try {
        const card = JSON.parse(m.content)
        const pre = card?.cardContext?.preMsg
        const reply = card?.cardContext?.replyMsg
        const quote = pre?.content
          ? `[引用 ${pre.sender ?? ''}: ${String(pre.content).slice(0, 80)}] `
          : ''
        text = quote + (reply?.content ?? m.content)
      } catch { /* 解析失败则用原始 content */ }
      return { id, type: 'text', user, timestamp, at: m.at, content: text }
    }
    case 'TEXT_MSG':
    default:
      return { id, type: 'text', user, timestamp, at: m.at, content: m.content }
  }
}

export interface WelinkChannelOptions {
  binary?: string
  /** 监控的群 ID(必需)。 */
  groupId: string
  /** 可选脚本路径(供 `node <script>` 跑 sim)。 */
  script?: string
  /** bot 自身账号(回环过滤的次要手段:按 sender 排除;主要靠 sentIds 按 CLI 发出 msgId 排除)。 */
  account?: string
  queryCount?: number
}

export function createWelinkChannel(options: WelinkChannelOptions): Channel {
  if (!options.groupId) throw new Error('WelinkChannel: groupId is required')
  const binary = options.binary ?? DEFAULT_BINARY
  const script = options.script ?? DEFAULT_SCRIPT
  const account = options.account ?? DEFAULT_ACCOUNT
  const groupId = options.groupId
  const queryCount = options.queryCount ?? DEFAULT_QUERY_COUNT

  const prefixArgs = script ? [script] : []

  /** 调 welink-cli im 子命令。经 execFileCmd(cross-spawn):.cmd/.bat 解析底层 exe 无 shell,`--text` 的空格/换行/`"`/`%` 全安全。 */
  async function runIm(...args: string[]): Promise<string> {
    return execFileCmd(binary, [...prefixArgs, 'im', ...args], { maxBuffer: 10 * 1024 * 1024 })
  }

  /**
   * 记住本通道经 CLI 发出的消息 msgId,getNewMessages 时排除(防回环:bot 自己的回复被轮询捞回
   * 喂给 Claude → 无限循环)。send-to-group 成功响应的 respData.msgIds(真实,大整数数组)加入此集合。
   * 只需覆盖"最近 queryCount 条"窗口内的回环消息;msgId 单调递增,最早发出的最不可能再出现在最近
   * 批次,故 FIFO 淘汰。上限远大于 queryCount,余量充足。
   */
  const sentIds = new Set<string>()
  const SENT_ID_CAP = Math.max(256, queryCount * 8)
  function rememberSent(id: string): void {
    if (!id) return
    sentIds.add(id)
    if (sentIds.size > SENT_ID_CAP) {
      const oldest = sentIds.values().next().value
      if (oldest !== undefined) sentIds.delete(oldest)
    }
  }

  /** 发到群并记录新消息 msgId(s)(防回环)。respData 无 msgId 时记警告(回退到 account 过滤)。 */
  async function sendAndRemember(...args: string[]): Promise<void> {
    const stdout = await runIm('send-to-group', ...args)
    const respData = parseEnvelope(stdout) // 校验 resultCode(失败抛 → Assistant 降级致歉)
    const ids = extractSentMsgIds(respData)
    if (ids.length) ids.forEach(rememberSent)
    else console.warn('[welink-channel] send-to-group 响应未含 msgId(s),无法按发送排除自身回环消息;请确认 WELINK_ACCOUNT 已设为 bot 登录账号作为回退过滤')
  }

  /** 补 @ 检测:welink 只对 IM 客户端 @-mention UI 置 at;手打 `@<account> ...` 时按正文前缀补 at 并剥前缀,让文本 @ 也能触发会话。 */
  const enrichAt = (m: IncomingMessage): IncomingMessage => {
    if (!m.at && m.content) {
      const re = new RegExp(`^@${account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
      if (re.test(m.content)) {
        m.at = true
        m.content = m.content.replace(re, '').trimStart()
      }
    }
    return m
  }

  return {
    /**
     * 拉取群最近 queryCount 条(新→old),过滤自身(避免回环)后映射。
     * 回环过滤双重:sender=bot 账号(WELINK_ACCOUNT)+ 本通道 CLI 发出的 msgId(sentIds,主要手段)。
     * 水位去重(只触发一次)+ 首次排除历史 由 core 负责(state.ts loadWatermark/saveWatermark)。
     */
    async getNewMessages(): Promise<IncomingMessage[]> {
      try {
        const stdout = await runIm('query-history-message', '--group-id', groupId, '--query-count', String(queryCount))
        const data = parseEnvelope<HistoryRespData>(stdout)
        const chatInfo = data?.chatInfo ?? []
        return chatInfo
          // 排除回环消息:① sender=bot 自身账号(WELINK_ACCOUNT,次要);② 本通道经 CLI 发出的 msgId
          //   (sentIds,主要,不依赖账号匹配——即便操作者用 bot 同一账号在 IM 客户端发言也不误排除,只排 CLI 发的)
          .filter(m => m.sender !== account && !sentIds.has(String(m.msgId)))
          .map(m => enrichAt(toIncoming(m)))
          .reverse() // chatInfo 是 new→old;反转为 old→new 便于 core 按序处理
      } catch (err) {
        console.error('[welink-channel] getNewMessages failed:', err instanceof Error ? err.message : err)
        return [] // 不崩主循环
      }
    },
    /** 发文本到群(userId 形参忽略,发到构造时的 groupId)。 */
    async sendText(_userId: string, text: string): Promise<void> {
      await sendAndRemember('--group-id', groupId, '--text', text)
    },
    /** 发图片到群。 */
    async sendPicture(_userId: string, imagePath: string): Promise<void> {
      await sendAndRemember('--group-id', groupId, '--image', imagePath)
    },
    /** 发文件到群。 */
    async sendFile(_userId: string, filePath: string): Promise<void> {
      await sendAndRemember('--group-id', groupId, '--file', filePath)
    },
  }
}
