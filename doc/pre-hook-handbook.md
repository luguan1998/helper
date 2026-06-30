# Pre-Hook 用户配置手册

> Pre-hook = 在 AI 分析前对一条消息做"预处理"的钩子:用**触发器**判断要不要处理、用**脚本**产出工件、把工件所在 + 摘要告诉 AI(并即时发到群),再让 AI 分析。
> 本手册面向"我想加自己的 pre-hook"的用户:写一个 `.mjs` 配置、(可选)写一个脚本,即可。
> 深入架构 / 改 pipeline / `scriptStep+spawn` 兜底见 `doc/session-preprocessing.md`;从零起见 `doc/getting-started.md`。

---

## 1. 工作机制(30 秒)

1. 群里 `@bot 开启` 会话 → bot 为该会话建一个工作目录(`workspace/<群>/<时间>/`,或 `BOT_ADD_DIR`)。
2. 你发消息 → bot 逐个 spec 试触发器;命中的 spec 跑它的脚本,产物落工作目录,**摘要即时发到群**(默认开,`notify`)。
3. 之后你提问 → bot 把"产物目录 + 摘要"注入提问,AI 用 `grep`/`read` 查产物回答。
4. `exit` 结束会话 → 预处理状态清空(空目录回收,有产物保留)。

**一个 spec = 一种 pre-hook**。可声明多个,各带触发器 + 脚本,同会话可累计多个产物。

---

## 2. 快速开始(3 步)

### 步骤 1:写配置文件(项目根,`preprocess.config.mjs`)

最小例子——消息里贴文件路径就触发,用内置 Node 脚本:

```js
export default [
  {
    name: 'file',
    trigger: /([A-Za-z]:[\\/][^\s,，]+\.[a-zA-Z0-9]+|\/[^\s,，]+\.[a-zA-Z0-9]+)/i,
    inputFrom: 1,
    script: 'scripts/preprocess-log.js',
  },
]
```

### 步骤 2:设环境变量指向它

```bash
# Windows PowerShell
$env:BOT_PREPROCESS_CONFIG='preprocess.config.mjs'
npm run dev        # 或 npm run sim:bot

# Linux / macOS
BOT_PREPROCESS_CONFIG=preprocess.config.mjs npm run dev
```

> 不设 `BOT_PREPROCESS_CONFIG` → 用内置默认(就是上面那条 file spec,脚本 `scripts/preprocess-log.js`)。设了配置 → **替换**内置默认;要保留内置,在配置里 `...buildBuiltinSpecs()` 追加(见 §6)。

### 步骤 3:群里验证

```
@bot 开启
D:/logs/xxx.zip 有什么错误       ← 触发:贴绝对路径;bot 先发"✅ 预处理完成"摘要
这个日志里有哪些 ERROR?          ← AI 基于产物回答
exit
```

---

## 3. Spec 字段参考

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `name` | 是 | — | 唯一名,`/^[A-Za-z0-9_-]+$/`(用作内部状态键) |
| `trigger` | 是 | — | 正则(对消息文本匹配)或函数 `(content) => match \| null` |
| `inputFrom` | 否 | `1` | 从匹配取"待处理输入":数字=捕获组索引(越界/空回退整串);函数自定义。**仅正则触发器生效** |
| `script` | 是¹ | — | 脚本路径(.js/.py/.exe…) |
| `interpreter` | 否 | `node` | 省略=node 跑 `.js`;`'python'`/`'py'`/`'python3'`;`null`=直跑 exe/带 shebang 脚本;其它字符串当解释器名 |
| `timeoutMs` | 否 | `300000`(5min) | 脚本超时;大日志调大 |
| `appliesTo` | 否 | `'text'` | `'text'`/`'image'`/`'both'`。**默认 pipeline 在 pre-hook 前已把图片转成文本**,故 `'text'` 覆盖图片场景;`'image'` 仅用于跳过识图的自定义 pipeline |
| `driver` | 否 | `'script'` | `'script'`(跑外部脚本)/`'claude'`(同会话 Claude 用 bash 处理) |
| `claudePrompt` | 否² | 内置模板 | `driver:'claude'` 时的指令 `(input) => string` |
| `qaTemplate` | 否² | 内置模板 | 注入 AI 提问的文本 `(result, workspacePath) => string`;返回空串=不注入 |
| `notify` | 否 | `true` | 预处理完成是否把结果**发到群**;`false` 则只注入 AI 提问、不发群消息 |
| `noticeTemplate` | 否² | 内置模板 | 发群通知文本 `(result, workspacePath) => string`;返回空串=不发。仅 `notify!==false` 时调用 |

