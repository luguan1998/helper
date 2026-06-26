// 会话预处理示例脚本(由 src/pipeline.ts 的 runScriptFile 调用;协议见 doc/session-preprocessing.md)。
//
// 协议:
//   stdin  = JSON { content, session, workspacePath }
//   stdout = JSON { session: { ...增量 } }  → merge 进会话级 ctx.session(跨消息保留)
//   stdout 为空 = no-op(如 session 无 pendingInput,跳过)
//   非零退出 = 失败(runScriptFile 抛错 → handle 降级致歉;不标 preprocessed,下次发文件可重试)
//
// session.pendingInput = 待预处理的文件路径;workspacePath = 会话 workspace 子目录(产物落此,
// text 会话 Claude 问答时 cwd 即此目录,能直接 grep/read 产物 —— 路径天然一致)。
//
// 这是示例:真实解压/解析按文件格式(zip/gz/tar/原生 log)实现,产物落 extracted/。此处仅演示协议。
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

const { session = {}, workspacePath } = JSON.parse(raw)
const pendingInput = session.pendingInput
if (!pendingInput || !workspacePath) {
  process.stdout.write('') // no-op
  process.exit(0)
}

const outDir = join(workspacePath, 'extracted')
await mkdir(outDir, { recursive: true })

let summary = ''
try {
  const buf = await readFile(pendingInput)
  await writeFile(join(outDir, basename(pendingInput)), buf)
  summary = `已读取 ${basename(pendingInput)}(${buf.length} 字节)到 extracted/。`
} catch (e) {
  // 读不到(可能是目录或压缩包):列目录或提示。真实场景此处按格式解压(gz 用 zlib、zip/tar 用第三方或系统命令)。
  try {
    const st = await stat(pendingInput)
    if (st.isDirectory()) {
      const entries = await readdir(pendingInput)
      summary = `路径是目录,含 ${entries.length} 项:${entries.slice(0, 10).join(', ')}。真实解压逻辑待实现。`
    } else {
      throw e
    }
  } catch (e2) {
    process.stderr.write(`[preprocess-log] 读取 ${pendingInput} 失败: ${e2.message}\n`)
    process.exit(1)
  }
}

const files = await readdir(outDir)
process.stdout.write(JSON.stringify({ session: { preprocessed: true, files, summary } }))
