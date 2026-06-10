# 教师备课助手

输入题目，AI 生成交互式步骤图示，教师可在线预览、修改图示、保存题库。支持多用户登录注册。

## 技术栈

- **前端**: Vue 3 + TypeScript + Vite
- **后端**: Express + TypeScript (tsx)
- **认证**: JWT（bcryptjs 密码哈希，30天有效）
- **Python 桥接**: 通过子进程调用 `ExplanationGenerator` 生成图示

## 环境变量配置

所有配置通过项目根目录的 `.env` 文件管理（与 `teacher_app/` 同级）。参考 `.env.template` 创建：

```bash
cp .env.template .env
vim .env
```

### 核心配置（必须）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_PORT` | `8765` | 服务监听端口 |
| `OAH_API_URL` | - | Open Agent Harness 服务地址，如 `http://host.docker.internal:8787`。Docker 部署时使用 `host.docker.internal` 访问宿主机服务 |

> 图示生成和修改均通过 OAH 服务完成，无需单独配置 LLM API 密钥。

### 直接 LLM 调用（仅不使用 OAH 时需要）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CUSTOM_API_BASE` | - | LLM API 地址（OpenAI 兼容格式），如 `http://localhost:8000/v1` |
| `CUSTOM_API_KEY` | - | LLM API 密钥 |
| `TEACHER_MODEL` | `qwen3.5-397b` | 生成图示使用的模型，支持多模型格式：`{{model1:标签1},{model2:标签2}}`，前端会显示为下拉选择 |
| `TEACHER_MODEL_DEFAULT` | 第一个模型 | 默认选中的模型 |

### OCR / TTS / ASR 配置（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OCR_URL` | - | OCR 服务地址 |
| `OCR_KEY` | - | OCR 服务密钥 |
| `OCR_MODE` | `openai` | OCR 模式：`openai` = 调用 `{OCR_URL}/chat/completions`（OpenAI 兼容格式）；`native` = POST `image_base64` 到 `OCR_URL` |


### 其他配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `JWT_SECRET` | `teacher-app-secret-2024` | JWT 签名密钥，**生产环境务必修改** |
| `MAX_CONCURRENT_JOBS` | `20` | 最大并发 worker 数 |
| `PYTHON` | `.venv/bin/python` | Python 解释器路径（Docker 内自动设为 `/usr/bin/python3`） |
| `LITELLM_SKIP_MODEL_VALIDATION` | - | 设为 `True` 跳过 LiteLLM 模型名验证 |

## 部署方式

### 方式一：Docker 部署（推荐）

#### 1. 拉取代码

```bash
# 克隆主仓库（EduIllustrate-teacher 分支）
git clone -b EduIllustrate-teacher https://github.com/bisz9918-maker/tutor.git EduIllustrate-teacher
cd EduIllustrate-teacher

# 克隆 VisualSolver 包（visual-solver-package 分支）并改名为 VisualSolver
git clone -b visual-solver-package https://github.com/bisz9918-maker/tutor.git VisualSolver
```

#### 2. 配置与启动

```bash
# 1. 配置 .env
cp .env.template .env
vim .env   # 至少配置 OAH_API_URL

# 2. 构建并启动
docker compose -f deploy/docker-compose.prod.yml up -d --build

# 3. 查看日志
docker compose -f deploy/docker-compose.prod.yml logs -f teacher-app

# 4. 重启（修改 .env 后）
docker compose -f deploy/docker-compose.prod.yml restart
```

浏览器访问 `http://<IP>:8765`

Docker 容器通过 bind mount 挂载：
- `.env` → 只读挂载，修改后重启生效
- `teacher_app/data/` → 用户数据持久化
- `output/` → 生成的图示文件持久化

### 方式二：本地开发

```bash
# 1. 前置依赖：Node.js 22+, Python 3.11+

# 2. 拉取代码
git clone -b EduIllustrate-teacher https://github.com/bisz9918-maker/tutor.git EduIllustrate-teacher
cd EduIllustrate-teacher
git clone -b visual-solver-package https://github.com/bisz9918-maker/tutor.git VisualSolver

# 3. 安装 VisualSolver Python 包
cd VisualSolver && pip install -e . && cd ..

# 4. 配置 .env
cp .env.template .env
vim .env   # 至少配置 OAH_API_URL

# 5. 安装前端依赖并启动
cd teacher_app
npm install

# 开发模式 (Vite HMR + Express 后端)
npm run dev

# 生产模式
npm run build
npm start

# 后台部署
nohup npm start > /tmp/teacher_app.log 2>&1 &

# 停止后台服务
pkill -f "tsx src/server/index.ts"
```

开发模式下 Vite 前端端口由 `.env` 中 `VITE_PORT` 控制（默认 `5175`），后端端口由 `SERVER_PORT` 控制（默认 `8765`）。

## 默认账号

首次使用需要注册。开发时可通过 API 注册测试账号：

