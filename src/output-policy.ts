// 输出策略:按最终回复是否 Markdown,决定发 picture(渲染截图)还是 text(直发)。
// 可换其他策略函数(如未来"含 todo 列表 → text")——Assistant 经 outputPolicy 注入。

export type OutputMode = 'text' | 'picture'
export type OutputPolicy = (reply: string) => OutputMode

// Markdown 启发式特征:命中任一即视为 Markdown(→ picture 渲染),否则纯文本(→ text)。
const MARKDOWN_PATTERNS: RegExp[] = [
  /^#{1,6}\s/m,            // 标题 # / ## / ...
  /```/,                    // 围栏代码块
  /^\|.+\|\s*$/m,          // 表格行(|...|)
  /^\s*([-*+]\s|\d+[.)]\s)/m, // 无序/有序列表
  /^>\s/m,                  // 引用
  /\*\*[^*]+\*\*/,          // 粗体 **...**
]

export function isMarkdown(s: string): boolean {
  if (!s) return false
  return MARKDOWN_PATTERNS.some(re => re.test(s))
}

/** 默认策略:Markdown → picture(渲染),纯文本 → text(直发)。 */
export const markdownOutputPolicy: OutputPolicy = (reply) =>
  isMarkdown(reply) ? 'picture' : 'text'
