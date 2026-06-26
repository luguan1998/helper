# 会话预处理架构与脚本扩展指南

> 本文说明"会话预处理"机制的设计、后续如何拓展,以及如何引入自己的脚本(Node.js / Python / exe / 任意可执行)。
> 实现见 `src/pipeline.ts`、`src/pipelines/log-qa.ts`、`src/assistant.ts`;示例脚本 `scripts/preprocess-log.js`。

---

## 1. 架构回顾(已实现)

### 1.1 一句话

**会话预处理 = pipeline 内一个带 `ctx.session.preprocessed` 守卫的 step + 会话级 `ctx.session`(跨消息保留)+ `ctx.workspacePath`(会话 workspace 子目录路径,经 `sessionLlm.getWorkspacePath(userId)` 取得)。** 预处理跑一次,产物落 workspace 文件,后续问答由 Claude 用 `grep`/`read` 按需查。

不引入 `sessionSteps` 字段,`Pipeline` 接口不变,默认 pipeline 不带预处理,核心循环(route/tick/handle)几乎不动。

### 1.2 数据流

```
@bot 开启
  └─ route() @开启分支:startSession(spawn Claude + 建 workspace/<日期时间>)
     ├─ sessionLlm.getWorkspacePath(sender)  ← 接缝内取 workspace 子目录路径
     └─ sessionCtx.set(sender, { scratch:{}, workspacePath })  ← 会话级上下文初始化

用户发消息(活跃期间,每条都进 handle)
  └─ handle():ctx = { userId, content, scratch:{}, session: sessionCtx[sender].scratch(引用), workspacePath }
     └─ runPipeline(log-qa):
        step1 守卫+抽取:已预处理?跳过。从正文抽日志路径 → session.pendingInput
        step2 预处理:scriptFileStep 跑脚本 / modelStep 让 Claude 跑 → 产物落 workspacePath,回写 session.preprocessed/files/summary
        step3 问答组装:已预处理 → content 注入 workspacePath + summary(让 Claude grep/read)
        step4 modelStep('text'):回答

exit → endSession(kill Claude → 空目录回收)+ sessionCtx.delete
```

### 1.3 关键文件

| 文件 | 角色 |
|---|---|
| `src/pipeline.ts` | `StepCtx`(含 `session`/`workspacePath`)、`modelStep`/`scriptStep`/`scriptFileStep`、`runPipeline` |
| `src/pipelines/log-qa.ts` | `createLogQaPipeline(opts)`——日志问答 4 步 pipeline(`driver:'script'`/`'claude'`) |
| `src/pipelines/default.ts` | `createDefaultPipeline()`——默认识图→文本接力(不带预处理,零配置默认) |
| `src/assistant.ts` | `Assistant.sessionCtx`(会话级 scratch map)、`route` @开启初始化、`handle` 注入、`pickDefaultPipeline`(`BOT_PIPELINE` env) |
| `src/llm.ts` / `src/session-pool.ts` / `src/claude-client.ts` | `SessionLlm.getWorkspacePath` → `SessionPool.getWorkspacePath` → `ClaudeSession.workspacePath`(接缝内) |
| `src/workspace.ts` | `createSessionWorkspace`(建子目录)、`removeDirIfEmpty`(空则回收) |
| `scripts/preprocess-log.js` | `scriptFileStep` 协议的 Node.js 示例脚本 |

### 1.4 为什么 workspacePath 天然一致

text 会话(pooled)的 Claude 子进程 `cwd` 就是它的 `workspace/<日期时间>` 子目录。`scriptFileStep` 在 Node 主进程跑、把产物写进 `ctx.workspacePath`(同一路径);text 会话的 Claude 问答时 `cwd` 正是该目录,能直接 `grep`/`read` 产物 —— **主进程脚本与 Claude 子进程共享同一物理目录,无需任何同步**。Claude 驱动变体同理(同会话两轮:预处理轮在自己 `cwd` 落文件,问答轮同 `cwd` 读)。

---

## 2. 拓展方式(都不碰核心)

按"粒度由小到大"三种方式,任选其一:

### 2.1 换 step2 预处理实现(最小改动)

`log-qa.ts` 的 step2 是预处理本身。改它即可换预处理逻辑:
- 确定性脚本:`scriptFileStep(path, { interpreter })`(默认)
- Claude 驱动:`async (ctx, models) => { ... models.text.ask(...) ... }`(同会话,灵活)
- 自定义 step:任意 `(ctx, models) => Promise<void>`,自由组合 `child_process`、调外部 API 等

