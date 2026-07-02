# 会话预处理架构与脚本扩展指南

> 本文说明"会话预处理"机制的设计、后续如何拓展,以及如何引入自己的脚本(Node.js / Python / exe / 任意可执行)。
> 用户配置手册(写自己的 pre-hook、配方集)见 `doc/pre-hook-handbook.md`。
> 实现见 `src/pipeline.ts`、`src/pipelines/preprocess.ts`、`src/assistant.ts`;示例脚本 `scripts/preprocess-log.js`。

---

## 0. 一句话

**会话预处理 = pipeline 内三步(守卫+触发 → 条件预处理 → 问答组装)+ 会话级 `ctx.session.__preprocess`(跨消息保留,按输入去重)+ `ctx.workspacePath`(会话 workspace 子目录路径)。** 多个 spec 各自带触发器(正则/函数)+ 脚本;每 spec 按输入去重(同输入跳过、不同输入累加);产物落 workspace,Claude 问答时 cwd 即该目录,能 `grep`/`read` 产物。

`Pipeline` 接口不变,核心循环(route/tick/handle)几乎不动。

---

## 1. 架构回顾(已实现)

### 1.1 数据流

```
@bot 开启
  └─ route() @开启分支:startSession(spawn Claude + 建 workspace/<groupId>/<日期时间>)
     ├─ sessionLlm.getWorkspacePath(sender)  ← 接缝内取 workspace 子目录路径
     └─ sessionCtx.set(sender, { scratch:{}, workspacePath })  ← 会话级上下文初始化

用户发消息(活跃期间,每条都进 handle)
  └─ handle():ctx = { userId, content, scratch:{}, session: sessionCtx[sender].scratch(引用), workspacePath, notify, onPartial }
     └─ runPipeline(default):
        step1 vision(图片→scratch.imageDesc) / step2 组装(图片→文本 content)   ← 文本消息跳过
        step3 守卫+触发:遍历 specs,eval trigger(正则对 text / 函数);命中且 input 未处理过 → scratch.fired
        step4 预处理(条件):仅 scratch.fired 非空才跑;每 spec 顺序执行、per-spec try/catch
              driver 'script'=runScriptFile(传 trigger 信息) / 'claude'=同会话 Claude
              → 产物落 workspacePath,回写 session.__preprocess[name].{inputs,results},经 ctx.notify 把摘要发群(默认)
        step5 问答组装:gather 全部累计 results → content 注入产物目录+摘要(让 Claude grep/read)
        step6 modelStep('text'):回答
   ★ runPipeline 后 handle 先 drain notifyChain(发预处理结果)再 drain partialChain(thinking)再发最终回复

exit → endSession(kill Claude → 空目录回收)+ sessionCtx.delete(__preprocess 全清,spec 重新可跑)
```

### 1.2 关键文件

| 文件 | 角色 |
|---|---|
| `src/pipeline.ts` | `StepCtx`(含 `session`/`workspacePath`/`notify`)、`modelStep`/`scriptStep`、`runScriptFile`(返回 `ScriptFileResult`:summary/artifacts 透传) |
| `src/pipelines/preprocess.ts` | `PreprocessSpec`/`PreprocessResult`/`PreprocessTrigger` 类型;`preprocessSteps(specs)`(三步多 spec);`buildBuiltinSpecs`/`loadPreprocessSpecs`(.mjs 配置载入);`filePathRegex`/`DEFAULT_QA_TEMPLATE`/`DEFAULT_NOTICE_TEMPLATE`/`DEFAULT_CLAUDE_PROMPT`;`fileRefLandingStep`/`DownloadFileFn`/导出 `FiredItem`(CARD_MSG 引用文件落地 step,step1 改 append) |
| `src/pipelines/default.ts` | `createDefaultPipeline(specs)`——默认识图→文本接力;preprocess 前插 `fileRefLandingStep(specs, downloadFile)`(附件落地) |
| `src/pipelines/log-qa.ts` | `createLogQaPipeline(opts)`——日志问答(内联构造 log spec,限定日志扩展名)+ text |
| `src/assistant.ts` | `Assistant.sessionCtx`、`route` @开启初始化、`handle` 注入(含挂 `scratch.fileRef`)、`pickDefaultPipeline`(async,调 `loadPreprocessSpecs`) |
| `src/llm.ts` / `src/session-pool.ts` / `src/claude-client.ts` | `SessionLlm.getWorkspacePath` → `SessionPool.getWorkspacePath` → `ClaudeSession.workspacePath`(接缝内) |
| `src/workspace.ts` | `createSessionWorkspace`(建子目录)、`removeDirIfEmpty`(空则回收) |
| `src/image.ts` | `downloadImage`(图片)+ `downloadFile`(文件,**sim 桩**,经 `fileRefLandingStep` 注入;生产下载 TODO:提取码/验证码,见 `doc/file-download-api.md`)+ `sanitizeFileName` |
| `scripts/preprocess-log.js` | 新协议的 Node.js 示例脚本 |

