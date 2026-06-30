# 小白配置指南(从零跑起来)

> 面向新手。跟着做,就能把客服助手 bot 跑起来,并学会用各类脚本(Node.js / Python / exe)做"会话预处理"。
> 深入原理见 `doc/session-preprocessing.md`;架构见 `CLAUDE.md`。

---

## 0. 它是什么

一个跑在内部通讯软件(welink-cli im 群)上的客服助手 bot:群里 `@bot 开启` 会话 → 提问 → Claude 回答(文本或截图)→ `exit` 结束。

**会话预处理**:开启会话后,你在消息里贴一个**文件路径**(比如产品日志 `D:/logs/xxx.zip`),bot 会自动跑一个脚本把它解压/解析、产物存到工作目录,然后你提问时 Claude 能直接 `grep`/读那些产物来回答。**默认就支持,不用额外开关**;预处理脚本可以是 Node.js、Python、exe 等各类。

---

## 1. 前提(先装好这些)

| 依赖 | 怎么确认 | 没有怎么办 |
|---|---|---|
| Node.js ≥ 20 | `node -v` 显示 v20+ | 去 nodejs.org 装 LTS |
| 项目依赖 | `npm install` | 在项目根目录跑一次 |
| Claude CLI | 命令行 `claude -h` 或 `openclaude -h` 有输出 | `npm install -g @anthropic-ai/claude-code@latest` |
| Chrome 或 Edge | 本机有浏览器即可(截图用) | 设 `CHROMIUM_PATH` 指向 chrome.exe(见第 5 节) |
| 群 ID | `WELINK_GROUP_ID`(接真群时必填) | 用模拟器调试可省(见第 6 节) |

---

## 2. 最简跑起来(用模拟器,不接真群)

模拟器 = 一个本地网页,假装是 welink 群,你在网页发消息,bot 回复。**最适合新手第一步**。

**两个终端:**

终端 1(开模拟器网页服务):
```bash
npm run sim:gui
# 看到 [sim gui] http://localhost:3000  就成了
```

终端 2(跑 bot,连模拟器):
```bash
npm run sim:bot
# 看到 [bot] 启动客服助手...  就成了
```

浏览器打开 http://localhost:3000 → 在网页输入框发消息:

1. 发 `@bot 开启`(或点界面的 @ 按钮)→ bot 回 "已开启会话..."。
2. 发任意问题,比如 `你好` → bot 回答(可能是截图)。
3. 发 `exit` → 会话结束。

> 模拟器默认有个 "echo" 自动回复,接 bot 时**记得在网页关掉 echo**(否则它也回消息,跟 bot 抢)。网页上有开关,或 `POST http://localhost:3000/api/config` body `{"echo":false}`。

接真 welink 群:设 `WELINK_GROUP_ID` 后用 `npm run dev`(代替 `sim:bot`)。

---

## 3. 各类脚本预处理(默认就支持,不用切 pipeline)

**默认行为**:开启会话后,你发一条**带文件绝对路径**的消息,bot 自动用 `scripts/preprocess-log.js`(Node.js)预处理,产物存工作目录,**先把摘要发到群**,然后你提问 Claude 基于产物回答。

> **要换脚本 / 用 Python / exe / 多种预处理?** 写一个 `.mjs` 配置文件指向它,见 `doc/pre-hook-handbook.md`(配方集 + 协议 + 完整 spec 字段)。

试一下(模拟器或真群,开启会话后):
```
@bot 开启
D:/logs/2024-01-01.zip 有什么错误       ← 贴日志绝对路径触发预处理;bot 先发"✅ 预处理完成"摘要
这个日志里有哪些 ERROR?                   ← 后续提问,Claude grep 产物回答
exit
```

### 换脚本 / 用 Python / exe(写 `.mjs` 配置)

在项目根建 `preprocess.config.mjs`,声明一个 spec(触发正则 + 脚本 + 解释器):

