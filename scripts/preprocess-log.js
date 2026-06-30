// 会话预处理示例脚本(由 src/pipeline.ts 的 runScriptFile 调用;协议见 doc/session-preprocessing.md)。
//
// 新协议(多 spec、按输入去重):
//   stdin  = JSON { content, session, workspacePath, trigger: { name, match, groups, input } }
//   stdout = JSON { summary, artifacts: { dir, files } }   → dir 相对 workspacePath 或绝对;summary 给 AI 的线索
//   stdout 为空 = no-op(如无 trigger.input,跳过)
//   非零退出 = 失败(runScriptFile 抛错 → handle 降级致歉;不标 done,下次发文件可重试)
//
// trigger.input = 待预处理的文件路径(由 spec.inputFrom 从触发正则捕获组解析);
// workspacePath = 会话 workspace 子目录(产物落此,text 会话 Claude 问答时 cwd 即此目录,
// 能直接 grep/read 产物 —— 路径天然一致)。
//
// 这是示例:真实解压/解析按文件格式(zip/gz/tar/原生 log)实现,产物落 extracted/。此处仅演示协议。
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

const { trigger = {}, workspacePath } = JSON.parse(raw)
const input = trigger.input
if (!input || !workspacePath) {
  process.stdout.write('') // no-op
  process.exit(0)
}

const outDir = join(workspacePath, 'extracted')
await mkdir(outDir, { recursive: true })

let summary = ''
try {
  const buf = await readFile(input)
  await writeFile(join(outDir, basename(input)), buf)
  summary = `已读取 ${basename(input)}(${buf.length} 字节)到 extracted/。`
} catch (e) {
  // 读不到(可能是目录或压缩包):列目录或提示。真实场景此处按格式解压(gz 用 zlib、zip/tar 用第三方或系统命令)。
  try {
    const st = await stat(input)
    if (st.isDirectory()) {
      const entries = await readdir(input)
      summary = `路径是目录,含 ${entries.length} 项:${entries.slice(0, 10).join(', ')}。真实解压逻辑待实现。`
    } else {
      throw e
    }
  } catch (e2) {
    process.stderr.write(`[preprocess-log] 读取 ${input} 失败: ${e2.message}\n`)
    process.exit(1)
  }
}

const files = await readdir(outDir)
process.stdout.write(JSON.stringify({ summary, artifacts: { dir: 'extracted', files } }))
