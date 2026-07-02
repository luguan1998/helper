// 一次性验证:buildHtml + mermaid 渲染(单浏览器,带计时)。
// 跑法:npx tsx scripts/mermaid-check.ts
import { buildHtml } from '../src/html-template.js'
import { writeFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

function resolveChrome(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) if (c && existsSync(c)) return c
  throw new Error('no chrome/edge found')
}
const t = (s: string) => console.log(`[${performance.now().toFixed(0)}ms] ${s}`)

const md = `# Mermaid 渲染验证

## 流程图

\`\`\`mermaid
flowchart LR
  A[用户提问] --> B{需要识图?}
  B -- 是 --> C[vision 模型]
  B -- 否 --> D[text 模型]
  C --> D
  D --> E[回复发群]
\`\`\`

## 时序图

\`\`\`mermaid
sequenceDiagram
  participant U as 用户
  participant B as Bot
  participant C as Claude
  U->>B: @bot 问题
  B->>C: ask
  C-->>B: 回复
  B-->>U: 图片
\`\`\`
`

t('start')
const html = buildHtml(md)
t(`buildHtml done (${(html.length / 1048576).toFixed(1)}MB)`)
writeFileSync('mermaid-test.html', html, 'utf8')
t('wrote mermaid-test.html')

const browser = await puppeteer.launch({ executablePath: resolveChrome(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] })
t('browser launched')
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 720, height: 800, deviceScaleFactor: 2 })
  t('setContent ...')
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 120000 })
  t('setContent done')
  await page.waitForFunction('() => !!window.mermaidReady', { timeout: 30000 }).catch(() => t('waitForFunction timed out'))
  await page.evaluate(async () => { if ((window as any).mermaidReady) await (window as any).mermaidReady }).catch(() => {})
  t('mermaidReady awaited')
  const probe = await page.evaluate(() => ({
    divs: document.querySelectorAll('.mermaid').length,
    renderedSvg: document.querySelectorAll('.mermaid svg').length,
    errorFallbacks: document.querySelectorAll('.mermaid pre').length,
    hasMermaidGlobal: typeof (window as any).mermaid === 'object',
  }))
  t(`probe: ${JSON.stringify(probe)}`)
  const height = await page.evaluate(() => { const c = document.querySelector('.card') as HTMLElement | null; if (!c) return 0; const r = c.getBoundingClientRect(); const s = getComputedStyle(c); return Math.ceil(r.height + (parseFloat(s.marginTop)||0) + (parseFloat(s.marginBottom)||0)) })
  const png = 'mermaid-test.png'
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 720, height: Math.max(height, 1) } })
  t(`screenshot → ${png} (height=${height})`)
  console.log(probe.renderedSvg === probe.divs && probe.divs > 0 ? '✅ 全部渲染成 SVG' : '❌ 未全部渲染')
} finally {
  await browser.close()
}
