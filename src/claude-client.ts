// Claude CLI 客户端 + Llm 适配器。
// spawn/NDJSON 解析/环境清洗/进程树杀,精简自 vibe-ide src/main/ai.ts(去掉 Electron IPC、
// 权限交互、流式 token、文件变更、partial-messages——bot 只需"完整回复")。
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Llm, SessionLlm } from './llm.js'
import { SessionPool, type Session } from './session-pool.js'
import { loadSessionId, saveSessionId } from './state.js'
import type { Reply, UserContent } from './types.js'

// ── 二进制发现(原样复用 ai.ts:62)──
const AI_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code@latest'

export function findBinary(customCommand?: string): { binary: string } | { error: string; installCmd: string } {
  const names = customCommand ? [customCommand] : ['claude', 'openclaude']
  for (const name of names) {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`
      execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
      return { binary: name }
    } catch { /* try next */ }
  }
  return { error: `Claude CLI not found. Install with: ${AI_INSTALL_CMD}`, installCmd: AI_INSTALL_CMD }
}

// ── Windows 环境清洗(原样复用 ai.ts:76)──
// Git Bash/MSYS2 会泄漏 Unix 变量(HOME/SHELL/MSYSTEM…)干扰 CLI 的 OS 探测,清掉它们。
export function sanitizeEnvForCli(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env }
  if (process.platform === 'win32') {
    const unixVars = [
      'HOME', 'SHELL', 'TERM', 'MSYSTEM', 'MINGW_PREFIX', 'MINGW_CHOST', 'MSYS',
      'MSYS2_PATH_TYPE', 'MANPATH', 'INFOPATH', 'HOSTTYPE', 'MACHTYPE', 'OSTYPE',
      'PKG_CONFIG_PATH', 'ORIGINAL_PATH', 'ORIGINAL_TEMP', 'ORIGINAL_TMP',
    ]
    for (const v of unixVars) delete childEnv[v]
  }
  return childEnv
}

// ── CLI 参数(简化自 ai.ts:95)──
// 保留 stream-json + bypassPermissions;去掉 --permission-prompt-tool stdio(bypass 已无需提示)
// 与 --include-partial-messages(我们只要最终完整文本,不要增量)。
function buildClaudeArgs(opts: { cwd: string; systemPrompt: string; resumeId?: string }): string[] {
  const platformDesc = process.platform === 'win32'
    ? 'Windows(用反斜杠路径如 C:\\Users\\...)'
    : process.platform === 'darwin'
      ? 'macOS(用 /Users/... 路径)'
      : 'Linux(用 /home/... 路径)'
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', `${opts.systemPrompt}\n(运行于 ${platformDesc};工作目录:${opts.cwd})`,
  ]
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  return args
}

// ── spawn(简化自 ai.ts:124)──
// model 经 env ANTHROPIC_MODEL 注入(跨 claude/openclaude/GLM 变体最稳,不依赖 --model flag 是否支持)。
function spawnClaude(opts: {
  cwd: string
  systemPrompt: string
  resumeId?: string
  model?: string
  cliCommand?: string
}): ChildProcess {
  const resolved = findBinary(opts.cliCommand)
  if ('error' in resolved) throw new Error(resolved.error)
  const args = buildClaudeArgs(opts)
  const env = sanitizeEnvForCli()
  if (opts.model) env.ANTHROPIC_MODEL = opts.model
  return spawn(resolved.binary, args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // Windows 上 .cmd 需要 shell 解析
  })
}

// ── 进程树杀(原样复用 ai.ts:733)──
// claude.cmd 会派生 node 子进程,SIGTERM 只杀 cmd 外壳,故 Windows 用 taskkill /f /t。
export function killAiProcess(proc: ChildProcess): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']) } catch { /* ignore */ }
  } else {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
  }
}

// ── ClaudeSession:一个用户的会话(子进程)──
export interface ClaudeSessionOpts {
  cwd: string
  systemPrompt: string
  resumeId?: string
  model?: string
  cliCommand?: string
}

export class ClaudeSession implements Session {
  private readonly proc: ChildProcess
  private lineBuffer = ''
  private ready = false
  claudeSessionId?: string
  private readyPromise: Promise<void>
  private readyResolve!: () => void

  /** 当前待回复的 send:收集文本,遇 result 即 resolve。 */
  private pendingResolve?: (reply: Reply) => void
  private pendingReject?: (err: Error) => void
  private pendingText = ''

  private constructor(proc: ChildProcess) {
    this.proc = proc
    this.readyPromise = new Promise(resolve => { this.readyResolve = resolve })
    this.attach()
  }

  /** 新建会话并等待 system/init 就绪。 */
  static async spawn(opts: ClaudeSessionOpts): Promise<ClaudeSession> {
    const proc = spawnClaude(opts)
    const session = new ClaudeSession(proc)
    await session.whenReady()
    return session
  }

  /** 提问,等完整回复(text 块拼接)后 resolve。 */
  async send(content: UserContent): Promise<Reply> {
    if (!this.ready) throw new Error('session not ready')
    const ndjson = JSON.stringify(this.buildUserMessage(content)) + '\n'
    return new Promise<Reply>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject
      this.pendingText = ''
      this.proc.stdin?.write(ndjson)
    })
  }

  kill(): void {
    killAiProcess(this.proc)
  }

  private whenReady(): Promise<void> {
    return this.readyPromise
  }

  /** stream-json 输入格式(参考 vibe-ide ai.ts:801;图片用 Anthropic 多模态内容块)。 */
  private buildUserMessage(content: UserContent): { type: 'user'; message: { role: 'user'; content: unknown } } {
    if (content.kind === 'text') {
      return { type: 'user', message: { role: 'user', content: content.text } }
    }
    const mediaType = /\.jpe?g$/i.test(content.imagePath) ? 'image/jpeg' : 'image/png'
    const data = readFileSync(content.imagePath).toString('base64')
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: content.caption || '请分析这张图片' },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        ],
      },
    }
  }

  private attach(): void {
    const stderr: string[] = []

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf-8')
      const lines = this.lineBuffer.split('\n')
      this.lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.onMessage(JSON.parse(trimmed))
        } catch {
          console.warn(`[claude] NDJSON parse failed:`, trimmed.slice(0, 200))
        }
      }
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) stderr.push(text)
    })

    this.proc.on('error', err => {
      this.failPending(err)
    })

    this.proc.on('exit', code => {
      if (!this.ready) {
        const detail = stderr.join('\n').trim()
        this.readyReject(new Error(`claude failed to start (code ${code})${detail ? `: ${detail}` : ''}`))
      }
      this.failPending(new Error(`claude subprocess exited (code ${code})`))
    })
  }

  private readyReject(err: Error): void {
    if (!this.ready) {
      this.ready = true // 防止 whenReady 永久挂起
      this.readyResolve()
      console.error(`[claude] startup failed:`, err.message)
    }
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case 'system': {
        if (msg.session_id) this.claudeSessionId = msg.session_id
        if (!this.ready) {
          this.ready = true
          this.readyResolve()
        }
        break
      }
      case 'assistant': {
        // 收集本轮所有 assistant 文本块,直到 result。
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string') this.pendingText += b.text
          }
        }
        break
      }
      case 'result': {
        const reply: Reply = { markdown: this.pendingText }
        this.pendingText = ''
        this.pendingResolve?.(reply)
        this.pendingResolve = undefined
        this.pendingReject = undefined
        break
      }
      default:
        // stream_event / tool_progress / keep_alive 等:bot 不需要,忽略。
        break
    }
  }

  private failPending(err: Error): void {
    if (this.pendingReject) {
      this.pendingReject(err)
      this.pendingReject = undefined
      this.pendingResolve = undefined
      this.pendingText = ''
    }
  }
}

// ── Llm 适配器工厂:ClaudeCliLlm = SessionPool(ClaudeSession) 或 无状态一次性 ──
export interface ClaudeCliLlmOptions {
  cwd: string
  systemPrompt: string
  /** Claude 模型 id(经 env ANTHROPIC_MODEL 切换模型)。 */
  model?: string
  /** true(默认,对话型,按用户续接 SessionPool)/ false(无状态,每次 spawn→ask→kill,识图等用)。 */
  pooled?: boolean
  maxSessions?: number
  cliCommand?: string
}

/** 无状态 Llm:每次 ask 新建会话、ask 完即 kill(userId 被忽略,无多轮续接)。识图等用。 */
function createStatelessLlm(opts: ClaudeCliLlmOptions): Llm {
  return {
    async ask(_userId: string, content: UserContent): Promise<Reply> {
      const session = await ClaudeSession.spawn({
        cwd: opts.cwd,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        cliCommand: opts.cliCommand,
      })
      try {
        return await session.send(content)
      } finally {
        session.kill()
      }
    },
  }
}

export async function createClaudeCliLlm(options: ClaudeCliLlmOptions): Promise<Llm> {
  if (options.pooled === false) {
    return createStatelessLlm(options)
  }
  const pool = new SessionPool({
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    maxSessions: options.maxSessions ?? 8,
    spawn: (opts) => ClaudeSession.spawn({ ...opts, model: options.model, cliCommand: options.cliCommand }),
    loadSessionId,
    saveSessionId,
  })
  const llm: SessionLlm = {
    async ask(userId: string, content: UserContent): Promise<Reply> {
      const session = await pool.acquire(userId)
      return session.send(content)
    },
    async startSession(userId: string): Promise<void> {
      await pool.startFresh(userId)
    },
    async endSession(userId: string): Promise<string | undefined> {
      const session = pool.release(userId)
      if (!session) return undefined
      const id = session.claudeSessionId
      session.kill()
      return id
    },
  }
  return llm
}