```js
// Python 脚本(模板见第 4 节)
export default [
  {
    name: 'log',
    trigger: /([A-Za-z]:[\\/][^\s,，]+\.(?:zip|gz|tar|log|txt)|\/[^\s,，]+\.(?:zip|gz|tar|log|txt))/i,
    inputFrom: 1,
    script: 'scripts/parse-log.py',
    interpreter: 'python',     // Windows 也可 'py';Linux/mac 'python3';省略=node 跑 .js;null=直跑 exe
    timeoutMs: 600_000,
  },
]
```

启动时指向它:

```bash
# Windows PowerShell
$env:BOT_PREPROCESS_CONFIG='preprocess.config.mjs'
npm run sim:bot

# Linux / macOS
BOT_PREPROCESS_CONFIG=preprocess.config.mjs npm run sim:bot
```

### `interpreter` 取值

| 值 | 含义 |
|---|---|
| **省略** | 用 Node.js 跑 `.js`(默认) |
| `'python'` / `'py'` / `'python3'` | 用对应 Python 跑 `.py` |
| `null` | 直接跑可执行(`.exe` 或带 shebang 的脚本) |
| 其它(如 `'ruby'`) | 当作解释器名:`ruby scripts/x.rb` |

> `script` 是脚本路径,相对项目根(如 `scripts/parse-log.py`)或绝对路径都行。Windows 路径用反斜杠(`D:\logs\x.zip`)在命令行里 OK;在消息正文里贴路径,反斜杠正斜杠都行(`D:/logs/x.zip` 最稳)。完整 spec 字段(触发器、`notify`、`qaTemplate`…)见 `doc/pre-hook-handbook.md`。

---

## 4. 写你自己的预处理脚本

### 协议(必须守)

你的脚本被 bot 调用时:
- **stdin** 收到一段 JSON:`{ "content": ..., "workspacePath": "...", "trigger": { "name": ..., "match": ..., "groups": [...], "input": "..." } }`
  - `trigger.input`:从你消息里抽到的待处理对象(如文件路径)——你要处理的就是它。
  - `workspacePath`:本次会话的工作目录(产物存这里,Claude 问答时能直接读)。
- **stdout** 输出 JSON:`{ "summary": "...", "artifacts": { "dir": "extracted", "files": [...] } }`
  - `summary`:给 Claude 的产物摘要(必填)。
  - `artifacts.dir`:产物目录(相对 `workspacePath`,如 `extracted`);`files`:产物清单。
  - **stdout 为空** = no-op(没 `trigger.input` 时就这么做,直接退出)。
- **非零退出** = 失败,bot 会发致歉,且不标完成(下次发同一路径可重试)。

### Node.js 模板(`scripts/preprocess-log.js` 已是,可改)

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
// ... 这里写你的解压/解析逻辑,产物落 outDir ...
const files = await readdir(outDir)
process.stdout.write(JSON.stringify({
  summary: `已处理 ${basename(input)}`,
  artifacts: { dir: 'extracted', files },
}))
```

### Python 模板(`scripts/parse-log.py`)

```python
import sys, json, os, zipfile

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
    import shutil
    shutil.copy(inp, out_dir)
    files = [os.path.basename(inp)]