### 2.2 加新 pipeline 工厂(新场景)

新场景(如"代码库问答""工单预处理")→ 在 `src/pipelines/` 加一个新工厂文件,复用 `scriptStep`/`scriptFileStep`/`modelStep` 组装 steps,经 `options.pipeline` 注入或加 `BOT_PIPELINE` 分支(见 `assistant.ts` `pickDefaultPipeline`)。

### 2.3 换触发条件(改 step1)

`log-qa.ts` step1 的 `extractLogInput` 决定"什么消息触发预处理"。改成抽别的(如"正文含 `@日志`""带附件""特定关键词")即可换触发语义。守卫 `ctx.session.preprocessed` 保证只跑一次。

### 2.4 会话级状态用法

- `ctx.session` 是 `Record<string, unknown>`,**跨消息保留**(同一引用,step mutate 直接生效到 `Assistant.sessionCtx` 持有的对象)。
- 约定 key:守卫标志用 `preprocessed: boolean`、待处理输入用 `pendingInput`/`pendingXxx`、产物元信息用 `files`/`summary`。自由扩展。
- 多种"会话级一次性"处理:每个处理各带自己的 `session.xxxDone` 守卫,互不干扰。当出现第 3+ 个时,可抽 `oncePerSession(key, step)` 工厂(当前 YAGNI,未实现)。

### 2.5 失败与重试

预处理 step **只在成功后**写 `session.preprocessed = true`。失败(抛错)→ `handle` try/catch 降级(发纯文本致歉,循环不死),`preprocessed` 未标,下次发同一条/新日志可重试。

---

## 3. 引入自己的脚本(`scriptFileStep` 协议)

### 3.1 协议

```
stdin  ← JSON { content, session, workspacePath }   (scriptFileStep 写入后 EOF)
stdout → JSON { "session": {...增量}, "content"?: {...} }   (merge 进 ctx.session / 覆盖 ctx.content)
        | 空 stdout = no-op(跳过,不改 ctx)
stdout 非零退出 / 非 JSON → 抛错(handle 降级,不标 preprocessed,可重试)
```

- `content`:当前 `UserContent`(`{kind:'text',text}` / `{kind:'image',imagePath,caption}`)。
- `session`:会话级 scratch(含 `pendingInput` 等触发信息)。回写的 `session` 字段会 **merge**(不是替换)进 `ctx.session`。
- `workspacePath`:会话 workspace 子目录绝对路径。**产物落这里**,text 会话 Claude 能读。

### 3.2 脚本放哪、路径怎么传

- 默认放 `scripts/`(项目根下),`scriptFileStep('scripts/xxx.js')` 相对**进程 cwd**(npm 启动时为项目根)解析。
- 跨进程 cwd 不确定时,传**绝对路径**:在 pipeline 工厂里用 `path.resolve(__dirname, '../../scripts/xxx.js')` 或 `process.env.MY_SCRIPT_PATH`。
- Windows 路径:反斜杠需在 JS 字符串里转义(`'D:\\logs\\x.zip'`)或用正斜杠(`'D:/logs/x.zip'`,Node/Python 都接受)。

### 3.3 Node.js 脚本(默认 interpreter)

省略 `interpreter` 即用 `node` 跑 `.js`。示例见 `scripts/preprocess-log.js`。要点:

```js
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk          // 读 stdin
const { session = {}, workspacePath } = JSON.parse(raw)
const pendingInput = session.pendingInput
if (!pendingInput || !workspacePath) { process.stdout.write(''); process.exit(0) }  // no-op

const outDir = join(workspacePath, 'extracted')
await mkdir(outDir, { recursive: true })
// ... 处理逻辑,产物落 outDir ...
const files = await readdir(outDir)
process.stdout.write(JSON.stringify({                          // 写 stdout
  session: { preprocessed: true, files, summary: '...' }
}))
```

---

## 4. 引用 Python 脚本

### 4.1 用法

```ts
scriptFileStep('scripts/parse-log.py', { interpreter: 'python' })
```

底层:`execFile('python', ['scripts/parse-log.py'])`,stdin/stdout 协议同上。

### 4.2 Python 示例(`scripts/parse-log.py`)

