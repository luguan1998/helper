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
- `Step` mutate `StepCtx { userId, content, scratch, reply }`;`modelStep(name)` 调命名模型写 `ctx.reply`,`scriptStep(fn)` 纯变换(可重组 `content` 喂下一步)。线性 steps,分支写在 script 内。
- 默认 pipeline:图片 → `vision` 识图(描述存 scratch)→ 脚本组装成文本 → `text` 分析;文本消息直接走 `text`。
- `Models = Record<string, Llm>` 命名注册表,`buildModels(specs)` 从配置构建;`output-policy.ts` 的 `isMarkdown` 决定 picture(渲染)还是 text(直发)。
- 零配置 `runAssistant({groupId})` 即默认 vision+text 模型 + 接力 pipeline + markdownOutputPolicy + welink 群通道 + state.ts 水位 + 生命周期。默认适配器在 `runAssistant` 内**懒加载**(动态 import),注入假时绝不加载 puppeteer/child_process/welink-cli——核心可零外部依赖驱动。

**按用户隔离会话**(`src/session-pool.ts`):`Map<userId, Session>` + LRU + `--resume` 续接;每用户 claudeSessionId 持久化于 `src/state.ts`(`~/.claude-bot/state.json`,可用 `BOT_STATE_DIR` 覆盖)。`SessionPool` 通过注入 `spawn` 工厂 + load/save 回调可脱离真子进程驱动。

**群消息监控 + 按发送者生命周期**(`src/assistant.ts` + `src/state.ts` + `SessionLlm`):
- **只触发一次(水位去重)**:每条消息**处理前**先把水位(最后处理 msgId)推进并持久化到 `state.ts`(`lastMsgIds[groupId]`),再处理 → 崩溃至多重丢"正在处理的那一条",绝不重复处理(at-most-once,用户取舍:宁可丢也不重发)。首次运行(无水位)落种到本批最新 msgId、不处理 → **排除历史**。msgId 是 >2^53 的大整数,`welink-channel.ts` parse 前正则引号化成 string,核心用 `BigInt` 比较(非数值 id 回退字符串比较)。
- **按发送者生命周期**(注入 `sessionLlm` 时生效;零配置自动取 `models.text`):`@bot 开启`(消息 `at===true` 且正文 trim 后以"开启"结尾)→ `startSession` 新建会话(**不续接**);活跃期间该发送者普通消息直接处理;`esc/quit/exit` → `endSession` 取 claudeSessionId 发到群里(作 resume 句柄)并结束;非活跃发送者消息忽略;活跃中再"开启"被拒,退出后才可开新一轮(防"串")。`SessionLlm`(`src/llm.ts`)= `Llm + startSession/endSession`;`SessionPool` 增 `startFresh`(不带 resumeId)/`release`/`has`。
- 水位与生命周期均**可注入、默认退化到"全处理、无生命周期"**(`loadWatermark` 默认 `()=>"0"` 全处理、`sessionLlm` 默认 undefined 每条都处理),便于手动驱动/集成。零配置 `runAssistant({groupId})` 才启用全生产行为(welink 通道 + state.ts 水位 + 生命周期)。

**Claude 子进程管理**(`src/claude-client.ts`):精简自兄弟项目 `D:\test\vibe-ide\src\main\ai.ts`(去掉 Electron IPC / 权限交互 / 流式 token / partial-messages),只收集最终 assistant 文本、遇 `result` 即 resolve。复用其 `findBinary`/`sanitizeEnvForCli`/`buildClaudeArgs`/`spawnClaude`/NDJSON 行缓冲解析/`killAiProcess`(Windows `taskkill /f /t` 杀进程树)。`ClaudeSession` 公开面仅 `spawn/send/kill`。

## 环境与约束

- 通讯软件**只收 text/picture、不支持流式** → 必须"请求 → 等 Claude 整轮完整回复"再处理。
- `welink-cli im` 群:`query-history-message --group-id G --query-count N` / `send-to-group --group-id G --text|--image|--file <...>`。stdout 信封 `{resultCode,resultContext,respData,sno}`(`resultCode "0"`=成功);`respData.chatInfo[]` 新→旧,`contentType` ∈ `TEXT_MSG`/`IMAGESPAN_MSG`/`FILE_MSG`/`CARD_MSG`(详见 `doc/trueapi.md`)。若 welink 输出格式有变,**只改 `src/channels/welink-channel.ts`** 一个适配器(接缝回报,不动架构)。
- 环境变量:`WELINK_GROUP_ID`(必填,监控的群 ID)、`WELINK_BIN`(默认 `welink-cli`)、`WELINK_QUERY_COUNT`(默认 20)、`BOT_STATE_DIR`(水位+会话 id 持久化目录,默认 `~/.claude-bot`)、`BOT_PICTURE_OUTPUT`(`image`|`html`,默认 `image`;设 `html` 则富文本回复发 HTML 文件而非截图,`runAssistant` 把默认策略的 `picture` 重映射成 `html`,见 `output-policy.ts` 的 `OutputMode`)。
- Claude CLI 需 `claude`/`openclaude` 在 PATH;`permissionMode: bypassPermissions`(全自动)。**模型切换经 env `ANTHROPIC_MODEL`**(不用 `--model` flag,跨 claude/openclaude/GLM 变体最稳)。`createClaudeCliLlm({ pooled })`:`true`=按用户续接(对话型),`false`=无状态 spawn→ask→kill(识图等)。
- 渲染用 **`puppeteer-core`(无 chromium 下载)**:设 `CHROMIUM_PATH` 或自动探测本机 Chrome/Edge。(本机装带下载的 `puppeteer` 会撞公司代理 TLS 失败——故用 core。)
- Claude 工作目录默认 `workspace/`(隔离的安全边界,bypassPermissions 赋予文件读写权,勿放敏感文件)。

## 演进方式(都不碰核心)

- 加/换模型 → `src/models.ts` 加 `ModelSpec`(`model` 切模型 id,`pooled` 控制会话策略)。
- 改接力顺序 → 换 `src/pipelines/default.ts` 的 steps,或传自定义 `pipeline`。
- 改输出规则 → 换 `outputPolicy` 函数;或设 `pictureOutput`/`BOT_PICTURE_OUTPUT=html` 把富文本回复从截图改成发 HTML 文件(`OutputMode` ∈ text/picture/html)。
- 外部脚本文件 → 加 `scriptFileStep(path)` 变体,`Step` 接口不变。

## 备注

- `doc/ai-internal-comm-design.md` 为早期"多浅模块"方案,**已被取代**;当前是"深模块 + 3 接缝 + 接力 pipeline"。完整设计见 `~/.claude/plans/c-users-l30033004-claude-skills-improve-generic-biscuit.md`。
- 验证范式:vitest/测试已移除(太慢);验证靠 `npm run typecheck` + `npm run dev` 手动集成(设 `WELINK_GROUP_ID` → 群里 `@bot 开启` → 提问 → `exit`;重启 bot 应不重处理历史/已处理消息)。核心逻辑仍按"可注入假"设计(`startLoop:false` + 注入 channel/llm/renderer/水位/sessionLlm),需测试时可按上表结构在 `test/fakes.ts` 重建三假。
