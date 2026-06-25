#!/usr/bin/env node
// sim/welink-cli.mjs — welink-cli 命令行模拟器(trueapi.md 精确接口 + 少量有文档的 sim 扩展)。
// 被真实 bot / GUI 服务 / 手工测试以 `node sim/welink-cli.mjs im <sub> ...` 调用。
// 零依赖。stdout 输出 trueapi.md 的 JSON 响应结构。
import { addMessage, queryHistory, buildImageEnvelope, buildFileEnvelope } from './store.mjs'

/** 解析 argv.slice(2) 中 --flag value / --flag=value 形式。 */
function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true // 布尔标志(出现即真)
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

/** 取字符串值;true(无值标志)→ 空串;缺失 → undefined。 */
function getString(flags, key) {
  const v = flags[key]
  if (typeof v === 'string') return v
  if (v === true) return ''
  return undefined
}

function ok(respData) {
  process.stdout.write(JSON.stringify({
    resultCode: '0',
    resultContext: 'Operate Success',
    respData,
    sno: null,
  }) + '\n')
}

function fail(msg) {
  process.stdout.write(JSON.stringify({
    resultCode: '1',
    resultContext: msg,
    respData: null,
    sno: null,
  }) + '\n')
  process.exit(1)
}

async function runQuery(flags) {
  const groupId = getString(flags, 'group-id')
  if (groupId === undefined) throw new Error('--group-id is required')
  const result = await queryHistory({
    groupId,
    queryCount: getString(flags, 'query-count'),
    messageId: getString(flags, 'message-id'),
    queryDirection: getString(flags, 'query-direction'),
  })
  ok(result)
}

async function runSend(flags) {
  const groupId = getString(flags, 'group-id')
  if (groupId === undefined) throw new Error('--group-id is required')
  const sender = getString(flags, 'sender') // sim 扩展:缺失时 addMessage 用默认账号
  const text = getString(flags, 'text')
  const image = getString(flags, 'image')
  const file = getString(flags, 'file')

  let contentType, content
  if (text !== undefined) {
    contentType = 'TEXT_MSG'
    content = text // 空串也合法
  } else if (image) {
    contentType = 'IMAGESPAN_MSG'
    content = await buildImageEnvelope(image)
  } else if (file) {
    contentType = 'FILE_MSG'
    content = await buildFileEnvelope(file)
  } else {
    throw new Error('one of --text / --image / --file is required')
  }
  const msg = await addMessage({ groupId, sender, contentType, content })
  ok({ msgId: msg.msgId }) // sim 扩展:返回新 msgId(真实 send respData 未文档化)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] !== 'im') return fail(`unknown command "${argv[0] ?? ''}" (expected "im")`)
  const sub = argv[1]
  const flags = parseFlags(argv.slice(2))
  try {
    if (sub === 'query-history-message') return await runQuery(flags)
    if (sub === 'send-to-group') return await runSend(flags)
    return fail(`unknown im subcommand "${sub ?? ''}"`)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

main()
