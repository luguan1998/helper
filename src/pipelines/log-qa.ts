// 日志问答 pipeline:无 vision 的日志特化预处理 + 问答。
// 触发限定日志扩展名(zip/gz/tgz/tar/log/txt);其余复用通用 preprocessSteps(多 spec、按输入去重)。
// 日常零配置默认 pipeline 已含通用预处理(任意扩展名),本 pipeline 仅当要"日志特化 + 无 vision 识图"时用(BOT_PIPELINE=log-qa)。
import { modelStep, type Pipeline } from '../pipeline.js'
import { preprocessSteps, filePathRegex, type PreprocessSpec } from './preprocess.js'

const LOG_EXTS = ['zip', 'gz', 'tgz', 'tar', 'log', 'txt']

export interface LogQaPipelineOptions {
  /** 预处理脚本路径(driver:'script' 时用,默认 scripts/preprocess-log.js)。 */
  preprocessScript?: string
  /** 'script'(默认,确定性脚本)/ 'claude'(同会话 Claude 驱动)。 */
  driver?: 'script' | 'claude'
  /** 预处理脚本超时毫秒(默认 5min,仅 driver:'script')。 */
  timeoutMs?: number
  /** 预处理脚本解释器:省略=node;'python'/'py' 等;null=直接跑 exe(见 doc/session-preprocessing.md)。 */
  interpreter?: string | null
}

/** 日志问答 pipeline:日志特化预处理(限定日志扩展名)+ text 问答。无 vision(纯文本日志场景)。 */
export function createLogQaPipeline(opts: LogQaPipelineOptions = {}): Pipeline {
  const logSpec: PreprocessSpec = {
    name: 'log',
    trigger: filePathRegex(LOG_EXTS),
    inputFrom: 1,
    script: opts.preprocessScript ?? 'scripts/preprocess-log.js',
    interpreter: opts.interpreter,
    timeoutMs: opts.timeoutMs,
    driver: opts.driver ?? 'script',
    appliesTo: 'text',
  }
  return {
    steps: [
      ...preprocessSteps([logSpec]),
      modelStep('text'),
    ],
  }
}
