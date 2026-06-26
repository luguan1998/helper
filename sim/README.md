# welink-cli 模拟器 + 聊天 GUI

按 `doc/trueapi.md` 接口实现的 `welink-cli` 模拟器(零依赖、纯 Node ESM `.mjs`、可被真实 bot 子进程调用)+ 一个简单聊天 GUI,用于测试 bot 的群消息收发回路。**测试用 MVP。**

## 架构

- **共享状态文件** `sim/state.json`(按群组存消息 + msgId 计数)。CLI 模拟器、GUI 服务、真实 bot 都经它读写(多写者,带最小锁)。
- **`welink-cli.mjs`** = CLI 模拟器,被以 `node sim/welink-cli.mjs im <sub> ...` 调用,stdout 输出 trueapi.md 的 JSON。
- **`gui/server.mjs` + `gui/index.html`** = 零依赖 http 聊天服务 + 原生页面。展示走 store 直读;发消息/上传/echo 回复/echo 轮询都经 CLI 子进程(execFile,忠实测 send/query)。`/file` 路由(仅本机)给浏览器展示与 bot 下载图片。
- **`store.mjs`** = 状态 + 锁 + 原子写 + 信封构造/解析。`config.mjs` = env 配置。
- **`run-bot.mjs`** = 设 sim env 后拉起真实 bot(`npm run dev`)。`selftest.mjs` = CLI 契约自测。

## 快速开始

```bash
# 1) 自包含 echo 测通 poll→reply 回路
npm run sim:gui                 # 起 GUI:http://localhost:3000
# 浏览器打开 http://localhost:3000 → 默认 echo 开 → 输入消息 → ~2s 后 bot01 回 "echo: ..."
# 上传图片/文件:点文件选择框

# 2) CLI 自测(对齐 trueapi.md)
node sim/selftest.mjs

# 3) 端到端接入真实 Claude bot
npm run sim:gui                 # 先起 GUI,并在页面关闭 echo(避免双重回复)
npm run sim:bot                 # 起 bot(channel=welink,指向 sim)
# 在 GUI 以 user01 发 "hello" → bot 轮询收到 → Claude 回复出现在 GUI(bot01)
```

> `sim:bot` 前提:已 `npm install`、`claude`/`openclaude` 在 PATH、chromium 可用(同 `npm run dev`)。

## CLI 手工示例

```bash
# 查询群历史(默认最新 N 条,new→old)
node sim/welink-cli.mjs im query-history-message --group-id 100001 --query-count 20

# 分页(0=更旧 msgId<ID,1=更新 msgId>ID;sim 解释)
node sim/welink-cli.mjs im query-history-message --group-id 100001 --query-count 20 --message-id 1000 --query-direction 0

# 发文本(--sender 是 sim 扩展,真实 welink 用登录账号)
node sim/welink-cli.mjs im send-to-group --group-id 100001 --sender user01 --text "Hello"

# 发图片(构造 IMAGESPAN_MSG 的 /:um_begin{...}/:um_end 信封)
node sim/welink-cli.mjs im send-to-group --group-id 100001 --sender user01 --image ./photo.png

# 发文件(构造 FILE_MSG 信封)
node sim/welink-cli.mjs im send-to-group --group-id 100001 --sender user01 --file ./doc.pdf
```

## sim 扩展(相对 trueapi.md 的偏离,均有文档,sim 侧)

1. `send-to-group` 加 `--sender`(真实用登录账号;sim 供测试冒充多客户)。
2. send 成功 `respData:{ msgId }`(真实未文档化;sim 返回新 id 便于测试)。
3. `msgId` 从小基数(1000)+1(真实 ~1e17 超 `Number.MAX_SAFE_INTEGER`;sim 留在安全整数内)。接真实 welink 时需改 BigInt。
4. `groupId` 安全整数时输出 number(真实 ~1e17 超)。
5. `query-direction`:0=更旧、1=更新(sim 解释;真实语义 TBD)。
6. 图片信封 URL = `<SIM_BASE_URL>/file?path=`(真实 clouddrive);sim 经 `/file` 服务本地文件供 bot 下载 / 浏览器展示。
7. md5 真 hash(`node:crypto`);图片 dim `0;0`(sim 不解析图片尺寸)。

## 配置(env)

| 变量 | 默认 | 说明 |
|---|---|---|
| `WELINK_SIM_STATE` | `sim/state.json` | 共享状态文件 |
| `WELINK_SIM_ACCOUNT` | `bot01` | 默认发送者/bot 账号;未设时回落到 `WELINK_ACCOUNT`(驱动 sim @-检测与 bot sender) |
| `SIM_BASE_URL` | `http://localhost:3000` | 图片信封 URL 前缀;**须指向 sim:gui 的地址**(GUI 改 `PORT` 时同步改此,或 GUI 未设时自动对齐自身 `PORT`) |
| `SIM_MSG_ID_BASE` | `1000` | msgId 计数基数 |
| `PORT` | `3000` | GUI 服务端口 |
| `SIM_GROUP_ID` | `100001` | GUI 默认群 |
| `SIM_ECHO` | `1` | GUI echo 自动回复开关(`0` 关) |
| `WELINK_CLI_BIN` | `welink-cli` | bot 适配器调用的二进制(sim 时为 `node`) |
| `WELINK_CLI_SCRIPT` | (无) | bot 适配器 args 前缀(sim 时为 `welink-cli.mjs` 路径) |
| `WELINK_GROUP_ID` | (必填) | bot 轮询/发送的群 |
| `WELINK_ACCOUNT` | `bot01` | bot 自身账号(过滤自身消息);sim 下也作 `WELINK_SIM_ACCOUNT` 的回落源 |
| `WELINK_QUERY_COUNT` | `20` | bot 单次拉取条数 |

## 安全模型

- `/file` 路由**仅本机**(`127.0.0.1` / `::1` / `::ffff:127.0.0.1`),服务任意本地路径(供 bot 截图 workspace/temp + 客户上传 sim/uploads)。**勿暴露到网络。**
- 状态文件无鉴权;sim 仅用于本机测试。

## 已知限制(MVP)

- 无 @mention 过滤:bot 回应群内所有消息,回复群内全员可见(隐私 TODO)。
- `lastMaxMsgId` 内存态:bot 重启后建新基线,离线期间消息被跳过(持久化 TODO)。
- echo 与真实 bot 不可同开(否则双重回复)。
- CARD_MSG 仅解析展示,不生成。
