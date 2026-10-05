# LX Music Docker · 洛雪音乐 Docker 版构建文件
# 飞牛 OS / Debian amd64 兼容
FROM node:20-bookworm-slim AS builder

WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai

# 运行时仅需要：ca-certificates（用于 HTTPS 音源请求）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata tini \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 复制 node_modules + 源码
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# 内置音源脚本（只读，挂载到 /app/builtin-sources/）
COPY builtin-sources ./builtin-sources
# 官方脚本（lyswhut/lx-music-source dist，只读）
COPY official-sources ./official-sources
# 用户提供给 script/ 目录的音源（启动时自动拷贝到 /app/data/sources 作为用户音源）
COPY script ./script

# 数据目录（音源、下载、数据库）挂载点
RUN mkdir -p /app/data/sources /app/data/music && chown -R node:node /app
USER node

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/server.js"]
