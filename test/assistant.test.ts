// 核心编排单测:注入假(Channel/Llm/Renderer/Models),零外部依赖验证
// 路由/去重/降级/动态输出(text vs picture)/多模型接力。
import { describe, it, expect } from 'vitest'
import { runAssistant } from '../src/assistant.js'
import { FakeChannel, FakeLlm, FakeRenderer } from './fakes.js'
import type { IncomingMessage } from '../src/types.js'
import type { Models } from '../src/llm.js'

const textMsg = (id: string, user: string, content: string): IncomingMessage => ({
  id, type: 'text', user, content, timestamp: 0,
})
const picMsg = (id: string, user: string, pictureUrl: string): IncomingMessage => ({
  id, type: 'picture', user, pictureUrl, timestamp: 0,
})

describe('assistant core', () => {
  it('Markdown 回复 → sendText(摘要) + sendPicture(截图)', async () => {
    const channel = new FakeChannel([textMsg('1', 'u1', '你好')])
    const llm = new FakeLlm({ markdown: '# 标题\n\n正文内容' })
    const renderer = new FakeRenderer('/tmp/a.png')
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()

    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toEqual({ userId: 'u1', content: { kind: 'text', text: '你好' } })
    expect(renderer.calls).toEqual(['# 标题\n\n正文内容'])
    expect(channel.sentText).toHaveLength(1)
    expect(channel.sentText[0].text).toMatch(/标题.*查看图片/)
    expect(channel.sentPicture).toEqual([{ user: 'u1', imagePath: '/tmp/a.png' }])
  })

  it('纯文本回复 → 只 sendText,不渲染图片', async () => {
    const channel = new FakeChannel([textMsg('1', 'u1', '在吗')])
    const llm = new FakeLlm({ markdown: '好的,我在,请问有什么可以帮您?' })
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()

    expect(renderer.calls).toHaveLength(0)           // 未渲染
    expect(channel.sentPicture).toHaveLength(0)       // 无图
    expect(channel.sentText).toHaveLength(1)
    expect(channel.sentText[0].text).toBe('好的,我在,请问有什么可以帮您?')
  })

  it('picture 消息 → 以 image 内容 ask(旧单 Llm 用法,平凡 pipeline)', async () => {
    const channel = new FakeChannel([picMsg('2', 'u2', '/tmp/in.png')])
    const llm = new FakeLlm({ markdown: '# 已分析' })
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    expect(llm.calls[0].content).toEqual({ kind: 'image', imagePath: '/tmp/in.png', caption: undefined })
  })

  it('去重:重复 id 不重复处理,新 id 才处理', async () => {
    const channel = new FakeChannel([textMsg('x', 'u', 'hi')])
    const llm = new FakeLlm({ markdown: '# ok' })
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    expect(llm.calls).toHaveLength(1)
    channel.push(textMsg('x', 'u', 'hi'), textMsg('y', 'u', 'yo'))
    await a.tick()
    expect(llm.calls).toHaveLength(2)
    expect((llm.calls[1].content as { text: string }).text).toBe('yo')
  })

  it('降级:llm 抛错 → 发纯文本致歉,且循环存活可处理后续消息', async () => {
    const channel = new FakeChannel([textMsg('e', 'u', 'boom')])
    const llm = new FakeLlm({ markdown: '好的' }, true) // shouldThrow
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    expect(channel.sentText[0].text).toMatch(/抱歉/)
    expect(channel.sentPicture).toHaveLength(0)

    // 恢复正常后,下一条(纯文本回复)仍可处理 → 循环未死
    llm.shouldThrow = false
    channel.push(textMsg('f', 'u', 'ok'))
    await a.tick()
    expect(channel.sentText[1].text).toBe('好的')   // 纯文本 → text 模式直发
    expect(channel.sentPicture).toHaveLength(0)
  })

  it('摘要:代码块被折叠,不影响截图原文', async () => {
    const channel = new FakeChannel([textMsg('c', 'u', 'code')])
    const llm = new FakeLlm({ markdown: '前言\n\n```js\nconst x=1\n```\n\n后语' })
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    expect(channel.sentText[0].text).toMatch(/\[代码块\]/)   // 摘要折叠代码块
    expect(renderer.calls[0]).toContain('const x=1')          // 截图原文完整
  })

  it('多模型接力:picture → vision 识图 → 组装 → text 分析 → 截图', async () => {
    const channel = new FakeChannel([picMsg('3', 'u3', '/tmp/cat.png')])
    const vision = new FakeLlm({ markdown: '图片描述:一只橘猫' })
    const text = new FakeLlm({ markdown: '# 分析\n这是一只橘猫的图片' })
    const models: Models = { vision, text }
    const renderer = new FakeRenderer('/tmp/relay.png')
    const a = await runAssistant({ channel, models, renderer, startLoop: false })
    await a.tick()

    expect(vision.calls).toHaveLength(1)
    expect(vision.calls[0].content.kind).toBe('image')
    expect(text.calls).toHaveLength(1)
    // text 收到组装后的文本(含图片描述),而非原始图片
    expect((text.calls[0].content as { text: string }).text).toContain('图片描述:一只橘猫')
    // text 回复是 Markdown → picture 模式
    expect(channel.sentPicture).toEqual([{ user: 'u3', imagePath: '/tmp/relay.png' }])
  })
})
