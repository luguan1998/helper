// ★深模块 Assistant:纯编排,无 I/O。
// loop: 轮询(channel)→ 去重(seen)→ 路由(text/picture)→ ask(llm)→ render → sendText+sendPicture。
// per-message try/catch → 出错发纯文本致歉,循环不死。
// 生产由后台循环驱动;测试 startLoop:false 后直接 await handle.tick()。
import type { Channel } from './channels/channel.js'
import type { Llm } from './llm.js'
import type { Renderer } from './renderers/renderer.js'
import type { IncomingMessage, UserContent } from './types.js'
import { downloadImage } from './image.js'

/** 内置安全客服提示词(可被 options.systemPrompt 覆盖)。 */
export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个内部通讯软件上的客服助手。',
  '请简洁、专业、礼貌地回答用户问题,使用与用户相同的语言。',
  '约束:不要做出任何承诺或保证;不要披露内部敏感信息、密钥、口令;',
  '遇到无法确定或超出权限的问题,提示用户联系人工客服。',
  '回复使用 Markdown(将渲染为图片发送)。',
].join('')

const DEFAULT_POLL_MS = 1000
const DEFAULT_MAX_SESSIONS = 8
const SUMMARY_MAX = 100

export interface AssistantOptions {
  /** Claude 子进程工作目录(隔离的安全边界,勿放敏感文件)。默认 workspace。 */
  claudeCwd?: string
  /** 客服人设与约束。默认内置安全提示词。 */
  systemPrompt?: string
  /** 注入假 channel(测试)。默认 LinkChannel。 */
  channel?: Channel
  /** 注入假 Llm(测试)。默认 ClaudeCliLlm(按用户隔离会话)。 */
  llm?: Llm
  /** 注入假 renderer(测试)。默认 PuppeteerRenderer。 */
  renderer?: Renderer
  /** 轮询间隔 ms。默认 1000。 */
  pollIntervalMs?: number
  /** 同时保活的用户会话上限(LRU)。默认 8。 */
  maxSessions?: number
  /** 不启动后台循环(测试用,由调用方驱动 tick)。默认 false=启动。 */
  startLoop?: boolean
  onReceive?: (msg: IncomingMessage) => void
  onReply?: (userId: string, imagePath: string) => void
  onError?: (userId: string, err: Error) => void
}

export interface AssistantHandle {
  /** 处理一个轮询周期(去重 + 路由 + 回复)。 */
  tick(): Promise<void>
  /** 停止后台循环。幂等。 */
  stop(): void
}

interface AssistantDeps {
  channel: Channel
  llm: Llm
  renderer: Renderer
  onReceive?: (msg: IncomingMessage) => void
  onReply?: (userId: string, imagePath: string) => void
  onError?: (userId: string, err: Error) => void
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** 把完整 Markdown 压成短摘要(去代码块、限长),作为截图前缀文本通知。 */
function summarize(markdown: string): string {
  const stripped = markdown.replace(/```[\s\S]*?```/g, '[代码块]').replace(/\s+/g, ' ').trim()
  const over = stripped.length > SUMMARY_MAX
  return `🤖 ${stripped.slice(0, SUMMARY_MAX)}${over ? '…' : ''}(查看图片获取完整内容)`
}

/**
 * 启动客服助手。零配置即可:`runAssistant()`。
 * 默认适配器(LinkChannel / ClaudeCliLlm / PuppeteerRenderer)懒加载——
 * 注入假时绝不加载 puppeteer / child_process,保证核心单测零外部依赖。
 */
export async function runAssistant(options: AssistantOptions = {}): Promise<AssistantHandle> {
  const channel = options.channel ?? (await import('./channels/link-channel.js')).createLinkChannel()
  const renderer = options.renderer ?? (await import('./renderers/puppeteer-renderer.js')).createPuppeteerRenderer()
  const llm = options.llm ?? await createDefaultLlm(options)

  const assistant = new Assistant({
    channel,
    llm,
    renderer,
    onReceive: options.onReceive,
    onReply: options.onReply,
    onError: options.onError,
  })

  if (options.startLoop !== false) {
    assistant.startLoop(options.pollIntervalMs ?? DEFAULT_POLL_MS)
  }
  return assistant
}

async function createDefaultLlm(options: AssistantOptions): Promise<Llm> {
  const { createClaudeCliLlm } = await import('./claude-client.js')
  return createClaudeCliLlm({
    cwd: options.claudeCwd ?? 'workspace',
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
  })
}

class Assistant implements AssistantHandle {
  private seen = new Set<string>()
  private running = false

  constructor(private readonly deps: AssistantDeps) {}

  startLoop(intervalMs: number): void {
    if (this.running) return
    this.running = true
    const loop = async (): Promise<void> => {
      while (this.running) {
        try {
          await this.tick()
        } catch (err) {
          console.error('[assistant] tick failed:', err)
        }
        await sleep(intervalMs)
      }
    }
    void loop()
  }

  stop(): void {
    this.running = false
  }

  async tick(): Promise<void> {
    let messages: IncomingMessage[]
    try {
      messages = await this.deps.channel.getNewMessages()
    } catch (err) {
      console.error('[assistant] getNewMessages failed:', err)
      return
    }
    for (const msg of messages) {
      if (this.seen.has(msg.id)) continue
      this.seen.add(msg.id)
      this.deps.onReceive?.(msg)
      try {
        await this.handle(msg)
      } catch (err) {
        console.error(`[assistant] handle ${msg.id} failed:`, err)
        this.deps.onError?.(msg.user, err as Error)
      }
    }
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    try {
      const content = await this.toUserContent(msg)
      const reply = await this.deps.llm.ask(msg.user, content)
      const imagePath = await this.deps.renderer.markdownToImage(reply.markdown)
      await this.deps.channel.sendText(msg.user, summarize(reply.markdown))
      await this.deps.channel.sendPicture(msg.user, imagePath)
      this.deps.onReply?.(msg.user, imagePath)
    } catch (err) {
      // 降级:发纯文本致歉,循环不死
      try {
        await this.deps.channel.sendText(msg.user, `抱歉,处理该消息时出错:${(err as Error).message}`)
      } catch {
        /* sendText 自身也失败时,无能为力,记日志即可 */
      }
      throw err
    }
  }

  private async toUserContent(msg: IncomingMessage): Promise<UserContent> {
    if (msg.type === 'text') {
      return { kind: 'text', text: msg.content ?? '' }
    }
    const imagePath = await downloadImage(msg.pictureUrl ?? '')
    return { kind: 'image', imagePath, caption: msg.content }
  }
}
