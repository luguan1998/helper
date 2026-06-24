// Renderer 端口 —— local-substitutable(Puppeteer / Gotenberg / 纯文本)。
// 两套适配器:PuppeteerRenderer(生产)/ FakeRenderer(测试),故为真接缝。

export interface Renderer {
  /** 把 Markdown 渲染成 PNG,返回本地文件路径。 */
  markdownToImage(markdown: string): Promise<string>
}
