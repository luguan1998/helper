# 文件下载接口 API(生产实现 TODO)

> 本文是"卡片式引用文件"工作流里**文件下载适配器**的接口契约,供后续实现生产下载(替换 sim 桩)时对接。
> 现状:sim 桩已实现(只下 localhost);**生产下载(提取码+验证码)是 TODO,未实现**。本文定义"生产实现必须满足什么"。
> 相关代码:`src/image.ts`(sim 桩 + `sanitizeFileName`)、`src/pipelines/preprocess.ts`(`DownloadFileFn` / `fileRefLandingStep`)、`src/pipelines/default.ts`(注入点)。

---

## 1. 背景

群里引用一条文件消息(CARD_MSG,preMsg=FILE_MSG)+ 文字问题 → bot 要把被引用文件下载到本地,再喂预处理脚本。welink 文件 URL 是 `https://clouddrive.huawei.com/f/<id>` **分享链**,发送时 welink-cli 上传到 clouddrive 建分享链(`doc/trueapi.md:18` "Creating share link…"),接收端拿到的是**受保护分享链**:

- **提取码**:分享链可能带提取码(发送方设定),接收方需输入。
- **用户验证码**:访问时可能要求验证码(captcha / 短信),需用户/凭据通过。
- `welink-cli` **无文件下载子命令**(只 `im` 系列,`doc/trueapi.md:61`)→ bot 得自己解决分享链解析 + 鉴权 + 下载。

裸 `fetch` 拿不到(会拿到登录/验证页 HTML,非文件字节)。故 sim 桩只下 localhost,生产实现是独立子问题。

架构上 `downloadFile` 经 `fileRefLandingStep` **注入**,生产实现落地时**只换这一个函数**,pipeline / preprocess / 核心循环不动。

---

## 2. 当前接口

### 2.1 函数签名(`src/pipelines/preprocess.ts`)

```ts
export type DownloadFileFn = (url: string, destDir: string, fileName?: string) => Promise<string>
```

| 参数 | 含义 | 来源 |
|---|---|---|
| `url` | 文件分享链 URL(welink `/:um_begin{url|…}` 段 0,`extractUmUrl` 提取) | channel 解析 CARD_MSG 的 preMsg |
| `destDir` | 落地目录绝对路径 = `<workspacePath>/downloads` | landing step 算好传入 |
| `fileName` | 文件名(welink `/:um_begin{…|fileName|…}` 段 3,`extractUmFileName` 提取);可能含空格/中文/特殊字符 | channel 提取 |
| **返回** | 下载后本地文件**绝对路径** | 供 landing step 作 fired `input`(去重 key + 喂预处理脚本) |

### 2.2 注入点(`src/pipelines/default.ts`)

```ts
import { fileRefLandingStep } from './preprocess.js'
import { downloadFile } from '../image.js'   // ← 生产实现替换此 import 指向的函数
export function createDefaultPipeline(specs) {
  return { steps: [
    …,
    fileRefLandingStep(specs, downloadFile),   // ← 注入
    ...preprocessSteps(specs),
    modelStep('text'),
  ] }
}
```

替换方式:改 `src/image.ts` 里 `downloadFile` 的实现,或在 `default.ts` 注入一个新函数(如 `prodDownloadFile`)。**不动 `fileRefLandingStep` 与 preprocess。**

### 2.3 landing step 如何调用它(契约来源)

`fileRefLandingStep`(`src/pipelines/preprocess.ts`)关键逻辑:

```ts
const destDir = join(ctx.workspacePath, 'downloads')
const local = join(destDir, sanitizeFileName(ref.name))   // ① 前置算好预期路径
const st = getState(ctx.session, spec.name)
if (st.inputs.includes(local)) return                      // ② 去重:同 input 跳过(连下载都省)
landed = await downloadFile(ref.url, destDir, ref.name)    // ③ 调用,返回实际落地路径
fired.push({ spec, match: landed, groups: [landed], input: landed })  // ④ input=landed
```

---

## 3. 生产实现必须满足的契约(硬性)

