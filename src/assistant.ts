// ★深模块 Assistant:纯编排,无 I/O。
// 泛化为:轮询(channel)→ 水位去重(只触发一次)→ 生命周期路由(@开启/exit)→ runPipeline(接力)
// → outputPolicy → text/picture(发群)。模型/接力步骤/输出策略/水位/生命周期均配置注入;
// per-message try/catch → 出错发纯文本致歉,循环不死。生产由后台循环驱动;测试 startLoop:false 后直接 await handle.tick()。
import type { Channel } from './channels/channel.js'
import type { Llm, Models, SessionLlm } from './llm.js'
import type { Renderer } from './renderers/renderer.js'
import type { IncomingMessage, UserContent, OnPartial } from './types.js'
import { downloadImage } from './image.js'
import { runPipeline, modelStep, type Pipeline, type StepCtx } from './pipeline.js'
import type { OutputMode, OutputPolicy } from './output-policy.js'
import { markdownOutputPolicy } from './output-policy.js'
import type { ModelSpec } from './models.js'
import { buildModels, DEFAULT_MODEL_SPECS } from './models.js'
import { createDefaultPipeline } from './pipelines/default.js'
import { createLogQaPipeline } from './pipelines/log-qa.js'
import { loadLastMsgId, saveLastMsgId } from './state.js'

const DEFAULT_POLL_MS = 1000
const DEFAULT_MAX_SESSIONS = 8
const SUMMARY_MAX = 100
const DEFAULT_EXIT_KEYWORDS = ['esc', 'quit', 'exit']
/** 单条 thinking 消息发送超时(ms):防 welink sendText 挂起阻塞最终回复。 */
const THINKING_SEND_TIMEOUT_MS = 30_000
/** 单条 thinking 消息最大字符:超长分段(防 IM 消息长度上限静默失败)。 */
const THINKING_CHUNK_MAX = 4000

/** @bot 开启时可指定的模型别名;CLI 经 ANTHROPIC_DEFAULT_*_MODEL 解析(参考 vibe-ide ai.ts:861)。 */
const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const

/**
 * 从开启消息正文里解析模型别名:找首个等于某别名的空白分隔 token(大小写不敏感)。
 * 返回 {alias(小写), rest=去掉该 token 后的正文};无别名返 null。rest 保留 @提及与其余正文。
 */
function parseModelAlias(text: string): { alias: string; rest: string } | null {
  const tokens = text.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const lower = tokens[i].toLowerCase()
    if ((MODEL_ALIASES as readonly string[]).includes(lower)) {
      return { alias: lower, rest: tokens.filter((_, j) => j !== i).join(' ') }
    }
  }
  return null
}

/** 解析逗号分隔列表(空白忽略;未设/空=[])。用于 BOT_ALLOWED_USERS 等发送者白名单。 */
function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

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
  /** esc-中断 watcher 在途轮询间隔(ms);默认 = pollIntervalMs。 */
  interruptPollMs?: number
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
  /** 发送者白名单(账号);非空时只处理列表内 sender 的消息,其余忽略(水位仍推进)。默认空=全部接受。可由 env BOT_ALLOWED_USERS 提供。 */
  allowedUsers?: string[]
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
  /** 发送者白名单;空 Set=全部接受。 */
  allowedUsers: Set<string>
  /** esc-中断 watcher 在途轮询间隔(ms)。 */
  interruptPollMs: number
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