```python
import sys, json, os, zipfile, shutil

raw = sys.stdin.read()
data = json.loads(raw)
session = data.get('session') or {}
wp = data.get('workspacePath')
pending = session.get('pendingInput')
if not pending or not wp:
    sys.stdout.write('')           # no-op
    sys.exit(0)

out_dir = os.path.join(wp, 'extracted')
os.makedirs(out_dir, exist_ok=True)
files = []
if pending.lower().endswith('.zip'):
    with zipfile.ZipFile(pending) as z:
        z.extractall(out_dir)
        files = z.namelist()
elif pending.lower().endswith(('.gz', '.tgz')):
    import gzip, tarfile
    if pending.lower().endswith('.tgz'):
        with tarfile.open(pending, 'r:gz') as t: t.extractall(out_dir)
    else:
        with gzip.open(pending, 'rb') as f:
            open(os.path.join(out_dir, os.path.basename(pending)[:-3]), 'wb').write(f.read())
    files = os.listdir(out_dir)
else:  # 原生 log/txt:复制
    shutil.copy(pending, out_dir)
    files = [os.path.basename(pending)]

summary = f"已预处理 {os.path.basename(pending)},产物在 extracted/,共 {len(files)} 个文件"
sys.stdout.write(json.dumps({'session': {'preprocessed': True, 'files': files, 'summary': summary}}))
```

### 4.3 跨平台与可执行名

`interpreter` 是任意字符串,直接当可执行名/路径传给 `execFile`:

| 平台 | 推荐 | 说明 |
|---|---|---|
| Windows | `'python'` 或 `'py'` | `py` 是官方 launcher,能选版本(`py -3`)。python.org 安装通常 `python` 在 PATH |
| Linux/macOS | `'python3'` | 系统自带或包管理装 |
| 不确定 | 绝对路径 | `interpreter: 'C:/Python311/python.exe'` 或 `/usr/bin/python3` |

**依赖管理**:Python 脚本若用第三方库(如 `pandas`),建议在 `scripts/requirements.txt` 声明,部署时 `pip install -r scripts/requirements.txt`;或在脚本里用 venv shebang(`#!/path/to/venv/bin/python`)。`zipfile`/`gzip`/`tarfile`/`json`/`os`/`shutil` 均为标准库,零依赖。

---

## 5. 引用 exe / 任意可执行

### 5.1 用法

```ts
scriptFileStep('D:/tools/log-parser.exe', { interpreter: null })
```

`interpreter: null` → 直接 `execFile(scriptPath)`(不带解释器)。Windows 上经 `shell:true` 解析扩展名/PATH,故 `.exe` 可省略扩展名(`'D:/tools/log-parser'`)也能跑。Linux 带 shebang 的脚本(如 `#!/usr/bin/env bash`)同样用 `interpreter: null`(需文件有可执行权限)。

### 5.2 exe 协议要求

exe 要**符合 scriptFileStep 协议**:读 stdin 的 JSON、往 stdout 写 JSON。若你的 exe 是这样设计的,直接 `interpreter: null` 接入。

**若 exe 不符合协议**(如接收命令行参数、输出自由文本)→ 不要用 `scriptFileStep`,改用 `scriptStep(fn)` 包装(见第 6 节)。

### 5.3 也支持其它解释器

`interpreter` 是任意可执行,例如:
- `interpreter: 'bash'` → `execFile('bash', ['scripts/x.sh'])`
- `interpreter: 'pwsh'` → `execFile('pwsh', ['-File', ...])`(注意:`scriptFileStep` 把 scriptPath 当第一个参数,PowerShell 需 `-File`,故 PS 脚本走第 6 节包装更顺)
- `interpreter: 'ruby'`/`'perl'` 等,同理

---

## 6. 不符合协议的脚本/命令怎么接(`scriptStep` 包装)

当外部工具:
- 接收命令行参数而非 stdin,或
- 输出自由文本而非 JSON,或
- 需要复杂参数(`-File`、`--out`、重定向)

→ 用 `scriptStep(fn)` 内联 `child_process` 自定义调用,自己 parse 输出、写 `ctx.session`:

```ts
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// 在 pipeline steps 里:
scriptStep(async (ctx) => {
  if (ctx.session.preprocessed) return
  if (!ctx.session.pendingInput || !ctx.workspacePath) return  // 非触发消息

  const outDir = join(ctx.workspacePath, 'extracted')
  // 例:调 exe,命令行参数传输入路径 + 输出目录
  const child = spawn('D:/tools/log-parser.exe', [
    ctx.session.pendingInput as string,
    '--out', outDir,
    '--format', 'json',
  ])
  let stdout = ''
  child.stdout.on('data', (c) => { stdout += c })
  const code = await new Promise<number>(r => child.on('exit', r))
  if (code !== 0) throw new Error(`log-parser exited ${code}`)

  // exe 输出可能是自由文本或它自己的 JSON → 自己 parse
  ctx.session.preprocessed = true
  ctx.session.summary = stdout.slice(0, 500)  // 或 JSON.parse(stdout) 取字段
})
```

