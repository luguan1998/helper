// Markdown → 完整 HTML 文档(marked + highlight.js + mermaid)。
// 一适配器(纯字符串变换),不开端口;PuppeteerRenderer setContent 用它。
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

// ── mermaid ──────────────────────────────────────────────────────────────
// 公司代理拦 CDN/TLS,故 mermaid 本地内联、不联网。启动时从 node_modules 读一次
// (dist 与 src 同跑、cwd 皆项目根,../node_modules 路径两态一致)。读不到则 mermaid
// 支持降级关闭(```mermaid 块退化为源码文本,不崩)。
// 只用 mermaid.min.js:它是 esbuild 打平的自包含 IIFE(3.5MB,206 个 diagram chunk 全内联,
// 末行 globalThis["mermaid"]=…default 挂全局)。ESM 版(mermaid.esm.min.mjs)仅 29KB,是懒加载器
// ——运行时 import("./chunks/…") 相对路径在 blob/内联下解析不了,diagram 全渲染失败,故不用。
const MERMAID_BUNDLE = (() => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const p = join(dir, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
  if (!existsSync(p)) return null
  // </script> 在 classic script 元素里会提前结束元素;bundle 仅在字符串字面量里含它,
  // 转成 <\/script>(JS 里 \/ 即 /,值不变)既防断标签又不损源码。
  return readFileSync(p, 'utf8').replace(/<\/script>/gi, '<\\/script>')
})()

// ```mermaid 代码块经 marked-highlight 输出为 <pre><code class="hljs language-mermaid">…</code></pre>
// (mermaid 非 hljs 已注册语言,回退 plaintext,内容为 HTML 转义后的源码)。
// 换成 <div class="mermaid">…</div> 交 mermaid.js 客户端渲染成 SVG。保持转义态:
// mermaid 读 element.textContent,浏览器自动反转义回原文,无需手动 decode。
const MERMAID_BLOCK_RE = /<pre><code class="hljs language-mermaid">([\s\S]*?)<\/code><\/pre>/g
function transformMermaidBlocks(html: string): { html: string; hasMermaid: boolean } {
  let hasMermaid = false
  const out = html.replace(MERMAID_BLOCK_RE, (_m, code: string) => {
    hasMermaid = true
    return `<div class="mermaid">${code}</div>`
  })
  return { html: out, hasMermaid }
}

// 两段 classic <script>,都放 body 末(见 buildHtml):bundle 先跑、同步挂 globalThis.mermaid;
// init 后跑、此时 .mermaid div 已在 DOM,遂能查到。设 window.mermaidReady:puppeteer 截图前
// waitForFunction 它再 await,确保 SVG 落定再量高。逐图 try/catch + 失败兜底:一张语法错
// 不连累整条回复,也不让截图抛错。securityLevel:'strict' 防 mermaid 标签里塞 <script>
// (html 文件模式收件人打开才执行,strict 经 DOMPurify 清洗,图片模式本就无 XSS 风险)。
const MERMAID_RUNTIME = `
<script id="mermaid-bundle">${MERMAID_BUNDLE ?? ''}</script>
<script id="mermaid-init">
  window.mermaidReady = (async () => {
    try {
      const mermaid = window.mermaid;
      if (!mermaid || typeof mermaid.run !== 'function') return;
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', suppressErrorRendering: true });
      const nodes = Array.from(document.querySelectorAll('.mermaid'));
      await Promise.all(nodes.map(async (n) => {
        try {
          await mermaid.run({ nodes: [n] });
        } catch (e) {
          const msg = String((e && e.message) || e).replace(/&/g, '&amp;').replace(/</g, '&lt;');
          n.innerHTML = '<pre style="color:#b91c1c;background:#fff0f0;padding:12px 14px;border-radius:8px;overflow-wrap:anywhere;font-size:13px">⚠ mermaid 渲染失败:' + msg + '</pre>';
        }
      }));
    } catch (e) {
      console.error('mermaid init failed', e);
    }
  })();
</script>`

const MERMAID_CSS = `
.mermaid { text-align: center; margin: 1em 0; }
.mermaid svg { max-width: 100% !important; height: auto !important; }
`

/** 把 Markdown 渲染成自包含样式的完整 HTML(供无头浏览器截图或落盘 .html 发群)。 */
export function buildHtml(markdown: string): string {
  const parsed = marked.parse(markdown, { gfm: true, async: false }) as string
  const { html: body, hasMermaid } = transformMermaidBlocks(parsed)
  // 仅在有 mermaid 块且 bundle 就绪时才内联(否则保持精简,非 mermaid 回复不增重)。
  // 脚本放 body 末:bundle 同步挂全局后,init 才查 .mermaid——此时 div 已在 DOM(放 head 会查空)。
  const mermaidScripts = hasMermaid && MERMAID_BUNDLE ? MERMAID_RUNTIME : ''
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
  ${MERMAID_CSS}
</style>
</head>
<body>
  <div class="card">
${body}
  </div>
${mermaidScripts}
</body>
</html>`
}