/** 给 promise 套一个超时:超时则 reject(原 promise 不取消,可能晚到但不再阻塞)。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms) })
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t) })
}

/** 把长文本按段落/换行切成 ≤max 的段(尽量不截断行);用于分段发送长 thinking。 */
function chunkThinking(text: string, max = THINKING_CHUNK_MAX): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max) // 优先在换行处切
    if (cut <= 0) cut = max                 // 无换行则硬切
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
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

  // 本助手监控的群 ID:零配置路径(buildModels / welink 通道 / 水位)必填;注入 channel+models 的测试路径可不提供。
  const groupId = options.groupId ?? process.env.WELINK_GROUP_ID
  // 发送者白名单(env BOT_ALLOWED_USERS,逗号分隔);空=全部接受(默认)。在 tick 去重后、route 前过滤。
  const allowedUsers = new Set(options.allowedUsers ?? parseList(process.env.BOT_ALLOWED_USERS))

  let models: Models
  let pipeline: Pipeline
  // sessionLlm:注入则显式;零配置自动取 models.text(对话型,实现 SessionLlm);测试路径默认 undefined(无生命周期)
  let sessionLlm: SessionLlm | undefined = options.sessionLlm

  if (options.models) {
    models = options.models
    pipeline = pickDefaultPipeline(options, models)
  } else if (options.llm) {
    // 旧用法:单 Llm → 平凡 pipeline(无接力,直接单模型)
    models = { default: options.llm }
    pipeline = options.pipeline ?? { steps: [modelStep('default')] }
  } else {
    // 零配置:默认 vision+text + 接力 pipeline + 生命周期(text 模型)
    if (!groupId) throw new Error('runAssistant: groupId required (set options.groupId or WELINK_GROUP_ID)')
    const specs = buildDefaultSpecs(options)
    models = await buildModels(specs, { cwd: options.claudeCwd ?? 'workspace', cliCommand: options.cliCommand, groupId })
    pipeline = pickDefaultPipeline(options, models)
    sessionLlm = options.sessionLlm ?? (models.text as SessionLlm | undefined)
  }

  // 通道:注入用注入的;否则零配置 welink-cli im 群(并注入 state.ts 水位 + groupId)
  let channel = options.channel
  let loadWatermark = options.loadWatermark
  let saveWatermark = options.saveWatermark
  if (!channel) {
    if (!groupId) throw new Error('runAssistant: groupId required (set options.groupId or WELINK_GROUP_ID)')
    channel = (await import('./channels/welink-channel.js')).createWelinkChannel({ groupId })
    // 生产水位:state.ts 持久化(首次返回 undefined → 核心据比排除历史)
    if (!loadWatermark) loadWatermark = async () => loadLastMsgId(groupId)
    if (!saveWatermark) saveWatermark = async (id: string) => saveLastMsgId(groupId, id)
  }

  const renderer = options.renderer ?? (await import('./renderers/puppeteer-renderer.js')).createPuppeteerRenderer()

  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const assistant = new Assistant({
    channel, models, pipeline, renderer, outputPolicy,
    sessionLlm, loadWatermark, saveWatermark,
    exitKeywords: options.exitKeywords ?? DEFAULT_EXIT_KEYWORDS,
    allowedUsers,
    interruptPollMs: options.interruptPollMs ?? pollMs,
    onReceive: options.onReceive, onReply: options.onReply, onError: options.onError,
  })
  if (options.startLoop !== false) {
    assistant.startLoop(pollMs)
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

/**
 * 选 pipeline:options.pipeline 优先;env BOT_PIPELINE=log-qa 时用日志问答 pipeline(需 models.text);
 * 否则默认接力 pipeline。日志场景零配置即:`BOT_PIPELINE=log-qa npm run dev`。
 */
function pickDefaultPipeline(options: AssistantOptions, models: Models): Pipeline {
  if (options.pipeline) return options.pipeline
  if (process.env.BOT_PIPELINE === 'log-qa' && models.text) return createLogQaPipeline()
  return createDefaultPipeline()
}

class Assistant implements AssistantHandle {
  /** 最后处理到的 msgId(水位);undefined=尚未载入(或生产首次,排除历史)。 */
  private watermark: string | undefined
  private watermarkLoaded = false
  private readonly loadWatermark: () => Promise<string | undefined>
  private readonly saveWatermark: (id: string) => Promise<void>
  /** 当前活跃发送者(每群单活跃:null=无人活跃;仅 sessionLlm 注入时使用)。 */
  private activeUserId: string | null = null
  /** esc-中断 watcher 消化掉的 esc msgId 集合;tick 主循环据此跳过(避免又当 exit 处理)。 */
  private readonly consumedEsc = new Set<string>()
  /** 会话级上下文(跨消息保留):预处理 scratch + workspace 路径。@开启 初始化、exit 清理。 */
  private readonly sessionCtx = new Map<string, { scratch: Record<string, unknown>; workspacePath?: string }>()
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
    // 优雅退出:清理各模型底层资源(对话型 SessionPool 的 Claude 子进程;无状态/假实现无 stop 则跳过)。
    // 不打断在途 tick(等当前 await route 自然结束或被 kill 触发 reject);index.ts 的 setTimeout 兜底强退。
    for (const m of Object.values(this.deps.models)) m.stop?.()
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
      // 发送者白名单(BOT_ALLOWED_USERS):非空时只接受列表内 sender,其余跳过(不处理/不回复);
      // 水位已推进故不会重复拉取。空=全部接受(默认)。
      if (this.deps.allowedUsers.size > 0 && !this.deps.allowedUsers.has(msg.user)) {
        if (process.env.BOT_DEBUG) {
          console.log(`[assistant] skip id=${msg.id} sender=${msg.user} (不在白名单)`)
        }
        continue
      }
      // esc-中断:被在途 watcher 消化掉的 esc 不再当 exit 处理(中断已完成;此刻主循环到此处时在途 handle 早已返回)。
      if (this.consumedEsc.has(msg.id)) {
        this.consumedEsc.delete(msg.id)
        if (process.env.BOT_DEBUG) console.log(`[assistant] skip consumed esc id=${msg.id} sender=${msg.user}`)
        continue
      }
      this.deps.onReceive?.(msg)
      if (process.env.BOT_DEBUG) {
        console.log(`[assistant] recv id=${msg.id} sender=${msg.user} at=${msg.at ?? false} type=${msg.type} ${(msg.content ?? '').slice(0, 60)}`)
      }
      try {
        await this.route(msg)
      } catch (err) {
        console.error(`[assistant] route ${msg.id} failed:`, err)
        this.deps.onError?.(msg.user, err as Error)
      }
    }
  }

  /**
   * 生命周期路由(每群单活跃)。注入 sessionLlm:
   *   本人活跃 → exit 结束 / 其余(含继续 @bot)直接处理;
   *   他人 @ → 若已有人活跃则拒绝(提示当前活跃者,不开新会话),否则开启 + ack + (别名)切模型 + 处理;
   *   非本人且非 @ → 忽略(不处理、不回复,不污染现有会话)。
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

    if (process.env.BOT_DEBUG) {
      const st = this.activeUserId === sender ? 'self' : this.activeUserId !== null ? 'busy' : 'idle'
      console.log(`[assistant] route id=${msg.id} sender=${sender} at=${msg.at ?? false} state=${st} exit=${isExit}`)
    }

    if (this.activeUserId === sender) {
      // 本人活跃:exit 结束,否则处理(含继续 @bot 的消息)
      if (isExit) {
        const id = await this.deps.sessionLlm.endSession(sender)
        this.activeUserId = null
        this.sessionCtx.delete(sender)
        const reply = `会话已结束${id ? `,会话 ID: ${id}` : ''}。`
        await this.deps.channel.sendText(sender, reply)
        this.deps.onReply?.(sender, { mode: 'text', reply })
      } else {
        await this.handle(msg)
      }
    } else if (msg.at) {
      if (this.activeUserId !== null) {
        // ★ 已有他人活跃 → 拒绝(仅对 @ 触发;普通消息不回复,避免群发垃圾)
        const reply = `${this.activeUserId} 正在会话中,请待其发送 exit 后再@我。`
        await this.deps.channel.sendText(sender, reply)
        this.deps.onReply?.(sender, { mode: 'text', reply })
        return
      }
      // 无人活跃 + @bot:开启 + 回 ack + (若带模型别名)切模型 + 把本条(剥别名后)丢给 Claude 处理
      await this.deps.sessionLlm.startSession(sender)
      this.activeUserId = sender
      const parsed = parseModelAlias(text)
      let ack: string
      if (parsed) {
        const ok = await this.deps.sessionLlm.setModel(sender, parsed.alias)
        if (!ok) console.warn(`[assistant] setModel(${parsed.alias}) 未命中活跃会话:`, sender)
        ack = `已开启会话(${parsed.alias}),可直接提问;发送 esc/quit/exit 结束。`
      } else {
        ack = '已开启会话,可直接提问;发送 esc/quit/exit 结束。'
      }
      await this.deps.channel.sendText(sender, ack)
      this.deps.onReply?.(sender, { mode: 'text', reply: ack })
      // ★ 会话级上下文初始化:预处理 scratch(跨消息保留)+ workspace 路径(供脚本写产物 / Claude 读)
      try {
        const wp = this.deps.sessionLlm?.getWorkspacePath?.(sender)
        this.sessionCtx.set(sender, { scratch: {}, workspacePath: wp })
      } catch (err) {
        console.error('[assistant] init sessionCtx failed:', err)
      }
      // 剥别名后空或仅剩 @提及 → 文本消息只 ack 不送 Claude;图片仍处理(图像本身即载荷)
      const rest = parsed?.rest ?? text
      const onlyMention = rest === '' || /^@\S+$/.test(rest)
      if (msg.type === 'text' && onlyMention) return
      if (parsed) msg.content = parsed.rest
      await this.handle(msg)
    }
    // 非本人且非 @:忽略(不处理、不回复)
  }

  /**
   * esc-中断 watcher:handle() 在途期间并发轮询,捕获活跃用户发来的 esc → 中断在途 Claude 调用。
   * 返回 stop 函数(handle 结束即停)。仅在 sessionLlm+活跃用户时启用;否则返回 no-op。
   *
   * 背景:tick 主循环串行(await route → await handle → await Claude),esc 到达时主循环正阻塞在在途
   * route,无法处理。故需此并发 watcher 在在途期间轮询,见活跃用户 esc 即向会话 stdin 发 interrupt
   * control_request(参考 vibe-ide ai.ts:885-896),CLI 随后回 result(is_aborted)→ 在途 send 以 aborted resolve。
   *
   * 仅当 interrupt 真正命中活跃会话(返 true)才把该 esc 记入 consumedEsc → tick 主循环后续跳过它(否则会
   * 又当 exit 退出会话,与"中断=保持会话"冲突)。返 false(在途步骤尚是无状态 vision、pooled 会话未建)
   * 不消费、续轮询,待 text 会话建起再中断。主循环此刻阻塞在 await route,无并发 watermark 推进,故无竞争。
   */
  private startInterruptWatcher(userId: string): () => void {
    if (!this.deps.sessionLlm || this.activeUserId !== userId) return () => {}
    const sessionLlm = this.deps.sessionLlm
    const channel = this.deps.channel
    const interval = this.deps.interruptPollMs
    const exitKeywords = this.deps.exitKeywords
    let stopped = false
    const poll = async (): Promise<void> => {
      while (!stopped) {
        await sleep(interval)
        if (stopped) return
        let batch: IncomingMessage[]
        try {
          batch = await channel.getNewMessages()
        } catch (err) {
          if (process.env.BOT_DEBUG) console.error('[assistant] interrupt watcher poll failed:', err)
          continue
        }
        for (const m of batch) {
          if (m.user !== userId) continue
          if (cmpId(m.id, this.watermark!) <= 0) continue
          const text = (m.content ?? '').trim().toLowerCase()
          if (!exitKeywords.some(k => text === k)) continue
          // 活跃用户在途期间发来 esc → 中断
          let interrupted = false
          try {
            interrupted = !!(await sessionLlm.interrupt?.(userId))
          } catch (err) {
            console.error('[assistant] interrupt failed:', err)
          }
          if (!interrupted) continue // 无在途活跃会话(可能在 vision 等无状态步骤);不消费,继续轮询
          this.consumedEsc.add(m.id)
          if (process.env.BOT_DEBUG) console.log(`[assistant] interrupt sent for id=${m.id} sender=${userId} (in-flight esc)`)
          return // 已中断,在途 handle 将以 aborted resolve;watcher 退出
        }
      }
    }
    void poll()
    return () => { stopped = true }
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    // 流式 thinking:每完成一个 thinking 块先发 `💭 ` 纯文本(绕过 outputPolicy,永不触发 html/picture);
    // 串行排队,最终回复前 drain → 保证"先 think 后结果"。includeThinking=off 时 onPartial 不触发,chain 恒 resolved。
    let partialChain: Promise<void> = Promise.resolve()
    const onPartial: OnPartial = (p) => {
      if (!p.thinking) return
      for (const chunk of chunkThinking(p.thinking)) {
        partialChain = partialChain
          .then(() => withTimeout(this.deps.channel.sendText(msg.user, `💭 ${chunk}`), THINKING_SEND_TIMEOUT_MS))
          .catch(() => { /* 单条 thinking 发送失败/超时不阻断后续与最终回复 */ })
      }
    }
    // esc-中断 watcher:仅在活跃用户+对话模型时并发轮询(handle 在途期间主循环阻塞,esc 只能由此捕获);finally 停。
    const stopWatcher = this.startInterruptWatcher(msg.user)
    try {
      const content = await this.toUserContent(msg)
      const s = this.sessionCtx.get(msg.user)
      const ctx: StepCtx = {
        userId: msg.user,
        content,
        scratch: {},
        // 会话级 scratch(同一引用,step mutate 直接生效到 map,跨消息保留)
        session: s?.scratch ?? {},
        workspacePath: s?.workspacePath,
        onPartial,
      }
      const reply = await runPipeline(this.deps.pipeline, this.deps.models, ctx)

      // 等 thinking 消息发完再发最终回复(先 think 后结果)
      await partialChain

      // esc 中断在途命令 → 发"已中断"提示,不退出会话(一次 esc 中断、二次 esc 退出)
      if (ctx.aborted) {
        const notice = '🛑已中断,再次发送 esc 可退出会话。'
        await this.deps.channel.sendText(msg.user, notice)
        this.deps.onReply?.(msg.user, { mode: 'text', reply: notice })
        return
      }

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
      // 先 drain 在途 thinking(防 thinking 与致歉乱序),再发纯文本致歉,循环不死
      await partialChain.catch(() => {})
      try {
        await this.deps.channel.sendText(msg.user, `抱歉,处理该消息时出错:${(err as Error).message}`)
      } catch {
        /* sendText 自身也失败时,无能为力,记日志即可 */
      }
      throw err
    } finally {
      stopWatcher()
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
