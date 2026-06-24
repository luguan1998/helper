// 多模型接力 pipeline:线性 steps,每步 mutate StepCtx。
// modelStep 调命名模型 → ctx.reply;scriptStep 纯变换(可读 reply/scratch、改写 content 供下一步)。
// 分支逻辑写在 script 步骤内(如"若是图片才调 vision"),不引入 DAG。
import type { Models } from './llm.js'
import type { UserContent } from './types.js'

/** 步骤间上下文:content 喂下一个模型;scratch 给脚本暂存;reply 是上一个模型输出。 */
export interface StepCtx {
  userId: string
  content: UserContent
  scratch: Record<string, unknown>
  reply?: string
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
    const reply = await model.ask(ctx.userId, ctx.content)
    ctx.reply = reply.markdown
  }
}

/** 纯变换脚本:读 ctx.reply/ctx.scratch,改写 ctx.content(为下一个模型准备)。 */
export function scriptStep(fn: (ctx: StepCtx) => Promise<void> | void): Step {
  return async (ctx) => {
    await fn(ctx)
  }
}
