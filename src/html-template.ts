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

/** 把 Markdown 渲染成带内联样式的完整 HTML(供无头浏览器截图)。 */
export function buildHtml(markdown: string): string {
  const body = marked.parse(markdown, { gfm: true, async: false }) as string
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.7; color: #1a1a2e;
    padding: 24px 28px; margin: 0; background: #ffffff;
  }
  h1, h2, h3 { line-height: 1.3; margin: 1.2em 0 .5em; }
  h1 { font-size: 1.6em; border-bottom: 1px solid #eee; padding-bottom: .2em; }
  h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  p { margin: .6em 0; }
  a { color: #6366f1; }
  ul, ol { padding-left: 1.5em; }
  pre {
    background: #f4f4f5; border-radius: 8px; padding: 14px 16px;
    overflow-x: auto; font-size: 13px;
  }
  code { font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace; }
  :not(pre) > code { background: #f4f4f5; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; margin: .8em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
  th { background: #f4f4f5; }
  img { max-width: 100%; border-radius: 4px; }
  blockquote {
    border-left: 4px solid #6366f1; margin: .8em 0; padding: .2em 1em;
    color: #555; background: #f8f8ff;
  }
  hr { border: none; border-top: 1px solid #eee; margin: 1.2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`
}
