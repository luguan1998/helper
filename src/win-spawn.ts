// Windows 命令调用辅助:cross-spawn 自动解析 .cmd/.bat 底层 .exe/node 并无 shell spawn → 不经 cmd.exe,
// `"`/`%`/换行/空格全安全(旧 quoteArg+cmd /c 方案下 `"` 会断引号、`%` 会被展开环境变量)。
// 供 welink-channel / claude-client / pipeline 三处复用。.exe 直跑、非 Windows 亦兼容(cross-spawn 透明转发)。
import { spawn } from 'cross-spawn'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface ExecOptions {
  /** stdout 上限,超则 kill 并 reject(防 OOM)。 */
  maxBuffer?: number
  /** 超时 ms,超则 kill 并 reject。 */
  timeout?: number
  /** 写入 stdin 后 end(pipeline 传 JSON)。不设则只 end stdin。 */
  input?: string | Buffer
}

/** 流式 spawn(cross-spawn):Windows .cmd/.bat 解析底层 .exe/node、无 shell;供 claude(NDJSON streaming,需 ChildProcess 句柄写 stdin/读 stdout)。 */
export function spawnCmd(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(file, args, options)
}

/**
 * execFile 风格:cross-spawn spawn + 收 stdout + 可选 stdin input/timeout/maxBuffer。
 * 任何 exit code 都 resolve(让调用方查 envelope resultCode);仅 spawn 错误/timeout/maxBuffer reject。
 * 用 'close'(非 'exit')等 stdout 流 drain 完,确保收集完整。
 */
export async function execFileCmd(file: string, args: string[], options: ExecOptions & SpawnOptions = {}): Promise<string> {
  const { maxBuffer = 10 * 1024 * 1024, timeout, input, ...rest } = options
  const child = spawn(file, args, { ...rest, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let size = 0
  let done = false
  let timer: NodeJS.Timeout | undefined
  return new Promise<string>((resolve, reject) => {
    const finish = (err: Error | null): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (err) { child.kill(); reject(err) } else resolve(stdout)
    }
    if (timeout) timer = setTimeout(() => finish(new Error(`exec timeout ${timeout}ms`)), timeout)
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (c: string) => {
      if (done) return
      size += c.length
      stdout += c
      if (size > maxBuffer) finish(new Error(`exec maxBuffer exceeded (${maxBuffer})`))
    })
    child.on('error', finish)
    child.on('close', () => finish(null))
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {}) // 忽略 EPIPE(子进程早退)
      child.stdin.end(input)
    } else {
      child.stdin?.end()
    }
  })
}
