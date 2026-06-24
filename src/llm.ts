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

/** 命名模型注册表:接力 pipeline 按名引用。 */
export type Models = Record<string, Llm>
