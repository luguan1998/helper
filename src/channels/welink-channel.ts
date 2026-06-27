// 生产适配器:WelinkChannel —— welink-cli im 群的真-外部耦合点(对齐 doc/trueapi.md)。
// 真实 welink-cli 输出格式有变时,只需改此文件(locality 来自接缝)。
// 群组导向:构造时绑定 groupId,所有 send 固定发到该群;sendText/sendPicture 的 userId
// 形参仅为兼容端口签名(群模型下被忽略——回复一律发到构造时的群),核心仍传 sender 以备日志/回调。
// 用 execFile 传参数组(structured args,Node 自动给含空格/特殊字符的参数加引号);Windows 上 shell:true 解析 welink-cli 的 .cmd 壳(否则 spawn ENOENT,对齐 claude-client 的 spawnClaude)。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Channel } from './channel.js'
import type { IncomingMessage } from '../types.js'

const execFileAsync = promisify(execFile)

const DEFAULT_BINARY = process.env.WELINK_CLI_BIN ?? 'welink-cli'
/** 可选:设则前缀到 args(供 `node <script>` 跑 sim;真实 welink 不需要)。 */
const DEFAULT_SCRIPT = process.env.WELINK_CLI_SCRIPT ?? ''
/** bot 自身账号(过滤自身消息,避免回环;需与 sim 的 WELINK_SIM_ACCOUNT 一致)。 */
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
 * 解析 stdout 为信封,校验 resultCode,返回 respData。
 * 关键:msgId/maxMsgId/minMsgId 是 >2^53 的大整数,JSON.parse 当 number 会丢精度 →
 * 先正则把这几个字段的数字字面量加引号包成 string 再 parse,全程以 string 携带、用 BigInt 比较。
 * (字段若本身已带引号则正则不匹配,原样保留,同样安全。)
 */
function parseEnvelope<T = unknown>(raw: string): T {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('welink-cli: empty stdout')
  const safe = trimmed
    .replace(/"msgId"\s*:\s*(\d+)/g, '"msgId":"$1"')
    .replace(/"maxMsgId"\s*:\s*(\d+)/g, '"maxMsgId":"$1"')
    .replace(/"minMsgId"\s*:\s*(\d+)/g, '"minMsgId":"$1"')
  const parsed = JSON.parse(safe) as Envelope<T>
  if (parsed.resultCode !== '0') {
    throw new Error(`welink-cli failed: ${parsed.resultCode} ${parsed.resultContext ?? ''}`.trim())
  }
  return parsed.respData as T
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
  /** bot 自身账号(过滤自身消息,避免回环)。 */
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

  /** 调 welink-cli im 子命令。execFile 传参数组(structured);Windows 上 shell:true 解析 .cmd 壳(对齐 claude-client spawnClaude),否则 spawn welink-cli ENOENT。Node 自动给含空格/特殊字符的参数加引号。 */
  async function runIm(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(binary, [...prefixArgs, 'im', ...args], {
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
    return stdout
  }

  return {
    /**
     * 拉取群最近 queryCount 条(新→old),过滤自身(避免回环)后映射。
     * 水位去重(只触发一次)+ 首次排除历史 由 core 负责(state.ts loadWatermark/saveWatermark)。
     */
    async getNewMessages(): Promise<IncomingMessage[]> {
      try {
        const stdout = await runIm('query-history-message', '--group-id', groupId, '--query-count', String(queryCount))
        const data = parseEnvelope<HistoryRespData>(stdout)
        const chatInfo = data?.chatInfo ?? []
        return chatInfo
          .filter(m => m.sender !== account)
          .map(toIncoming)
          .reverse() // chatInfo 是 new→old;反转为 old→new 便于 core 按序处理
      } catch (err) {
        console.error('[welink-channel] getNewMessages failed:', err instanceof Error ? err.message : err)
        return [] // 不崩主循环
      }
    },
    /** 发文本到群(userId 形参忽略,发到构造时的 groupId)。 */
    async sendText(_userId: string, text: string): Promise<void> {
      const stdout = await runIm('send-to-group', '--group-id', groupId, '--text', text)
      parseEnvelope(stdout) // 校验 resultCode(失败抛 → Assistant 降级致歉)
    },
    /** 发图片到群。 */
    async sendPicture(_userId: string, imagePath: string): Promise<void> {
      const stdout = await runIm('send-to-group', '--group-id', groupId, '--image', imagePath)
      parseEnvelope(stdout)
    },
    /** 发文件到群。 */
    async sendFile(_userId: string, filePath: string): Promise<void> {
      const stdout = await runIm('send-to-group', '--group-id', groupId, '--file', filePath)
      parseEnvelope(stdout)
    },
  }
}
