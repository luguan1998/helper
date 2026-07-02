// sim/verify-card-ref.mjs — 注入一条 CARD_MSG(preMsg 为 FILE_MSG 信封)到 sim state,供 bot 拉取处理。
// 验证"卡片式引用文件 + text"工作流:bot 应下载被引用文件 → 预处理 → 发 ✅ 摘要 → 基于产物回答。
//
// 用法:node sim/verify-card-ref.mjs <本地文件路径> [回复文字] [发送者]
//   默认发送者 user01——须与先在 GUI 里 @bot 开启会话的发送者一致(活跃用户才进 handle)。
// 前置:终端 A `npm run sim:gui`、终端 B `BOT_DEBUG=1 npm run sim:bot`;
//      在 GUI 用同发送者 @bot 开启会话(收到 ack 后),再跑本脚本。
import { basename } from 'node:path'
import { addMessage, buildFileEnvelope } from './store.mjs'

const [,, filePath, replyText = '请分析这个文件', sender = 'user01'] = process.argv
if (!filePath) {
  console.error('用法: node sim/verify-card-ref.mjs <本地文件路径> [回复文字] [发送者]')
  console.error('前置:先在 GUI 用同发送者 @bot 开启会话(活跃用户才进 handle)。')
  process.exit(1)
}

const gid = process.env.SIM_GROUP_ID ?? '100001'
const fileName = basename(filePath)
// /:um_begin{url|File|size|fileName|0|meta}/:um_end —— preMsg.content 自带完整信封,bot 不查被引用消息
const fileEnv = await buildFileEnvelope(filePath)

// CARD_MSG:preMsg.content = 文件信封(type 段=File),replyMsg.content = 用户文字问题
const cardContent = JSON.stringify({
  cardContext: {
    preMsg: { messageID: '0', nameEN: 'Test', nameZH: '测试', sender, type: 4, content: fileEnv },
    replyMsg: { content: replyText, type: 0 },
  },
  cardType: 65,
  isShowSource: 0,
})
const cardMsg = await addMessage({ groupId: gid, sender, contentType: 'CARD_MSG', content: cardContent })
console.log(`✓ 注入 CARD_MSG msgId=${cardMsg.msgId} (sender=${sender}, 引用文件 ${fileName})`)
console.log(`  期望:BOT_DEBUG 日志见 recv content=[引用文件: ${fileName}] fileUrl=http://localhost:3000/file?...;`)
console.log(`        workspace/.../downloads/${fileName} 落地;群里发 ✅ 【file】预处理完成;text 基于产物回答。`)
