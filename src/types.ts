// 领域类型(纯数据,无运行时依赖)。

/** 来自通讯软件(link get)的一条原始消息。 */
export interface IncomingMessage {
  id: string
  type: 'text' | 'picture'
  /** 发送者标识(link send --user 用它)。 */
  user: string
  /** text 消息内容。 */
  content?: string
  /** picture 消息的图片 URL / 路径。 */
  pictureUrl?: string
  /** 毫秒时间戳。 */
  timestamp: number
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
