// 测试假实现:Channel / Llm / Renderer 三接缝的 in-memory 替身。
// 注入到 runAssistant({ startLoop:false }) 后,核心编排可无外部依赖瞬跑。
import type { Channel } from '../src/channels/channel.js'
import type { Llm } from '../src/llm.js'
import type { Renderer } from '../src/renderers/renderer.js'
import type { IncomingMessage, Reply, UserContent } from '../src/types.js'

/** 把一批消息塞进 queue,每次 getNewMessages 取走并清空(模拟 link get 一次性返回)。 */
export class FakeChannel implements Channel {
  queue: IncomingMessage[] = []
  sentText: Array<{ user: string; text: string }> = []
  sentPicture: Array<{ user: string; imagePath: string }> = []

  constructor(messages: IncomingMessage[] = []) {
    this.queue = [...messages]
  }

  /** 测试在两次 tick 之间向 queue 追加新消息。 */
  push(...msgs: IncomingMessage[]): void {
    this.queue.push(...msgs)
  }

  async getNewMessages(): Promise<IncomingMessage[]> {
    const batch = this.queue
    this.queue = []
    return batch
  }
  async sendText(user: string, text: string): Promise<void> {
    this.sentText.push({ user, text })
  }
  async sendPicture(user: string, imagePath: string): Promise<void> {
    this.sentPicture.push({ user, imagePath })
  }
}

/** 默认回固定 Reply;可传函数按输入决定;shouldThrow=true 模拟降级路径(可运行时切换)。 */
export class FakeLlm implements Llm {
  calls: Array<{ userId: string; content: UserContent }> = []
  shouldThrow: boolean
  constructor(
    private readonly reply: Reply | ((userId: string, content: UserContent) => Reply) = { markdown: '## 回复\n已收到。' },
    shouldThrow = false,
  ) {
    this.shouldThrow = shouldThrow
  }
  async ask(userId: string, content: UserContent): Promise<Reply> {
    this.calls.push({ userId, content })
    if (this.shouldThrow) throw new Error('FakeLlm boom')
    return typeof this.reply === 'function' ? this.reply(userId, content) : this.reply
  }
}

/** 记录每次渲染的 Markdown,返回固定图片路径。 */
export class FakeRenderer implements Renderer {
  calls: string[] = []
  constructor(private readonly imagePath = '/tmp/fake.png') {}
  async markdownToImage(markdown: string): Promise<string> {
    this.calls.push(markdown)
    return this.imagePath
  }
}
