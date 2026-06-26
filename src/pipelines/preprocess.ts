// 通用会话预处理 steps:守卫+抽取 → 预处理(条件)→ 问答组装。
// 被 createDefaultPipeline(默认内置,零配置即支持)与 createLogQaPipeline(日志特化)复用。
// 触发:消息正文含文件路径(绝对路径+扩展名)→ session.pendingInput;预处理只在 pendingInput 存在时跑
//   (条件跑,避免每条消息都 spawn 脚本)。产物落 ctx.workspacePath,回写 session.preprocessed/files/summary;
//   守卫 preprocessed 保证只跑一次(失败不标可重试)。问答组装把 workspacePath+summary 注入 content。
import { scriptStep, runScriptFile, type Step } from '../pipeline.js'
import type { UserContent } from '../types.js'

/** 从正文抽文件路径(Windows 盘符 / Unix 绝对;带扩展名)。exts 限定则只匹配这些扩展名(如日志场景)。 */
export function extractFilePath(content: UserContent, exts?: readonly string[]): string | undefined {
  if (content.kind !== 'text') return undefined
  const extPat = exts ? `(?:${exts.join('|')})` : '[a-zA-Z0-9]+'
  const re = new RegExp(`([A-Za-z]:[\\\\/][^\\s,，]+\\.${extPat}|/[^\\s,，]+\\.${extPat})`, 'i')
  return content.text.match(re)?.[1]
}

export interface PreprocessStepsOptions {
  /** 预处理脚本路径(driver:'script' 时用)。 */
  scriptPath: string
  /** 脚本解释器:省略=node;'python'/'py' 等;null=直接跑 exe。 */
  interpreter?: string | null
  /** 脚本超时毫秒(默认 5min)。 */
  timeoutMs?: number
  /** 'script'(默认,确定性脚本)/ 'claude'(同会话 Claude 驱动)。 */
  driver?: 'script' | 'claude'
  /** 限定触发扩展名;省略=任意带扩展名文件(通用)。 */
  exts?: readonly string[]
}

/**
 * 返回 [守卫+抽取, 预处理(条件), 问答组装] 三步,插在 text 模型前。
 *   step1 守卫+抽取:已预处理跳过;否则从正文抽路径,有则记 session.pendingInput。
 *   step2 预处理(条件):仅 pendingInput 存在才跑——script=runScriptFile 跑脚本;claude=同会话 Claude 用 bash。
 *   step3 问答组装:已预处理则把 workspacePath+summary 注入 content;否则原样(正常问答)。
 */
export function preprocessSteps(opts: PreprocessStepsOptions): Step[] {
  const driver = opts.driver ?? 'script'
  return [
    // step1: 守卫 + 触发抽取
    scriptStep((ctx) => {
      if (ctx.session.preprocessed) return // 已预处理,跳过
      const input = extractFilePath(ctx.content, opts.exts)
      if (!input) return // 非触发消息,不标记(等以后发文件)
      ctx.session.pendingInput = input
    }),
    // step2: 预处理(条件:仅 pendingInput 存在才跑,避免每条消息 spawn)
    driver === 'script'
      ? async (ctx) => {
          if (!ctx.session.pendingInput) return
          await runScriptFile(ctx, opts.scriptPath, { timeoutMs: opts.timeoutMs, interpreter: opts.interpreter })
        }
      : async (ctx, models) => {
          if (!ctx.session.pendingInput) return
          const r = await models.text.ask(ctx.userId, {
            kind: 'text',
            text: `请预处理 ${ctx.session.pendingInput}:在当前工作目录下解压并解析,产物文件留在目录内,最后用一段话总结产物清单与可查询的关键线索。`,
          })
          ctx.session.preprocessed = true
          ctx.session.summary = r.markdown
        },
    // step3: 问答组装(注入 workspace 路径 + 产物线索)
    scriptStep((ctx) => {
      if (!ctx.session.preprocessed) return // 未预处理:content 保持原样(正常问答)
      const summary = typeof ctx.session.summary === 'string' ? ctx.session.summary : ''
      const q = ctx.content.kind === 'text' ? ctx.content.text : ''
      ctx.content = {
        kind: 'text',
        text: `已预处理,产物目录 ${ctx.workspacePath ?? '(未知)'}。\n${summary}\n可用 grep/read 按需查询目录内文件。\n\n用户问题:${q}`,
      }
    }),
  ]
}
