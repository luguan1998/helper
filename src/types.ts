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
  /** 本次回复是否被用户 esc 中断(在途 Claude 调用被 interrupt control_request 打断):true 时 markdown 可能空/残缺,调用方应发"已中断"提示而非渲染回复。 */
  aborted?: boolean
}

/**
 * Llm 生成过程中的中间产物(流式回调用)。
 * 通讯软件不支持流式,故仅"块完整"时回调(非逐 token)——目前只承载已完成的 thinking 块。
 */
export interface ReplyPartial {
  /** 已完成的 thinking 块文本。 */
  thinking?: string
}

/** 流式回调:同步返回(实现方内部用 chain 处理异步,避免泄漏 promise)。 */
export type OnPartial = (partial: ReplyPartial) => void
