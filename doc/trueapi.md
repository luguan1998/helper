这是内部cli实际接口cli 命令 如何设计远程agent连接操作 实现内部cli对话栏能操作claude code
# 接受命令从群组
welink-cli im query-history-message --group-id "979824523237052806" --query-count 20

# 发送消息给群组
welink-cli im send-to-group --group-id "979824523237052806" --text "Group message"

# 发送图片给群组
welink-cli im send-to-group --group-id "979824523237052806" --image "./photo.png"

# 发送文件给群组
welink-cli im send-to-group --group-id "979824523237052806" --file "./document.pdf"

```bash
PS E:\skill\helper-master> welink-cli im send-to-group --group-id "979824523237052806" --image "./aaa.png"
Getting user info...
Uploading file...
Creating share link...
Sending message...
{
  "respData": {
    "msgIds": [
      89135802280760068
    ],
    "serverSendTime": 1782716045615
  },
  "resultCode": "0",
  "resultContext": "Operate Success",
  "sno": null
}
PS E:\skill\helper-master> welink-cli im send-to-group --group-id "979824523237052806" --file "./CLAUDE.md"
Getting user info...
Uploading file...
Creating share link...
Sending message...
{
  "respData": {
    "msgIds": [
      89135803457442313
    ],
    "serverSendTime": 1782716069149
  },
  "resultCode": "0",
  "resultContext": "Operate Success",
  "sno": null
}
PS E:\skill\helper-master> welink-cli im send-to-group --group-id "979824523237052806" --text "Group message"
{
  "respData": {
    "msgIds": [
      89135807002479166
    ],
    "serverSendTime": 1782716140049
  },
  "resultCode": "0",
  "resultContext": "Operate Success",
  "sno": null
}
```

本文档完整记录 `welink-cli` 各命令的 stdout JSON 返回格式，独立于任何 bot 实现。
所有示例中的账号、ID 等均已脱敏处理。

---

## 1. im query-history-message通用响应结构

所有命令的 stdout 输出均为此 JSON 结构：

```json
{
  "resultCode":    "0",
  "resultContext": "Operate Success",
  "respData":      {},
  "sno":           null
}
```

### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `resultCode` | `string` | 结果码。`"0"` 表示成功，非零值表示失败 |
| `resultContext` | `string` | 结果描述文本 |
| `respData` | `object \| null` | 业务数据体。失败时为 `null` |
| `sno` | `string \| null` | 请求序列号，通常为 `null` |

---

## 2. im query-history-message

### 命令

```bash
# 查询群聊历史消息
welink-cli im query-history-message --group-id "123456789012345678" --query-count 20

# 分页查询（指定起始消息和方向）
welink-cli im query-history-message --group-id "123456789012345678" --query-count 20 --message-id 89117689482073165 --query-direction 0
```

### 完整响应

```json
{
  "resultCode": "0",
  "resultContext": "Operate Success",
  "respData": {
    "chatInfo": [
      {
        "at": false,
        "atAccountList": [],
        "content": "消息内容字符串",
        "contentType": "TEXT_MSG",
        "groupId": 123456789012345678,
        "groupType": 0,
        "msgId": 89117689482073165,
        "receiver": "",
        "sender": "a0012345",
        "serverSendTime": 1782353789641
      }
    ],
    "maxMsgId": 89117689482073165,
    "minMsgId": 89114357856397910,
    "msgTotalCount": 20
  },
  "sno": null
}
```

### 2.1 respData 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `chatInfo` | `object[]` | 消息列表，按时间倒序（新→旧） |
| `maxMsgId` | `number` | 本次返回的最大 `msgId`（即最新的消息 ID） |
| `minMsgId` | `number` | 本次返回的最小 `msgId`（即最旧的消息 ID） |
| `msgTotalCount` | `number` | 本次实际返回的消息条数 |

### 2.2 chatInfo[] 元素字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `msgId` | `number` | 消息唯一 ID，严格递增 |
| `contentType` | `string` | 消息类型枚举（见 §2.3） |
| `content` | `string` | 消息正文（格式随 contentType 变化，见 §2.4） |
| `sender` | `string` | 发送者的 w3 账号 |
| `groupId` | `number` | 群组 ID |
| `groupType` | `number` | 群组类型（0=普通群） |
| `serverSendTime` | `number` | 服务端时间戳（毫秒，13 位 Unix 时间戳） |
| `at` | `boolean` | 当前登录用户是否被 @ |
| `atAccountList` | `string[]` | 被 @ 的所有用户 w3 账号列表 |
| `receiver` | `string` | 私聊时为对方账号；群聊时为空字符串 `""` |

### 2.3 contentType 枚举

| 枚举值 | 说明 |
|--------|------|
| `TEXT_MSG` | 纯文本消息 |
| `IMAGESPAN_MSG` | 图片消息（可能附带文字描述） |
| `FILE_MSG` | 文件消息 |
| `CARD_MSG` | 卡片消息（回复引用、合并转发等） |

### 2.4 content 格式详解

#### TEXT_MSG

`content` 即为纯文本字符串，无嵌套格式：

