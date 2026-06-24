// Channel 端口 —— true-external(通讯软件 link CLI)。
// 两套适配器:LinkChannel(生产)/ FakeChannel(测试),故为真接缝。
import type { IncomingMessage } from '../types.js'

export interface Channel {
  /** 拉取最新一批消息(link get --number N)。核心自行去重。 */
  getNewMessages(): Promise<IncomingMessage[]>
  /** 发送纯文本(link send --user --content)。 */
  sendText(userId: string, text: string): Promise<void>
  /** 发送图片(link send --user --picture)。 */
  sendPicture(userId: string, imagePath: string): Promise<void>
}