### 1.3 为什么 workspacePath 天然一致

text 会话(pooled)的 Claude 子进程 `cwd` 就是它的 `workspace/<groupId>/<日期时间>` 子目录(或 `BOT_ADD_DIR`)。`runScriptFile` 在 Node 主进程跑、把产物写进 `ctx.workspacePath`(同一路径);text 会话的 Claude 问答时 `cwd` 正是该目录,能直接 `grep`/`read` 产物 —— **主进程脚本与 Claude 子进程共享同一物理目录,无需任何同步**。Claude 驱动(driver:'claude')变体同理(同会话两轮:预处理轮在自己 cwd 落文件,问答轮同 cwd 读)。

---

## 2. Spec:声明一种预处理类型

`PreprocessSpec` 字段:

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 唯一,需匹配 `/^[A-Za-z0-9_-]+$/`;作 `session.__preprocess[name]` 键 |
| `trigger` | 是 | 正则(对 `content.text` 匹配)或函数 `(content) => PreprocessTriggerMatch \| null` |
| `inputFrom` | 否 | 从 match 取"待处理输入":数字=捕获组索引(默认 1;越界/空回退 full match);函数自定义。**仅对正则触发器生效**;函数触发器自负责 input |
| `script` | 是 | 脚本路径(driver:'script' 时用) |
| `interpreter` | 否 | 省略=node;'python'/'py'/'python3';null=直接跑 exe |
| `timeoutMs` | 否 | 脚本超时毫秒(默认 5min) |
| `appliesTo` | 否 | 'text'(默认)/'image'/'both'。默认 pipeline 在预处理前已把图片→文本,故 'text' 覆盖图片场景 |
| `driver` | 否 | 'script'(默认,确定性脚本)/'claude'(同会话 Claude 驱动) |
| `claudePrompt` | 否 | driver:'claude' 时的指令模板;缺省 `DEFAULT_CLAUDE_PROMPT` |
| `qaTemplate` | 否 | QA 注入文本生成;缺省 `DEFAULT_QA_TEMPLATE`(列产物目录+摘要+文件清单) |
| `notify` | 否 | 预处理完是否把结果发到群(默认 `true`);`false` 则只注入 AI 提问 |
| `noticeTemplate` | 否 | 发群通知文本;缺省 `DEFAULT_NOTICE_TEMPLATE`(✅+摘要+产物目录+文件数)。返回空串=不发 |

### 2.1 触发器

- **正则触发器**(常见):对 `content.text` 匹配;命中则 `match=m[0]`、`groups=m.map(...)`;`input` 由 `inputFrom` 解析(默认捕获组 1,无捕获组回退 full match)。正则只对 text 生效(图片走函数)。
- **函数触发器**(逃生口):`(content: UserContent) => { match, groups, input } | null`。**函数自负责返回 `input`**(`inputFrom` 不适用)。可处理图片、复杂判断、跨字段抽取。

`filePathRegex(exts?)` 工具:返回匹配文件绝对路径(Windows 盘符 / Unix 绝对;带扩展名)的正则;`exts` 限定扩展名。内置默认 spec 与 log-qa 都用它。

### 2.2 按输入去重

`session.__preprocess[name] = { inputs: string[], results: PreprocessResult[] }`(用数组非 Set,简单可序列化)。

- 同 spec + 同 `input` → 跳过(幂等,不重跑)。
- 同 spec + 不同 `input` → 各跑一次,`results` 累加。
- QA 组装 gather 全部 specs 的全部 `results`,拼进 content。
- 失败不 push `inputs` → 下次同 `input` 可重试。
- `exit` → `sessionCtx.delete` → `__preprocess` 全清 → 重新可跑。

> 想让"同输入也可重跑"?在 spec 里把 `inputFrom` 设成永远唯一的值(如时间戳)即可——但通常不需要。

---

## 3. 配置 specs(`.mjs`)

### 3.1 用 env 指向配置文件

```bash
# Windows PowerShell
$env:BOT_PREPROCESS_CONFIG='preprocess.config.mjs'
npm run dev        # 或 sim:bot

# Linux / macOS
BOT_PREPROCESS_CONFIG=preprocess.config.mjs npm run dev
```

