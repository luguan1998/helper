// ★深模块 Assistant:纯编排,无 I/O。
// 泛化为:轮询(channel)→ 去重 → toUserContent → runPipeline(接力)→ outputPolicy → text/picture。
// 模型/接力步骤/输出策略均配置注入;per-message try/catch → 出错发纯文本致歉,循环不死。
// 生产由后台循环驱动;测试 startLoop:false 后直接 await handle.tick()。
import type { Channel } from './channels/channel.js'
import type { Llm, Models } from './llm.js'
import type { Renderer } from './renderers/renderer.js'
import type { IncomingMessage, UserContent } from './types.js'
import { downloadImage } from './image.js'
import { runPipeline, modelStep, type Pipeline, type StepCtx } from './pipeline.js'
import type { OutputMode, OutputPolicy } from './output-policy.js'
import { markdownOutputPolicy } from './output-policy.js'
import type { ModelSpec } from './models.js'
import { buildModels, DEFAULT_MODEL_SPECS } from './models.js'
import { createDefaultPipeline } from './pipelines/default.js'

const DEFAULT_POLL_MS = 1000
const DEFAULT_MAX_SESSIONS = 8
const SUMMARY_MAX = 100

export interface ReplyResult {
  mode: OutputMode
  reply: string
  /** picture 模式下的截图路径。 */
  imagePath?: string
}

export interface AssistantOptions {
  /** Claude 子进程工作目录(隔离的安全边界,勿放敏感文件)。默认 workspace。 */
  claudeCwd?: string
  /** 覆盖默认 text 模型提示词(零配置时生效)。 */
  systemPrompt?: string
  /** 旧用法:注入单个 Llm → 包成 { default: llm } + 平凡 pipeline。优先级低于 models。 */
  llm?: Llm
  /** 注入命名模型集(触发默认接力 pipeline)。 */
  models?: Models
  /** 注入自定义 pipeline(测试)。 */
  pipeline?: Pipeline
  /** 注入假 channel/renderer(测试)。 */
  channel?: Channel
  renderer?: Renderer
  /** 注入输出策略(测试)。默认 markdownOutputPolicy(Markdown→picture,纯文本→text)。 */
  outputPolicy?: OutputPolicy
  pollIntervalMs?: number
  maxSessions?: number
  cliCommand?: string
  /** 不启动后台循环(测试用)。默认 false=启动。 */
  startLoop?: boolean
  onReceive?: (msg: IncomingMessage) => void
  onReply?: (userId: string, result: ReplyResult) => void
  onError?: (userId: string, err: Error) => void
}

export interface AssistantHandle {
  tick(): Promise<void>
  stop(): void
}

interface AssistantDeps {
  channel: Channel
  models: Models
  pipeline: Pipeline
  renderer: Renderer
  outputPolicy: OutputPolicy
  onReceive?: (msg: IncomingMessage) => void
  onReply?: (userId: string, result: ReplyResult) => void
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
 * 启动客服助手。零配置即可:`runAssistant()` —— 默认 vision+text 模型 + 接力 pipeline + 动态输出。
 * 默认适配器懒加载——注入假时绝不加载 puppeteer / child_process。
 */
export async function runAssistant(options: AssistantOptions = {}): Promise<AssistantHandle> {
  const channel = options.channel ?? (await import('./channels/link-channel.js')).createLinkChannel()
  const renderer = options.renderer ?? (await import('./renderers/puppeteer-renderer.js')).createPuppeteerRenderer()
  const outputPolicy = options.outputPolicy ?? markdownOutputPolicy

  let models: Models
  let pipeline: Pipeline
  if (options.models) {
    models = options.models
    pipeline = options.pipeline ?? createDefaultPipeline()
  } else if (options.llm) {
    // 旧用法:单 Llm → 平凡 pipeline(无接力,直接单模型)
    models = { default: options.llm }
    pipeline = options.pipeline ?? { steps: [modelStep('default')] }
  } else {
    // 零配置:默认 vision+text + 接力 pipeline
    const specs = buildDefaultSpecs(options)
    models = await buildModels(specs, { cwd: options.claudeCwd ?? 'workspace', cliCommand: options.cliCommand })
    pipeline = options.pipeline ?? createDefaultPipeline()
  }

  const assistant = new Assistant({
    channel, models, pipeline, renderer, outputPolicy,
    onReceive: options.onReceive, onReply: options.onReply, onError: options.onError,
  })
  if (options.startLoop !== false) {
    assistant.startLoop(options.pollIntervalMs ?? DEFAULT_POLL_MS)
  }
  return assistant
}

/** 零配置默认模型配置:systemPrompt/maxSessions 覆盖 text 模型。 */
function buildDefaultSpecs(options: AssistantOptions): ModelSpec[] {
  return DEFAULT_MODEL_SPECS.map(spec => {
    if (spec.name === 'text') {
      return {
        ...spec,
        systemPrompt: options.systemPrompt ?? spec.systemPrompt,
        maxSessions: options.maxSessions ?? spec.maxSessions ?? DEFAULT_MAX_SESSIONS,
      }
    }
    return spec
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
      const ctx: StepCtx = { userId: msg.user, content, scratch: {} }
      const reply = await runPipeline(this.deps.pipeline, this.deps.models, ctx)

      const mode = this.deps.outputPolicy(reply)
      if (mode === 'picture') {
        const imagePath = await this.deps.renderer.markdownToImage(reply)
        await this.deps.channel.sendText(msg.user, summarize(reply))
        await this.deps.channel.sendPicture(msg.user, imagePath)
        this.deps.onReply?.(msg.user, { mode, reply, imagePath })
      } else {
        await this.deps.channel.sendText(msg.user, reply)
        this.deps.onReply?.(msg.user, { mode, reply })
      }
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