¹ `script` 仅 `driver:'script'` 时必填。
² 缺省:`DEFAULT_CLAUDE_PROMPT` / `DEFAULT_QA_TEMPLATE`(注入 AI)/ `DEFAULT_NOTICE_TEMPLATE`(发群通知:✅ + 摘要 + 产物目录 + 文件数)。

---

## 4. 触发器

### 4.1 正则触发器(常见)

对消息文本匹配。`match=整串`、`groups=捕获组`(`groups[0]`=整串,`groups[1]`…=捕获)。`input` 由 `inputFrom` 解析(默认捕获组 1;正则无捕获组则回退整串)。

```js
// 匹配 Windows/Unix 文件绝对路径(带扩展名),input = 路径(捕获组 1)
trigger: /([A-Za-z]:[\\/][^\s,，]+\.[a-zA-Z0-9]+|\/[^\s,，]+\.[a-zA-Z0-9]+)/i,
inputFrom: 1,

// 限定日志扩展名
trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|gz|tar|log|txt)|\/[^\s,，]+\.(?:zip|gz|tar|log|txt))/i,
```

> 懒得写路径正则?配置里 `import { filePathRegex } from './src/pipelines/preprocess.ts'` 后用 `trigger: filePathRegex()`(任意扩展名)或 `filePathRegex(['zip','log'])`(限定)。纯 JS 配置(不 import 项目源码)就直接写字面正则,见 §2/§6。

### 4.2 函数触发器(逃生口)

`(content) => { match, groups, input } | null`。**函数自负责返回 `input`**(`inputFrom` 不适用)。可做复杂判断、跨字段抽取、关键词触发:

```js
trigger: (content) => {
  if (content.kind !== 'text') return null
  const m = content.text.match(/工单\s*([A-Z]{2}-\d+)/)
  return m ? { match: m[0], groups: [m[0], m[1]], input: m[1] } : null
  // input = 工单号(如 IT-12345),喂给脚本
},
```

> 图片:默认 pipeline 在 pre-hook 前已把图片转成"图片内容:…\n附言",故函数触发器看到的是文本。要匹配图片附言,按文本匹配即可。

---

## 5. 脚本协议(`driver:'script'`)

```
stdin  ← JSON { content, workspacePath, trigger: { name, match, groups, input } }
stdout → JSON { "summary": "...", "artifacts"?: { "dir": "...", "files": [...] } }
        | 空 stdout = no-op(跳过,不标完成)
        | 非 JSON / 非零退出 = 失败(发致歉,不标完成,下次同输入可重试)
```

- `trigger.input`:你要处理的对象(文件路径 / 工单号 / …)。
- `workspacePath`:会话工作目录绝对路径。**产物落这里**,AI 问答时能直接 `grep`/`read`。
- `summary`:**必填**,给 AI 的线索。空 = 视为未产出,抛错。
- `artifacts.dir`:产物目录,**相对 `workspacePath`** 或绝对(默认注入模板解析成绝对)。省略=workspacePath 本身。
- `artifacts.files`:产物文件清单(可选)。

---

## 6. 配方集

### 6.1 文件路径 → Node 脚本(默认)

```js
export default [
  { name: 'file', trigger: /([A-Za-z]:[\\/][^\s,，]+\.[a-zA-Z0-9]+|\/[^\s,，]+\.[a-zA-Z0-9]+)/i, inputFrom: 1, script: 'scripts/preprocess-log.js' },
]
```

