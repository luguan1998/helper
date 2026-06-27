// Markdown → 完整 HTML 文档(marked + highlight.js)。
// 一适配器(纯字符串变换),不开端口;PuppeteerRenderer setContent 用它。
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      try {
        return hljs.highlight(code, { language }).value
      } catch {
        return code
      }
    },
  }),
)

// highlight.js github 浅色主题(精简:仅 token 配色;基础 background/padding 交由 pre,避免双重内边距)。
const HLJS_GITHUB_LIGHT = `
.hljs { color: #24292e; }
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #d73a49; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #005cc5; }
.hljs-string, .hljs-doctag, .hljs-regexp { color: #032f62; }
.hljs-title, .hljs-section, .hljs-selector-id { color: #6f42c1; font-weight: 600; }
.hljs-type, .hljs-built_in, .hljs-builtin-name, .hljs-name { color: #005cc5; }
.hljs-attribute, .hljs-tag, .hljs-symbol { color: #22863a; }
.hljs-meta { color: #6a737d; }
.hljs-deletion { color: #b31d28; background: #ffeef0; }
.hljs-addition { color: #22863a; background: #f0fff4; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
`

/** 把 Markdown 渲染成自包含样式的完整 HTML(供无头浏览器截图或落盘 .html 发群)。 */
export function buildHtml(markdown: string): string {
  const body = marked.parse(markdown, { gfm: true, async: false }) as string
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.75; color: #1a1a2e;
    margin: 0; padding: 0; background: #f6f7f9;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden; /* 兜底:即便有元素溢出,也不让 fullPage 截图被撑宽 */
  }
  .card {
    max-width: 680px; margin: 24px auto;
    background: #ffffff; border-radius: 14px;
    box-shadow: 0 6px 24px rgba(20, 20, 50, 0.07);
    padding: 34px 38px;
    overflow-wrap: anywhere; /* 超长 URL/无空格串能断行,不撑破卡片(继承给所有文本子元素) */
  }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.4em 0 .5em; color: #1a1a2e; }
  h1 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: .25em; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.12em; }
  .card > :first-child { margin-top: 0; }
  p { margin: .65em 0; }
  a { color: #6366f1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 1.6em; margin: .6em 0; }
  li { margin: .25em 0; }
  pre {
    background: #f6f8fa; border-radius: 10px; padding: 16px 18px;
    font-size: 13px; line-height: 1.6; margin: 1em 0;
    white-space: pre-wrap; /* 截图是图片、无法横向滚动:代码自动换行,长行完整可见而非被裁断 */
  }
  code { font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace; }
  :not(pre) > code {
    background: #eef; color: #6366f1;
    padding: .15em .4em; border-radius: 4px; font-size: .9em;
  }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; table-layout: fixed; } /* 固定列宽:长内容换行而不撑破表格 */
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f5f3ff; font-weight: 600; }
  img { max-width: 100%; border-radius: 6px; }
  blockquote {
    border-left: 4px solid #6366f1; margin: 1em 0; padding: .3em 1em;
    color: #555; background: #f5f3ff; border-radius: 0 8px 8px 0;
  }
  hr { border: none; border-top: 1px solid #eee; margin: 1.4em 0; }
  ${HLJS_GITHUB_LIGHT}
</style>
</head>
<body>
  <div class="card">
${body}
  </div>
</body>
</html>`
}
