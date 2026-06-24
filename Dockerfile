# 客服助手运行镜像:Node 20 + 系统 Chromium(puppeteer-core,无 Chromium 下载)。
# 需在容器内提供:link CLI(内部通讯软件)、claude CLI(@anthropic-ai/claude-code)。

FROM node:20-slim

# Chromium + emoji 字体(Puppeteer 截图用)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Claude CLI(全局)
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# 先装依赖(利用层缓存)
COPY package.json package-lock.json ./
RUN npm ci

# 编译 TS → dist
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 裁掉 devDeps(运行编译后的 JS 不需要 tsx/vitest/typescript)
RUN npm prune --omit=dev

# 注意:link CLI 为内部通讯软件,需自行挂载/安装到容器 PATH。
CMD ["node", "dist/index.js"]
