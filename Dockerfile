# Stage 1: 构建 Vue 前端
FROM node:24-slim AS client-builder

WORKDIR /app/tutor/client
COPY tutor/client/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY tutor/client/ ./
RUN npm run build

# Stage 2: 安装 server 依赖（含 tsx 用于运行时）
FROM node:24-slim AS server-deps

WORKDIR /app/tutor/server
COPY tutor/server/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com

# Stage 3: 运行时镜像
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app

# VisualSolver Python 依赖 + 源码
COPY VisualSolver/requirements.docker.txt ./VisualSolver/requirements.docker.txt
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -r VisualSolver/requirements.docker.txt
COPY VisualSolver/ ./VisualSolver/
RUN touch ./VisualSolver/.env

# generate_doc_direct.py
COPY generate_doc_direct.py ./

# Tutor server
COPY --from=server-deps /app/tutor/server/node_modules ./tutor/server/node_modules
COPY tutor/server/ ./tutor/server/

# Tutor client 构建产物
COPY --from=client-builder /app/tutor/client/dist ./tutor/client/dist

# Tutor static
COPY tutor/static ./tutor/static

RUN mkdir -p resources/uploads tutor/mistakes

EXPOSE 7896
CMD ["npx", "tsx", "tutor/server/src/index.ts"]
