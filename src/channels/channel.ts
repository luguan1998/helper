// Channel 端口 —— true-external(通讯软件 welink-cli im)。
// 两套适配器:WelinkChannel(生产)/ FakeChannel(测试),故为真接缝。
// 群组导向:生产适配器构造时绑定 groupId,send 固定发到该群;userId 形参为发送者(群模型下
// 仅作上下文/日志,实际收件人为群)。去重(只处理新消息)由核心 Assistant 持久化水位负责。
import type { IncomingMessage } from '../types.js'

export interface Channel {
  /** 拉取群最近一批消息(welink-cli im query-history-message,可能含已见)。核心按水位去重。 */
  getNewMessages(): Promise<IncomingMessage[]>
  /** 发纯文本到群(welink-cli im send-to-group --text)。userId=发送者(群模型下被适配器忽略)。 */
  sendText(userId: string, text: string): Promise<void>
  /** 发图片到群(welink-cli im send-to-group --image)。userId=发送者(群模型下被适配器忽略)。 */
  sendPicture(userId: string, imagePath: string): Promise<void>
}
