// ★深模块 Assistant:纯编排,无 I/O。
// 泛化为:轮询(channel)→ 水位去重(只触发一次)→ 生命周期路由(@开启/exit)→ runPipeline(接力)
// → outputPolicy → text/picture(发群)。模型/接力步骤/输出策略/水位/生命周期均配置注入;
// per-message try/catch → 出错发纯文本致歉,循环不死。生产由后台循环驱动;测试 startLoop:false 后直接 await handle.tick()。
import type { Channel } from './channels/channel.js'
import type { Llm, Models, SessionLlm } from './llm.js'
import type { Renderer } from './renderers/renderer.js'
import type { IncomingMessage, UserContent } from './types.js'
import { downloadImage } from './image.js'
import { runPipeline, modelStep, type Pipeline, type StepCtx } from './pipeline.js'
import type { OutputMode, OutputPolicy } from './output-policy.js'
import { markdownOutputPolicy } from './output-policy.js'
import type { ModelSpec } from './models.js'
import { buildModels, DEFAULT_MODEL_SPECS } from './models.js'
import { createDefaultPipeline } from './pipelines/default.js'
import { loadLastMsgId, saveLastMsgId } from './state.js'

const DEFAULT_POLL_MS = 1000
const DEFAULT_MAX_SESSIONS = 8
const SUMMARY_MAX = 100
const DEFAULT_EXIT_KEYWORDS = ['esc', 'quit', 'exit']

