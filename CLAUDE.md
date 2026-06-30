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
npm run sim:gui
npm run sim:bot
./start.ps1                 # 一键启动(PowerShell,真实 welink):编辑顶部 CONFIG(群/think/轮询间隔/拉取数)后跑
```

## 关键约定

- **ESM + NodeNext**:所有相对导入必须带 `.js` 后缀(如 `import './llm.js'`),即便源文件是 `.ts`。新增文件务必遵守,否则运行时解析失败。
- **两份 tsconfig**:`tsconfig.json`(noEmit,类型检查 src,供 IDE/typecheck);`tsconfig.build.json`(只 emit `src/` 到扁平 `dist/`)。`npm run build` 用后者。
- **类型先行**:端口接口(`Channel`/`Llm`/`Renderer`)与其具体适配器分文件放,接口用 `import type` 引用,避免测试拉起重的运行时依赖。

## 架构(深模块 + 3 接缝 + 配置驱动 pipeline)

核心是**一个深模块 `Assistant`**(`src/assistant.ts`):纯编排、无 I/O。主循环 = `轮询(channel) → 水位去重(只触发一次)→ 生命周期路由(@开启/exit)→ runPipeline → outputPolicy → text/picture/html(发群)`;每条消息 try/catch,出错发纯文本致歉、循环不死。生产由后台循环驱动,手动驱动用 `startLoop:false` 后直接 `await handle.tick()`。

**三个真接缝**(各为端口 + 生产适配器;测试假实现已随 vitest 移除,需时可按此结构在 `test/fakes.ts` 重建 `FakeChannel`/`FakeLlm`/`FakeRenderer`。其余依赖只有一个适配器、**不开端口**,勿投机性加 port):

| 接缝 | 端口 | 生产适配器 |
|---|---|---|
| 通讯渠道 | `src/channels/channel.ts` (`Channel`) | `welink-channel.ts`(welink-cli im 群) |
| 大模型 | `src/llm.ts` (`Llm`) | `claude-client.ts`(Claude CLI 子进程) |
| 截图渲染 | `src/renderers/renderer.ts` (`Renderer`) | `puppeteer-renderer.ts`(Puppeteer) |

> 端口方法:`Channel` = `getNewMessages`/`sendText`/`sendPicture`/`sendFile`;`Renderer` = `markdownToImage`/`markdownToHtml`。`sendFile`+`markdownToHtml` 服务"富文本回复发 HTML 文件"形态(见 `BOT_PICTURE_OUTPUT`),其余方法不变。

**多模型接力**(`src/pipeline.ts` + `src/pipelines/default.ts` + `src/models.ts` + `src/output-policy.ts`):
- `Step` mutate `StepCtx { userId, content, scratch, session, workspacePath?, reply }`;`modelStep(name)` 调命名模型写 `ctx.reply`,`scriptStep(fn)` 纯变换(可重组 `content` 喂下一步),`scriptFileStep(path)` 调外部脚本(stdin 传 `{content,session,workspacePath}` → stdout 回 `{session?,content?}`,merge 进 ctx)。线性 steps,分支写在 script 内。`scratch` 消息级(每条新建);`session` 会话级(跨消息保留,`@开启` 初始化、`exit` 清理,预处理产物元信息/"已预处理"守卫放此);`workspacePath` 会话 workspace 子目录路径(供脚本写产物 / Claude 读,见下"会话预处理")。
- 默认 pipeline(`src/pipelines/default.ts`):图片 → `vision` 识图(描述存 scratch)→ 脚本组装 → **通用会话预处理**(默认内置,见下)→ `text` 分析。文本消息:带文件路径则触发预处理,否则直接 `text`。
- `Models = Record<string, Llm>` 命名注册表,`buildModels(specs)` 从配置构建;`output-policy.ts` 的 `isMarkdown` 决定 picture(渲染)还是 text(直发)。
- 零配置 `runAssistant({groupId})` 即默认 vision+text 模型 + 接力 pipeline + markdownOutputPolicy + welink 群通道 + state.ts 水位 + 生命周期。**多群=入口 `index.ts` 循环起多个 `runAssistant({groupId})`**(每群独立 Assistant/pool/active/channel,隔离结构性,不需复合键;单进程多 loop 并发,I/O 交错)。默认适配器在 `runAssistant` 内**懒加载**(动态 import),注入假时绝不加载 puppeteer/child_process/welink-cli——核心可零外部依赖驱动。

**按用户隔离会话**(`src/session-pool.ts`):`Map<userId, Session>` + LRU + `--resume` 续接;每用户 claudeSessionId 持久化于 `src/state.ts`(**每群独立文件 `~/.claude-bot/state-<groupId>.json`**`{watermark, sessionIds}`,可用 `BOT_STATE_DIR` 覆盖;groupId 经 `createClaudeCliLlm` 闭包绑进 load/save,SessionPool 本身仍 userId 键——因每群一个 pool 实例,无跨群串号)。`SessionPool` 通过注入 `spawn` 工厂 + load/save 回调可脱离真子进程驱动。

**群消息监控 + 按发送者生命周期**(`src/assistant.ts` + `src/state.ts` + `SessionLlm`):
- **只触发一次(水位去重)**:每条消息**处理前**先把水位(最后处理 msgId)推进并持久化到 `state.ts`(每群独立文件的 `watermark` 字段),再处理 → 崩溃至多重丢"正在处理的那一条",绝不重复处理(at-most-once,用户取舍:宁可丢也不重发)。首次运行(无水位)落种到本批最新 msgId、不处理 → **排除历史**。msgId 是 >2^53 的大整数,`welink-channel.ts` parse 前正则引号化成 string,核心用 `BigInt` 比较(非数值 id 回退字符串比较)。
- **每群单活跃生命周期**(注入 `sessionLlm` 时生效;零配置自动取 `models.text`;每群一个 `activeUserId: string|null`):`@bot`(消息 `at===true`,**任意 @ 即开、不要求"开启"二字**)→ 无人活跃时 `startSession` 新建会话(**不续接**);活跃期间该发送者普通消息直接处理;**他人 @ 被拒**(回复当前活跃者、不开新会话;他人普通消息照旧忽略不回复);`esc/quit/exit` → **命令在途时中断**(并发 watcher 在 `handle()` 在途期间轮询——主循环串行阻塞在在途 route 看不到 esc,故需 watcher;见活跃用户 esc 即向 CLI stdin 发 `interrupt` control_request,参考 vibe-ide `ai.ts:885-896`;CLI 回 `result(is_aborted)` → `Reply.aborted` → `modelStep` 写 `ctx.aborted` → `handle` 发"🛑已中断,再次发送 esc 可退出会话。"纯文本、**不退出会话**,被消化的 esc 记入 `consumedEsc` 由主循环跳过避免又当 exit)/ **命令空闲时**(handle 已返回、watcher 已停)→ `endSession` 取 claudeSessionId 发到群里(作 resume 句柄)并结束——即"一次 esc 中断、二次 esc 退出"。退出后才可开新一轮(防"串")。**模型别名**:`@bot <alias>`(`haiku`/`sonnet`/`opus`/`fable`,首个匹配的空白分隔 token、大小写不敏感)在开启时经 `set_model` control_request(stream-json stdin,参考 vibe-ide `ai.ts`)切该会话模型,别名从正文剥离后剩余为空或仅剩 @提及则只 ack 不送 Claude;输错走默认,不影响开启。`SessionLlm`(`src/llm.ts`)= `Llm + startSession/endSession/setModel/interrupt`;`SessionPool` 增 `startFresh`(不带 resumeId)/`release`/`has`/`setModel`/`interrupt`(`interrupt(userId)` 取活跃会话调 `session.interrupt()`,无活跃 pooled 会话如在 vision 等无状态步骤返 false,watcher 据此不消费 esc、续轮询)。
- 水位与生命周期均**可注入、默认退化到"全处理、无生命周期"**(`loadWatermark` 默认 `()=>"0"` 全处理、`sessionLlm` 默认 undefined 每条都处理),便于手动驱动/集成。零配置 `runAssistant({groupId})` 才启用全生产行为(welink 通道 + state.ts 水位 + 生命周期)。

**Claude 子进程管理**(`src/claude-client.ts`):精简自兄弟项目 `D:\test\vibe-ide\src\main\ai.ts`(去掉 Electron IPC / 权限交互 / 流式 token / partial-messages),只收集最终 assistant 文本、遇 `result` 即 resolve。复用其 `findBinary`/`sanitizeEnvForCli`/`buildClaudeArgs`/`spawnClaude`/NDJSON 行缓冲解析/`killAiProcess`(Windows `taskkill /f /t` 杀进程树)。`ClaudeSession` 公开面 `spawn/send/kill/setModel`(`setModel` 经 `set_model` control_request 运行期切模型,精简自 vibe-ide `ai.ts` 的 `AI_SET_MODEL`)。**不用 `--add-dir`**:`BOT_ADD_DIR` 直接作 cwd(vibe-ide 风格——GLM 后端 `--add-dir` 不并入默认 `**` 范围,改 cwd 根除搜索 bug;`buildClaudeArgs` 仅把 cwd 写进 system-prompt 提示)。`Llm` 接口可选 `stop?()`(pooled 实现=`SessionPool.stopAll()` 杀全部子进程);`Assistant.stop()` 遍历 models 调 `m.stop?.()`,多群 shutdown 时由 `index.ts` 逐 handle 调用,防漏杀 Claude 子进程。

## 环境与约束

- 通讯软件**只收 text/picture、不支持流式** → 必须"请求 → 等 Claude 整轮完整回复"再处理。
- `welink-cli im` 群:`query-history-message --group-id G --query-count N` / `send-to-group --group-id G --text|--image|--file <...>`。stdout 信封 `{resultCode,resultContext,respData,sno}`(`resultCode "0"`=成功);`respData.chatInfo[]` 新→旧,`contentType` ∈ `TEXT_MSG`/`IMAGESPAN_MSG`/`FILE_MSG`/`CARD_MSG`(详见 `doc/trueapi.md`)。若 welink 输出格式有变,**只改 `src/channels/welink-channel.ts`** 一个适配器(接缝回报,不动架构)。
- 环境变量:`WELINK_GROUP_IDS`(必填,逗号分隔的监控群 ID;回退兼容旧 `WELINK_GROUP_ID` 单群)、`WELINK_BIN`(默认 `welink-cli`)、`WELINK_QUERY_COUNT`(默认 20)、`BOT_POLL_INTERVAL_MS`(轮询间隔 ms,默认 1000)、`BOT_STATE_DIR`(水位+会话 id 持久化目录,默认 `~/.claude-bot`;每群独立 `state-<groupId>.json`)、`BOT_ADD_DIR`(单个额外目录,默认空=不加;设则**直接作 Claude 的 cwd**(vibe-ide 风格,**不用 `--add-dir`**——实测 GLM 后端 `--add-dir` 不并入默认 `**` 搜索范围、形同未生效),Claude 默认 `**` glob 自然覆盖该目录(如项目/日志目录);per-session 预处理产物仍落该目录下的 `<groupId>/<日期时间>` 子目录(退出空则回收);不存在则 `ensureDir` 兜底创建;回退兼容旧 `BOT_ADD_DIRS`(取首项);`start.ps1` 顶部 `$AddDir` 可改)、`BOT_ALLOWED_USERS`(逗号分隔的发送者白名单,默认空=全部接受;非空时只处理列表内 `sender`(即 `IncomingMessage.user`)的消息,其余忽略——在 `tick` 水位推进后、`onReceive`/`route` 前过滤,水位仍推进故不重复拉取;`start.ps1` 顶部 `$AllowedUsers` 可改)、`BOT_PICTURE_OUTPUT`(`image`|`html`,默认 `image`;设 `html` 则富文本回复发 HTML 文件而非截图,`runAssistant` 把默认策略的 `picture` 重映射成 `html`,见 `output-policy.ts` 的 `OutputMode`)、`BOT_INCLUDE_THINKING`(`1`/`true`/`yes`/`on`,默认关;开则 Claude 生成中每完成一个 thinking 块就先以 `💭 ` **纯文本**消息发到群、再发最终回复——"先 think 后结果",thinking 永远直发 `sendText`、绕过 outputPolicy,不触发 picture/html。流式经 `Llm.ask`/`Session.send` 的可选 `onPartial` 回调(块级,非逐 token;`modelStep` 透传,故仅最终回复模型流式,vision/preprocess 等中间步骤不流式),见 `claude-client.ts` + `assistant.ts` 的 `partialChain`)。
- Claude CLI 需 `claude`/`opencc`/`openclaude` 在 PATH(回退顺序:claude → opencc → openclaude,`findBinary` 逐个探测,首个命中即用);`permissionMode: bypassPermissions`(全自动)。**模型切换经 env `ANTHROPIC_MODEL`**(不用 `--model` flag,跨 claude/opencc/openclaude/GLM 变体最稳)。`createClaudeCliLlm({ pooled })`:`true`=按用户续接(对话型),`false`=无状态 spawn→ask→kill(识图等)。
- 渲染用 **`puppeteer-core`(无 chromium 下载)**:设 `CHROMIUM_PATH` 或自动探测本机 Chrome/Edge。(本机装带下载的 `puppeteer` 会撞公司代理 TLS 失败——故用 core。)
- Claude 工作目录:base 默认 `workspace/`(隔离的安全边界,bypassPermissions 赋予文件读写权,勿放敏感文件)。**每 pooled 会话开独立子目录** `workspace/<groupId>/<日期时间>`(`@开启` 各不同,多群防同毫秒碰撞;claudeSessionId 在 spawn 后首轮 send 才到、且 Windows 不能移动运行中进程 cwd,故用日期时间命名而非对话 id),会话退出(exit/淘汰/进程退出)后若子目录为空则自动回收(非空保留);无状态识图仍用 base。见 `src/workspace.ts`。**设 `BOT_ADD_DIR` 时**:该目录即 Claude cwd(替换 base 作 cwd),pooled 会话的 per-session 子目录改建在 `<BOT_ADD_DIR>/<groupId>/<日期时间>` 下(预处理产物落此、在 cwd 之下可被默认 `**` 命中、退出回收叶子不删 BOT_ADD_DIR 本身),无状态识图亦用该目录作 cwd。

## 演进方式(都不碰核心)

- 加/换模型 → `src/models.ts` 加 `ModelSpec`(`model` 切模型 id,`pooled` 控制会话策略)。
- 改接力顺序 → 换 `src/pipelines/default.ts` 的 steps,或传自定义 `pipeline`。
- 改输出规则 → 换 `outputPolicy` 函数;或设 `pictureOutput`/`BOT_PICTURE_OUTPUT=html` 把富文本回复从截图改成发 HTML 文件(`OutputMode` ∈ text/picture/html)。
- 外部脚本文件 → `runScriptFile(ctx,path,opts)` / `scriptFileStep(path)`(已实现,`Step` 接口不变;stdin 传 `{content,session,workspacePath}`、stdout 回 `{session?,content?}`;`runScriptFile` 供 step 内条件调用——仅 `session.pendingInput` 存在才 spawn,避免每条消息都起子进程)。
- 会话级预处理(跨消息,如日志解压/解析/搜索→问答)→ `StepCtx.session`(会话级 scratch)+ `ctx.workspacePath` + `sessionLlm.getWorkspacePath(userId)`(接缝内:`Session.workspacePath` → `SessionPool.getWorkspacePath` → `SessionLlm`)。预处理由 `src/pipelines/preprocess.ts` 的 `preprocessSteps(opts)` 提供(守卫+抽取 → 条件预处理 → 问答组装),`driver:'script'`(默认,`runScriptFile` 跑外部脚本)/ `'claude'`(同会话 Claude 用 bash)。**默认 pipeline 已内置通用预处理**(任意带扩展名文件路径触发,条件跑);env `BOT_PREPROCESS_SCRIPT`/`BOT_PREPROCESS_INTERPRETER` 配脚本+解释器(node/python/exe,见 `doc/getting-started.md`)。`BOT_PIPELINE=log-qa` 仅当要日志特化(限定 zip/gz/tar/log/txt)+ 无 vision 时用。

## 备注

- `doc/ai-internal-comm-design.md` 为早期"多浅模块"方案,**已被取代**;当前是"深模块 + 3 接缝 + 接力 pipeline"。完整设计见 `~/.claude/plans/c-users-l30033004-claude-skills-improve-generic-biscuit.md`。
- 验证范式:vitest/测试已移除(太慢);验证靠 `npm run typecheck` + `npm run dev`/`./start.ps1` 手动集成(设 `WELINK_GROUP_IDS` → 群里 `@bot` → 提问 → `exit`;重启 bot 应不重处理历史/已处理消息)。多群/单活跃验证:`npm run sim:gui` + `npm run sim:bot`(或真实环境 `./start.ps1`)→ A `@bot` 开启、B `@bot` 应被拒、B 普通消息不回复、`exit` 后 B 可开、两群互不影响。核心逻辑仍按"可注入假"设计(`startLoop:false` + 注入 channel/llm/renderer/水位/sessionLlm),需测试时可按上表结构在 `test/fakes.ts` 重建三假。
