// 生产适配器:PuppeteerRenderer —— Markdown → HTML(setContent)→ 按内容高度 clip 截图 PNG。
// 用 puppeteer-core(不下载 Chromium),executablePath 由 CHROMIUM_PATH 或本机探测给出。
import puppeteer from 'puppeteer-core'
import type { Browser } from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Renderer } from './renderer.js'
import { buildHtml } from '../html-template.js'

const VIEWPORT_WIDTH = 720
const DEVICE_SCALE = 2 // 2x 提升截图清晰度

/** 解析 Chrome/Chromium 可执行路径:CHROMIUM_PATH > 常见安装位置。 */
function resolveExecutablePath(): string {
  const fromEnv = process.env.CHROMIUM_PATH
  if (fromEnv) return fromEnv
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    for (const c of candidates) if (c && existsSync(c)) return c
  }
  // Linux/macOS:假定 PATH 上有 chromium/chrome
  return process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium'
}

export interface PuppeteerRendererOptions {
  executablePath?: string
  width?: number
}

export function createPuppeteerRenderer(options: PuppeteerRendererOptions = {}): Renderer {
  const width = options.width ?? VIEWPORT_WIDTH
  const executablePath = options.executablePath ?? resolveExecutablePath()
  let browserPromise: Promise<Browser> | null = null

  const getBrowser = async (): Promise<Browser> => {
    if (!browserPromise) {
      browserPromise = puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      })
    }
    return browserPromise
  }

  return {
    async markdownToImage(markdown: string): Promise<string> {
      const html = buildHtml(markdown)
      const browser = await getBrowser()
      const page = await browser.newPage()
      try {
        await page.setViewport({ width, height: 800, deviceScaleFactor: DEVICE_SCALE })
        await page.setContent(html, { waitUntil: 'networkidle0' })
        // 量正文真实占地(卡片高 + 上下外边距),按此高度 clip 截图:
        // fullPage 截的是 <html> 的 scrollHeight,而根元素至少撑满视口(800),
        // 内容短时下半截全是 body 浅灰底(看似"全白")。clip 按内容高度精确截取,长短皆宜。
        const contentHeight = await page.evaluate(() => {
          const card = document.querySelector('.card') as HTMLElement | null
          if (!card) return document.body.scrollHeight
          const r = card.getBoundingClientRect()
          const s = getComputedStyle(card)
          const mt = parseFloat(s.marginTop) || 0
          const mb = parseFloat(s.marginBottom) || 0
          return Math.ceil(r.height + mt + mb)
        })
        const dest = join(tmpdir(), `ai-response-${randomBytes(6).toString('hex')}.png`)
        await page.screenshot({
          path: dest,
          clip: { x: 0, y: 0, width, height: Math.max(contentHeight, 1) },
        })
        return dest
      } finally {
        await page.close()
      }
    },
    async markdownToHtml(markdown: string): Promise<string> {
      // 不开浏览器:buildHtml 已是自包含样式文档,直接落盘成 .html 文件供发群。
      const html = buildHtml(markdown)
      const dest = join(tmpdir(), `ai-response-${randomBytes(6).toString('hex')}.html`)
      await writeFile(dest, html, 'utf8')
      return dest
    },
  }
}
