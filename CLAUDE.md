# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概要

客服助手 bot:在内部通讯软件(welink-cli im 群,收 text/picture/file/card、**不支持 Markdown、不支持流式**)上,轮询群消息 → 水位去重(只触发一次)→ 喂给 Claude → 把回复按规则发回群。TypeScript + Node.js(ESM,Node ≥ 20)。

## 常用命令

```bash
npm install                 # 装依赖
npm run dev                 # 跑 bot(tsx 直跑 src/index.ts,需 welink-cli/claude/chromium 在环境可用)
npm run build               # tsc -p tsconfig.build.json → 编译到 dist/(扁平)
npm start                   # 跑编译产物 node dist/index.js
npm run typecheck           # tsc --noEmit(检查 src)
npm run sim:gui             # 本地模拟器网页(http://localhost:3000,可发文本/图片/文件)
npm run sim:bot             # 带 sim 配置跑真实 bot(连模拟器,WELINK_GROUP_ID 默认 100001)
./start.ps1                 # 一键启动(PowerShell,真实 welink):编辑顶部 CONFIG(群/think/轮询间隔/拉取数/add-dir/白名单)后跑
```

验证范式:vitest/测试已移除(太慢);验证靠 `npm run typecheck` + `npm run dev`/`./start.ps1` 手动集成(设 `WELINK_GROUP_IDS` → 群里 `@bot` → 提问 → `exit`;重启 bot 应不重处理历史/已处理消息)。多群/单活跃验证:`npm run sim:gui` + `npm run sim:bot` → A `@bot` 开启、B `@bot` 应被拒、B 普通消息不回复、`exit` 后 B 可开、两群互不影响。核心逻辑仍按"可注入假"设计(`startLoop:false` + 注入 channel/llm/renderer/水位/sessionLlm),需测试时可按下面接缝表在 `test/fakes.ts` 重建三假。

## 关键约定

- **ESM + NodeNext**:所有相对导入必须带 `.js` 后缀(如 `import './llm.js'`),即便源文件是 `.ts`。新增文件务必遵守,否则运行时解析失败。
- **两份 tsconfig**:`tsconfig.json`(noEmit,类型检查 src,供 IDE/typecheck);`tsconfig.build.json`(只 emit `src/` 到扁平 `dist/`)。`npm run build` 用后者。
- **类型先行**:端口接口(`Channel`/`Llm`/`Renderer`)与其具体适配器分文件放,接口用 `import type` 引用,避免测试拉起重的运行时依赖。
- **Windows spawn 一律走 `src/win-spawn.ts`**:`execFileCmd`/`spawnCmd` 基于 cross-spawn,自动解析 `.cmd/.bat` 底层 exe、**无 shell** → `--text`/system-prompt/JSON input 里的空格/换行/`"`/`%` 全安全(旧 `cmd /c` 方案下 `"` 断引号、`%` 展开环境变量)。welink-channel / claude-client / pipeline 三处复用。

## 架构(深模块 + 3 接缝 + 配置驱动)

核心是**一个深模块 `Assistant`**(`src/assistant.ts`):纯编排、无 I/O。三个真接缝(各为端口 + 生产适配器;测试假实现已随 vitest 移除,需时可重建):

| 接缝 | 端口 | 生产适配器 | 端口方法 |
|---|---|---|---|
| 通讯渠道 | `src/channels/channel.ts` (`Channel`) | `welink-channel.ts`(welink-cli im 群) | `getNewMessages`/`sendText`/`sendPicture`/`sendFile` |
| 大模型 | `src/llm.ts` (`Llm`/`SessionLlm`) | `claude-client.ts`(Claude CLI 子进程) | `Llm.ask`;`SessionLlm` 增 `startSession`/`endSession`/`setModel`/`interrupt`/`getWorkspacePath` |
| 截图渲染 | `src/renderers/renderer.ts` (`Renderer`) | `puppeteer-renderer.ts`(Puppeteer) | `markdownToImage`/`markdownToHtml` |

