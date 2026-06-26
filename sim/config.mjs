// sim/config.mjs — 共享 sim 配置(从 env 读 + 默认)。零依赖。
// 被 welink-cli.mjs(CLI)、gui/server.mjs(服务)共用。纯常量,无函数。
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// __dirname 在 ESM 下需手动求;用 fileURLToPath 避免 Windows path 形如 /D:/... 的坑。
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 共享状态文件:CLI 模拟器 / GUI 服务 / 真实 bot 子进程都经它读写(多写者,见 store.mjs 的锁)。 */
export const WELINK_SIM_STATE = process.env.WELINK_SIM_STATE ?? join(__dirname, 'state.json')

/** 默认发送者/bot 账号(= bot 自己的账号)。回落链:WELINK_SIM_ACCOUNT > WELINK_ACCOUNT > 'bot01',
 *  使只设 WELINK_ACCOUNT 即可让 sim 的 @-检测与 sender 都用同一账号(welink-channel.ts 自过滤也读 WELINK_ACCOUNT,
 *  两变量天然一致)。真实 welink 用登录账号;sim 仍可显式 WELINK_SIM_ACCOUNT 覆盖以冒充多客户。 */
export const WELINK_SIM_ACCOUNT = process.env.WELINK_SIM_ACCOUNT ?? process.env.WELINK_ACCOUNT ?? 'bot01'

/** 图片/文件信封里的 URL 前缀(由 GUI 的 /file 路由提供下载/展示)。末尾斜杠会被去掉。 */
export const SIM_BASE_URL = (process.env.SIM_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

/**
 * msgId 计数基数。真实 welink 的 msgId ~1e17 超 Number.MAX_SAFE_INTEGER(~9e15);
 * sim 用小基数,留在安全整数内。TODO: 接真实 welink 时改 BigInt 比较。
 */
export const SIM_MSG_ID_BASE = Number(process.env.SIM_MSG_ID_BASE ?? 1000)

/** 锁参数(多写者:GUI 服务 in-process 写 + bot CLI 子进程写并发)。 */
export const SIM_LOCK_STALE_MS = Number(process.env.SIM_LOCK_STALE_MS ?? 5000)
export const SIM_LOCK_RETRY_MS = Number(process.env.SIM_LOCK_RETRY_MS ?? 50)
export const SIM_LOCK_MAX_RETRIES = Number(process.env.SIM_LOCK_MAX_RETRIES ?? 20)

/** sim 目录绝对路径(供 GUI 求 uploads 目录等)。 */
export const SIM_DIR = __dirname
