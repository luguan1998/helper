// 默认接力 pipeline:识图(vision)→ 脚本组装 → 通用会话预处理(specs)→ 文本分析(text)。
// 文本消息:step1/2 跳过;带文件路径则触发预处理(step3-5);step6 text 回答。图片:vision→组装→(预处理)→text。
// 预处理 specs 由调用方传入(runAssistant 经 loadPreprocessSpecs() 载入:env BOT_PREPROCESS_CONFIG .mjs 或内置默认)。
import { modelStep, scriptStep, type Pipeline } from '../pipeline.js'
import { preprocessSteps, fileRefLandingStep, type PreprocessSpec } from './preprocess.js'
import { downloadFile } from '../image.js'

export function createDefaultPipeline(specs: readonly PreprocessSpec[]): Pipeline {
  return {
    steps: [
      // step1:若是图片,调 vision 识图,描述存 scratch;文本跳过
      async (ctx, models) => {
        if (ctx.content.kind === 'image') {
          const reply = await models.vision.ask(ctx.userId, ctx.content)
          ctx.scratch.imageDesc = reply.markdown
        }
      },
      // step2:若是图片,把描述 + 用户附言 组装成文本 content 喂后续
      scriptStep((ctx) => {
        if (ctx.content.kind === 'image') {
          const caption = ctx.content.caption ?? ''
          ctx.content = { kind: 'text', text: `图片内容:\n${ctx.scratch.imageDesc ?? ''}\n\n${caption}` }
        }
      }),
      // step2.5: 附件落地——CARD_MSG 引用文件时(scratch.fileRef 由 handle 挂入)下载到 workspace/downloads
      // 并 push 到 scratch.fired(绕过路径正则,对含空格路径稳健)。无 fileRef / 无 'file' spec 则跳过。
      fileRefLandingStep(specs, downloadFile),
      // step3-5: 通用会话预处理(多 spec;按输入去重;条件跑,仅触发器命中才 spawn)
      ...preprocessSteps(specs),
      // step6: text 模型分析 → ctx.reply(最终回复)
      modelStep('text'),
    ],
  }
}
