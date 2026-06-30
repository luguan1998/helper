// 多模型接力 pipeline:线性 steps,每步 mutate StepCtx。
// modelStep 调命名模型 → ctx.reply;scriptStep 纯变换(可读 reply/scratch、改写 content 供下一步)。
// runScriptFile 调外部脚本(stdin JSON → stdout JSON,透传 summary/artifacts),会话预处理等确定性场景用。
// 分支逻辑写在 script 步骤内(如"若是图片才调 vision"、"触发器命中才跑"),不引入 DAG。
import { execFileCmd } from './win-spawn.js'
import { execPath } from 'node:process'
import type { Models } from './llm.js'
import type { UserContent, OnPartial } from './types.js'

/** 步骤间上下文:content 喂下一个模型;scratch 给脚本暂存(消息级,每条新建);reply 是上一个模型输出。
 *  session 是会话级暂存(跨消息保留:@开启 时初始化、exit 时清理)——预处理产物元信息、按输入去重状态等放这里
 *  (约定保留键前缀 `__`,如 session.__preprocess);workspacePath 是该会话的 workspace 子目录路径,供脚本写文件 / Claude 读产物。
 *  onPartial 是流式回调(thinking 块完成时触发),由 Assistant 注入、modelStep 透传给 Llm.ask。
 *  notify 是中途通知回调(preprocess 完成产物后调它把摘要发到群),由 Assistant 注入、preprocess step 调用。 */
export interface StepCtx {
  userId: string
  content: UserContent
  scratch: Record<string, unknown>
  /** 会话级(跨消息保留)。step mutate 直接生效到 Assistant 持有的引用。 */
  session: Record<string, unknown>
  /** 会话 workspace 子目录路径(text 会话才有;无状态/未注入 sessionLlm 时 undefined)。 */
  workspacePath?: string
  reply?: string
  /** 上一模型回复是否被用户 esc 中断;modelStep 透传 Reply.aborted。handle() 据此发"已中断"提示而非渲染回复。 */
  aborted?: boolean
  /** 流式回调:模型生成中每完成一个 thinking 块时触发(Assistant 注入,经 modelStep 透传给 Llm.ask)。 */
  onPartial?: OnPartial
  /** 中途通知回调:preprocess step 完成产物后调它把摘要发到群(Assistant 注入,串行排队,先于最终回复 drain)。 */
  notify?: (text: string) => void
}

export type Step = (ctx: StepCtx, models: Models) => Promise<void>

export interface Pipeline {
  steps: Step[]
}

/** 顺序跑 steps,返回最终 ctx.reply(最终模型 markdown)。 */
export async function runPipeline(p: Pipeline, models: Models, ctx: StepCtx): Promise<string> {
  for (const step of p.steps) {
    await step(ctx, models)
  }
  return ctx.reply ?? ''
}

/** 调命名模型,把回复 markdown 写入 ctx.reply(不改 content——由后续 script 决定是否重组)。 */
export function modelStep(name: string): Step {
  return async (ctx, models) => {
    const model = models[name]
    if (!model) throw new Error(`model '${name}' not found in registry`)
    const reply = await model.ask(ctx.userId, ctx.content, ctx.onPartial)
    ctx.reply = reply.markdown
    ctx.aborted = reply.aborted
  }
}

/** 纯变换脚本:读 ctx.reply/ctx.scratch/ctx.session,改写 ctx.content(为下一个模型准备)。 */
export function scriptStep(fn: (ctx: StepCtx) => Promise<void> | void): Step {
  return async (ctx) => {
    await fn(ctx)
  }
}

/** 外部脚本执行选项:超时 + 解释器 + 额外 stdin 字段。 */
export interface ScriptFileOptions {
  timeoutMs?: number
  /** 解释器:省略=node(.js,默认);'python'/'python3'/'py' 等=跑对应脚本;null=直接跑可执行(.exe/带 shebang)。 */
  interpreter?: string | null
  /** 额外字段并入 stdin JSON payload(与 content/workspacePath 同级)。预处理协议用它传 trigger 信息。 */
  extraInput?: Record<string, unknown>
}

/** 脚本 stdout 的解析结果(透传给调用方):summary/artifacts 是预处理协议字段,由 preprocess step 读取。 */
export interface ScriptFileResult {
  /** 产物摘要(给 AI 的线索)。 */
  summary?: string
  /** 产物描述(dir 相对 workspacePath 或绝对 + 文件清单)。 */
  artifacts?: { dir: string; files: string[] }
  /** 逃生口:协议未来扩展字段原样透传。 */
  [key: string]: unknown
}

/**
 * 跑外部脚本:用指定解释器跑 scriptPath,把 {content, workspacePath, ...extraInput} 经 stdin 传入;
 * 脚本在 workspacePath 下处理(如解压/解析/落产物),stdout 输出 JSON {summary, artifacts?, ...}——原样返回给调用方。
 * stdout 为空 = no-op(返回 undefined)。超时(默认 5min)与脚本错误/非 JSON 输出均抛出,被 handle try/catch 降级。
 * interpreter:省略=node 跑 .js(默认);'python'/'python3'/'py'=跑 .py;null=直接跑 .exe/带 shebang 可执行。
 *   协议见 scripts/preprocess-log.js,拓展见 doc/session-preprocessing.md。会话预处理等确定性场景用(对比 modelStep)。
 * 提为独立函数供 step 内条件调用(如仅触发器命中才跑,避免每条消息都起子进程)。
 */
export async function runScriptFile(ctx: StepCtx, scriptPath: string, opts: ScriptFileOptions = {}): Promise<ScriptFileResult | undefined> {
  const payload: Record<string, unknown> = { content: ctx.content, workspacePath: ctx.workspacePath }
  if (opts.extraInput) Object.assign(payload, opts.extraInput)
  const input = JSON.stringify(payload)
  const direct = opts.interpreter === null
  const cmd = direct ? scriptPath : (opts.interpreter ?? execPath)
  const args = direct ? [] : [scriptPath]
  // 经 execFileCmd(cross-spawn):.cmd/.bat 解析底层 exe 无 shell,脚本路径/JSON input 的空格/换行/`"`/`%` 全安全
  const stdout: string = await execFileCmd(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 300_000,
    input,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return undefined // 脚本 no-op(如本类型无待处理输入)
  try {
    return JSON.parse(trimmed) as ScriptFileResult
  } catch {
    throw new Error(`runScriptFile(${scriptPath}) stdout 非 JSON: ${trimmed.slice(0, 200)}`)
  }
}
