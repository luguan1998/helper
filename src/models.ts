// Models 注册表:命名模型实例,接力 pipeline 按名引用。
// buildModels 从 ModelSpec 数组构建;默认 specs(prompt + 是否 pooled)供零配置 runAssistant 用。
import type { Models } from './llm.js'
import { createClaudeCliLlm } from './claude-client.js'

export interface ModelSpec {
  /** 模型名(pipeline 按 name 引用)。 */
  name: string
  /** Claude 模型 id(切换模型,经 env ANTHROPIC_MODEL)。 */
  model?: string
  systemPrompt: string
  /** true(默认,对话续接)/ false(无状态,识图等一次性)。 */
  pooled?: boolean
  maxSessions?: number
}

export interface ModelsShared {
  cwd: string
  cliCommand?: string
}

/** 从配置数组构建命名模型实例。 */
export async function buildModels(specs: ModelSpec[], shared: ModelsShared): Promise<Models> {
  const models: Models = {}
  for (const spec of specs) {
    models[spec.name] = await createClaudeCliLlm({
      cwd: shared.cwd,
      systemPrompt: spec.systemPrompt,
      model: spec.model,
      pooled: spec.pooled,
      maxSessions: spec.maxSessions,
      cliCommand: shared.cliCommand,
    })
  }
  return models
}

// ── 默认提示词 ──
/** 文本模型(对话型):客服助手人设与安全约束。 */
export const DEFAULT_TEXT_PROMPT = [
  '你是一个内部通讯软件上的客服助手。',
  '请简洁、专业、礼貌地回答用户问题,使用与用户相同的语言。',
  '约束:不要做出任何承诺或保证;不要披露内部敏感信息、密钥、口令;',
  '遇到无法确定或超出权限的问题,提示用户联系人工客服。',
  '回复使用 Markdown(将渲染为图片发送)。',
].join('')

/** 识图模型(无状态):简洁描述图片内容,供后续文本模型分析。 */
export const DEFAULT_VISION_PROMPT = [
  '你是识图助手。简洁、准确地描述图片内容(中文),',
  '包括主体、文字、图表数据等关键信息,供后续文本模型分析使用。',
].join('')

/**
 * 默认模型配置(零配置 runAssistant 用):
 * - vision:无状态识图(pooled:false,每次 spawn→ask→kill)
 * - text:对话型分析(pooled:true,按用户续接)
 */
export const DEFAULT_MODEL_SPECS: ModelSpec[] = [
  { name: 'vision', systemPrompt: DEFAULT_VISION_PROMPT, pooled: false },
  { name: 'text', systemPrompt: DEFAULT_TEXT_PROMPT, pooled: true },
]