`loadPreprocessSpecs()`:`BOT_PREPROCESS_CONFIG` 设 → 动态 `import(file://URL)`(Windows ESM 必须用 `file://` URL)读 `default` 导出(或具名 `specs`)→ 校验 → 返回;**未设 → `buildBuiltinSpecs()`**(文件路径→`scripts/preprocess-log.js`)。配置文件**替换**内置默认;要追加内置默认,在配置里 `import { buildBuiltinSpecs } from './src/pipelines/preprocess.ts'` 后展开(见 3.3)。

### 3.2 配置文件示例(`preprocess.config.mjs`)

```js
import { filePathRegex, buildBuiltinSpecs } from './src/pipelines/preprocess.ts'

export default [
  // 追加内置默认(文件路径→preprocess-log.js)
  ...buildBuiltinSpecs(),

  // 日志特化(zip/gz/…)→ Python 脚本
  {
    name: 'log',
    trigger: filePathRegex(['zip', 'gz', 'tgz', 'tar', 'log', 'txt']),
    inputFrom: 1,
    script: 'scripts/parse-log.py',
    interpreter: 'python',
    timeoutMs: 600_000,
  },

  // 关键词触发(函数触发器,input 自定)→ exe
  {
    name: 'ticket',
    trigger: (content) => {
      if (content.kind !== 'text') return null
      const m = content.text.match(/工单\s*([A-Z]{2}-\d+)/)
      return m ? { match: m[0], groups: [m[0], m[1]], input: m[1] } : null
    },
    script: 'D:/tools/ticket-fetch.exe',
    interpreter: null,
  },
]
```

