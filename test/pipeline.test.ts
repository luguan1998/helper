// pipeline 接力单测:注入假 models(vision/text),验证图片走 3 步接力、文本走 1 步。
import { describe, it, expect } from 'vitest'
import { runPipeline, modelStep, scriptStep, type Pipeline, type StepCtx } from '../src/pipeline.js'
import type { Models } from '../src/llm.js'
import { FakeLlm } from './fakes.js'

/** 构造与默认 pipeline 同构的接力步骤(识图 → 组装 → 文本分析)。 */
function relaySteps(): Pipeline['steps'] {
  return [
    // step1:若是图片,调 vision 识图,描述存 scratch;文本跳过
    async (ctx, models) => {
      if (ctx.content.kind === 'image') {
        const r = await models.vision.ask(ctx.userId, ctx.content)
        ctx.scratch.imageDesc = r.markdown
      }
    },
    // step2:若是图片,组装成文本 content 喂 text 模型
    scriptStep((ctx) => {
      if (ctx.content.kind === 'image') {
        const caption = ctx.content.caption ?? ''
        ctx.content = { kind: 'text', text: `图片内容:\n${ctx.scratch.imageDesc ?? ''}\n\n${caption}` }
      }
    }),
    // step3:text 模型分析 → ctx.reply
    modelStep('text'),
  ]
}

describe('pipeline relay', () => {
  it('图片消息:vision 识图 → 脚本组装 → text 分析(3 步接力)', async () => {
    const vision = new FakeLlm({ markdown: '图片描述:一只橘猫' })
    const text = new FakeLlm({ markdown: '# 分析\n这是一只橘猫的图片' })
    const models: Models = { vision, text }

    const ctx: StepCtx = {
      userId: 'u1',
      content: { kind: 'image', imagePath: '/tmp/cat.png', caption: '这是什么?' },
      scratch: {},
    }
    const reply = await runPipeline({ steps: relaySteps() }, models, ctx)

    expect(vision.calls).toHaveLength(1)
    expect(vision.calls[0].content.kind).toBe('image')
    expect(text.calls).toHaveLength(1)
    // text 收到的是组装后的文本(含图片描述),而非原始图片
    expect(text.calls[0].content).toMatchObject({ kind: 'text' })
    expect((text.calls[0].content as { text: string }).text).toContain('图片描述:一只橘猫')
    expect(reply).toBe('# 分析\n这是一只橘猫的图片')
  })

  it('文本消息:跳过 vision,直接 text 分析(1 步)', async () => {
    const vision = new FakeLlm({ markdown: '不应被调用' })
    const text = new FakeLlm({ markdown: '好的,已为您处理' })
    const models: Models = { vision, text }

    const ctx: StepCtx = {
      userId: 'u1',
      content: { kind: 'text', text: '帮我处理一下' },
      scratch: {},
    }
    const reply = await runPipeline({ steps: relaySteps() }, models, ctx)

    expect(vision.calls).toHaveLength(0)       // 文本不触发识图
    expect(text.calls).toHaveLength(1)
    expect((text.calls[0].content as { text: string }).text).toBe('帮我处理一下')
    expect(reply).toBe('好的,已为您处理')
  })

  it('modelStep 缺名 → 抛错', async () => {
    const models: Models = {}
    const ctx: StepCtx = { userId: 'u', content: { kind: 'text', text: 'hi' }, scratch: {} }
    await expect(runPipeline({ steps: [modelStep('missing')] }, models, ctx)).rejects.toThrow(/not found/)
  })
})