sys.stdout.write(json.dumps({
    'summary': f'已处理 {os.path.basename(inp)}',
    'artifacts': {'dir': 'extracted', 'files': files},
}))
```

放好后按第 3 节写 `.mjs` 配置(`BOT_PREPROCESS_CONFIG`)启动。

> Python 第三方库(如 pandas)写 `scripts/requirements.txt`,部署时 `pip install -r scripts/requirements.txt`。`zipfile`/`json`/`os` 是标准库,零依赖。

---

## 5. 环境变量速查表

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `WELINK_GROUP_ID` | 接真群时必填 | — | 要监控的群 ID(`sim:bot` 默认 100001) |
| `WELINK_ACCOUNT` | 否 | `bot01` | bot 自己的账号(过滤自身消息,避免回环) |
| `BOT_PREPROCESS_CONFIG` | 否 | 不设=内置默认 | 指向 `.mjs` 配置文件,声明预处理 spec(触发正则+脚本+解释器);见 `doc/pre-hook-handbook.md` |
| `BOT_PICTURE_OUTPUT` | 否 | `image` | `image`=发截图;`html`=发 HTML 文件 |
| `BOT_INCLUDE_THINKING` | 否 | 不设=关 | `1`/`true`/`yes`/`on`=把 Claude 思考过程(thinking 块)流式发出:每完成一块先发一条 `💭 ` 纯文本消息,再发最终回复(先 think 后结果) |
| `BOT_STATE_DIR` | 否 | `~/.claude-bot` | 水位/会话 ID 持久化目录 |
| `CHROMIUM_PATH` | 否 | 自动探测 | Chrome/Edge 可执行路径(截图失败时设) |
| `BOT_PIPELINE` | 否 | 默认 pipeline | `log-qa`=用日志特化无识图 pipeline(日常不用设,默认已含预处理) |

---

## 6. 用模拟器调试(不接真群)

- `npm run sim:gui`:开本地网页 http://localhost:3000,可发文本/图片/文件、看消息列表。
- `npm run sim:bot`:带 sim 配置跑真实 bot(连模拟器),`WELINK_GROUP_ID` 默认 100001。
- 模拟器状态文件 `sim/state.json`(消息都存这),可手改重置。
- 接 bot 时**关 echo**(见第 2 节)。

调试预处理:在 `sim/state.json` 同目录看 bot 的 `workspace/<日期时间>/` 子目录,预处理产物在里面的 `extracted/`。

---

## 7. 常见问题

**bot 没反应?**
- 确认消息是 `@bot 开启`(必须 @ 到 bot,且正文以"开启"结尾)。
- 确认 `WELINK_GROUP_ID` / 群 ID 对(`sim:bot` 默认 100001,跟模拟器一致)。
- 重启 bot 不会重处理历史消息(水位机制):要让 bot 处理某条,在它运行时发新消息。

**截图失败 / 报 chromium 错?**
- 设 `CHROMIUM_PATH` 指向本机 Chrome 或 Edge,如 `set CHROMIUM_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`。
- 或设 `BOT_PICTURE_OUTPUT=html`(发 HTML 文件,不开浏览器)。

**预处理没触发?**
- 消息正文必须含**文件绝对路径 + 扩展名**,如 `D:/logs/xxx.zip`(不能只写 `xxx.zip`)。
- 必须先 `@bot 开启` 再发路径;发路径后 bot 会先发"✅ 预处理完成"摘要。
- 换了脚本/配置但没生效?配置仅启动时载入,**重启 bot**;确认 `BOT_PREPROCESS_CONFIG` 指对的 `.mjs`、spec 里 `script`/`interpreter` 路径对。
- 没发"✅ 预处理完成"通知?默认开;确认 spec 没设 `notify: false`、`noticeTemplate` 没返回空串。

**Python 脚本报 "python not found"?**
- Windows 在 spec 里用 `'py'` 作 `interpreter`(官方 launcher);或用绝对路径 `'C:\\Python311\\python.exe'`。
- Linux/mac 用 `python3`。

**内存爆 / OOM?**
- 接 bot 时关掉模拟器 echo(减少并发)。
- 清理临时目录(`%TEMP%\ai-response-*`、`%TEMP%\bot-img-*`)。
- 大日志预处理给足超时(脚本里别一次性读超大文件到内存,分块或用流)。

**想看 bot 在干嘛?**
- bot 的日志打在终端(stdout/stderr)。预处理 spawn 脚本、Claude 回复、发送都有日志。
- `workspace/<日期时间>/` 是本次会话的工作目录,Claude 在这跑、产物在这。