1. **★ 返回路径必须等于 `join(destDir, sanitizeFileName(fileName))`**。
   landing step ② 用 `local`(前置算的)去重,④ 把 `landed`(你返回的)记入 `st.inputs`。**下次引用同文件**时 ② 比的是 `local`,只有 `landed === local` 才命中去重。若你返回别的路径(如带随机后缀、tmp 目录),**去重失效**→每次引用都重下重处理、产物累计爆。
   → 生产实现**必须**复用 `src/image.ts` 导出的 `sanitizeFileName` 算 dest,写文件到 `join(destDir, sanitizeFileName(fileName))` 并原样返回。
   > 硬化建议(可选,非本次):把"算 dest 路径"提成导出 helper(如 `downloadDest(destDir, fileName)`),landing step 与 downloadFile 共用,根除两边路径漂移;或 landing step 改成"下载后用返回值去重"(代价:重复引用多一次下载)。

2. **失败抛错,不要返回空/部分**。landing step `try/catch` 捕获 → `ctx.notify` 发 `⚠️ 引用文件下载失败:<message>` → 不阻断(text-only 问答仍进行)。错误信息要人话(给群里看)。

3. **安全**:
   - `url` 校验是 welink/clouddrive 分享链(host allowlist,如 `clouddrive.huawei.com` 及其 CDN 域)→ 防 SSRF。sim 桩的 allowlist(localhost 系)是**桩专用**,生产实现用**自己的**域名校验。
   - `fileName` 来自消息(发送方可控)→ **必须 sanitize**(去路径分隔符 / `..` / 特殊字符)再 join 到 destDir,防目录穿越。复用 `sanitizeFileName` 即满足。
   - 只写 destDir 之下;不给 `bypassPermissions` 的 Claude 越权读盘面。

4. **大文件**:桩用 `Buffer.from(await res.arrayBuffer())` 全量入内存;生产实现若可能遇大日志,用流式写盘(`res.body` pipe 到 `createWriteStream`)。

5. **超时**:分享链解析 + 下载可能慢;自带超时(如 10min),超时抛错走 ② 致歉路径。landing step 不传 timeoutMs(不像 `runScriptFile` 有 `timeoutMs`);生产实现自行包超时。

---

## 4. 缺口:提取码 / 验证码(当前签名表达不了交互)

当前签名 `(url, destDir, fileName)` 只够"无状态下载"。但:

- **提取码**:bot(接收方)不知道发送方设的提取码 → 要么用户告诉 bot,要么凭据绕过。
- **验证码**:访问时生成,无法预知 → 要么自动过(captcha 难),要么用户输入。

非交互式方案(clouddrive API + 凭据)当前签名够用;**交互式方案(问用户要码)当前签名不够**——需要"发群提问 + 等该用户回复"的能力,签名得扩。

---

## 5. 候选实现方向(本次不选定)

| 方向 | 怎么下 | 提取码来源 | 验证码 | 对 API 的要求 |
|---|---|---|---|---|
| **A. clouddrive 凭据/API 直连** | 用账号 cookie/token 调 clouddrive 分享链解析 API → 直链下载 | 凭据可免 | 凭据可免 | 当前签名够;需逆向 API + 持久化凭据(§7) |
| **B. puppeteer 自动化** | headless 驱动分享页,填码,点下载(puppeteer-core 已是渲染依赖) | env / 消息文本 / askUser | 多半过不了 → 降级 askUser | 验证码场景需 §6 askUser 扩展 |
| **C. 人工在群里交互** | bot 问用户要码 → 用户回复 → bot 填入(经 API 或 puppeteer)下载 | askUser | askUser | 需 §6 askUser 扩展 + A 或 B 作底层提交 |

A 最稳(若能逆向 + 拿到凭据,可全免交互);B 中等(验证码是硬伤);C 最朴素但占会话、多轮。可组合(如 A 凭据优先、失败降级 C 问用户)。

---

## 6. 交互式扩展(askUser)— 主要设计工作

若选 B/C,需把签名扩为带"交互上下文":

