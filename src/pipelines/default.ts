// 默认接力 pipeline:识图(vision)→ 脚本组装 → 通用会话预处理 → 文本分析(text)。
// 文本消息:step1/2 跳过;带文件路径则触发预处理(step3-5);step6 text 回答。图片:vision→组装→(预处理)→text。
// 预处理默认内置(零配置即支持):env BOT_PREPROCESS_SCRIPT/BOT_PREPROCESS_INTERPRETER 配脚本+解释器(node/python/exe)。
import { modelStep, scriptStep, type Pipeline } from '../pipeline.js'
import { preprocessSteps } from './preprocess.js'

/** 解析 env BOT_PREPROCESS_INTERPRETER:未设=node;'python'/'py'/'python3' 等=该解释器;'null'/'none'/'direct'=直接跑 exe。 */
function parseInterpreter(env: string | undefined): string | null | undefined {
  if (env === undefined) return undefined
  if (env === 'null' || env === 'none' || env === 'direct') return null
  return env
}

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
      // step2:若是图片,把描述 + 用户附言 组装成文本 content 喂后续
      scriptStep((ctx) => {
        if (ctx.content.kind === 'image') {
          const caption = ctx.content.caption ?? ''
          ctx.content = { kind: 'text', text: `图片内容:\n${ctx.scratch.imageDesc ?? ''}\n\n${caption}` }
        }
      }),
      // step3-5: 通用会话预处理(默认内置;env 配脚本+解释器,支持 node/python/exe;条件跑,仅带路径消息才 spawn)
      ...preprocessSteps({
        scriptPath: process.env.BOT_PREPROCESS_SCRIPT ?? 'scripts/preprocess-log.js',
        interpreter: parseInterpreter(process.env.BOT_PREPROCESS_INTERPRETER),
      }),
      // step6: text 模型分析 → ctx.reply(最终回复)
      modelStep('text'),
    ],
  }
}
