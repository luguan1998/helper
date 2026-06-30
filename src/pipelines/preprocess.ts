// 通用会话预处理 steps(多 spec):守卫+触发 → 预处理(条件,按输入去重)→ 问答组装。
// 被 createDefaultPipeline(默认内置,零配置即支持)与 createLogQaPipeline(日志特化)复用。
//
// 触发:每个 spec 自带 trigger(正则对正文 text 匹配,或函数)。命中 → 算 input(spec.inputFrom,默认捕获组 1,
//   无捕获组回退 full match)。按输入去重:同 spec+同 input 跳过,不同 input 各跑一次,结果累计。
//   预处理完把结果(summary)经 ctx.notify 发到群(默认 on,spec.notify 可关);QA 组装把全部结果(产物目录+摘要)
//   注入 content,让 text 模型 grep/read 产物回答。
//
// 多 spec 同消息命中:全收集、顺序跑、每 spec 独立 try/catch(失败不标 done、不阻断其他 spec,下次同输入可重试)。
// specs 来源:env BOT_PREPROCESS_CONFIG 指向 .mjs(导出 PreprocessSpec[] default);未设 → buildBuiltinSpecs()(文件路径)。
// 协议见 scripts/preprocess-log.js + doc/session-preprocessing.md。
import { scriptStep, runScriptFile, type Step, type StepCtx } from '../pipeline.js'
import type { Models } from '../llm.js'
import type { UserContent } from '../types.js'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'

/** session 上保留给框架内部用的键前缀(脚本不应碰)。 */
const PREPROCESS_KEY = '__preprocess'

/** 触发匹配结果(match=完整子串,groups=捕获组[0]=full…,input=待处理输入)。 */
export interface PreprocessTriggerMatch {
  match: string
  groups: string[]
  input: string
}

/** 触发器:正则(对 content.text 匹配,input 由 spec.inputFrom 解析)或函数(自负责返回含 input 的完整 match)。 */
export type PreprocessTrigger = RegExp | ((content: UserContent) => PreprocessTriggerMatch | null)

/** 一种预处理类型。 */
export interface PreprocessSpec {
  /** 唯一名,需匹配 /^[A-Za-z0-9_-]+$/;作 session.__preprocess[name] 键。 */
  name: string
  /** 触发器:正则或函数。正则只对 text 生效;图片走函数触发器。 */
  trigger: PreprocessTrigger
  /** 从 match 取"待处理输入":数字=捕获组索引(0=full,默认 1;越界/空回退 full);函数自定义。仅对正则触发器生效。 */
  inputFrom?: number | ((m: PreprocessTriggerMatch) => string)
  /** 脚本路径(driver:'script' 时用)。 */
  script: string
  /** 脚本解释器:省略=node;'python'/'py' 等;null=直接跑 exe。 */
  interpreter?: string | null
  /** 脚本超时毫秒(默认 5min,仅 driver:'script')。 */
  timeoutMs?: number
  /** 触发作用于哪种 content:默认 'text'(默认 pipeline 在预处理前已把图片→文本)。 */
  appliesTo?: 'text' | 'image' | 'both'
  /** 'script'(默认,确定性脚本)/ 'claude'(同会话 Claude 驱动)。 */
  driver?: 'script' | 'claude'
  /** driver:'claude' 时的指令模板;缺省用 DEFAULT_CLAUDE_PROMPT。 */
  claudePrompt?: (input: string) => string
  /** QA 注入文本生成(默认 DEFAULT_QA_TEMPLATE);返回空串=该结果不注入。 */
  qaTemplate?: (r: PreprocessResult, workspacePath: string) => string
  /** 预处理完成后是否把结果发到群(默认 true);设 false 则只注入 AI 提问、不发群消息。 */
  notify?: boolean
  /** 发群通知的文本(默认 DEFAULT_NOTICE_TEMPLATE);返回空串=不发。仅 notify!==false 时调用。 */
  noticeTemplate?: (r: PreprocessResult, workspacePath: string) => string
}

/** 一次预处理产物(累计存 session.__preprocess[name].results)。 */
export interface PreprocessResult {
  name: string
  input: string
  summary: string
  /** dir 相对 workspacePath 或绝对;files=产物文件清单。 */
  artifacts: { dir: string; files: string[] }
}

