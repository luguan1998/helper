// 附件下载:把 picture/file 消息的 URL/路径转成本地路径(喂 Claude 视觉 / 预处理脚本用)。
// 一适配器(http fetch / 直传本地路径),按规则不开端口。
import { writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 远程(http/https)→ 下载到系统临时目录;本地路径 → 原样返回。 */
export async function downloadImage(src: string): Promise<string> {
  if (!src) throw new Error('empty image source')
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`download ${src} failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const dest = join(tmpdir(), `bot-img-${randomBytes(6).toString('hex')}.png`)
    await writeFile(dest, buf)
    return dest
  }
  return src
}

/** sanitize 文件名:保留扩展名(供 filePathRegex 匹配 + 脚本识别类型),去路径分隔符与特殊字符防 traversal,空值回退。 */
export function sanitizeFileName(name?: string): string {
  if (!name) return 'file.bin'
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return safe || 'file.bin'
}

/** sim 桩接受的 host(仅本地;真实 welink 分享链需提取码+验证码,生产下载为 TODO,不走此桩)。 */
const STUB_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']

/**
 * 下载远程文件到指定目录(文件名 sanitize 后使用),返回本地路径。
 * ⚠️ sim 桩:仅允许 http(s)+localhost 系 host(sim 文件 URL 无鉴权,可直接 fetch)。
 * 真实 welink 文件是 clouddrive 分享链,要提取码+验证码,生产下载 TODO——落地时替换此实现即可
 * (经 fileRefLandingStep 注入,见 src/pipelines/preprocess.ts)。
 */
export async function downloadFile(url: string, destDir: string, fileName?: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`downloadFile: 非 http(s) URL: ${url}`)
  let host: string
  try { host = new URL(url).hostname } catch { throw new Error(`downloadFile: URL 解析失败: ${url}`) }
  if (!STUB_ALLOWED_HOSTS.includes(host)) {
    throw new Error(`downloadFile: host '${host}' 不被 sim 桩接受(生产下载为 TODO,见计划)`)
  }
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, sanitizeFileName(fileName))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`downloadFile ${url} failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return dest
}
