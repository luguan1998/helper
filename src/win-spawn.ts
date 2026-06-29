// Windows 命令调用辅助:解决两个 Node坑——(1) spawn(CreateProcess 用 lpApplicationName)不搜 PATH,
// 裸名(如 `welink-cli`/`claude`/`python`)ENOENT;(2) .cmd/.bat 壳不能无 shell 运行,而 shell:true 又不给
// 参数加引号 → cmd 按空格/换行切参数(截断 --text / --append-system-prompt)。
// 策略:`where` 解析全路径,优先 .exe(无 shell,Node MSVC 引号传参,空格/换行/引号全安全);.cmd/.bat →
// 显式 `cmd /d /s /c <全引号命令行>`。非 Windows / 已是全路径 → 原样无 shell。
// 供 welink-channel / claude-client / pipeline 三处复用(同源问题,DRY)。
import { execSync } from 'node:child_process'

export interface ResolvedCmd { file: string; useShell: boolean }

const cache = new Map<string, ResolvedCmd>()

/** 解析命令:Windows 裸名走 `where`(优先 .exe 无 shell;.cmd/.bat 需 shell);非 Windows / 全路径原样无 shell。结果缓存。 */
export function resolveCommand(name: string): ResolvedCmd {
  if (process.platform !== 'win32' || /[\\/]/.test(name)) return { file: name, useShell: false }
  const cached = cache.get(name)
  if (cached) return cached
  let r: ResolvedCmd
  try {
    const out = execSync(`where ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    const paths = out.split(/\r?\n/).filter(Boolean)
    const exe = paths.find(p => /\.exe$/i.test(p))
    if (exe) r = { file: exe, useShell: false }
    else {
      const sh = paths.find(p => /\.(cmd|bat)$/i.test(p))
      r = sh ? { file: sh, useShell: true } : { file: name, useShell: false }
    }
  } catch {
    r = { file: name, useShell: false } // 不在 PATH;交调用方处理 ENOENT
  }
  cache.set(name, r)
  return r
}

/** 引号一个参数供 `cmd /c` 用:折叠换行(cmd 不能内嵌),含空格/引号则包双引号(MSVC 规则:反斜杠只在引号前需翻倍)。 */
export function quoteArg(arg: string): string {
  const a = arg.replace(/[\r\n]+/g, ' ')
  if (a.length > 0 && !/[\s"]/.test(a)) return a
  let s = a.replace(/(\\*)(")/g, '$1$1\\$2')
  s = s.replace(/(\\*)$/, '$1$1')
  return `"${s}"`
}

export interface PreparedSpawn {
  file: string
  args: string[]
  options: { shell: boolean; windowsVerbatimArguments?: boolean }
}

/**
 * 把 (file, args) 准备成 spawn/execFile 可用的 (file, args, options):
 *   .exe / 全路径 / 非 Windows → 原样、无 shell(Node MSVC 引号传参);
 *   .cmd/.bat → `cmd /d /s /c <全引号命令行>`(windowsVerbatimArguments=true,命令行原样透传)。
 * 调用方再合并 maxBuffer / stdio / cwd / env / timeout 等。
 */
export function prepareSpawn(file: string, args: string[]): PreparedSpawn {
  const { file: resolved, useShell } = resolveCommand(file)
  if (!useShell) return { file: resolved, args, options: { shell: false } }
  const cmdline = [resolved, ...args].map(quoteArg).join(' ')
  return { file: 'cmd', args: ['/d', '/s', '/c', cmdline], options: { shell: false, windowsVerbatimArguments: true } }
}