```ts
export interface DownloadInteraction {
  /** 活跃用户 w3 账号(发群提问 / 等回复用)。 */
  userId: string
  /** 非阻塞发群(已有 ctx.notify 透传)。 */
  notify: (text: string) => void
  /** 发群提问 + 等该用户下一条回复,返回其正文。超时抛错。 */
  askUser: (prompt: string, opts?: { timeoutMs?: number }) => Promise<string>
}
export type DownloadFileFn = (
  url: string, destDir: string, fileName?: string, interaction?: DownloadInteraction,
) => Promise<string>
```

`askUser` 是新能力。实现它需要一个 **"待答 waiter"子系统**(bot 现没有):注册一个 `(groupId, userId)` → `resolver`,`route()` 收到该用户下一条消息时 resolve 它。

**与串行 route 的互斥(关键设计点)**:
- `handle()` 在 `await askUser()` 期间阻塞 pipeline step → 主循环 `tick` 阻塞在 `route` → 用户回复消息会**排在水位后等当前 route 结束**才进 route → 死锁(reply 永远进不了 route,askUser 永远等不到)。
- 解法:像 esc-watcher 那样开**并发 poller**拦截回复。`askUser` 注册 waiter 后,由一个并发 watcher 轮询 `getNewMessages`,命中该用户的新消息即 resolve waiter(并 `consumedXxx` 标记防主循环重复处理,类比 `consumedEsc`)。
- 超时:askUser 自带 timeoutMs,超时 reject → downloadFile 抛错 → 走 ⚠️ 致歉。

> 这块是交互方案的真正难点,不在本次实现范围。落地时建议先实现 A(免交互),把 askUser 留作 A 失败时的降级。

---

## 7. 凭据 / 状态存放

- **凭据**(A 方案的 cookie/token):走 env(如 `WELINK_CLOUDDRIVE_COOKIE` / `WELINK_CLOUDDRIVE_TOKEN`)或 `BOT_STATE_DIR` 下文件(类比 `state-<groupId>.json`)。`downloadFile` 是无状态适配器,凭据从 env/进程状态读,**不经 call args 传**(签名不变)。
- **会话级缓存**:若一个分享链在会话内被多次引用,landing step 的 `st.inputs` 去重已防重下(§3 契约①);无需 downloadFile 自己缓存。

---

## 8. 待定的设计问题(实现前需拍板)

1. **提取码从哪来**:用户在引用消息正文里带(`引用文件 提取码1234 …`→ channel 解析传入)?还是 askUser 问?还是凭据免?决定 channel 是否要再解析一个"提取码"字段。
2. **验证码类型**:captcha 图片 / 短信 / 其他?决定能否自动过、是否必须 askUser。
3. **clouddrive API 是否可逆**:能否拿到凭据、API 是否稳定?决定 A 是否可行。
4. **是否做多群隔离**:凭据是否群级(不同群不同账号)?影响凭据存放键。
5. **askUser 的并发 waiter 与 esc-watcher 是否共用一套 poller**:避免两套并发轮询重复拉消息。

---

## 9. 相关文件

| 文件 | 角色 |
|---|---|
| `src/image.ts` | sim 桩 `downloadFile` + 导出 `sanitizeFileName`(生产实现替换 `downloadFile`) |
| `src/pipelines/preprocess.ts` | `DownloadFileFn` 类型 + `fileRefLandingStep`(调用方,§3 契约来源) |
| `src/pipelines/default.ts` | 注入点:`fileRefLandingStep(specs, downloadFile)` |
| `src/channels/welink-channel.ts` | `extractUmUrl`/`extractUmFileName`/`extractUmType`(从 CARD_MSG preMsg 提取 url/fileName/type) |
| `src/assistant.ts` | `handle` 把 `msg.fileUrl`/`fileName` 挂到 `scratch.fileRef` |
| `sim/verify-card-ref.mjs` | sim 端注入 CARD_MSG 引用文件,验证用 |
| `doc/trueapi.md` | welink-cli 命令 + `/:um_begin{…}` 信封格式(:18,:61,:215-242) |
