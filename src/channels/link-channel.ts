// 生产适配器:LinkChannel —— link CLI 的真-外部耦合点。
// 真实 link 的输出格式有变时,只需改此文件(locality 来自接缝)。
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Channel } from './channel.js'
import type { IncomingMessage } from '../types.js'

const execAsync = promisify(exec)

const DEFAULT_BINARY = process.env.LINK_BIN ?? 'link'
const DEFAULT_BATCH = Number(process.env.LINK_BATCH_SIZE ?? 5)

/** link get 的原始返回结构(假定为 JSON;真实格式以 link CLI 为准)。 */
interface RawLinkMessage {
  id: string | number
  type: 'text' | 'picture'
  user: string | number
  content?: string
  pictureUrl?: string
  timestamp?: number
}

/** 解析 link get 的 stdout 为 IncomingMessage[]。支持裸数组或 { messages: [...] }。 */
function parseMessages(raw: string): IncomingMessage[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  const arr: RawLinkMessage[] = Array.isArray(parsed) ? parsed : (parsed?.messages ?? [])
  return arr.map(m => ({
    id: String(m.id),
    type: m.type,
    user: String(m.user),
    content: m.content,
    pictureUrl: m.pictureUrl,
    timestamp: m.timestamp ?? Date.now(),
  }))
}

/** 简单的双引号包裹(适合典型短文本;含特殊字符的极端情况需按真实 link 转义规则调整)。 */
function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

export interface LinkChannelOptions {
  binary?: string
  batchSize?: number
}

export function createLinkChannel(options: LinkChannelOptions = {}): Channel {
  const binary = options.binary ?? DEFAULT_BINARY
  const batchSize = options.batchSize ?? DEFAULT_BATCH

  return {
    async getNewMessages(): Promise<IncomingMessage[]> {
      const { stdout } = await execAsync(`${binary} get --number ${batchSize}`)
      return parseMessages(stdout)
    },
    async sendText(user: string, text: string): Promise<void> {
      await execAsync(`${binary} send --user ${quote(user)} --content ${quote(text)}`)
    },
    async sendPicture(user: string, imagePath: string): Promise<void> {
      await execAsync(`${binary} send --user ${quote(user)} --picture ${quote(imagePath)}`)
    },
  }
}