```bash
curl -X POST http://localhost:8765/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"test","password":"test"}'
```

## 功能

- **用户系统**：登录/注册，每用户独立题库，JWT 认证
- **生成图示**：输入题目文字或粘贴/拍照识别题目图片，AI 规划大纲并逐步生成交互式 HTML 场景
- **进度显示**：Header 进度条实时反映生成阶段，每个 Scene 完成即刻展示；超过并发上限时显示排队位置
- **修改图示**：右下角输入框输入修改需求，点击"修改 Scene N"重新生成当前场景
- **下载图示**：Scene 右上角下载按钮，保存当前 HTML 到本地
- **题库管理**：保存题目到题库（生成中也可保存），题库列表显示完成状态，支持恢复、继续生成、删除

## 目录结构

```
src/
  server/
    index.ts              Express 入口，监听端口，启动时迁移旧数据库
    middleware/
      auth.ts             JWT requireAuth 中间件
    routes/
      auth.ts             POST /api/auth/login, /register; GET /api/auth/me
      generate.ts         生成任务队列（并发控制 + Job 30分钟自动清理）
      bank.ts             题库 CRUD，按用户隔离
      doc.ts              静态 HTML 图示文件服务
      ocr.ts              图片 OCR
      chat.ts             流式对话
      proxy.ts            模型反向代理
  bridge/
    worker.py             Python 桥接，读取 stdin JSON 命令，
                          调用 ExplanationGenerator，输出 JSON 事件流
  client/
    App.vue               主布局，登录守卫，Header 用户名+退出
    components/
      LoginPage.vue       登录/注册页
      ProblemInput.vue    题目输入区（文字/图片/OCR，支持继续生成按钮）
      SceneViewer.vue     Scene 展示 iframe + 下载按钮
      AnalysisPanel.vue   解析文字面板（Markdown + MathJax）
      BottomBar.vue       右下角修改图示输入框
      QuestionBank.vue    题库弹窗（完成状态/恢复/继续生成/删除）
    composables/
      useAuth.ts          login/register/logout/initAuth + currentUser
      useGenerate.ts      生成状态管理（startGenerate/continueGenerate/modifyScene）
      useRecorder.ts      语音录入
      useTTS.ts           文字朗读
    utils/
      api.ts              apiUrl() + apiFetch()（自动注入 Authorization header）
data/
  users.json              用户列表（bcrypt 密码哈希）
  users/{username}/
    database.json         每用户独立题库
```

## API

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/auth/login` | POST | 否 | 登录，返回 JWT |
| `/api/auth/register` | POST | 否 | 注册，返回 JWT |
| `/api/auth/me` | GET | 否 | 验证 token |
| `/api/generate` | POST | 否 | 启动图示生成任务，返回 `job_id` |
| `/api/poll/:jobId` | GET | 否 | 轮询生成事件（progress/scene_ready/done/error） |
| `/api/modify_scene` | POST | ✓ | 修改指定 Scene |
| `/api/bank/save` | POST | ✓ | 保存题目到题库 |
| `/api/bank/list` | GET | ✓ | 获取题库列表（含完成状态） |
| `/api/bank/:id` | GET | ✓ | 获取单条题目（含 scenes/texts） |
| `/api/bank/:id` | DELETE | ✓ | 删除题目 |
| `/api/ocr` | POST | 否 | 图片 OCR 识别 |
| `/api/tts` | POST | 否 | 文字转语音 |
| `/api/asr` | POST | 否 | 语音转文字 |
| `/api/chat` | POST | 否 | 流式对话（SSE） |

## 事件协议（worker.py → generate.ts）

```jsonc
{"type": "progress", "message": "...", "percent": 5}
{"type": "scene_ready", "scene": 1, "url": "doc/output/teacher/..."}
{"type": "done", "scenes": [...], "texts": [...]}
{"type": "error", "message": "..."}
```

## 数据存储

- **用户**: `teacher_app/data/users.json`
- **题库**: `teacher_app/data/users/{username}/database.json`（原子写入 + 写锁）
- **图示输出**: `output/teacher/{topic}/scene{N}/code/{topic}_scene{N}_v{M}.html`
- **完成标记**: `output/teacher/{topic}/doc/solution.html` 存在即为已完成

## 故障排查

### Python worker 启动失败
```bash
# Docker 部署
docker compose -f deploy/docker-compose.prod.yml exec teacher-app bash
python3 -c "from visual_solver import ExplanationGenerator; print('OK')"
python3 -c "from oah_client import OAHClient; print('OK')"
```

### OAH 连接失败
```bash
# 从容器内测试连通性
docker compose -f deploy/docker-compose.prod.yml exec teacher-app \
  curl -s http://host.docker.internal:8787/api/v1/workspaces
```

### 前端白屏
```bash
docker compose -f deploy/docker-compose.prod.yml exec teacher-app \
  ls /app/teacher_app/dist/client/
```
