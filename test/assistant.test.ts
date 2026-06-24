// 核心编排单测:注入 3 假(Channel/Llm/Renderer),零外部依赖验证路由/去重/降级。
import { describe, it, expect } from 'vitest'
import { runAssistant } from '../src/assistant.js'
import { FakeChannel, FakeLlm, FakeRenderer } from './fakes.js'
import type { IncomingMessage } from '../src/types.js'

const textMsg = (id: string, user: string, content: string): IncomingMessage => ({
  id, type: 'text', user, content, timestamp: 0,
})
const picMsg = (id: string, user: string, pictureUrl: string): IncomingMessage => ({
  id, type: 'picture', user, pictureUrl, timestamp: 0,
})

describe('assistant core', () => {
  it('text 消息 → ask 一次 → sendText(摘要) + sendPicture(截图)', async () => {
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

  it('picture 消息 → 以 image 内容 ask(本地路径原样喂 Claude 视觉)', async () => {
    const channel = new FakeChannel([picMsg('2', 'u2', '/tmp/in.png')])
    const llm = new FakeLlm()
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    expect(llm.calls[0].content).toEqual({ kind: 'image', imagePath: '/tmp/in.png', caption: undefined })
  })

  it('去重:重复 id 不重复处理,新 id 才处理', async () => {
    const channel = new FakeChannel([textMsg('x', 'u', 'hi')])
    const llm = new FakeLlm()
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })

    await a.tick()
    expect(llm.calls).toHaveLength(1)

    // 第二个 tick:重复 x + 新 y
    channel.push(textMsg('x', 'u', 'hi'), textMsg('y', 'u', 'yo'))
    await a.tick()
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1].content).toEqual({ kind: 'text', text: 'yo' })
  })

  it('降级:llm 抛错 → 发纯文本致歉,且循环存活可处理后续消息', async () => {
    const channel = new FakeChannel([textMsg('e', 'u', 'boom')])
    const llm = new FakeLlm({ markdown: 'x' }, true) // shouldThrow
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })

    await a.tick()
    expect(channel.sentText[0].text).toMatch(/抱歉/)
    expect(channel.sentPicture).toHaveLength(0)

    // 恢复正常后,下一条仍可处理 → 循环未死
    llm.shouldThrow = false
    channel.push(textMsg('f', 'u', 'ok'))
    await a.tick()
    expect(channel.sentPicture).toHaveLength(1)
    expect(channel.sentPicture[0]).toEqual({ user: 'u', imagePath: '/tmp/fake.png' })
  })

  it('摘要:代码块被折叠,不影响截图原文', async () => {
    const channel = new FakeChannel([textMsg('c', 'u', 'code')])
    const llm = new FakeLlm({ markdown: '前言\n\n```js\nconst x=1\n```\n\n后语' })
    const renderer = new FakeRenderer()
    const a = await runAssistant({ channel, llm, renderer, startLoop: false })
    await a.tick()
    // sendText 摘要里代码块已折叠为 [代码块],但传给 renderer 的原文完整
    expect(channel.sentText[0].text).toMatch(/\[代码块\]/)
    expect(renderer.calls[0]).toContain('const x=1')
  })
})