脚本模板见 `scripts/preprocess-log.js`(已是,可改)。

### 6.2 文件路径 → Python 脚本

```js
export default [
  {
    name: 'log',
    trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|gz|tar|log|txt)|\/[^\s,，]+\.(?:zip|gz|tar|log|txt))/i,
    inputFrom: 1,
    script: 'scripts/parse-log.py',
    interpreter: 'python',     // Windows 也可试 'py';Linux/mac 用 'python3'
    timeoutMs: 600_000,
  },
]
```

`scripts/parse-log.py`:

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

### 6.3 关键词 → exe

```js
export default [
  {
    name: 'ticket',
    trigger: (content) => {
      if (content.kind !== 'text') return null
      const m = content.text.match(/工单\s*([A-Z]{2}-\d+)/)
      return m ? { match: m[0], groups: [m[0], m[1]], input: m[1] } : null
    },
    script: 'D:/tools/ticket-fetch.exe',
    interpreter: null,         // 直接跑 exe(exe 须守 §5 协议:读 stdin JSON、写 stdout JSON)
  },
]
```

> exe 不守协议(收命令行参数、输出自由文本)?不要用 `script`+`interpreter`,改走 `scriptStep(fn)+spawn` 兜底,见 `doc/session-preprocessing.md` 第 6 节。

### 6.4 同会话 Claude 驱动(不写脚本)

```js
export default [
  {
    name: 'log-claude',
    trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|log|txt))/i,
    inputFrom: 1,
    driver: 'claude',
    claudePrompt: (input) => `请预处理 ${input}:在当前工作目录下解压并解析,产物留在目录内,最后总结产物清单与关键线索。`,
  },
]
```

`summary` = Claude 的回复;产物目录 = 工作目录(Claude 在自己 cwd 落文件)。适合临时/灵活场景;大批量确定性处理用 `driver:'script'` 更稳。通知默认也发(`notify:true`),若不想 Claude 的预处理摘要重复刷屏,设 `notify: false`。

### 6.5 多 spec 组合(+ 追加内置默认)

```js
// 开发(tsx)可直接 import .ts;生产(npm start)改从 dist/ 导入编译产物
import { buildBuiltinSpecs, filePathRegex } from './src/pipelines/preprocess.ts'

export default [
  ...buildBuiltinSpecs(),    // 内置:文件路径 → scripts/preprocess-log.js
  { name: 'log', trigger: filePathRegex(['zip','gz','tar','log','txt']), inputFrom: 1, script: 'scripts/parse-log.py', interpreter: 'python' },
  { name: 'ticket', trigger: (c) => { /* 同 6.3 */ }, script: 'D:/tools/ticket-fetch.exe', interpreter: null },
]
```

> 纯 JS 配置(不 import 项目源码,任意 node/tsx 能跑)就把 `filePathRegex(...)` 换成字面正则、去掉 `buildBuiltinSpecs` 那行(或手写 file spec)。

---

## 7. 去重与累计行为

- **同 spec + 同 input** → 跳过(幂等,不重跑)。
- **同 spec + 不同 input**(如发两个不同 zip)→ 各跑一次,产物摘要**累计**;之后提问 AI 能看到全部产物目录。
- **失败** → 不记完成,下次发**同一条触发消息**可重试(水位已推进,旧消息不会重拉)。
- **`exit`** → 预处理状态全清,重新 `@bot 开启` 后 spec 重新可跑。
- **多 spec 同消息命中** → 全触发、顺序跑、互不影响(某个失败不阻断其他)。

> 想让"同输入也可重跑"?把 `inputFrom` 设成永远唯一的值(如时间戳)即可——但通常不需要。

---

## 8. 发群通知与 QA 注入

预处理完成后,bot 默认**把摘要发到群**(经 welink-cli im),然后再让 AI 分析、发最终回复。两件事可分别配置:

### 8.1 发群通知(`notify` / `noticeTemplate`)

