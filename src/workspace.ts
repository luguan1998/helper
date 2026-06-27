// 按会话隔离的 Claude 工作目录生命周期:create per-session 子目录、空则删。
// fs 适配器(非端口,同 state.ts/image.ts 定位):claude-client 用它给每个 pooled 会话
// 开独立 cwd(@开启 各不同),会话退出后若目录为空则回收,不残留空目录。
import { mkdir, readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 确保 base 工作目录存在(无状态识图等共用 base;也作 per-session 子目录的父目录)。 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * 在 base 下新建一个唯一会话工作目录(@开启 每次一个,互不相同)。
 * 目录名用日期时间(带毫秒):claudeSessionId 在 spawn 后首轮 send 才到达,无法在 spawn 时
 * 用作目录名,且 Windows 不能移动运行中进程的 cwd,故改用日期时间;毫秒精度避免同秒碰撞。
 * groupId 给定时按群分子目录(workspace/<groupId>/<datetime>):多群并发消除同毫秒碰撞 + 调试可读。
 */
export async function createSessionWorkspace(baseCwd: string, groupId?: string): Promise<{ path: string }> {
  const name = new Date().toISOString().replace(/:/g, '-') // → 2026-06-26T14-30-52.123Z
  const parent = groupId ? join(baseCwd, groupId) : baseCwd
  const path = join(parent, name)
  await mkdir(path, { recursive: true })
  return { path }
}

/** 目录是否为空(无任何条目)。不存在或读取失败视为非空(不删)。 */
async function isEmptyDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.length === 0
  } catch {
    return false
  }
}

/**
 * 若目录为空则删除(会话结束/退出后回收)。Windows 上子进程刚被 taskkill /f /t,
 * 句柄释放可能有延迟,故短重试。best-effort:失败仅记日志。非空→保留(用户要求)。
 */
export async function removeDirIfEmpty(path: string, retries = 4): Promise<void> {
  for (let i = 0; i < retries; i++) {
    if (!(await isEmptyDir(path))) return
    try {
      await rmdir(path)
      console.log(`[workspace] 回收空工作目录: ${path}`)
      return
    } catch (err: any) {
      if (err?.code === 'ENOENT') return // 已不在,视为已回收
      // EBUSY/EPERM:句柄未释放,等一下再试
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  console.warn(`[workspace] 回收失败(可能非空或被占用): ${path}`)
}