```json
{ "content": "你好，今天天气不错" }
```

#### IMAGESPAN_MSG

`content` 使用 `/:um_begin{...}/:um_end` 格式包裹图片信息：

```json
{
  "content": "/:um_begin{https://clouddrive.huawei.com/f/a1b2c3d4e5f6|Img|180302|7943D710-757C-4AA0-CACD-C712E72DEF56.png|2068;303|c301c68d9055d3146c07|isOriginalImg: 0;md5:656035eeda36fca5a287b743df684173;isCrossInstance:0;emotionId:;objectId:;cdnUrl:}/:um_end附带文字描述"
}
```

**格式规约：**
```
/:um_begin{<URL>|<type>|<size>|<fileName>|<dimension>|<metadata>}/:um_end[caption]
```

管道符分隔的字段详解：

| 段索引 | 含义 | 示例 |
|--------|------|------|
| 0 | 图片 CDN 下载 URL | `https://clouddrive.huawei.com/f/a1b2c3d4e5f6` |
| 1 | 固定标识 `Img` | `Img` |
| 2 | 文件大小（字节） | `180302` |
| 3 | 文件名 | `7943D710-757C-4AA0-CACD-C712E72DEF56.png` |
| 4 | 图片像素尺寸 `{宽};{高}` | `2068;303` |
| 5+ | 元数据段，分号分隔的 `key:value`（见下方） | `isOriginalImg: 0;md5:...` |

`/:um_end` 之后可跟随纯文本，作为图片的描述文字（caption）。

**metadata 常见键值对：**

| 键 | 值类型 | 说明 |
|----|--------|------|
| `isOriginalImg` | `0` \| `1` | 是否原图 |
| `md5` | 32 位十六进制 | 文件的 MD5 哈希 |
| `isCrossInstance` | `0` \| `1` | 是否跨实例 |
| `emotionId` | string | 表情 ID（无表情时为空） |
| `objectId` | string | 对象 ID（通常为空） |
| `cdnUrl` | URL | CDN 地址 |

> 注意：各字段间的分隔可能有 `;`（与 metadata 内的键值对共用分隔符），所以 metadata 分段位置不固定，需从尾部向前解析。

#### FILE_MSG

```json
{
  "content": "/:um_begin{https://xxx.com/f/4d621b4befb79b885cb4ecf1477fc6a4|File|196|.gitignore|0|;;7638239c410a5399af4e|isOriginalImg: 0;md5:2145690d20ea94280a32bf5d5116f566;isCrossInstance:0;emotionId:;objectId:;cdnUrl:}/:um_end"
}
```

管道符分隔的字段：

| 段索引 | 含义 | 示例 |
|--------|------|------|
| 0 | 文件下载 URL | `https://xxx.com/f/4d621b4befb79b885cb4ecf1477fc6a4` |
| 1 | 固定标识 `File` | `File` |
| 2 | 文件大小（字节） | `196` |
| 3 | 文件名 | `.gitignore` |
| 4 | 未知（通常为 `0`） | `0` |
| 5+ | 元数据段（同 IMAGESPAN_MSG） | `;;7638239c410a5399af4e\|isOriginalImg: 0;...` |

> `File` 与 `Img` 的区别：第 4 段在 `Img` 中是 `宽;高`，在 `File` 中是 `0`（或其他值）。

#### CARD_MSG

`content` 是一个 **JSON 字符串**（被序列化过一次），需先 `JSON.parse()` 才能读取内部字段：

```json
{
  "content": "{\"cardContext\":{\"preMsg\":{\"messageID\":\"89117688115542961\",\"nameEN\":\"LuGuan\",\"nameZH\":\"鲁冠\",\"sender\":\"a0012345\",\"type\":4,\"content\":\"/:um_begin{...}/:um_end\"},\"replyMsg\":{\"content\":\"回复的文字\",\"type\":0,\"PcContent\":\"<FONT style=\\\"...\\\">回复的文字</FONT>\"}},\"cardType\":65,\"isShowSource\":0}"
}
```

解析后结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cardContext.preMsg` | `object` | 被引用的原始消息 |
| `cardContext.preMsg.messageID` | `string` | 原始消息的 `msgId` |
| `cardContext.preMsg.nameEN` | `string` | 原始发送者英文名 |
| `cardContext.preMsg.nameZH` | `string` | 原始发送者中文名 |
| `cardContext.preMsg.sender` | `string` | 原始发送者 w3 账号 |
| `cardContext.preMsg.type` | `number` | 原始消息类型（4=文件, 0=文本） |
| `cardContext.preMsg.content` | `string` | 原始消息的 `content` 原文 |
| `cardContext.replyMsg` | `object` | 回复/引用的消息 |
| `cardContext.replyMsg.content` | `string` | 回复的文字内容 |
| `cardContext.replyMsg.type` | `number` | 回复文字类型（0=纯文本） |
| `cardContext.replyMsg.PcContent` | `string` | PC 端的 HTML 渲染内容 |
| `cardType` | `number` | 卡片类型（65=回复引用卡片） |
| `isShowSource` | `number` | 是否显示来源（0/1） |

---