默认通知(`DEFAULT_NOTICE_TEMPLATE`):`✅ 【name】预处理完成\n摘要:…\n产物:…(N 文件)`,每个 spec 完成即发一条,先于最终回复。

- 关闭某 spec 的通知:`notify: false`(摘要仍注入 AI 提问,只是不发群消息)。
- 自定义通知文本:`noticeTemplate: (r, workspacePath) => string`(返回空串=不发)。

```js
noticeTemplate: (r, wp) => `📦 ${r.name} 解析完毕:${r.summary}`,
```

### 8.2 QA 注入(告诉 AI 什么)

默认注入 AI 提问:`已预处理以下内容,可用 grep/read 按需查询产物目录:\n【name】(输入:…)\n产物目录:…\n摘要:…\n产物文件:…\n\n用户问题:…`。

用 `qaTemplate` 改写(返回空串 = 该结果不注入):

```js
qaTemplate: (r, workspacePath) =>
  `日志已解析(${r.input}),详见 ${r.artifacts.dir}/。摘要:${r.summary}`,
```

`r` = `{ name, input, summary, artifacts:{dir, files} }`;`workspacePath` = 会话工作目录绝对路径(`r.artifacts.dir` 相对它,需绝对时用 `path.join(workspacePath, r.artifacts.dir)`)。

---

## 9. 配置校验(启动即暴露)

`BOT_PREPROCESS_CONFIG` 的 `.mjs` 在 bot 启动时载入并校验,非法 → bot 启动失败(早暴露)。校验规则:

- `name`:唯一、匹配 `/^[A-Za-z0-9_-]+$/`
- `trigger`:`RegExp` 或函数
- `script`:非空字符串(`driver:'script'` 时)
- `driver`:`'script'` 或 `'claude'`
- `appliesTo`:`'text'`/`'image'`/`'both'`
- `timeoutMs`:正数
- `inputFrom`:number 或函数
- `interpreter`:string / null / undefined

`.mjs` 会执行任意代码(同预处理脚本信任模型),**只指向可信文件**。

---

## 10. 检查清单 / 排错

- **不触发?**
  - 正则要能匹配消息正文。文件路径需是**绝对路径 + 扩展名**(`D:/logs/x.zip`,不能只写 `x.zip`)。
  - 函数触发器记得 `return null` 表示不触发,且必须返回 `input`。
  - 先 `@bot 开启` 再发触发消息;`exit` 后状态清空,需重新开启。
- **脚本没跑/报错?**
  - 看终端日志:`[preprocess] spec '…' input='…' failed: …`。
  - 确认 `interpreter` 在 PATH(Windows `python`/`py`,Linux `python3`),或传绝对路径。
  - 脚本必须守 §5 协议:读 stdin JSON、写 stdout JSON(空 stdout = no-op);非 JSON/非零退出 = 失败。
  - 超时?调大 `timeoutMs`;大日志别一次性读进内存,分块或用流。
- **没发群通知?**
  - 默认开(`notify:true`)。确认 spec 没设 `notify: false`、`noticeTemplate` 没返回空串。
  - 通知发送失败/超时不会阻断最终回复(单条容错),看终端有无 send 错误。
- **产物 AI 看不到?**
  - 产物必须落在 `workspacePath` 下(text 会话 Claude cwd 即此目录,默认 `**` 能命中)。
  - `artifacts.dir` 用相对 `workspacePath` 的路径(如 `'extracted'`),注入模板会解析成绝对告诉 AI。
- **换了脚本/配置没生效?** 重启 bot(配置仅启动时载入,无热重载)。
- **路径含空格/中文/反斜杠?** 用 `execFile` 数组参数(spec 的 `script` 路径 + 协议 JSON 经 stdin)天然安全;消息正文里贴路径,反斜杠正斜杠都行(`D:/logs/x.zip` 最稳)。
- **安全**:`bypassPermissions` 给了 Claude 完整工具权,工作目录是隔离边界,**勿放敏感文件**。脚本读用户给的路径——**校验路径**防越权(限定某根目录下,拒绝 `..`)。