/** 文件绝对路径(Windows 盘符 / Unix 绝对;带扩展名)正则。exts 限定则只匹配这些扩展名。 */
export function filePathRegex(exts?: readonly string[]): RegExp {
  const extPat = exts ? `(?:${exts.join('|')})` : '[a-zA-Z0-9]+'
  return new RegExp(`([A-Za-z]:[\\\\/][^\\s,，]+\\.${extPat}|/[^\\s,，]+\\.${extPat})`, 'i')
}

/** 默认 QA 注入模板:列出产物目录(解析成绝对)+ 摘要 + 文件清单(前 20)。 */
export function DEFAULT_QA_TEMPLATE(r: PreprocessResult, workspacePath: string): string {
  const dir = r.artifacts.dir
  const absDir = isAbsolute(dir) ? dir : join(workspacePath, dir)
  const files = r.artifacts.files.length ? `\n产物文件:${r.artifacts.files.slice(0, 20).join(', ')}` : ''
  return `【${r.name}】(输入:${r.input})\n产物目录:${absDir}\n摘要:${r.summary}${files}`
}

/** 默认发群通知模板:✅ 标记 + 摘要 + 产物目录(解析成绝对)+ 文件数。比 QA 模板简洁(给人看,不是给 AI)。 */
export function DEFAULT_NOTICE_TEMPLATE(r: PreprocessResult, workspacePath: string): string {
  const dir = r.artifacts.dir
  const absDir = isAbsolute(dir) ? dir : join(workspacePath, dir)
  const count = r.artifacts.files.length ? `(${r.artifacts.files.length} 文件)` : ''
  return `✅ 【${r.name}】预处理完成\n摘要:${r.summary}\n产物:${absDir}${count}`
}

/** driver:'claude' 的默认指令。 */
export function DEFAULT_CLAUDE_PROMPT(input: string): string {
  return `请预处理 ${input}:在当前工作目录下解压并解析,产物文件留在目录内,最后用一段话总结产物清单与可查询的关键线索。`
}

/** 内部:每 spec 的会话级累计状态(inputs=已处理输入去重;results=累计结果)。用数组非 Set——session 会被 JSON.stringify 传给脚本。 */
interface SpecState { inputs: string[]; results: PreprocessResult[] }

/** 取(必要时建)某 spec 的会话级状态。 */
function getState(session: Record<string, unknown>, name: string): SpecState {
  const root = (session[PREPROCESS_KEY] ?? {}) as Record<string, SpecState>
  if (!(PREPROCESS_KEY in session)) session[PREPROCESS_KEY] = root
  if (!root[name]) root[name] = { inputs: [], results: [] }
  return root[name]
}

/** 收集会话内全部 spec 的累计结果(供 QA 组装)。 */
function gatherResults(session: Record<string, unknown>): PreprocessResult[] {
  const root = session[PREPROCESS_KEY] as Record<string, SpecState> | undefined
  if (!root) return []
  return Object.values(root).flatMap(s => s.results)
}

/** 按 spec.inputFrom 解析"待处理输入"(仅正则触发器用)。无捕获组/越界回退 full match。 */
function resolveInput(spec: PreprocessSpec, match: string, groups: string[]): string {
  const from = spec.inputFrom
  if (typeof from === 'function') return from({ match, groups, input: match }) || match
  const idx = from ?? 1
  return groups[idx] || groups[0] || match
}

/** 评估触发器:返回完整 match(含 input)或 null。正则只对 text;函数自负责 input(inputFrom 不适用)。 */
function evalTrigger(spec: PreprocessSpec, content: UserContent): PreprocessTriggerMatch | null {
  const applies = spec.appliesTo ?? 'text'
  if (applies !== 'both' && content.kind !== applies) return null
  if (typeof spec.trigger === 'function') return spec.trigger(content)
  if (content.kind !== 'text') return null
  const m = content.text.match(spec.trigger as RegExp)
  if (!m) return null
  const groups = m.map(g => (g === undefined ? '' : g))
  return { match: m[0], groups, input: resolveInput(spec, m[0], groups) }
}