export interface ReplyResult {
  mode: OutputMode
  reply: string
  /** picture 模式下的截图路径。 */
  imagePath?: string
  /** html 模式下的 HTML 文件路径。 */
  htmlPath?: string
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
  /** 富文本回复的产物形态:'image'(默认,截图 PNG)|'html'(发 HTML 文件)。可由 env BOT_PICTURE_OUTPUT 覆盖。 */
  pictureOutput?: 'image' | 'html'
  pollIntervalMs?: number
  maxSessions?: number
  cliCommand?: string
  /** 不启动后台循环(测试用)。默认 false=启动。 */
  startLoop?: boolean
  /** 监控的群 ID(零配置生产必填;可由 WELINK_GROUP_ID 提供)。 */
  groupId?: string
  /** 注入带生命周期的对话模型 → 开启 @bot/exit 生命周期(测试/生产)。零配置自动取 models.text。 */
  sessionLlm?: SessionLlm
  /** 水位读取(默认 ()=>\"0\" → 全处理、不排除历史;生产注入 state.ts → 首次 undefined 排除历史)。 */
  loadWatermark?: () => Promise<string | undefined>
  /** 水位推进(默认 no-op;生产注入 state.ts 持久化)。 */
  saveWatermark?: (msgId: string) => Promise<void>
  /** 退出关键词(默认 esc/quit/exit);退出 = 正文 trim+lowercase 后精确等于其一。 */
  exitKeywords?: string[]
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
  sessionLlm?: SessionLlm
  loadWatermark?: () => Promise<string | undefined>
  saveWatermark?: (msgId: string) => Promise<void>
  exitKeywords: string[]
  onReceive?: (msg: IncomingMessage) => void
  onReply?: (userId: string, result: ReplyResult) => void
  onError?: (userId: string, err: Error) => void
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * 比较两个 msgId(welink 的 msgId 是 >2^53 的大整数,以 string 携带)。
 * 优先 BigInt 数值比较;非数值(如测试用 'x'/'y')回退字符串比较,保证测试可用。
 */
function cmpId(a: string, b: string): number {
  try {
    const ba = BigInt(a), bb = BigInt(b)
    return ba < bb ? -1 : ba > bb ? 1 : 0
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

/** 把完整 Markdown 压成短摘要(去代码块、限长),作为附件前缀文本通知。where=图片|文件。 */
function summarize(markdown: string, where: string): string {
  const stripped = markdown.replace(/```[\s\S]*?```/g, '[代码块]').replace(/\s+/g, ' ').trim()
  const over = stripped.length > SUMMARY_MAX
  return `🤖 ${stripped.slice(0, SUMMARY_MAX)}${over ? '…' : ''}(查看${where}获取完整内容)`
}

/**
 * 启动客服助手。零配置即可:`runAssistant()` —— 默认 vision+text 模型 + 接力 pipeline + 动态输出
 * + welink-cli im 群通道 + state.ts 持久化水位(只触发一次)+ 按发送者生命周期(@开启/exit)。
 * 默认适配器懒加载——注入假时绝不加载 puppeteer / child_process / welink-cli。
 */
export async function runAssistant(options: AssistantOptions = {}): Promise<AssistantHandle> {
  // pictureOutput='html' 时把默认策略的 picture 重映射成 html(发 HTML 文件而非截图);
  // text/html 原样透传——与注入的自定义 outputPolicy 组合安全(自定义策略仍可直接返回 'html')。
  const pictureOutput = options.pictureOutput ?? process.env.BOT_PICTURE_OUTPUT ?? 'image'
  const basePolicy = options.outputPolicy ?? markdownOutputPolicy
  const outputPolicy: OutputPolicy = pictureOutput === 'html'
    ? (reply) => { const m = basePolicy(reply); return m === 'picture' ? 'html' : m }
    : basePolicy

  let models: Models
  let pipeline: Pipeline
  // sessionLlm:注入则显式;零配置自动取 models.text(对话型,实现 SessionLlm);测试路径默认 undefined(无生命周期)
  let sessionLlm: SessionLlm | undefined = options.sessionLlm

  if (options.models) {
    models = options.models
    pipeline = options.pipeline ?? createDefaultPipeline()
  } else if (options.llm) {
    // 旧用法:单 Llm → 平凡 pipeline(无接力,直接单模型)
    models = { default: options.llm }
    pipeline = options.pipeline ?? { steps: [modelStep('default')] }
  } else {
    // 零配置:默认 vision+text + 接力 pipeline + 生命周期(text 模型)
    const specs = buildDefaultSpecs(options)
    models = await buildModels(specs, { cwd: options.claudeCwd ?? 'workspace', cliCommand: options.cliCommand })
    pipeline = options.pipeline ?? createDefaultPipeline()
    sessionLlm = options.sessionLlm ?? (models.text as SessionLlm | undefined)
  }

  // 通道:注入用注入的;否则零配置 welink-cli im 群(并注入 state.ts 水位 + groupId)
  let channel = options.channel
  let loadWatermark = options.loadWatermark
  let saveWatermark = options.saveWatermark
  if (!channel) {
    const groupId = options.groupId ?? process.env.WELINK_GROUP_ID
    if (!groupId) throw new Error('runAssistant: groupId required (set options.groupId or WELINK_GROUP_ID)')
    channel = (await import('./channels/welink-channel.js')).createWelinkChannel({ groupId })
    // 生产水位:state.ts 持久化(首次返回 undefined → 核心据比排除历史)
    if (!loadWatermark) loadWatermark = async () => loadLastMsgId(groupId)
    if (!saveWatermark) saveWatermark = async (id: string) => saveLastMsgId(groupId, id)
  }

  const renderer = options.renderer ?? (await import('./renderers/puppeteer-renderer.js')).createPuppeteerRenderer()

  const assistant = new Assistant({
    channel, models, pipeline, renderer, outputPolicy,
    sessionLlm, loadWatermark, saveWatermark,
    exitKeywords: options.exitKeywords ?? DEFAULT_EXIT_KEYWORDS,
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
  /** 最后处理到的 msgId(水位);undefined=尚未载入(或生产首次,排除历史)。 */
  private watermark: string | undefined
  private watermarkLoaded = false
  private readonly loadWatermark: () => Promise<string | undefined>
  private readonly saveWatermark: (id: string) => Promise<void>
  /** 已开启会话的发送者集合(生命周期;仅 sessionLlm 注入时使用)。 */
  private readonly active = new Set<string>()
  private running = false

  constructor(private readonly deps: AssistantDeps) {
    // 默认退化:未注入水位 → "0"(全处理、不排除历史、内存推进),等价旧 seen 行为
    this.loadWatermark = deps.loadWatermark ?? (async () => '0')
    this.saveWatermark = deps.saveWatermark ?? (async () => {})
  }

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
    if (!this.watermarkLoaded) {
      try {
        this.watermark = await this.loadWatermark()
      } catch (err) {
        console.error('[assistant] loadWatermark failed:', err)
        this.watermark = '0' // fail-safe:全处理、不排除历史
      }
      this.watermarkLoaded = true
    }

    let batch: IncomingMessage[]
    try {
      batch = await this.deps.channel.getNewMessages()
    } catch (err) {
      console.error('[assistant] getNewMessages failed:', err)
      return
    }

    // 首次运行(无持久化水位):排除历史——落种到本批最新 msgId,不处理任何消息。
    if (this.watermark === undefined) {
      if (batch.length > 0) {
        let maxId = batch[0].id
        for (const m of batch) if (cmpId(m.id, maxId) > 0) maxId = m.id
        this.watermark = maxId
        try { await this.saveWatermark(maxId) } catch (err) { console.error('[assistant] saveWatermark(seed) failed:', err) }
        console.log(`[assistant] 首次运行:排除 ${batch.length} 条历史消息,水位=${maxId}`)
      }
      return
    }

    // 过滤出新消息(id > 水位),按 id 升序处理。
    const newMsgs = batch
      .filter(m => cmpId(m.id, this.watermark!) > 0)
      .sort((a, b) => cmpId(a.id, b.id))

    for (const msg of newMsgs) {
      // ★at-most-once:先把水位推进到本条 msgId 并落盘,再处理 → 崩溃至多重丢这一条,绝不重复处理。
      this.watermark = msg.id
      try { await this.saveWatermark(msg.id) } catch (err) { console.error('[assistant] saveWatermark failed:', err) }
      this.deps.onReceive?.(msg)
      try {
        await this.route(msg)
      } catch (err) {
        console.error(`[assistant] route ${msg.id} failed:`, err)
        this.deps.onError?.(msg.user, err as Error)
      }
    }
  }

  /**
   * 生命周期路由。注入 sessionLlm:
   *   未活跃 + @bot → 开启(回 ack)+ 把本条丢给 Claude 处理(一句话即开问答);
   *   已活跃 → exit 结束 / 其余(含继续 @bot)直接处理;
   *   未活跃 + 非@ → 忽略。
   * 未注入 sessionLlm → 每条新消息直接处理(旧行为)。
   */
  private async route(msg: IncomingMessage): Promise<void> {
    if (!this.deps.sessionLlm) {
      await this.handle(msg)
      return
    }
    const sender = msg.user
    const text = (msg.content ?? '').trim()
    const isExit = this.deps.exitKeywords.some(k => text.toLowerCase() === k)

    if (this.active.has(sender)) {
      // 已活跃:exit 结束,否则处理(含继续 @bot 的消息)
      if (isExit) {
        const id = await this.deps.sessionLlm.endSession(sender)
        this.active.delete(sender)
        const reply = `会话已结束${id ? `,会话 ID: ${id}` : ''}。`
        await this.deps.channel.sendText(sender, reply)
        this.deps.onReply?.(sender, { mode: 'text', reply })
      } else {
        await this.handle(msg)
      }
    } else if (msg.at) {
      // 未活跃 + @bot:开启 + 回 ack + 把本条丢给 Claude 处理
      await this.deps.sessionLlm.startSession(sender)
      this.active.add(sender)
      const ack = '已开启会话,可直接提问;发送 esc/quit/exit 结束。'
      await this.deps.channel.sendText(sender, ack)
      this.deps.onReply?.(sender, { mode: 'text', reply: ack })
      await this.handle(msg)
    }
    // 未活跃 + 非@:忽略(不处理、不回复)
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    try {
      const content = await this.toUserContent(msg)
      const ctx: StepCtx = { userId: msg.user, content, scratch: {} }
      const reply = await runPipeline(this.deps.pipeline, this.deps.models, ctx)

      const mode = this.deps.outputPolicy(reply)
      if (mode === 'picture') {
        const imagePath = await this.deps.renderer.markdownToImage(reply)
        await this.deps.channel.sendText(msg.user, summarize(reply, '图片'))
        await this.deps.channel.sendPicture(msg.user, imagePath)
        this.deps.onReply?.(msg.user, { mode, reply, imagePath })
      } else if (mode === 'html') {
        const htmlPath = await this.deps.renderer.markdownToHtml(reply)
        await this.deps.channel.sendText(msg.user, summarize(reply, '文件'))
        await this.deps.channel.sendFile(msg.user, htmlPath)
        this.deps.onReply?.(msg.user, { mode, reply, htmlPath })
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
