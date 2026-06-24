// isMarkdown / markdownOutputPolicy 单测。
import { describe, it, expect } from 'vitest'
import { isMarkdown, markdownOutputPolicy } from '../src/output-policy.js'

describe('isMarkdown', () => {
  it('纯文本 → false', () => {
    expect(isMarkdown('你好,这是纯文本回复。')).toBe(false)
    expect(isMarkdown('ok')).toBe(false)
  })

  it('标题 → true', () => {
    expect(isMarkdown('# 标题\n正文')).toBe(true)
    expect(isMarkdown('## 二级标题')).toBe(true)
  })

  it('代码块 → true', () => {
    expect(isMarkdown('说明\n\n```js\nconst x=1\n```')).toBe(true)
  })

  it('表格 → true', () => {
    expect(isMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(true)
  })

  it('列表 → true', () => {
    expect(isMarkdown('- 项目一\n- 项目二')).toBe(true)
    expect(isMarkdown('1. 第一步\n2. 第二步')).toBe(true)
  })

  it('粗体 → true', () => {
    expect(isMarkdown('这是 **重点** 内容')).toBe(true)
  })

  it('引用 → true', () => {
    expect(isMarkdown('> 引用一段')).toBe(true)
  })
})

describe('markdownOutputPolicy', () => {
  it('Markdown → picture', () => {
    expect(markdownOutputPolicy('# 标题')).toBe('picture')
    expect(markdownOutputPolicy('```code```')).toBe('picture')
  })
  it('纯文本 → text', () => {
    expect(markdownOutputPolicy('好的,这就为您处理')).toBe('text')
  })
  it('空串 → text', () => {
    expect(markdownOutputPolicy('')).toBe('text')
  })
})