/** 单个已触发 spec 的预处理执行(成功返 PreprocessResult;失败抛错由 step2 per-spec catch)。 */
async function runOne(ctx: StepCtx, models: Models, item: FiredItem): Promise<PreprocessResult> {
  const spec = item.spec
  const wp = ctx.workspacePath ?? ''
  if (spec.driver === 'claude') {
    const promptFn = spec.claudePrompt ?? DEFAULT_CLAUDE_PROMPT
    const r = await models.text.ask(ctx.userId, { kind: 'text', text: promptFn(item.input) })
    return { name: spec.name, input: item.input, summary: r.markdown || '(无摘要)', artifacts: { dir: wp, files: [] } }
  }
  const result = await runScriptFile(ctx, spec.script, {
    timeoutMs: spec.timeoutMs,
    interpreter: spec.interpreter,
    extraInput: { trigger: { name: spec.name, match: item.match, groups: item.groups, input: item.input } },
  })
  if (!result) throw new Error('脚本 no-op(空 stdout)')
  const summary = typeof result.summary === 'string' && result.summary ? result.summary : ''
  if (!summary) throw new Error('脚本未返回 summary')
  const art = (result.artifacts && typeof result.artifacts === 'object') ? result.artifacts as { dir?: unknown; files?: unknown } : {}
  const dir = typeof art.dir === 'string' && art.dir ? art.dir : wp
  const files = Array.isArray(art.files) ? art.files.map(String) : []
  return { name: spec.name, input: item.input, summary, artifacts: { dir, files } }
}

/** 内部:step1 收集的待执行项。 */
interface FiredItem { spec: PreprocessSpec; match: string; groups: string[]; input: string }

/**
 * 返回 [守卫+触发, 预处理(条件), 问答组装] 三步,插在 text 模型前。多 spec;按输入去重;session.__preprocess 累计。
 *   step1 守卫+触发:!workspacePath 跳过;遍历 specs,eval trigger,命中且 input 未处理过 → 收集到 scratch.fired。
 *   step2 预处理(条件):仅 scratch.fired 非空才跑;顺序执行每项,per-spec try/catch(失败不标 done、不阻断其他)。
 *     driver 'script'=runScriptFile(传 trigger 信息);'claude'=同会话 Claude。成功 → 累计 result + 记 input + 经 ctx.notify 发群(默认 on)。
 *   step3 问答组装:gather 全部累计结果;空则 content 原样(正常问答);否则注入产物目录+摘要,让 Claude grep/read。
 */
export function preprocessSteps(specs: readonly PreprocessSpec[]): Step[] {
  const specByName = new Map(specs.map(s => [s.name, s]))
  return [
    // step1: 守卫 + 触发抽取
    scriptStep((ctx) => {
      if (!ctx.workspacePath) return
      const fired: FiredItem[] = []
      for (const spec of specs) {
        const m = evalTrigger(spec, ctx.content)
        if (!m) continue
        const st = getState(ctx.session, spec.name)
        if (st.inputs.includes(m.input)) continue // 按输入去重:同输入已处理过跳过
        fired.push({ spec, match: m.match, groups: m.groups, input: m.input })
      }
      if (fired.length) ctx.scratch.fired = fired
    }),
    // step2: 预处理(条件:仅 scratch.fired 非空才跑,避免每条消息 spawn)
    async (ctx, models) => {
      const fired = (ctx.scratch.fired ?? []) as FiredItem[]
      if (!fired.length) return
      for (const item of fired) {
        try {
          const result = await runOne(ctx, models, item)
          const st = getState(ctx.session, item.spec.name)
          st.results.push(result)
          st.inputs.push(item.input)
          // ★ 预处理完把结果发到群(notify 默认 on);串行排队、先于最终回复 drain
          if (item.spec.notify !== false) {
            const tmpl = item.spec.noticeTemplate ?? DEFAULT_NOTICE_TEMPLATE
            const text = tmpl(result, ctx.workspacePath ?? '')
            if (text) ctx.notify?.(text)
          }
        } catch (err) {
          // per-spec 失败:不标 done(下次同输入可重试)、不阻断其他 spec
          console.error(`[preprocess] spec '${item.spec.name}' input='${item.input.slice(0, 80)}' failed:`, err instanceof Error ? err.message : err)
        }
      }
    },
    // step3: 问答组装(注入全部累计产物目录 + 摘要)
    scriptStep((ctx) => {
      const results = gatherResults(ctx.session)
      if (!results.length) return // 无已预处理:content 保持原样(正常问答)
      const wp = ctx.workspacePath ?? '(未知)'
      const parts = results
        .map(r => {
          const spec = specByName.get(r.name)
          const tmpl = spec?.qaTemplate ?? DEFAULT_QA_TEMPLATE
          return tmpl(r, wp)
        })
        .filter(s => s)
      if (!parts.length) return
      const q = ctx.content.kind === 'text' ? ctx.content.text : ''
      ctx.content = {
        kind: 'text',
        text: `已预处理以下内容,可用 grep/read 按需查询产物目录:\n${parts.join('\n\n')}\n\n用户问题:${q}`,
      }
    }),
  ]
}

