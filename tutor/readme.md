# AI 作业辅导 (Tutor)

基于 BGE-M3 语义检索 + LLM 启发式引导的交互式解题辅导系统。

## 功能

### 题目解答
- 输入/粘贴题目文字或拍照识别（OCR），语义检索匹配题库
- AI 以启发式引导方式与学生多轮对话，逐步讲解解题思路
- 对话中适时展示分步骤图示（scene1~sceneN）
- **语音朗读**：每条 AI 回复旁有播放按钮，可听 AI 讲解；支持自动朗读模式
- **语音输入**：点击麦克风按钮录音，自动识别为文字填入输入框
- 支持 MathJax 公式渲染，流式打字效果

### 题目批改
- 输入题目 + 学生解答，AI 逐步批改并给出评分与改进建议
- 支持拍照识别解题过程（OCR）

### 出题练习
- 按知识点搜索相似题目
- 按当前题目的向量相似度推荐相关练习
- **准备讲解材料**：对任意题目用 AI 生成图文讲解（VisualSolver），异步后台生成，前端轮询进度

### 错题本
- 一键收藏错题，按用户隔离
- AI 深度分析错因、知识漏洞与针对性建议
- 可从错题直接跳转到讲题模式
- 支持继续生成讲解材料

### 用户系统
- 注册/登录，基于 session token 认证
- 错题本和会话数据按用户隔离
- 用户 Profile（昵称、年级、学习目标、偏好风格）
  - 四种教学风格：详细讲解 / 简洁直接 / 苏格拉底式提问 / 鼓励引导
  - Profile 信息自动融入讲题 prompt，个性化指导

## 项目结构

```
tutor2/
├── Dockerfile                          # 多阶段构建镜像（Node 编译 + Python 运行时）
├── docker-compose.yml                  # 容器编排与数据卷挂载
├── .dockerignore
├── generate_doc_direct.py              # 直接调用 VisualSolver 生成讲解
├── VisualSolver/                       # HTML 讲解生成引擎（独立 pip 包）
│   ├── pyproject.toml                  # 包声明，支持 pip install -e
│   ├── visual_solver/                  # Python 包
│   │   ├── __init__.py                 # 导出 ExplanationGenerator
│   │   ├── generate_explanation.py
│   │   ├── src/                        # core, config, rag, utils
│   │   ├── mllm_tools/                 # LLM 调用封装
│   │   └── task_generator/             # prompt 模板
│   ├── mcp_server.py
│   └── ...
├── resources/
│   ├── database.json                   # 题库（2230+ 条）
│   ├── exp_gemini-3-pro-preview/       # 预生成讲解文件
│   ├── my_experiment/                  # 用户自定义生成的讲解
│   └── uploads/                        # OCR 上传图片
└── tutor/
    ├── src/server.ts                   # TypeScript 源码（Express 后端 + 内嵌前端）
    ├── dist/server.js                  # 编译产物
    ├── embeddings.json                 # 题目向量索引（BGE-M3，1024 维）
    ├── static/                         # 静态资源
    ├── users.json                      # 用户数据
    ├── sessions.json                   # 登录会话
    ├── mistakes/                       # 错题本（按用户分文件）
    ├── package.json
    └── tsconfig.json
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 24 + Express 5 + TypeScript 6 |
| LLM 调用 | OpenAI SDK（流式 SSE） |
| 讲解生成 | Python 3.13 + LiteLLM + Pillow（pip install -e VisualSolver） |
| 前端 | 内嵌单页应用（MathJax 3，纯 CSS，无框架） |
| 数据存储 | 文件 JSON（无需数据库） |
| 容器化 | Docker 多阶段构建 + OrbStack |

## 配置

在项目根目录 `.env` 中配置：

```env
# LLM API（OpenAI 兼容接口）
API_URL=https://your-api-endpoint/v1
API_KEY=your-api-key
MODEL=Kimi-K25

# 服务端口
TUTOR_PORT=7896

# OCR 识别
OCR_URL=https://your-ocr-endpoint/v1
OCR_KEY=your-key

# ASR 语音识别
ASR_URL=https://your-asr-endpoint
ASR_KEY=your-key

# TTS 语音合成
TTS_URL=https://your-tts-endpoint
TTS_KEY=your-key

# BGE-M3 Embedding API（GPU 服务）
EMBED_URL=https://your-embed-endpoint/v1
EMBED_KEY=your-key
EMBED_MODEL=/path/to/bge-m3
```

在 `VisualSolver/.env` 中配置讲解生成：

```env
CUSTOM_API_BASE=https://your-api-endpoint/v1
CUSTOM_API_KEY=your-api-key
VISUAL_SOLVER_MODEL=Kimi-K25   # 生成讲解使用的模型
```

## 外部服务依赖

| 服务 | 用途 | 接口 |
|------|------|------|
| LLM API | 对话、批改、错题分析 | OpenAI 兼容 `/v1/chat/completions` |
| BGE-M3 Embedding | 题目语义检索 | OpenAI 兼容 `/v1/embeddings`（GPU 服务） |
| OCR | 拍照识别题目/解题过程 | GLM-OCR |
| ASR | 学生语音输入转文字 | `POST /transcribe` |
| TTS | AI 讲解语音朗读 | `POST /tts/zero_shot` |

## 安装与启动

### 本地开发

```bash
# 1. 安装 Node 依赖
cd tutor && npm install

