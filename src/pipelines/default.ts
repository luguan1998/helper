// 默认接力 pipeline:识图(vision)→ 脚本组装 → 文本分析(text)。
// 文本消息:step1/2 跳过,直接 step3。图片消息:3 步接力。
import { modelStep, scriptStep, type Pipeline } from '../pipeline.js'

export function createDefaultPipeline(): Pipeline {
  return {
    steps: [
      // step1:若是图片,调 vision 识图,描述存 scratch;文本跳过
      async (ctx, models) => {
        if (ctx.content.kind === 'image') {
          const reply = await models.vision.ask(ctx.userId, ctx.content)
          ctx.scratch.imageDesc = reply.markdown
        }
      },
      // step2:若是图片,把描述 + 用户附言 组装成文本 content 喂 text 模型
      scriptStep((ctx) => {
        if (ctx.content.kind === 'image') {
          const caption = ctx.content.caption ?? ''
          ctx.content = { kind: 'text', text: `图片内容:\n${ctx.scratch.imageDesc ?? ''}\n\n${caption}` }
        }
      }),
      // step3:text 模型分析 → ctx.reply(最终回复)
      modelStep('text'),
    ],
  }
}