/** 零配置内置 specs:文件路径(任意扩展名)→ scripts/preprocess-log.js(node)。要换脚本/解释器用 BOT_PREPROCESS_CONFIG。 */
export function buildBuiltinSpecs(): PreprocessSpec[] {
  return [{
    name: 'file',
    trigger: filePathRegex(),
    inputFrom: 1,
    script: 'scripts/preprocess-log.js',
    appliesTo: 'text',
    driver: 'script',
  }]
}

/** 校验 spec 列表(来自不可信 .mjs 导出);返回同数组(已断言类型)。 */
function validateSpecs(specs: unknown[]): PreprocessSpec[] {
  const seen = new Set<string>()
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i] as Record<string, unknown>
    if (!s || typeof s !== 'object') throw new Error(`spec[${i}] 非对象`)
    const name = s.name
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`spec[${i}].name 非法(需匹配 /^[A-Za-z0-9_-]+$/): ${String(name)}`)
    if (seen.has(name)) throw new Error(`spec name 重复: ${name}`)
    seen.add(name)
    if (!(s.trigger instanceof RegExp) && typeof s.trigger !== 'function') throw new Error(`spec '${name}'.trigger 需为 RegExp 或函数`)
    if (typeof s.script !== 'string' || !s.script) throw new Error(`spec '${name}'.script 需为非空字符串`)
    if (s.driver !== undefined && s.driver !== 'script' && s.driver !== 'claude') throw new Error(`spec '${name}'.driver 需为 'script'|'claude'`)
    if (s.appliesTo !== undefined && s.appliesTo !== 'text' && s.appliesTo !== 'image' && s.appliesTo !== 'both') throw new Error(`spec '${name}'.appliesTo 需为 'text'|'image'|'both'`)
    if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== 'number' || s.timeoutMs <= 0)) throw new Error(`spec '${name}'.timeoutMs 需为正数`)
    if (s.inputFrom !== undefined && typeof s.inputFrom !== 'number' && typeof s.inputFrom !== 'function') throw new Error(`spec '${name}'.inputFrom 需为 number 或函数`)
    if (s.interpreter !== null && s.interpreter !== undefined && typeof s.interpreter !== 'string') throw new Error(`spec '${name}'.interpreter 需为 string|null|undefined`)
  }
  return specs as PreprocessSpec[]
}

/**
 * 载入 specs:env BOT_PREPROCESS_CONFIG 指向 .mjs(导出 default PreprocessSpec[] 或具名 specs)→ 校验返回;
 * 未设 → buildBuiltinSpecs()。.mjs 经 file:// URL 动态 import(Windows ESM 必需)。失败抛描述性错误(启动即暴露)。
 */
export async function loadPreprocessSpecs(): Promise<PreprocessSpec[]> {
  const configPath = process.env.BOT_PREPROCESS_CONFIG
  if (!configPath) return buildBuiltinSpecs()
  const resolved = resolve(process.cwd(), configPath)
  let mod: { default?: unknown; specs?: unknown }
  try {
    mod = await import(pathToFileURL(resolved).href)
  } catch (err) {
    throw new Error(`loadPreprocessSpecs: 无法加载配置 ${resolved}: ${err instanceof Error ? err.message : err}`)
  }
  const specs = mod?.default ?? mod?.specs
  if (!Array.isArray(specs)) throw new Error(`loadPreprocessSpecs: ${resolved} 未导出 default 数组(PreprocessSpec[])`)
  return validateSpecs(specs)
}
