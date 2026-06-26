// 生产适配器:PuppeteerRenderer —— Markdown → HTML(setContent)→ 整页截图 PNG。
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
        const dest = join(tmpdir(), `ai-response-${randomBytes(6).toString('hex')}.png`)
        // fullPage 自适应内容高度:宽固定 720,高随正文
        await page.screenshot({ path: dest, fullPage: true })
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