> 群模型:`Channel` 构造时绑定 groupId,所有 send 固定发到该群;`sendXxx(userId,…)` 的 userId 形参仅为兼容端口签名(群模型下被适配器忽略,核心仍传 sender 以备日志/回调)。去重(只处理新消息)由核心 Assistant 持久化水位负责。**其余依赖(state/image/workspace/html-template/win-spawn)各只一个适配器、不开端口,勿投机性加 port。**

> **Mermaid 渲染**:`html-template.ts` 的 `buildHtml` 把 ```` ```mermaid ```` 块(marked-highlight 输出为 `<pre><code class="hljs language-mermaid">`)换成 `<div class="mermaid">`,并在**有 mermaid 块时**才内联 `node_modules/mermaid/dist/mermaid.min.js`(3.5MB 自包含 IIFE,末行挂 `globalThis.mermaid`;**不能用 `.esm.min.mjs`——它仅 29KB 懒加载器,运行时 `import("./chunks/…")` 在内联/blob 下解析不了,diagram 全失败**)+ 经典 `<script>` init(`startOnLoad:false`+逐图 `mermaid.run({nodes:[n]})` try/catch + 失败兜底,设 `window.mermaidReady`)。脚本放 body 末(bundle 先同步挂全局、init 后查 `.mermaid` div)。`puppeteer-renderer` 截图前 `waitForFunction(mermaidReady)` 再 await,确保 SVG 落定再量高。全本地、不联网(公司代理拦 CDN/TLS);`securityLevel:'strict'` 防 html 文件模式标签里塞 `<script>`。无 mermaid 块则 HTML 不增重。

**多模型接力 pipeline**(`src/pipeline.ts` + `src/pipelines/*.ts` + `src/models.ts` + `src/output-policy.ts`):
- `Step = (ctx: StepCtx, models: Models) => Promise<void>`,**线性 steps、每步 mutate `StepCtx`**;分支写在 script 内(如"若是图片才调 vision"),不引入 DAG。`runPipeline` 顺序跑完返回 `ctx.reply`。
- `StepCtx { userId, content, scratch(消息级,每条新建), session(会话级,跨消息保留——同一引用,step mutate 直接生效到 Assistant 持有的 map), workspacePath?(会话 workspace 子目录,供脚本写产物 / Claude 读), reply?(上一模型输出), aborted?, onPartial? }`。
- 两类 step 工厂:`modelStep(name)` 调命名模型写 `ctx.reply`(不改 content);`scriptStep(fn)` 纯变换(可重组 content 喂下一步,读 reply/scratch/session)。外部脚本经 `runScriptFile(ctx, path, opts)`(stdin 传 `{content, workspacePath, ...extraInput}` → stdout 回 `{summary?, artifacts?}`,透传给调用方;preprocess 用它跑脚本)。
- `Models = Record<string, Llm>` 命名注册表,`buildModels(specs)` 从 `ModelSpec` 构建;`output-policy.ts` 的 `isMarkdown` 决定 picture(渲染)还是 text(直发)。
- 零配置 `runAssistant({groupId})` 即默认 vision+text 模型 + 接力 pipeline + markdownOutputPolicy + welink 群通道 + state.ts 水位 + 生命周期。**多群 = 入口 `index.ts` 循环起多个 `runAssistant({groupId})`**(每群独立 Assistant/pool/active/channel,隔离结构性,不需复合键;单进程多 loop 并发,I/O 交错)。默认适配器在 `runAssistant` 内**懒加载**(动态 import),注入假时绝不加载 puppeteer/child_process/welink-cli——核心可零外部依赖驱动。

**按用户隔离会话**(`src/session-pool.ts`):`Map<userId, Session>` + LRU + `--resume` 续接;每用户 claudeSessionId 持久化于 `src/state.ts`(**每群独立文件 `~/.claude-bot/state-<groupId>.json`** = `{watermark, sessionIds}`,可用 `BOT_STATE_DIR` 覆盖;groupId 经 `createClaudeCliLlm` 闭包绑进 load/save,SessionPool 本身仍 userId 键——因每群一个 pool 实例,无跨群串号)。`SessionPool` 通过注入 `spawn` 工厂 + load/save 回调可脱离真子进程驱动。**每 pooled 会话开独立子目录** `workspace/<groupId>/<日期时间>`(`@开启` 各不同;claudeSessionId 在 spawn 后首轮 send 才到、且 Windows 不能移动运行中进程 cwd,故用日期时间名),退出后若子目录为空则自动回收(非空保留);无状态识图仍用 base cwd。见 `src/workspace.ts`。

**Claude 子进程管理**(`src/claude-client.ts`):精简自兄弟项目 `D:\test\vibe-ide\src\main\ai.ts`(去掉 Electron IPC / 权限交互 / 流式 token / partial-messages),只收集最终 assistant 文本、遇 `result` 即 resolve。复用其 `findBinary`/`sanitizeEnvForCli`/`buildClaudeArgs`/`spawnClaude`/NDJSON 行缓冲解析/`killAiProcess`(Windows `taskkill /f /t` 杀进程树)。`ClaudeSession` 公开面 `spawn/send/kill/setModel/interrupt`。**不用 `--add-dir`**:`BOT_ADD_DIR` 直接作 cwd(vibe-ide 风格——GLM 后端 `--add-dir` 不并入默认 `**` 范围,改 cwd 根除搜索 bug;`buildClaudeArgs` 仅把 cwd 写进 system-prompt 提示)。**模型切换经 env `ANTHROPIC_MODEL`**(不用 `--model` flag,跨 claude/opencc/openclaude/GLM 变体最稳)。`Llm` 接口可选 `stop?()`(pooled = `SessionPool.stopAll()`);`Assistant.stop()` 遍历 models 调 `m.stop?.()`,多群 shutdown 时由 `index.ts` 逐 handle 调用,防漏杀 Claude 子进程。

## 处理流程(端到端)★重点

> 单条消息从入群到回复的完整路径,以及默认 pipeline 的逐步语义。**改流程主要动这里;核心循环(route/tick/handle)几乎不动。**

### 1. 主循环 `tick()`(src/assistant.ts:307)

1. **懒载水位**:首次 `loadWatermark()`(生产接 `state.ts`),失败 fail-safe 到 `'0'`(全处理)。
2. `channel.getNewMessages()` → 批次(welink-channel 已反转成 old→new、并过滤回环:sender=bot 账号 + 本通道 CLI 发出的 msgId `sentIds`)。
3. **首次运行(水位 undefined)**:落种到本批最新 msgId 并持久化、**不处理任何消息** → 排除历史。
4. 过滤 `id > 水位`、按 id 升序。逐条:
   - **★at-most-once**:先把水位推进到本条 msgId 并**落盘**,再处理 → 崩溃至多重丢"正在处理的那一条",绝不重复处理(用户取舍:宁可丢也不重发)。msgId 是 >2^53 的大整数,`welink-channel.ts` parse 前正则引号化成 string,核心用 `BigInt` 比较(非数值 id 回退字符串比较)。
   - **发送者白名单**(`BOT_ALLOWED_USERS`):非空且 sender 不在列表 → 跳过(不处理/不回复;水位已推进故不重复拉取)。
   - **consumedEsc**:被在途 esc-watcher 消化掉的 esc msgId → 跳过(中断已完成,不再当 exit)。
   - `onReceive` 回调 → `try route(msg) catch → onError`(每条 try/catch,循环不死)。

### 2. 生命周期路由 `route()`(src/assistant.ts:381,每群单活跃)

未注入 `sessionLlm` → 每条直接 `handle`(旧行为)。注入后按发送者分流:

- **本人活跃**(`activeUserId === sender`):`exit` 关键词(正文 trim+lowercase 精确等于 esc/quit/exit)→ `endSession`(kill、取 claudeSessionId 发到群里作 resume 句柄)、`activeUserId=null`、`sessionCtx.delete`、回"会话已结束,会话 ID: X。";否则 `handle(msg)`(含继续 @bot 的消息)。
- **他人 @**(`msg.at===true`,**任意 @ 即开、不要求"开启"二字**):
  - 已有他人活跃 → **拒绝**:回"`<活跃者>` 正在会话中,请待其发送 exit 后再@我。"(**仅对 @ 触发**;他人普通消息不回复,避免群发垃圾)。
  - 无人活跃 → `startSession`(**不续接**,全新会话)+ `activeUserId=sender` + 解析模型别名 + ack + 初始化 `sessionCtx` + `handle(msg)`。
- **他人普通消息(非 @)**:忽略(不处理、不回复,不污染现有会话)。

**模型别名**:`@bot <alias>`(`haiku`/`sonnet`/`opus`/`fable`,首个匹配的空白分隔 token、大小写不敏感)在开启时经 `setModel` → `set_model` control_request 切该会话模型;别名从正文剥离后,剩余为空或仅剩 @提及 → 文本消息只 ack 不送 Claude(图片仍处理,图像本身即载荷);输错走默认,不影响开启。

**esc 语义(一次 esc 中断、二次 esc 退出)**:命令在途时收 esc → **中断**(并发 watcher 在 `handle()` 在途期间轮询——主循环串行阻塞在在途 route 看不到 esc,故需 watcher);见活跃用户 esc 即向 CLI stdin 发 `interrupt` control_request(参考 vibe-ide `ai.ts:885-896`),CLI 回 `result(is_aborted)` → `Reply.aborted` → `modelStep` 写 `ctx.aborted` → `handle` 发"🛑已中断,再次发送 esc 可退出会话。"纯文本、**不退出会话**,被消化的 esc 记入 `consumedEsc` 由主循环跳过。命令空闲时(handle 已返回、watcher 已停)收 esc → `endSession` 退出。退出后才可开新一轮(防"串")。watcher 仅当 `interrupt` 真正命中活跃会话(返 true)才消费 esc;返 false(在途步骤尚是无状态 vision、pooled 会话未建)不消费、续轮询。

### 3. 单条处理 `handle()`(src/assistant.ts:499)

1. **流式 thinking**(env `BOT_INCLUDE_THINKING`):`onPartial` 收到已完成 thinking 块 → 切段(`chunkThinking`,≤4000)→ 串行 chain 发 `💭 ` 纯文本(**绕过 outputPolicy,永不触发 picture/html**)、单条超时 30s 容错;`partialChain` 在最终回复前 drain → 保证"先 think 后结果"。仅最终回复模型流式(vision/preprocess 等中间步骤不流式)。
2. `startInterruptWatcher(userId)` 在途并发轮询(见上 esc),`finally` 停。
3. `toUserContent(msg)`:text → `{kind:'text',text}`;picture → `downloadImage` 落本地 → `{kind:'image',imagePath,caption}`。
4. 建 `StepCtx { userId, content, scratch:{}, session: sessionCtx[sender].scratch(引用,跨消息保留), workspacePath, onPartial }`。
5. `reply = runPipeline(pipeline, models, ctx)`(线性跑完返回 `ctx.reply`)。
6. `await partialChain`(drain thinking)。
7. `ctx.aborted` → 发"🛑已中断…"纯文本、**不渲染回复、不退出会话**。
8. `mode = outputPolicy(reply)`:
   - `picture` → `renderer.markdownToImage` + `sendText(summarize(reply,'图片'))` + `sendPicture`
   - `html` → `renderer.markdownToHtml` + `sendText(summarize(reply,'文件'))` + `sendFile`(`BOT_PICTURE_OUTPUT=html` 时把 picture 重映射成 html)
   - `text` → `sendText(reply)`
9. `catch` → 先 drain 在途 thinking(防与致歉乱序)→ `sendText("抱歉,处理该消息时出错:…")` → `throw`(交 route 的 catch → onError,循环不死)。

### 4. 默认 pipeline 的 6 步(`src/pipelines/default.ts`)

| step | 实现 | 语义 |
|---|---|---|
| 1 | inline `modelStep`-ish | 图片 → `models.vision.ask` 识图,描述存 `ctx.scratch.imageDesc`;文本跳过 |
| 2 | `scriptStep` | 图片 → 把 `描述 + 用户附言` 组装成文本 content 喂后续(`图片内容:\n{desc}\n\n{caption}`);文本跳过 |
| 3 | `preprocessSteps[0]` 守卫+触发 | `!workspacePath` 跳过;遍历 specs,eval `trigger`(正则对 text / 函数),命中且 input 未在 `session.__preprocess[name].inputs` → 收集到 `scratch.fired` |
| 4 | `preprocessSteps[1]` 条件预处理 | **仅 `scratch.fired` 非空才跑**(避免每条消息 spawn);每 spec 顺序跑、per-spec try/catch:`driver:'script'`(默认)= `runScriptFile`(传 `trigger` 信息);`driver:'claude'` = 同会话 `models.text.ask`。成功 → 累计 `session.__preprocess[name].results` + 记 input(按输入去重)+ 经 `ctx.notify` 把摘要发群(默认 on,`spec.notify` 可关) |
| 5 | `preprocessSteps[2]` 问答组装 | gather 全部累计 results → content 注入各产物目录+摘要(让 Claude grep/read);无则原样(正常问答) |
| 6 | `modelStep('text')` | text 模型分析 → `ctx.reply`(最终回复 markdown) |

> 文本消息:step1/2 跳过;带文件路径 → step3-5 预处理;step6 回答。图片:vision→组装→(预处理)→text。`log-qa` pipeline(`BOT_PIPELINE=log-qa`)复用 step3-5 但**限定日志扩展名**(zip/gz/tgz/tar/log/txt)+ 无 vision,仅当要"日志特化 + 无识图"时用。

### 5. 会话预处理详解(`src/pipelines/preprocess.ts` + `src/pipeline.ts:runScriptFile`)

**多 spec**:每个 `PreprocessSpec` = `{ name, trigger, inputFrom, script, interpreter, timeoutMs, appliesTo, driver, claudePrompt?, qaTemplate?, notify?, noticeTemplate? }`。specs 由 `loadPreprocessSpecs()` 载入(env `BOT_PREPROCESS_CONFIG` 指向 `.mjs` 导出 `PreprocessSpec[]`,经 `file://` URL 动态 import + 校验;未设 → `buildBuiltinSpecs()` 固定 file spec)。

**触发**:`trigger` 正则(对 `content.text` 匹配)或函数(`(content) => {match,groups,input}|null`,可处理图片);`inputFrom`(默认捕获组 1,无捕获组回退 full)解析"待处理输入"——**仅对正则触发器生效**,函数触发器自负责 input。`filePathRegex(exts?)` 工具匹配文件绝对路径+扩展名。

**按输入去重**:`session.__preprocess[name] = { inputs: string[], results: PreprocessResult[] }`(`__` 前缀保留;数组非 Set)。同 spec+同 input 跳过(幂等),不同 input 各跑一次、results 累加;失败不记 input → 可重试;exit 清空。多 spec 同消息命中:全收集、顺序跑、per-spec try/catch(失败不阻断其他)。

**workspacePath 天然一致**:text 会话(pooled)的 Claude 子进程 `cwd` 就是它的 `workspace/<groupId>/<datetime>` 子目录(或 `BOT_ADD_DIR`);`runScriptFile` 在 Node 主进程跑、把产物写进 `ctx.workspacePath`(同一路径);text 会话 Claude 问答时 `cwd` 正是该目录,能直接 `grep`/`read` 产物 —— **主进程脚本与 Claude 子进程共享同一物理目录,无需任何同步**。Claude 驱动变体同理(同会话两轮:预处理轮在自己 cwd 落文件,问答轮同 cwd 读)。

**script 协议**(`runScriptFile`,语言无关;python/js/exe/Windows):
```
stdin  ← JSON { content, workspacePath, trigger: { name, match, groups, input } }   (写入后 EOF)
stdout → JSON { "summary": "...", "artifacts"?: { "dir": "...", "files": [...] } }
        | 空 stdout = no-op(本类型跳过,不标 done)
        | 非 JSON / 非零退出 → 抛错(handle 降级致歉,不标 done,下次同输入可重试)
```
- `runScriptFile` 返回 parsed stdout(`ScriptFileResult`:`summary`/`artifacts` 透传给 preprocess step);`extraInput` 并入 stdin(传 `trigger`);stdin 不含 `session`(框架内部状态不外泄)。
- **发群通知**:preprocess 成功后经 `ctx.notify` 把摘要发群(默认 on;`spec.notify:false` 关、`noticeTemplate` 自定义文本);`handle` 在最终回复前 drain `notifyChain`(先发结果再发回复,失败/超时不阻断)。
- `interpreter`:省略 = node 跑 `.js`(默认);`'python'`/`'py'`/`'python3'` = 跑 `.py`;`null`/`'none'`/`'direct'` = 直接跑 `.exe`/带 shebang 脚本;其它字符串当解释器名。超时默认 5min。经 `execFileCmd`(cross-spawn),路径与 JSON input 的空格/换行/`"`/`%` 全安全。
- `artifacts.dir` 相对 workspacePath 或绝对(QA 模板解析成绝对);`summary` 必填(空=未产出,抛错不标 done)。

### 6. 扩展点(后续要拓展,都不碰核心)

1. **加新 spec**(零代码):写 `.mjs` 配置(`BOT_PREPROCESS_CONFIG`),声明 `{name, trigger, script, interpreter, …}`;可 `import { buildBuiltinSpecs }` 追加内置默认。校验见 `loadPreprocessSpecs`。
2. **换 spec 脚本**:spec 的 `script`/`interpreter` 指向你的脚本(.js/.py/.exe,守新协议);或 `driver:'claude'` 让同会话 Claude 用 bash 预处理(`claudePrompt` 自定义)。
3. **换触发条件**:spec 的 `trigger`(正则或函数)+ `inputFrom`。函数触发器可处理图片/关键词/跨字段;`filePathRegex(exts?)` 工具匹配文件路径。
4. **换 QA 注入**:spec 的 `qaTemplate(result, workspacePath)` 自定义注入文本。
5. **加新 pipeline 工厂**(新场景,如"代码库问答"):`src/pipelines/` 加工厂,复用 `preprocessSteps(specs)` 组装,经 `options.pipeline` 注入或加 `BOT_PIPELINE` 分支(`pickDefaultPipeline`)。
6. **不符协议的工具**(`scriptStep`+`spawn` 包装):外部工具接收命令行参数/输出自由文本/需复杂参数 → 用 `scriptStep(fn)` 内联 `child_process.spawn`,自己 parse 输出、写 `session.__preprocess`。spec+`script`+协议是快路径,`scriptStep`+`spawn` 是万能兜底。
7. **加/换模型** → `src/models.ts` 加 `ModelSpec`;**改接力顺序** → 换 `src/pipelines/default.ts` 的 steps 或传自定义 `pipeline`;**改输出规则** → 换 `outputPolicy` 函数或设 `BOT_PICTURE_OUTPUT=html`(`OutputMode` ∈ text/picture/html)。

> 深入:用户配置手册见 `doc/pre-hook-handbook.md`、协议示例见 `scripts/preprocess-log.js`、扩展全指南见 `doc/session-preprocessing.md`、新手配置见 `doc/getting-started.md`。文件下载适配器(生产下载 TODO:提取码/验证码)接口契约见 `doc/file-download-api.md`。

## 环境与约束

- 通讯软件**只收 text/picture、不支持流式** → 必须"请求 → 等 Claude 整轮完整回复"再处理。
- `welink-cli im` 群:`query-history-message --group-id G --query-count N` / `send-to-group --group-id G --text|--image|--file <...>`。stdout 信封 `{resultCode,resultContext,respData,sno}`(`resultCode "0"`=成功);`respData.chatInfo[]` 新→旧,`contentType` ∈ `TEXT_MSG`/`IMAGESPAN_MSG`/`FILE_MSG`/`CARD_MSG`(详见 `doc/trueapi.md`)。真实 welink send-to-group(--image/--file)在 JSON 前打进度行 → `parseEnvelope` 先 `extractJsonObject` 截取首个完整对象;msgId/maxMsgId/minMsgId/msgIds[] 是 >2^53 大整数,parse 前正则引号化成 string。**若 welink 输出格式有变,只改 `src/channels/welink-channel.ts` 一个适配器**(接缝回报,不动架构)。
- 环境变量:
  - `WELINK_GROUP_IDS`(必填,逗号分隔的监控群 ID;回退兼容旧 `WELINK_GROUP_ID` 单群)、`WELINK_BIN`(默认 `welink-cli`)、`WELINK_QUERY_COUNT`(默认 20)、`BOT_POLL_INTERVAL_MS`(轮询间隔 ms,默认 1000)。
  - `BOT_STATE_DIR`(水位+会话 id 持久化目录,默认 `~/.claude-bot`;每群独立 `state-<groupId>.json`)。
  - `BOT_ADD_DIR`(单个额外目录,默认空=不加;设则**直接作 Claude 的 cwd**——vibe-ide 风格,**不用 `--add-dir`**(实测 GLM 后端 `--add-dir` 不并入默认 `**` 搜索范围、形同未生效),Claude 默认 `**` glob 自然覆盖该目录;per-session 预处理产物仍落该目录下的 `<groupId>/<日期时间>` 子目录(退出空则回收);不存在则 `ensureDir` 兜底创建;回退兼容旧 `BOT_ADD_DIRS`(取首项);`start.ps1` 顶部 `$AddDir` 可改)。
  - `BOT_ALLOWED_USERS`(逗号分隔的发送者白名单,默认空=全部接受;非空时只处理列表内 `sender` 的消息,其余忽略——在 `tick` 水位推进后、`route` 前过滤,水位仍推进故不重复拉取;`start.ps1` 顶部 `$AllowedUsers` 可改;设 `BOT_DEBUG=1` 看日志里 sender 值)。
  - `BOT_PICTURE_OUTPUT`(`image`|`html`,默认 `image`;设 `html` 则富文本回复发 HTML 文件而非截图,`runAssistant` 把默认策略的 `picture` 重映射成 `html`,见 `output-policy.ts` 的 `OutputMode`)。
  - `BOT_INCLUDE_THINKING`(`1`/`true`/`yes`/`on`,默认关;开则 Claude 生成中每完成一个 thinking 块就先以 `💭 ` **纯文本**消息发到群、再发最终回复——"先 think 后结果",thinking 永远直发 `sendText`、绕过 outputPolicy,不触发 picture/html。流式经 `Llm.ask`/`Session.send` 的可选 `onPartial` 回调,块级非逐 token)。
  - `BOT_PIPELINE`(`log-qa` = 日志特化无识图 pipeline;否则默认接力 pipeline)、`BOT_PREPROCESS_CONFIG`(指向 `.mjs` 声明预处理 spec;未设 → 内置默认 file spec;见"扩展点"与 `doc/pre-hook-handbook.md`)。
  - `WELINK_ACCOUNT`(bot 自身账号,回环过滤的次要手段;主要靠 `sentIds` 按 CLI 发出 msgId 排除,同/异账号皆安全)、`WELINK_CLI_SCRIPT`(供 `node <script>` 跑 sim)、`CHROMIUM_PATH`(截图用 Chrome/Edge 路径,否则自动探测)、`BOT_DEBUG`(打每条 recv + route 决策)。
- Claude CLI 需 `claude`/`opencc`/`openclaude` 在 PATH(回退顺序:claude → opencc → openclaude,`findBinary` 逐个探测,首个命中即用);`permissionMode: bypassPermissions`(全自动)。
- 渲染用 **`puppeteer-core`(无 chromium 下载)**:设 `CHROMIUM_PATH` 或自动探测本机 Chrome/Edge。(本机装带下载的 `puppeteer` 会撞公司代理 TLS 失败——故用 core。)
- Claude 工作目录:base 默认 `workspace/`(隔离的安全边界,bypassPermissions 赋予文件读写权,**勿放敏感文件**)。**设 `BOT_ADD_DIR` 时**:该目录即 Claude cwd(替换 base 作 cwd),pooled 会话的 per-session 子目录改建在 `<BOT_ADD_DIR>/<groupId>/<日期时间>` 下,无状态识图亦用该目录作 cwd。

## 备注

- `doc/ai-internal-comm-design.md` 为早期"多浅模块"方案,**已被取代**;当前是"深模块 + 3 接缝 + 接力 pipeline"。完整设计见 `~/.claude/plans/c-users-l30033004-claude-skills-improve-generic-biscuit.md`。
- 水位与生命周期均**可注入、默认退化到"全处理、无生命周期"**(`loadWatermark` 默认 `()=>"0"` 全处理、`sessionLlm` 默认 undefined 每条都处理),便于手动驱动/集成。零配置 `runAssistant({groupId})` 才启用全生产行为(welink 通道 + state.ts 水位 + 生命周期)。