> 注:从 `.mjs` import `.ts` 需经 tsx(开发)或编译后的 `dist/`(生产 `npm start`)。纯 JS 配置可只写正则+字符串,不 import 任何东西(见下"纯 JS 配置"。

### 3.3 纯 JS 配置(不依赖 ts)

```js
// preprocess.config.mjs — 不 import 项目源码,任意 node/tsx 都能跑
export default [
  {
    name: 'log',
    trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|gz|tgz|tar|log|txt)|\/[^\s,，]+\.(?:zip|gz|tgz|tar|log|txt))/i,
    inputFrom: 1,
    script: 'scripts/parse-log.py',
    interpreter: 'python',
  },
]
```

### 3.4 校验(启动即暴露)

`loadPreprocessSpecs` 校验:`name` 唯一且 `/^[A-Za-z0-9_-]+$/`、`trigger` 是 RegExp 或函数、`script` 非空串、`driver` ∈ {'script','claude'}、`appliesTo` ∈ {'text','image','both'}、`timeoutMs` 正数、`inputFrom` number 或函数、`interpreter` string|null|undefined。非法 → 抛描述性错误,bot 启动失败(早暴露)。

---

## 4. 脚本协议(driver:'script')

### 4.1 协议

```
stdin  ← JSON { content, workspacePath, trigger: { name, match, groups, input } }   (写入后 EOF)
stdout → JSON { "summary": "...", "artifacts"?: { "dir": "...", "files": [...] } }
        | 空 stdout = no-op(本类型跳过,不标 done)
        | 非 JSON / 非零退出 = 抛错(handle 降级致歉,不标 done,下次同输入可重试)
```

- `trigger.input`:待处理输入(由 `spec.inputFrom` 从触发正则捕获组解析,或函数触发器返回)。
- `trigger.match`/`groups`:正则的完整匹配与捕获组(函数触发器返回的)。
- `workspacePath`:会话 workspace 子目录绝对路径。**产物落这里**,text 会话 Claude 能读。
- `summary`:**必填**。给 AI 的产物摘要(空=视为未产出,抛错不标 done)。
- `artifacts.dir`:产物目录,**相对 `workspacePath`** 或绝对(默认模板解析成绝对注入 content)。省略=workspacePath 本身。
- `artifacts.files`:产物文件清单(可选)。

预处理完成后,bot 默认经 `ctx.notify` 把摘要发到群(`spec.notify` 可关、`noticeTemplate` 可定制,见 §2),先于最终回复。

### 4.2 Node.js 脚本(默认 interpreter)

省略 `interpreter` 即用 `node` 跑 `.js`。示例见 `scripts/preprocess-log.js`。要点:

```js
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const { trigger = {}, workspacePath } = JSON.parse(raw)
const input = trigger.input
if (!input || !workspacePath) { process.stdout.write(''); process.exit(0) }  // no-op

const outDir = join(workspacePath, 'extracted')
await mkdir(outDir, { recursive: true })
// ... 处理逻辑,产物落 outDir ...
const files = await readdir(outDir)
process.stdout.write(JSON.stringify({
  summary: `已处理 ${basename(input)},产物在 extracted/`,
  artifacts: { dir: 'extracted', files },
}))
```

### 4.3 Python 脚本

```bash
# spec: { script: 'scripts/parse-log.py', interpreter: 'python' }
```

```python
import sys, json, os, zipfile, shutil

raw = sys.stdin.read()
data = json.loads(raw)
trigger = data.get('trigger') or {}
wp = data.get('workspacePath')
inp = trigger.get('input')
if not inp or not wp:
    sys.stdout.write('')           # no-op
    sys.exit(0)

out_dir = os.path.join(wp, 'extracted')
os.makedirs(out_dir, exist_ok=True)
files = []
if inp.lower().endswith('.zip'):
    with zipfile.ZipFile(inp) as z:
        z.extractall(out_dir)
        files = z.namelist()
else:
    shutil.copy(inp, out_dir)
    files = [os.path.basename(inp)]

sys.stdout.write(json.dumps({
    'summary': f'已处理 {os.path.basename(inp)},产物在 extracted/,共 {len(files)} 个文件',
    'artifacts': {'dir': 'extracted', 'files': files},
}))
```

### 4.4 exe / 任意可执行

```js
{ script: 'D:/tools/log-parser.exe', interpreter: null }
```

`interpreter: null` → 直接 `execFile(scriptPath)`(不带解释器)。exe 必须守协议(读 stdin JSON、写 stdout JSON)。Linux 带 shebang 的脚本(`#!/usr/bin/env bash`)同理(需可执行权限)。`interpreter` 也可是 `'bash'`/`'ruby'` 等(PowerShell 需 `-File`,走第 6 节包装更顺)。

### 4.5 跨平台与可执行名

| 平台 | Python 推荐 | 说明 |
|---|---|---|
| Windows | `'python'` 或 `'py'` | `py` 是官方 launcher;python.org 安装通常 `python` 在 PATH |
| Linux/macOS | `'python3'` | 系统自带或包管理装 |
| 不确定 | 绝对路径 | `'C:/Python311/python.exe'` 或 `/usr/bin/python3` |

**依赖**:Python 第三方库写 `scripts/requirements.txt`,部署 `pip install -r scripts/requirements.txt`。`zipfile`/`gzip`/`tarfile`/`json`/`os`/`shutil` 均标准库,零依赖。

---

## 5. driver:'claude'(同会话 Claude 驱动)

不跑外部脚本,让同会话 Claude 用 bash 预处理:

```js
{
  name: 'log-claude',
  trigger: filePathRegex(['zip', 'log', 'txt']),
  inputFrom: 1,
  driver: 'claude',
  claudePrompt: (input) => `请预处理 ${input}:在当前工作目录下解压并解析,产物留在目录内,最后总结产物清单与关键线索。`,
}
```

`summary` = Claude 的 markdown 回复;`artifacts.dir` = workspacePath(Claude 在自己 cwd 落文件)。无文件清单。适合临时/灵活场景;确定性大批量用 driver:'script' 更稳。

---

## 6. 不符合协议的脚本/命令怎么接(`scriptStep` 包装)

外部工具接收命令行参数而非 stdin、或输出自由文本、或需复杂参数(`-File`/`--out`/重定向)→ 用 `scriptStep(fn)` 内联 `child_process.spawn`,自己 parse 输出、写 `session.__preprocess`:

```ts
import { spawn } from 'node:child_process'
import { join, isAbsolute } from 'node:path'
import { scriptStep } from '../pipeline.js'

// 在自定义 pipeline steps 里(经 options.pipeline 注入):
scriptStep(async (ctx) => {
  if (!ctx.workspacePath) return
  const m = ctx.content.kind === 'text' ? ctx.content.text.match(/工单\s*([A-Z]{2}-\d+)/) : null
  if (!m) return
  const input = m[1]
  // ...自己维护 session.__preprocess 去重(参照 preprocess.ts)...
  const outDir = join(ctx.workspacePath, 'ticket')
  const child = spawn('D:/tools/ticket-fetch.exe', [input, '--out', outDir, '--format', 'json'])
  let stdout = ''
  child.stdout.on('data', (c) => { stdout += c })
  const code = await new Promise<number>(r => child.on('exit', r))
  if (code !== 0) throw new Error(`ticket-fetch exited ${code}`)
  // ...parse stdout,写 session.__preprocess[name].results / inputs...
})
```

**spec+`script`(协议化)是快路径,`scriptStep`+`spawn` 是万能兜底。**优先用 spec+协议;只在无法守协议时走这节。

---

## 7. 拓展方式(都不碰核心)

1. **加新 spec**:写 `.mjs` 配置(`BOT_PREPROCESS_CONFIG`),声明 `{name, trigger, script, interpreter, …}`。零代码。
2. **换 spec 脚本**:spec 的 `script`/`interpreter` 指向你的脚本(.js/.py/.exe);守第 4 节协议即可。
3. **换触发条件**:spec 的 `trigger`(正则或函数)+ `inputFrom`。函数触发器可任意复杂(图片、关键词、跨字段)。
4. **换 QA 注入**:spec 的 `qaTemplate(result, workspacePath)` 自定义注入文本。
5. **加新 pipeline 工厂**(新场景,如"代码库问答"):在 `src/pipelines/` 加工厂,复用 `preprocessSteps(specs)` 组装,经 `options.pipeline` 注入或加 `BOT_PIPELINE` 分支(见 `assistant.ts` `pickDefaultPipeline`)。
6. **不符协议的工具**:第 6 节 `scriptStep`+`spawn` 包装。

> 加/换模型 → `src/models.ts`;改输出规则 → `outputPolicy` / `BOT_PICTURE_OUTPUT=html`。

---

## 8. 端到端示例:接 Python 预处理脚本

### 8.1 脚本

把第 4.3 的 `scripts/parse-log.py` 放到项目根 `scripts/` 下(本例只用标准库,可空 `requirements.txt`)。

### 8.2 配置 + 启动

`preprocess.config.mjs`(项目根):
```js
export default [
  { name: 'log', trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|gz|tgz|tar|log|txt)|\/[^\s,，]+\.(?:zip|gz|tgz|tar|log|txt))/i, inputFrom: 1, script: 'scripts/parse-log.py', interpreter: 'python' },
]
```

```bash
# Windows PowerShell
$env:BOT_PREPROCESS_CONFIG='preprocess.config.mjs'
npm run sim:bot
```

不配 `BOT_PREPROCESS_CONFIG` 时用内置默认(文件路径→`scripts/preprocess-log.js`)。要换脚本/解释器就写配置。

### 8.3 验证

1. `@bot 开启` → 收 ack;`workspace/<groupId>/<日期时间>/` 已建。
2. 发 `D:/logs/xxx.zip 有什么错误`(正文贴绝对路径)→ spec `log` 触发 → `workspace/…/extracted/` 出现产物 + Claude 回预处理 summary。
3. 后续提问(不带路径)→ Claude 基于 `extracted/` 产物 `grep`/`read` 回答;同输入不重跑(去重)。
4. 发**另一个**日志路径 → 同 spec 不同 input,再跑一次,结果累加,QA 列出两个产物目录。
5. 发不带路径的普通提问 → **不 spawn**(条件跑),直接 `text` 回答。
6. `exit` → 会话结束;`__preprocess` 清空;空 workspace 回收,非空(有产物)保留。

---

## 9. 检查清单

- **路径**:Windows 反斜杠在 JS 字符串里转义或用正斜杠;含空格/中文的路径用 `execFile` 数组参数(不要拼进 command 字符串)。
- **超时**:`runScriptFile` 默认 5min;大日志调大 `timeoutMs`。超时 SIGTERM(Windows TerminateProcess),错误被降级。
- **失败重试**:预处理失败不标 done,下次发同输入可重试;但**同一会话**用户得重新发触发消息(水位已推进,旧消息不重处理)。
- **workspace 回收**:会话 `exit` 后空目录自动回收;**有产物的目录保留**(用户可查)。
- **安全**:`bypassPermissions` 给了 Claude 完整工具权;workspace 是隔离的安全边界,**勿放敏感文件**。外部脚本也跑在主进程,注意权限。预处理脚本读用户给的路径——**校验路径**防越权(如限定在某个日志根目录下,拒绝 `..`)。`BOT_PREPROCESS_CONFIG` 指向的 `.mjs` 会执行任意代码,只指向可信文件(同预处理脚本信任模型)。
- **Python 可执行名**:部署环境确认 `python`/`py`/`python3` 在 PATH,或传绝对路径。
- **协议一致性**:用 spec+`script` 必须守 stdin JSON / stdout JSON 协议(读 `trigger.input`、回 `summary`+`artifacts`);不符合走第 6 节 `scriptStep`+`spawn`。
- **保留键**:`session.__preprocess`(`__` 前缀)是框架内部状态(按输入去重 + 累计结果);脚本不接触 `session`(协议已无该字段)。
- **并发**:同用户消息在 route 内串行(tick for-await),无并发;不同用户独立 workspace + sessionCtx,互不影响。多 spec 同消息顺序跑(不并发 spawn)。