# 2. 安装 Python 依赖（VisualSolver 讲解生成）
python3 -m venv .venv
.venv/bin/pip install -e VisualSolver

# 3. 构建向量索引（首次，或题库更新后）
python3 /tmp/build_embeddings.py   # 见下方说明

# 4. 启动（开发模式，ts-node 直接运行源码，无需编译）
npm run dev

# 或编译后启动
npm run build && npm start
```

### 向量索引构建

题库更新后需重建 `tutor/embeddings.json`：

```python
# build_embeddings.py 示例（调用 GPU Embedding API）
import json, urllib.request, ssl

DB_PATH = "resources/database.json"
EMBED_PATH = "tutor/embeddings.json"
EMBED_URL = "https://your-embed-endpoint/v1/embeddings"
EMBED_KEY = "your-key"
EMBED_MODEL = "/path/to/bge-m3"
BATCH_SIZE = 32

# ... 批量调用 API，写入 embeddings.json
```

### Docker 部署

#### 构建与启动

```bash
# 构建镜像
docker compose build

# 启动
docker compose up -d

# 查看日志
docker compose logs -f

# 更新部署
docker compose build && docker compose up -d
```

#### 数据卷说明

`docker-compose.yml` 已配置以下挂载，容器重启数据不丢失：

| 宿主机路径 | 容器路径 | 说明 |
|------------|----------|------|
| `./resources` | `/app/resources` | 题库、讲解文件、上传图片 |
| `./VisualSolver/.env` | `/app/VisualSolver/.env` | VisualSolver API 配置（只读） |
| `./tutor/embeddings.json` | `/app/tutor/embeddings.json` | 题目向量索引 |
| `./tutor/users.json` | `/app/tutor/users.json` | 用户数据 |
| `./tutor/sessions.json` | `/app/tutor/sessions.json` | 登录会话 |
| `./tutor/mistakes` | `/app/tutor/mistakes` | 错题本（按用户分文件） |

#### 首次部署前准备

确保宿主机目录结构如下：

```
/path/to/tutor2/
├── .env
├── VisualSolver/.env
├── resources/
│   ├── database.json
│   ├── exp_gemini-3-pro-preview/
│   └── uploads/
└── tutor/
    ├── embeddings.json
    ├── users.json
    ├── sessions.json
    └── mistakes/
```

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/login` | - | 登录 |
| POST | `/api/register` | - | 注册 |
| POST | `/api/logout` | - | 登出 |
| GET | `/api/me` | - | 验证 session |
| GET | `/api/profile` | token | 获取用户 Profile |
| PUT | `/api/profile` | token | 更新用户 Profile |
| POST | `/api/ocr` | - | 图片 OCR 识别 |
| POST | `/api/tts` | - | 文字转语音 |
| GET | `/api/tts-stream/:sid` | - | 轮询 TTS 合成进度 |
| GET | `/api/tts-cache/:id` | - | 获取缓存的 TTS 音频 |
| POST | `/api/asr` | - | 语音转文字 |
| POST | `/api/search` | - | 语义检索题目 |
| POST | `/api/chat` | - | 流式对话（SSE） |
| POST | `/api/load` | - | 按 index 加载题目 |
| POST | `/api/similar` | - | 相似题目推荐 |
| GET | `/api/subjects` | - | 列出所有科目与知识点 |
| POST | `/api/grade` | - | 流式批改（SSE） |
| POST | `/api/generate-doc` | token | 启动讲解材料生成（返回 taskId） |
| GET | `/api/generate-doc/status/:taskId` | token | 轮询生成进度 |
| POST | `/api/mistakes` | token | 加入错题本 |
| GET | `/api/mistakes` | token | 获取错题列表 |
| DELETE | `/api/mistakes/:id` | token | 删除错题 |
| POST | `/api/mistakes/analyze` | token | 流式错题分析（SSE） |
| GET | `/doc/:index/:file` | - | 访问生成的讲解文档 |

## 检索原理

1. 启动时加载 `embeddings.json`（所有题目的 BGE-M3 向量，1024 维）
2. 用户输入题目后，调用 GPU Embedding API 计算查询向量
3. 与所有题目向量做余弦相似度，>= 0.6 视为匹配成功

## 讲解材料生成原理

1. 前端 POST `/api/generate-doc`，立即返回 `taskId`
2. 后端 spawn Python 子进程，调用 `generate_doc_direct.py`
3. `generate_doc_direct.py` 调用 `visual_solver.ExplanationGenerator`（pip install -e 安装），通过 LLM 生成多场景 HTML 讲解
4. 前端每 3 秒轮询 `/api/generate-doc/status/:taskId`
5. 生成完成后（约 10-20 分钟），前端显示完成并可进入讲题模式
6. 生成文件保存在 `resources/my_experiment/<topic>/`
7. 新题目自动加入题库并计算向量写入 `embeddings.json`

## 语音功能

### TTS 朗读
- AI 回复完成后自动添加「播放」按钮
- 支持自动朗读模式

### ASR 语音输入
- 输入栏麦克风按钮，点击开始/停止录音
- 自动转写文字填入输入框
