// 领域类型(纯数据,无运行时依赖)。

/** 来自通讯软件(welink-cli im query-history-message)的一条群消息。 */
export interface IncomingMessage {
  /** msgId(welink 大整数 >2^53,以 string 携带保精度,用 BigInt 比较)。 */
  id: string
  type: 'text' | 'picture'
  /** 发送者 w3 账号(会话隔离 key;群回复固定发群,不用它寻址)。 */
  user: string
  /** text 消息内容。 */
  content?: string
  /** picture 消息的图片 URL / 路径。 */
  pictureUrl?: string
  /** 毫秒时间戳(serverSendTime)。 */
  timestamp: number
  /** 该消息是否 @ 了 bot(当前登录用户)。激活信号:"@助手 开启"。 */
  at?: boolean
}

/**
 * 喂给 Llm 的用户内容。
 * - text:纯文本提问
 * - image:本地图片路径(由 Channel 下载到本地后填入),直接喂 Claude 多模态视觉(无 OCR 端口)
 */
export type UserContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; imagePath: string; caption?: string }

/** Llm 的回复。 */
export interface Reply {
  /** 完整 Markdown(待 Renderer 渲染成截图)。 */
  markdown: string
}
