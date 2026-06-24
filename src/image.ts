// 图片下载:把 picture 消息的 URL/路径转成本地路径(喂 Claude 视觉用)。
// 一适配器(http fetch / 直传本地路径),按规则不开端口。
import { writeFile } from 'node:fs/promises'
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