这样任何外部工具(exe / bat / ps1 / 系统命令如 `unzip`/`grep`/`7z`)都能接入,只是不走 `scriptFileStep` 的统一协议,而是 step 内自定义。**`scriptFileStep` 是协议化快路径,`scriptStep`+`spawn` 是万能兜底。**

---

## 7. 端到端示例:接 Python 预处理脚本

> **默认 pipeline 已内置通用预处理**(零配置即支持,任意带扩展名文件路径触发,见 `src/pipelines/default.ts` + `src/pipelines/preprocess.ts`)。下面用 Python 脚本替换默认的 Node.js 脚本。

### 7.1 脚本

把第 4.2 的 `scripts/parse-log.py` 放到项目根 `scripts/` 下,加 `scripts/requirements.txt`(本例只用标准库,可空)。

### 7.2 启动(env 配脚本+解释器,最简)

```bash
# Windows CMD
set BOT_PREPROCESS_SCRIPT=scripts/parse-log.py
set BOT_PREPROCESS_INTERPRETER=python
npm run dev        # 或 sim:bot

# Linux / macOS
BOT_PREPROCESS_SCRIPT=scripts/parse-log.py BOT_PREPROCESS_INTERPRETER=python npm run dev
```

默认 pipeline 读这两个 env:`BOT_PREPROCESS_SCRIPT` 指定脚本(.js/.py/.exe 都行),`BOT_PREPROCESS_INTERPRETER` 决定怎么跑(省略=node、`python`、`null`=直接跑 exe)。详见 `doc/getting-started.md`。

### 7.3 何时用 `BOT_PIPELINE=log-qa`(可选)

仅当要**日志特化(限定 zip/gz/tar/log/txt 触发)+ 无 vision 识图**的精简 pipeline 时:
```bash
BOT_PIPELINE=log-qa npm run dev
```
日常零配置默认 pipeline 已含通用预处理(任意扩展名 + vision),不需要设这个。

### 7.4 验证

1. `@bot 开启` → 收 ack;`workspace/<日期时间>/` 已建。
2. 发 `D:/logs/xxx.zip`(正文贴绝对路径)→ `workspace/<日期时间>/extracted/` 出现产物 + Claude 回预处理 summary。
3. 后续提问(不带路径)→ Claude 基于 `extracted/` 产物 `grep`/`read` 回答;`session.preprocessed` 守卫,不重跑。
4. 发不带路径的普通提问 → **不 spawn 预处理脚本**(条件跑),直接 `text` 回答。
5. `exit` → 会话结束;空 workspace 回收,非空(有产物)保留。

---

## 8. 检查清单

- **路径**:Windows 反斜杠转义或用正斜杠;含空格/中文的路径用 `execFile` 数组参数(不要拼进 command 字符串)。
- **超时**:`scriptFileStep` 默认 5min;大日志调大 `timeoutMs`。超时 SIGTERM(Windows TerminateProcess),错误被降级。
- **失败重试**:预处理失败不标 `preprocessed`,下次发日志可重试;但**同一会话**用户得重新发触发消息(水位已推进,旧消息不重处理)。
- **workspace 回收**:会话 `exit` 后空目录自动回收;**有产物的目录保留**(用户可查)。Claude 驱动变体产物也在同目录,同样保留。
- **安全**:`bypassPermissions` 给了 Claude 完整工具权;workspace 是隔离的安全边界,**勿放敏感文件**。外部脚本也跑在主进程,注意权限。预处理脚本读用户给的日志路径——**校验路径**防越权(如限定在某个日志根目录下,拒绝 `..`)。
- **Python 可执行名**:部署环境确认 `python`/`py`/`python3` 在 PATH,或传绝对路径;CI/生产与开发机可能不同。
- **依赖**:Python 第三方库写 `requirements.txt`;exe 确保目标机有对应运行时(VC++ redistributable 等)。
- **协议一致性**:用 `scriptFileStep` 必须守 stdin JSON / stdout JSON 协议;不符合走 `scriptStep`+`spawn`。
- **并发**:同用户消息在 route 内串行(tick for-await),无并发;不同用户独立 workspace + sessionCtx,互不影响。
