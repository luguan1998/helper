// Llm 端口 —— true-external(Claude 子进程)。
// 两套适配器:ClaudeCliLlm(生产,包 vibe-ide ai.ts)/ FakeLlm(测试),故为真接缝。
import type { UserContent, Reply } from './types.js'

export interface Llm {
  /**
   * 按 userId 取/建隔离会话后提问(同用户串行、跨用户隔离)。
   * 必须等完整回复后再 resolve(通讯软件不支持流式)。
   */
  ask(userId: string, content: UserContent): Promise<Reply>
}

/**
 * 带会话生命周期的 Llm(对话型模型)。核心用它驱动 @开启 / esc-quit-exit 生命周期。
 * 识图等无状态模型不实现此接口(每次 ask 即 spawn→ask→kill,无生命周期)。
 */
export interface SessionLlm extends Llm {
  /** 为该用户新建一个会话(不续接历史);若已存在活跃会话则先结束旧的。 */
  startSession(userId: string): Promise<void>
  /** 结束该用户会话并返回 claudeSessionId(发到群里作 resume 句柄);无活跃会话返回 undefined。 */
  endSession(userId: string): Promise<string | undefined>
  /** 运行期切该用户当前活跃会话的模型(经 set_model control_request,参考 vibe-ide ai.ts);无活跃会话返 false。 */
  setModel(userId: string, model: string): Promise<boolean>
  /** 该用户活跃会话的 workspace 子目录路径(供会话预处理脚本写产物;无活跃会话/无状态模型返 undefined)。 */
  getWorkspacePath?(userId: string): string | undefined
}

/** 命名模型注册表:接力 pipeline 按名引用。 */
export type Models = Record<string, Llm>
