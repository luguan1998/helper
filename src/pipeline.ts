// 多模型接力 pipeline:线性 steps,每步 mutate StepCtx。
// modelStep 调命名模型 → ctx.reply;scriptStep 纯变换(可读 reply/scratch、改写 content 供下一步)。
// scriptFileStep 调外部脚本(stdin JSON → stdout JSON,merge session/content),会话预处理等确定性场景用。
// 分支逻辑写在 script 步骤内(如"若是图片才调 vision"、"若未预处理且带日志才跑"),不引入 DAG。
import { execFileCmd } from './win-spawn.js'
import { execPath } from 'node:process'
import type { Models } from './llm.js'
import type { UserContent, OnPartial } from './types.js'

/** 步骤间上下文:content 喂下一个模型;scratch 给脚本暂存;reply 是上一个模型输出。
 *  session 是会话级暂存(跨消息保留:@开启 时初始化、exit 时清理)——预处理产物元信息、"已预处理"
 *  守卫标志等放这里;workspacePath 是该会话的 workspace 子目录路径,供脚本写文件 / Claude 读产物。
 *  onPartial 是流式回调(thinking 块完成时触发),由 Assistant 注入、modelStep 透传给 Llm.ask。 */
export interface StepCtx {
  userId: string
  content: UserContent
  scratch: Record<string, unknown>
  /** 会话级(跨消息保留)。step mutate 直接生效到 Assistant 持有的引用。 */
  session: Record<string, unknown>
  /** 会话 workspace 子目录路径(text 会话才有;无状态/未注入 sessionLlm 时 undefined)。 */
  workspacePath?: string
  reply?: string
  /** 流式回调:模型生成中每完成一个 thinking 块时触发(Assistant 注入,经 modelStep 透传给 Llm.ask)。 */
  onPartial?: OnPartial
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
  }
}

/** 纯变换脚本:读 ctx.reply/ctx.scratch/ctx.session,改写 ctx.content(为下一个模型准备)。 */
export function scriptStep(fn: (ctx: StepCtx) => Promise<void> | void): Step {
  return async (ctx) => {
    await fn(ctx)
  }
}

/** 外部脚本执行选项:超时 + 解释器。 */
export interface ScriptFileOptions {
  timeoutMs?: number
  /** 解释器:省略=node(.js,默认);'python'/'python3'/'py' 等=跑对应脚本;null=直接跑可执行(.exe/带 shebang)。 */
  interpreter?: string | null
}

/**
 * 跑外部脚本:用指定解释器跑 scriptPath,把 {content, session, workspacePath} 经 stdin 传入;
 * 脚本在 workspacePath 下处理(如解压/解析/落产物),stdout 输出 JSON {session?, content?}——
 * session 增量 merge 进 ctx.session,content 覆盖 ctx.content。stdout 为空 = no-op(跳过)。
 * 超时(默认 5min)与脚本错误/非 JSON 输出均抛出,被 handle try/catch 降级(发纯文本致歉,循环不死)。
 * interpreter:省略=node 跑 .js(默认);'python'/'python3'/'py'=跑 .py;null=直接跑 .exe/带 shebang 可执行。
 *   协议见 scripts/preprocess-log.js,拓展见 doc/session-preprocessing.md。会话预处理等确定性场景用(对比 modelStep)。
 * 提为独立函数供 step 内条件调用(如仅 session.pendingInput 存在才跑,避免每条消息都 spawn)。
 */
export async function runScriptFile(ctx: StepCtx, scriptPath: string, opts: ScriptFileOptions = {}): Promise<void> {
  const input = JSON.stringify({ content: ctx.content, session: ctx.session, workspacePath: ctx.workspacePath })
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
  if (!trimmed) return // 脚本 no-op(如会话尚无 pendingInput)
  let delta: { session?: Record<string, unknown>; content?: UserContent }
  try {
    delta = JSON.parse(trimmed)
  } catch {
    throw new Error(`runScriptFile(${scriptPath}) stdout 非 JSON: ${trimmed.slice(0, 200)}`)
  }
  if (delta.session && typeof delta.session === 'object') Object.assign(ctx.session, delta.session)
  if (delta.content) ctx.content = delta.content
}

/** 外部脚本 step:每条消息无条件跑 scriptPath。要条件跑(如仅待处理输入存在才跑)请用 runScriptFile。 */
export function scriptFileStep(scriptPath: string, opts: ScriptFileOptions = {}): Step {
  return async (ctx) => runScriptFile(ctx, scriptPath, opts)
}
