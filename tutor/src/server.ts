import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn, ChildProcess } from "child_process";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/static", express.static(path.resolve(__dirname, "../static")));

const RESOURCES = path.resolve(__dirname, "../../resources");
const BENCHMARK_PATH = path.join(RESOURCES, "database.json");
const CUSTOM_DB_PATH = path.join(RESOURCES, "custom_database.json");
const EXP_DIR = path.join(RESOURCES, "exp_gemini-3-pro-preview");
const MY_EXP_DIR = path.join(RESOURCES, "my_experiment");
const UPLOADS_DIR = path.join(RESOURCES, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const EMBEDDINGS_PATH = path.join(__dirname, "../embeddings.json");
const PYTHON = path.resolve(__dirname, "../../.venv/bin/python");
const MODEL_PATH = path.resolve(__dirname, "../bge-m3");
const USERS_PATH = path.join(__dirname, "../users.json");
const GENERATE_DOC_SCRIPT = path.resolve(__dirname, "../../generate_doc_direct.py");
const generatingTopics = new Set<string>();

interface GenTask {
  status: "running" | "done" | "error";
  msg: string;
  index?: number;
  scenes?: object[];
  problemImgUrl?: string | null;
  hasDoc?: boolean;
  question?: string;
}
const genTasks = new Map<string, GenTask>();
const SESSIONS_PATH = path.join(__dirname, "../sessions.json");
const ASR_URL = process.env.ASR_URL || "";
const ASR_KEY = process.env.ASR_KEY || process.env.API_KEY || "";
const TTS_URL = process.env.TTS_URL || "";
const TTS_KEY = process.env.TTS_KEY || process.env.API_KEY || "";

// ── OAH Workspace API ─────────────────────────────────────────────────────────
const OAH_API_URL = process.env.OAH_API_URL || "";
const OAH_WORKSPACE_TEMPLATE = process.env.OAH_WORKSPACE_TEMPLATE || "question-tutor";
const OAH_GRADER_TEMPLATE = process.env.OAH_GRADER_TEMPLATE || "question-grader";
const USERS_DIR = path.resolve(__dirname, "../users");

// 缓存: userId:index -> { workspaceId, sessionId, lastUsed }
const oahCache = new Map<string, { workspaceId: string; sessionId: string; lastUsed: number }>();
// 批改 workspace 待清理列表: workspaceId -> 创建时间
const graderWorkspaces = new Map<string, number>();
const GRADER_WS_TTL = 2 * 60 * 60 * 1000; // 2 小时
// 每 10 分钟清理超过 TTL 的缓存/workspace
setInterval(async () => {
  const now = Date.now();
  for (const [k, v] of oahCache) {
    if (now - v.lastUsed > 24 * 60 * 60 * 1000) {
      oahCache.delete(k);
      // 清理 OAH workspace
      try {
        await fetch(`${OAH_API_URL}/api/v1/workspaces/${v.workspaceId}`, { method: "DELETE" });
        console.log(`[OAH] 清理过期 workspace: ${v.workspaceId}`);
      } catch {}
    }
  }
  for (const [wsId, createdAt] of graderWorkspaces) {
    if (now - createdAt > GRADER_WS_TTL) {
      graderWorkspaces.delete(wsId);
      try {
        await fetch(`${OAH_API_URL}/api/v1/workspaces/${wsId}`, { method: "DELETE" });
        console.log(`[OAH] 清理过期批改 workspace: ${wsId}`);
      } catch {}
    }
  }
}, 10 * 60 * 1000);

// ── 用户 & Session ────────────────────────────────────────────────────────────

interface UserProfile {
  nickname?: string;
  grade?: string;                          // 学段: '小学'|'初中'|'高中'|'大学'|'教师'|'其他'
  favoriteSubjects?: string[];             // 最喜爱的学科
  selfLevel?: string;                      // 知识水平自评: '基础'|'中等'|'较强'|'优秀'
  guidingStyle?: string;                   // 指导风格: '详细讲解'|'简洁直接'|'苏格拉底式追问'|'鼓励式'
  guidingStyleDetail?: Record<string, string>; // 指导风格详细说明
  learningGoal?: string;                   // 学习目标，≤100字
}
interface UserRecord { uid: string; password_hash: string; created_at: string; }
type UsersDB = Record<string, UserRecord>;

function loadUsers(): UsersDB {
  if (!fs.existsSync(USERS_PATH)) return {};
  return JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
}
function saveUsers(db: UsersDB) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(db, null, 2), "utf-8");
}
function hashPassword(pwd: string): string {
  return crypto.createHash("sha256").update(pwd).digest("hex");
}

type SessionsDB = Record<string, { uid: string; createdAt: string }>;
function loadSessions(): SessionsDB {
  if (!fs.existsSync(SESSIONS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
}
function saveSessions(db: SessionsDB) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(db, null, 2), "utf-8");
}
function getUidFromReq(req: Request): string | null {
  const token = req.headers["x-session-token"] as string | undefined;
  if (!token) return null;
  const sessions = loadSessions();
  return sessions[token]?.uid ?? null;
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!getUidFromReq(req)) { res.status(401).json({ error: "未登录" }); return; }
  next();
}

// ── 用户数据目录 ─────────────────────────────────────────────────────────────

function ensureUserDir(uid: string): string {
  const dir = path.join(USERS_DIR, uid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const files: Record<string, string> = {
    "profile.json": "{}",
    "mistakes.json": "[]",
    "tutoring_history.jsonl": "",
    "grading_history.jsonl": "",
  };
  for (const [name, defaultContent] of Object.entries(files)) {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, defaultContent, "utf-8");
  }
  return dir;
}

function readUserProfile(uid: string): UserProfile {
  const fp = path.join(USERS_DIR, uid, "profile.json");
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { return {}; }
}

function appendTutoringHistory(uid: string, index: number, userMsg: string, assistantMsg: string) {
  const fp = path.join(USERS_DIR, uid, "tutoring_history.jsonl");
  const entry = { index, userMessage: userMsg, assistantMessage: assistantMsg, ts: new Date().toISOString() };
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}

// ── OAH Workspace 辅助函数 ────────────────────────────────────────────────────

async function uploadFileToWorkspace(workspaceId: string, filePath: string, workspacePath: string): Promise<void> {
  const fileBuf = fs.readFileSync(filePath);
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(workspacePath)}&overwrite=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fileBuf,
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[OAH] upload file failed: ${workspacePath}`, resp.status, text);
  }
}

async function uploadBufferToWorkspace(workspaceId: string, buf: Buffer, workspacePath: string): Promise<void> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(workspacePath)}&overwrite=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[OAH] upload buffer failed: ${workspacePath}`, resp.status, text);
  }
}

/** 通过 /files/content 的 JSON envelope 读取工作区文件文本内容 */
async function readWorkspaceFile(workspaceId: string, workspacePath: string): Promise<string> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(workspacePath)}`
  );
  if (!resp.ok) throw new Error(`read workspace file failed: ${resp.status}`);
  const data = await resp.json() as { content: string };
  return data.content;
}

/** 通过 /files/download 获取工作区文件的原始二进制内容 */
async function downloadWorkspaceFile(workspaceId: string, workspacePath: string): Promise<Buffer> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/download?path=${encodeURIComponent(workspacePath)}`
  );
  if (!resp.ok) throw new Error(`download workspace file failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// 登录
app.post("/api/login", (req: Request, res: Response) => {
  const { uid, password } = req.body as { uid: string; password: string };
  if (!uid || !password) { res.status(400).json({ error: "uid 和 password 不能为空" }); return; }
  const users = loadUsers();
  const user = users[uid];
  if (!user || user.password_hash !== hashPassword(password)) {
    res.status(401).json({ error: "用户名或密码错误" }); return;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = loadSessions();
  sessions[token] = { uid, createdAt: new Date().toISOString() };
  saveSessions(sessions);
  res.json({ ok: true, token, uid });
});

// 注册
app.post("/api/register", (req: Request, res: Response) => {
  const { uid, password } = req.body as { uid: string; password: string };
  if (!uid || !password) { res.status(400).json({ error: "uid 和 password 不能为空" }); return; }
  if (!/^[a-zA-Z0-9_-]{2,20}$/.test(uid)) {
    res.status(400).json({ error: "用户名只能含字母数字下划线横线，2-20位" }); return;
  }
  if (password.length < 6) { res.status(400).json({ error: "密码至少6位" }); return; }
  const users = loadUsers();
  if (users[uid]) { res.status(409).json({ error: "用户名已存在" }); return; }
  users[uid] = { uid, password_hash: hashPassword(password), created_at: new Date().toISOString() };
  saveUsers(users);
  // 自动登录
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = loadSessions();
  sessions[token] = { uid, createdAt: new Date().toISOString() };
  saveSessions(sessions);
  res.json({ ok: true, token, uid });
});

// 登出
app.post("/api/logout", (req: Request, res: Response) => {
  const token = req.headers["x-session-token"] as string | undefined;
  if (token) {
    const sessions = loadSessions();
    delete sessions[token];
    saveSessions(sessions);
  }
  res.json({ ok: true });
});

// 验证 session
app.get("/api/me", (req: Request, res: Response) => {
  const uid = getUidFromReq(req);
  if (!uid) { res.status(401).json({ error: "未登录" }); return; }
  res.json({ uid, profile: readUserProfile(uid) });
});

// 获取 profile
app.get("/api/profile", requireAuth, (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  res.json(readUserProfile(uid));
});

// 保存 profile
app.put("/api/profile", requireAuth, (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  const { nickname, grade, favoriteSubjects, selfLevel, guidingStyle, learningGoal } = req.body as UserProfile;
  const profile: UserProfile = {};
  if (nickname !== undefined) profile.nickname = String(nickname).slice(0, 30);
  if (grade !== undefined) profile.grade = String(grade);
  if (Array.isArray(favoriteSubjects)) profile.favoriteSubjects = favoriteSubjects.map(String).slice(0, 10);
  if (selfLevel !== undefined) profile.selfLevel = String(selfLevel);
  if (guidingStyle !== undefined) {
    profile.guidingStyle = String(guidingStyle);
    profile.guidingStyleDetail = GUIDING_STYLE_DETAILS[guidingStyle] ?? {};
  }
  if (learningGoal !== undefined) profile.learningGoal = String(learningGoal).slice(0, 100);
  ensureUserDir(uid);
  fs.writeFileSync(path.join(USERS_DIR, uid, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
  res.json({ ok: true, profile });
});

const client = new OpenAI({
  baseURL: process.env.API_URL || "https://api.openai.com/v1",
  apiKey: process.env.API_KEY || "",
});
const MODEL = process.env.MODEL || "gpt-4o";

const ocrClient = new OpenAI({
  baseURL: process.env.OCR_URL || "",
  apiKey: process.env.OCR_KEY || "",
});

// ── API: OCR 识别 ──────────────────────────────────────────────────────────────

app.post("/api/ocr", async (req: Request, res: Response) => {
  const { image, prompt = "Text Recognition:" } = req.body as {
    image: string;   // base64，不含 data:image 前缀
    prompt?: string;
  };
  if (!image) { res.status(400).json({ error: "image required" }); return; }
  try {
    // 保存图片到磁盘，供 MCP 使用
    const filename = `ocr_${Date.now()}.png`;
    const imagePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(imagePath, Buffer.from(image, "base64"));

    const resp = await ocrClient.chat.completions.create({
      model: "ocr2.0",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
          { type: "text", text: prompt },
        ] as any,
      }],
      max_tokens: 8192,
    });
    res.json({ text: resp.choices[0].message.content?.trim() ?? "", imagePath });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── TTS 工具函数 ──────────────────────────────────────────────────────────────

function cleanTTSText(text: string): string {
  return text
    .replace(/\[SHOW_SCENE\s+scene\d+\]/g, "")
    .replace(/\[SPOTLIGHT\s+[^\]]+\]/g, "")
    .replace(/\[LASER:[^\]]+\]/g, "")
    .replace(/\[scene\d+\]/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "公式")
    .replace(/\$[^$]+\$/g, (m) => {
      const inner = m.slice(1, -1).trim();
      return inner
        .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1分之$2")
        .replace(/\\sqrt\{([^}]*)\}/g, "$1的平方根")
        .replace(/\^2/g, "的平方")
        .replace(/\^3/g, "的立方")
        .replace(/=/g, "等于")
        .replace(/\\times/g, "乘以")
        .replace(/\\div/g, "除以")
        .replace(/\\pm/g, "加减")
        .replace(/[\\{}]/g, "");
    })
    .replace(/\*\*/g, "")
    .replace(/#{1,6}\s*/g, "")
    .trim();
}

async function synthesizeTTS(text: string): Promise<Buffer | null> {
  const clean = cleanTTSText(text);
  if (!clean || !TTS_URL) return null;
  try {
    const formData = new URLSearchParams();
    formData.append("text", clean);
    formData.append("prompt_text", "希望你以后能够做的比我还好呦");
    const resp = await fetch(`${TTS_URL}/tts/zero_shot`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TTS_KEY}` },
      body: formData,
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}

// 流式 TTS：调用 zero_shot_stream，返回 SSE 响应体作为 ReadableStream
async function synthesizeTTSStream(text: string): Promise<ReadableStream | null> {
  const clean = cleanTTSText(text);
  if (!clean || !TTS_URL) return null;
  try {
    const formData = new URLSearchParams();
    formData.append("text", clean);
    formData.append("prompt_text", "希望你以后能够做的比我还好呦");
    const resp = await fetch(`${TTS_URL}/tts/zero_shot_stream`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TTS_KEY}` },
      body: formData,
    });
    if (!resp.ok || !resp.body) return null;
    return resp.body;
  } catch { return null; }
}

// TTS 流式会话：存储每个 chat 会话的音频流
const ttsStreams = new Map<string, { streams: (ReadableStream | null)[]; currentIdx: number; done: boolean; ttsAllDone: boolean; ts: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsStreams) { if (now - v.ts > 10 * 60 * 1000) ttsStreams.delete(k); }
}, 60 * 1000);

// TTS 预合成会话：存储每个 chat 会话的音频 ID 列表
const ttsSessions = new Map<string, { audioIds: string[]; done: boolean; ttsAllDone: boolean; ts: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsSessions) { if (now - v.ts > 10 * 60 * 1000) ttsSessions.delete(k); }
}, 60 * 1000);

// 前端轮询获取音频 ID 列表
app.get("/api/tts-stream/:sid", (req: Request, res: Response) => {
  const sess = ttsSessions.get(req.params.sid as string);
  if (!sess) { res.json({ audioIds: [], done: true }); return; }
  res.json({ audioIds: sess.audioIds, done: sess.done, ttsAllDone: sess.ttsAllDone || false });
});
const ttsCache = new Map<string, { data: Buffer; ts: number }>();
let ttsCacheId = 0;
// 每 5 分钟清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsCache) { if (now - v.ts > 5 * 60 * 1000) ttsCache.delete(k); }
}, 60 * 1000);

app.get("/api/tts-cache/:id", (req: Request, res: Response) => {
  const item = ttsCache.get(req.params.id as string);
  if (!item) { res.status(404).send("not found"); return; }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-cache");
  res.send(item.data);
});

// 流式 TTS 端点：前端通过 SSE 接收音频数据
app.get("/api/tts-stream-direct/:sid", async (req: Request, res: Response) => {
  const sess = ttsStreams.get(req.params.sid as string);
  if (!sess) { res.status(404).json({ error: "session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // 逐个流式传输每段音频
  while (sess.currentIdx < sess.streams.length || !sess.ttsAllDone) {
    if (sess.currentIdx >= sess.streams.length) {
      // 等待新流到来
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    const stream = sess.streams[sess.currentIdx];
    if (!stream) {
      // 流还没就绪（占位 null），等待
      if (!sess.ttsAllDone) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      // ttsAllDone 且 stream 仍为 null → 合成失败，跳过
      sess.currentIdx++;
      res.write(`data: ${JSON.stringify({ error: "stream failed" })}\n\n`);
      continue;
    }
    sess.currentIdx++;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const lines = sseBuf.split("\n");
        sseBuf = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            // 透传 TTS API 的 SSE 事件到前端
            res.write(line + "\n\n");
          }
        }
      }
      // 处理剩余缓冲
      if (sseBuf.startsWith("data: ")) {
        res.write(sseBuf + "\n\n");
      }
      // 段结束标记
      res.write(`data: ${JSON.stringify({ chunkEnd: true })}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ error: "stream read failed" })}\n\n`);
    }
  }
  // 所有段完成
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

// ── API: TTS 语音合成（单次，保留兼容）─────────────────────────────────────────

app.post("/api/tts", async (req: Request, res: Response) => {
  const { text } = req.body as { text: string };
  if (!text || !TTS_URL) { res.status(400).json({ error: "text required or TTS not configured" }); return; }
  const buf = await synthesizeTTS(text);
  if (!buf) { res.status(502).json({ error: "TTS failed" }); return; }
  res.setHeader("Content-Type", "audio/wav");
  res.send(buf);
});

// 按需播放：触发流式 TTS 合成并注册到 ttsStreams
app.post("/api/tts-stream-start", async (req: Request, res: Response) => {
  const { text, sid } = req.body as { text: string; sid: string };
  if (!text || !TTS_URL) { res.status(400).json({ error: "text required or TTS not configured" }); return; }
  const clean = cleanTTSText(text);
  if (!clean) { res.status(400).json({ error: "text too short after cleaning" }); return; }

  // 创建流式会话
  const streamSession = { streams: [] as (ReadableStream | null)[], currentIdx: 0, done: false, ttsAllDone: false, ts: Date.now() };
  ttsStreams.set(sid, streamSession);

  // 异步启动流式合成
  synthesizeTTSStream(clean).then((stream) => {
    if (stream) {
      streamSession.streams.push(stream);
    } else {
      streamSession.streams.push(null as any);
    }
    streamSession.ttsAllDone = true;
    streamSession.done = true;
  }).catch(() => {
    streamSession.streams.push(null as any);
    streamSession.ttsAllDone = true;
    streamSession.done = true;
  });

  res.json({ ok: true, sid });
});

// ── API: ASR 语音识别 ─────────────────────────────────────────────────────────

// 将任意音频转为 16kHz mono WAV（ASR 服务要求）
function convertTo16kWav(inputBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const script = `
import sys, wave, array, struct, io

data = sys.stdin.buffer.read()

# 尝试按 WAV 解析
try:
    inp = wave.open(io.BytesIO(data), 'r')
    rate = inp.getframerate()
    channels = inp.getnchannels()
    sampwidth = inp.getsampwidth()
    frames = inp.readframes(inp.getnframes())
    inp.close()

    # 转为 16-bit samples
    if sampwidth == 1:
        samples = array.array('b', frames)
        samples = array.array('h', [s * 256 for s in samples])
    elif sampwidth == 2:
        samples = array.array('h', frames)
    elif sampwidth == 4:
        raw = array.array('i', frames)
        samples = array.array('h', [s >> 16 for s in raw])
    else:
        samples = array.array('h', frames[:len(frames)//2*2])

    # 转为单声道
    if channels > 1:
        mono = array.array('h', [samples[i] for i in range(0, len(samples), channels)])
        samples = mono

    # 重采样到 16000
    if rate != 16000 and rate > 0:
        ratio = rate / 16000
        new_len = int(len(samples) / ratio)
        resampled = array.array('h', [samples[min(int(i * ratio), len(samples)-1)] for i in range(new_len)])
        samples = resampled

    out = io.BytesIO()
    w = wave.open(out, 'w')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(samples.tobytes())
    w.close()
    sys.stdout.buffer.write(out.getvalue())
except Exception as e:
    # 非 WAV 格式（webm 等）：直接透传，让 ASR 服务尝试处理
    sys.stdout.buffer.write(data)
`;
    const proc = spawn(PYTHON, ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => console.error("[ASR resample]", c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error("resample failed"));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(inputBuf);
    proc.stdin.end();
  });
}

app.post("/api/asr", express.raw({ type: "*/*", limit: "20mb" }), async (req: Request, res: Response) => {
  console.log("[ASR] 收到请求, content-type:", req.headers["content-type"], "body length:", req.body?.length ?? 0);
  if (!ASR_URL) { res.status(400).json({ error: "ASR not configured" }); return; }
  const audioBuffer = req.body as Buffer;
  if (!audioBuffer || audioBuffer.length === 0) { res.status(400).json({ error: "empty audio" }); return; }
  try {
    // 转为 16kHz WAV
    const wavBuffer = await convertTo16kWav(audioBuffer);
    console.log("[ASR] 转换后大小:", wavBuffer.length);

    // 构建 multipart/form-data
    const boundary = "----AudioBoundary" + Date.now();
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), wavBuffer, Buffer.from(footer)]);
    const resp = await fetch(`${ASR_URL}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Authorization": `Bearer ${ASR_KEY}`,
      },
      body,
    });
    const respText = await resp.text();
    console.log("[ASR] ASR 服务返回:", resp.status, respText);
    if (!resp.ok) { res.status(502).json({ error: `ASR error: ${resp.status} ${respText}` }); return; }
    const data = JSON.parse(respText) as { text: string };
    res.json({ text: data.text || "" });
  } catch (e) {
    console.error("[ASR] 错误:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ── 加载 benchmark ────────────────────────────────────────────────────────────

interface BenchmarkItem {
  index: number;
  hash_id: string;
  question: string;
  img: string;
  img_caption: string;
  subject: string;
  type: string;
  difficulty: string;
  knowledge_point: string[];
  topic?: string;
  format_answer: {
    format_solution: string[];
    ground_truth: string[];
  };
}

const benchmark: BenchmarkItem[] = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf-8"));
const customDb: BenchmarkItem[] = fs.existsSync(CUSTOM_DB_PATH) ? JSON.parse(fs.readFileSync(CUSTOM_DB_PATH, "utf-8")) : [];

function normalizeQuestion(q: string): string {
  return q.replace(/<image>/g, "").replace(/\s+/g, " ").trim();
}

// ── 向量检索 ──────────────────────────────────────────────────────────────────

interface EmbeddingStore {
  indices: number[];
  embeddings: number[][];
}

const store: EmbeddingStore = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf-8"));
const indexMap = new Map<number, BenchmarkItem>([...benchmark, ...customDb].map(item => [item.index, item]));

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// 通过 API 调用 BGE-M3 embedding 服务（GPU）
const EMBED_URL = (process.env.EMBED_URL || "").replace(/\/$/, "");
const EMBED_KEY = process.env.EMBED_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";

async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(`${EMBED_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EMBED_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: [normalizeQuestion(text)] }),
  });
  if (!resp.ok) throw new Error(`embed API error: ${resp.status}`);
  const data = await resp.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

async function findBestMatch(userQ: string): Promise<{ item: BenchmarkItem; score: number } | null> {
  const queryVec = await embedText(userQ);
  let bestScore = 0, bestIdx = -1;
  for (let i = 0; i < store.indices.length; i++) {
    const score = cosineSimilarity(queryVec, store.embeddings[i]);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestScore < 0.6) return null;
  const item = indexMap.get(store.indices[bestIdx]);
  return item ? { item, score: bestScore } : null;
}

// ── 读取 doc ──────────────────────────────────────────────────────────────────

interface DocData {
  solutionMd: string;
  scenes: { name: string; url: string; isHtml: boolean }[];
  problemImgUrl: string | null;
}

function findExpFolder(index: number, hash?: string): { dir: string; folder: string } | null {
  // 优先从 indexMap 里取 topic
  const topic = hash ? `problem_${hash}_custom` : indexMap.get(index)?.topic;
  // 优先查 my_experiment，再查 exp_gemini
  for (const baseDir of [MY_EXP_DIR, EXP_DIR]) {
    if (!fs.existsSync(baseDir)) continue;
    const folders = fs.readdirSync(baseDir);
    // 按 topic 精确匹配
    if (topic) {
      const byTopic = folders.find(f => f === topic);
      if (byTopic) return { dir: baseDir, folder: byTopic };
    }
    // 按数字 index 匹配（兼容旧数据）
    const folder = folders.find(f => {
      const match = f.match(/^problem_(\d+)_/);
      return match && parseInt(match[1]) === index;
    });
    if (folder) return { dir: baseDir, folder };
  }
  return null;
}

function loadDoc(index: number, subject: string, hash?: string): DocData | null {
  const found = findExpFolder(index, hash);
  if (!found) return null;
  const { dir, folder } = found;

  const docDir = path.join(dir, folder, "doc");

  // 支持 solution.html 或 solution.md
  const solutionHtmlPath = path.join(docDir, "solution.html");
  const solutionMdPath = path.join(docDir, "solution.md");
  let solutionMd = "";
  let isHtmlDoc = false;
  if (fs.existsSync(solutionHtmlPath)) {
    // 读取 html 文本内容供 AI 参考（去掉标签）
    const raw = fs.readFileSync(solutionHtmlPath, "utf-8");
    solutionMd = raw.replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s{2,}/g, "\n").trim();
    isHtmlDoc = true;
  } else if (fs.existsSync(solutionMdPath)) {
    solutionMd = fs.readFileSync(solutionMdPath, "utf-8");
  } else {
    return null;
  }

  // 列出 scene 文件（html 或 png）
  const scenes = fs.readdirSync(docDir)
    .filter(f => f.match(/^scene\d+\.(png|html)$/))
    .sort()
    .map(f => {
      const html = f.endsWith(".html");
      return {
        name: f.replace(/\.(png|html)$/, ""),
        url: `doc/${index}/${f}`,
        isHtml: html,
      };
    });

  // 题目图片
  const probImg = path.join(dir, folder, "problem_diagram.png");
  const problemImgUrl = fs.existsSync(probImg) ? `doc/${index}/problem_diagram.png` : null;

  return { solutionMd, scenes, problemImgUrl };
}

// ── 静态图片路由 ───────────────────────────────────────────────────────────────

app.get("/doc/:index/:file", (req: Request, res: Response) => {
  const index = parseInt(req.params["index"] as string);
  const file = req.params["file"] as string;
  const found = findExpFolder(index);
  if (!found) { res.status(404).send("not found"); return; }
  const { dir, folder } = found;

  const docDir = path.join(dir, folder, "doc");
  const filePath = path.join(docDir, file);
  if (!fs.existsSync(filePath)) {
    const alt = path.join(dir, folder, file);
    if (fs.existsSync(alt)) { res.sendFile(alt); return; }
    res.status(404).send("not found"); return;
  }
  res.sendFile(filePath);
});

// ── API: 检索题目 ─────────────────────────────────────────────────────────────

app.post("/api/search", async (req: Request, res: Response) => {
  const { question } = req.body as { question: string };
  if (!question) { res.status(400).json({ error: "question required" }); return; }

  let result: { item: BenchmarkItem; score: number } | null = null;
  try {
    result = await findBestMatch(question);
  } catch (e) {
    res.status(500).json({ error: String(e) }); return;
  }

  if (!result) {
    res.json({ found: false });
    return;
  }

  const { item: match, score } = result;
  const doc = loadDoc(match.index, match.subject);
  let searchImgUrl = doc?.problemImgUrl ?? null;
  if (!searchImgUrl && (match as any).img) {
    searchImgUrl = `data:image/png;base64,${(match as any).img}`;
  }
  res.json({
    found: true,
    index: match.index,
    subject: match.subject,
    type: match.type,
    difficulty: match.difficulty,
    knowledge_point: match.knowledge_point,
    question: normalizeQuestion(match.question),
    score: Math.round(score * 100),
    scenes: doc?.scenes ?? [],
    problemImgUrl: searchImgUrl,
    hasDoc: doc !== null,
  });
});

// ── Profile 辅助函数 ──────────────────────────────────────────────────────────

const GUIDING_STYLE_DETAILS: Record<string, Record<string, string>> = {
  "详细讲解": {
    "语气": "耐心、细致，像在一对一辅导课上讲解",
    "节奏": "每一步都充分展开，主动解释\"为什么\"，不跳步骤",
    "提问方式": "先铺垫背景知识再提问，让学生有足够上下文",
    "错误处理": "当学生答错时，逐步拆解错误所在，给出完整的纠正路径",
    "SPEECH要求": "可用 4-5 句话，第一句复述题目条件或前一步结论，再引出本步问题",
    "KEYPOINT要求": "写出完整推导链，注明每一步依据（定理名、公式名）",
  },
  "简洁直接": {
    "语气": "干练、精准，不废话",
    "节奏": "快速推进，只说关键点",
    "提问方式": "直接点明本步目标，用最短的句子提问",
    "错误处理": "简短指出错误类型，给出正确方向，不过度解释",
    "SPEECH要求": "严格限制在 1-2 句，一句点题一句提问",
    "KEYPOINT要求": "只写结论公式，省略过渡文字",
  },
  "苏格拉底式追问": {
    "语气": "好奇、平等，像哲学对话而非授课",
    "节奏": "不直接给答案，通过层层提问引导学生自己发现结论",
    "提问方式": "从学生已知的前提出发提出推论性问题；答对时追问\"你怎么知道这一定成立？\"；答错时反问\"如果这样，那会推出什么结果？\"",
    "错误处理": "绝不直接否定，用\"有意思，那让我们验证一下……\"引出矛盾",
    "SPEECH要求": "每次只问一个问题，以问号结尾；可适当用\"好问题\"\"你已经很接近了\"鼓励",
    "KEYPOINT要求": "KEYPOINT 仅在学生自己说出正确结论后才写出，起到\"确认\"作用",
  },
  "鼓励式": {
    "语气": "热情、正面、充满活力，像一个为学生加油的教练",
    "节奏": "先肯定、再引导、最后总结；让学生每一步都有成就感",
    "提问方式": "每次提问前先肯定学生当前的进展，问题要具体可操作，降低心理负担",
    "错误处理": "先肯定再温和提示，绝不使用\"错了\"\"不对\"等否定词",
    "SPEECH要求": "第一句必须是正面肯定，最后一句是充满信心的提问",
    "KEYPOINT要求": "写出结论后加一句简短鼓励，例如\"✓ 这步你推导得很严密！\"",
  },
};

// ── API: 流式对话 ─────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
}

app.post("/api/chat", async (req: Request, res: Response) => {
  const { index, history, userMessage, profile } = req.body as {
    index: number;
    history: Message[];
    userMessage: string;
    profile?: UserProfile;
  };
  const uid = getUidFromReq(req) || "anonymous";
  console.log(`[OAH] /api/chat called: uid=${uid}, index=${index}, OAH_API_URL=${OAH_API_URL}`);

  const doc = loadDoc(index, "");
  if (!doc) { res.status(404).json({ error: "doc not found" }); return; }

  if (!OAH_API_URL) {
    res.status(500).json({ error: "OAH_API_URL not configured" }); return;
  }

  // 确保用户数据目录存在
  ensureUserDir(uid);

  // 读取 profile（优先请求体传入，否则从文件读）
  const effectiveProfile = profile && Object.keys(profile).length > 0 ? profile : readUserProfile(uid);

  // ── OAH workspace 缓存逻辑 ──────────────────────────────────────────────
  const cacheKey = `${uid}:${index}`;
  let workspaceId: string;
  let sessionId: string;

  const cached = oahCache.get(cacheKey);
  if (cached) {
    workspaceId = cached.workspaceId;
    sessionId = cached.sessionId;
    cached.lastUsed = Date.now();
    console.log(`[OAH] 缓存命中: ws=${workspaceId} ses=${sessionId}`);
  } else {
    // 缓存未命中：创建 workspace + 创建 session + 发送初始化消息 + 上传文件
    try {
      // 1. 创建 workspace
      const wsName = `tutor-${uid}-${index}-${Date.now()}`;
      const wsResp = await fetch(`${OAH_API_URL}/api/v1/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wsName, runtime: OAH_WORKSPACE_TEMPLATE }),
      });
      if (!wsResp.ok) throw new Error(`create workspace failed: ${wsResp.status} ${await wsResp.text()}`);
      const wsData = await wsResp.json() as { id: string };
      workspaceId = wsData.id;
      console.log(`[OAH] 创建 workspace: ${workspaceId}`);

      // 2. 创建 session（需要先创建 session 使 workspace 拥有非空 session，文件上传才能正常工作）
      const sesResp = await fetch(`${OAH_API_URL}/api/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `题目 ${index} 讲解` }),
      });
      if (!sesResp.ok) throw new Error(`create session failed: ${sesResp.status} ${await sesResp.text()}`);
      const sesData = await sesResp.json() as { id: string };
      sessionId = sesData.id;
      console.log(`[OAH] 创建 session: ${sessionId}`);

      // 3. 发送一条初始化消息，确保 session 非空（OAH 要求 workspace 已有非空 session 才能正常上传文件）
      const initMsgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "初始化会话，暂时不要调用任何工具，只需回复【已就绪】。" }),
      });
      if (initMsgResp.ok) {
        const initMsgData = await initMsgResp.json() as { runId: string };
        console.log(`[OAH] 初始化消息已发送: run=${initMsgData.runId}`);
        // 等待初始化消息的 run 完成，确保 session 非空
        const initRunDone = async (runId: string, maxMs = 30000): Promise<void> => {
          const start = Date.now();
          while (Date.now() - start < maxMs) {
            try {
              const r = await fetch(`${OAH_API_URL}/api/v1/runs/${runId}`);
              if (r.ok) {
                const run = await r.json() as { status: string };
                if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
                  console.log(`[OAH] 初始化 run 完成: status=${run.status}`);
                  return;
                }
              }
            } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
          console.warn(`[OAH] 初始化 run 等待超时`);
        };
        await initRunDone(initMsgData.runId);
      } else {
        console.warn(`[OAH] 初始化消息发送失败: ${initMsgResp.status} ${await initMsgResp.text()}`);
      }

      // 4. 上传题目文件
      let solutionFileName = "";
      const sceneFilesToWait: string[] = [];
      const found = findExpFolder(index);
      if (found) {
        const { dir, folder } = found;
        const docDir = path.join(dir, folder, "doc");

        // solution.md / solution.html
        const solMdPath = path.join(docDir, "solution.md");
        const solHtmlPath = path.join(docDir, "solution.html");
        if (fs.existsSync(solMdPath)) {
          solutionFileName = "solution.md";
          await uploadFileToWorkspace(workspaceId, solMdPath, "solution.md");
        } else if (fs.existsSync(solHtmlPath)) {
          solutionFileName = "solution.html";
          await uploadFileToWorkspace(workspaceId, solHtmlPath, "solution.html");
        }

        // scene files
        const sceneFiles = fs.readdirSync(docDir).filter(f => f.match(/^scene\d+\.(png|html)$/));
        for (const sf of sceneFiles) {
          await uploadFileToWorkspace(workspaceId, path.join(docDir, sf), sf);
          sceneFilesToWait.push(sf);
        }

        // elements_manifest.json: extract element IDs from HTML scenes
        const manifest: Record<string, { isHtml: boolean; elements: string[] }> = {};
        for (const sf of sceneFiles) {
          const sceneName = sf.replace(/\.(png|html)$/, '');
          const isHtml = sf.endsWith('.html');
          const elements: string[] = [];
          if (isHtml) {
            const html = fs.readFileSync(path.join(docDir, sf), 'utf-8');
            const idRe = /id\s*=\s*"([^"]+)"/g;
            let m;
            while ((m = idRe.exec(html)) !== null) elements.push(m[1]);
          }
          manifest[sceneName] = { isHtml, elements };
        }
        if (Object.keys(manifest).length > 0) {
          await uploadBufferToWorkspace(workspaceId, Buffer.from(JSON.stringify(manifest, null, 2)), "elements_manifest.json");
        }

        // problem_diagram.png
        const probImgPath = path.join(dir, folder, "problem_diagram.png");
        if (fs.existsSync(probImgPath)) {
          await uploadFileToWorkspace(workspaceId, probImgPath, "problem_diagram.png");
        }
      }

      // 5. 上传用户数据文件
      const userDir = path.join(USERS_DIR, uid);
      const profilePath = path.join(userDir, "profile.json");
      const mistakesPath = path.join(userDir, "mistakes.json");
      if (fs.existsSync(profilePath)) {
        await uploadFileToWorkspace(workspaceId, profilePath, "profile.json");
      }
      if (fs.existsSync(mistakesPath)) {
        await uploadFileToWorkspace(workspaceId, mistakesPath, "mistakes.json");
      }

      // 6. 等待文件同步到 workspace 本地磁盘
      // OAH 异步从 S3 同步文件到 agent 可见的本地路径，需要等待同步完成
      const waitForFile = async (wsId: string, filePath: string, maxMs = 10000): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          try {
            const r = await fetch(`${OAH_API_URL}/api/v1/workspaces/${wsId}/files/content?path=${encodeURIComponent(filePath)}`);
            if (r.ok) { console.log(`[OAH] 文件同步完成: ${filePath} (${Date.now() - start}ms)`); return; }
          } catch {}
          await new Promise(r => setTimeout(r, 500));
        }
        console.warn(`[OAH] 文件同步超时: ${filePath}`);
      };
      const fileWaitTasks: Promise<void>[] = [];
      fileWaitTasks.push(waitForFile(workspaceId, "profile.json"));
      if (solutionFileName) fileWaitTasks.push(waitForFile(workspaceId, solutionFileName));
      if (sceneFilesToWait.length > 0) fileWaitTasks.push(waitForFile(workspaceId, "elements_manifest.json", 5000));
      for (const sf of sceneFilesToWait) {
        fileWaitTasks.push(waitForFile(workspaceId, sf, 5000));
      }
      await Promise.all(fileWaitTasks);

      // 7. 写入缓存
      oahCache.set(cacheKey, { workspaceId, sessionId, lastUsed: Date.now() });
    } catch (e) {
      console.error("[OAH] 初始化失败:", e);
      res.status(500).json({ error: `OAH init failed: ${String(e)}` });
      return;
    }
  }

  // ── 构建消息内容 ──────────────────────────────────────────────────────────
  // 系统提示、回复格式、指导风格等已写入 OAH template 和 profile.json，
  // agent 会自行读取 workspace 中的文件，无需在消息中重复。
  const messageContent = userMessage;

  // ── 发送消息到 OAH ────────────────────────────────────────────────────────
  let runId: string;
  try {
    const msgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageContent }),
    });
    if (!msgResp.ok) throw new Error(`send message failed: ${msgResp.status} ${await msgResp.text()}`);
    const msgData = await msgResp.json() as { runId: string; messageId: string };
    runId = msgData.runId;
    console.log(`[OAH] 消息已发送: run=${runId}`);
  } catch (e) {
    console.error("[OAH] 发送消息失败:", e);
    res.status(500).json({ error: `OAH send message failed: ${String(e)}` });
    return;
  }

  // ── 创建 TTS 流式会话 ──────────────────────────────────────────────────
  const ttsSessionId = "tts-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const ttsStreamSession = { streams: [] as (ReadableStream | null)[], currentIdx: 0, done: false, ttsAllDone: false, ts: Date.now() };
  ttsStreams.set(ttsSessionId, ttsStreamSession);
  // 兼容旧的前端轮询路径
  const ttsSession = { audioIds: [] as string[], done: false, ttsAllDone: false, ts: Date.now() };
  ttsSessions.set(ttsSessionId, ttsSession);

  // SSE 流式输出
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-TTS-Session", ttsSessionId);

  // ── 监听 OAH SSE 事件并转换 ───────────────────────────────────────────────
  try {
    const eventsUrl = `${OAH_API_URL}/api/v1/sessions/${sessionId}/events?runId=${encodeURIComponent(runId)}`;
    const eventsResp = await fetch(eventsUrl);
    if (!eventsResp.ok || !eventsResp.body) throw new Error(`SSE connect failed: ${eventsResp.status}`);

    const reader = eventsResp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    // TTS 相关变量
    let fullText = "";
    let ttsBuf = "";
    let ttsSessionDone = false;
    let ttsStreamSlotIdx = 0;

    // 每个 [SPEECH]...[/SPEECH] 块整体一次流式 TTS 请求
    const processTtsFromDelta = (delta: string) => {
      ttsBuf += delta;
      while (true) {
        if (!ttsBuf.includes("[SPEECH]") && !ttsBuf.startsWith("[SPEECH]")) {
          const s = ttsBuf.indexOf("[");
          if (s < 0) { ttsBuf = ""; break; }
          ttsBuf = ttsBuf.slice(s); break;
        }
        const sStart = ttsBuf.indexOf("[SPEECH]");
        if (sStart < 0) break;
        const afterOpen = ttsBuf.slice(sStart + "[SPEECH]".length);
        const closeIdx = afterOpen.indexOf("[/SPEECH]");
        if (closeIdx >= 0) {
          // 完整 SPEECH 块 → 单次流式 TTS 请求
          const speechText = afterOpen.slice(0, closeIdx);
          if (speechText.trim() && TTS_URL) {
            const slotIdx = ttsStreamSlotIdx++;
            ttsStreamSession.streams.push(null);
            console.log(`[TTS] SPEECH 块就绪 (slot=${slotIdx}, ${speechText.length}字)`);
            synthesizeTTSStream(cleanTTSText(speechText)).then(stream => {
              ttsStreamSession.streams[slotIdx] = stream;
              if (ttsSessionDone && ttsStreamSession.streams.every(s => s !== null)) {
                ttsStreamSession.ttsAllDone = true;
                ttsStreamSession.done = true;
                ttsSession.done = true;
                ttsSession.ttsAllDone = true;
              }
            }).catch(() => {
              ttsStreamSession.streams[slotIdx] = null;
              if (ttsSessionDone) { ttsStreamSession.ttsAllDone = true; ttsStreamSession.done = true; ttsSession.done = true; ttsSession.ttsAllDone = true; }
            });
          }
          ttsBuf = afterOpen.slice(closeIdx + "[/SPEECH]".length);
        } else {
          // SPEECH 块还没关闭，继续积累
          break;
        }
      }
    };

    let runDone = false;

    while (!runDone) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // 解析 SSE 事件
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || ""; // 保留未完成的行

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          // 完整事件，处理
          try {
            const data = JSON.parse(currentData);

            if (currentEvent === "message.delta") {
              // 流式 delta
              const delta = data.delta as string || "";
              if (delta) {
                fullText += delta;
                res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                processTtsFromDelta(delta);
              }
            } else if (currentEvent === "message.completed") {
              // 消息完成：提取 [KEYPOINT]
              const content = data.content;
              let textContent = "";
              if (typeof content === "string") {
                textContent = content;
              } else if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === "text" && part.text) textContent += part.text;
                }
              }
              // 如果 fullText 为空但 message.completed 有内容，用 completed 的内容
              if (!fullText && textContent) {
                fullText = textContent;
                // 一次性发送全部 delta
                res.write(`data: ${JSON.stringify({ delta: textContent })}\n\n`);
                processTtsFromDelta(textContent);
              }
              // 提取 KEYPOINT
              const keypointRe = /\[KEYPOINT\]([\s\S]*?)\[\/KEYPOINT\]/g;
              let m;
              while ((m = keypointRe.exec(fullText)) !== null) {
                const kp = m[1].trim();
                if (kp) res.write(`data: ${JSON.stringify({ keypoint: kp })}\n\n`);
              }
            } else if (currentEvent === "run.completed" || currentEvent === "run.failed" || currentEvent === "run.cancelled") {
              runDone = true;
              if (currentEvent === "run.failed") {
                console.error(`[OAH] run failed:`, data);
              }
            }
          } catch (parseErr) {
            // 忽略解析错误，继续
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }

    // 流结束
    ttsSessionDone = true;
    // 检查是否所有 SPEECH 块的流都已完成
    if (ttsStreamSession.streams.every(s => s !== null)) {
      ttsStreamSession.ttsAllDone = true;
      ttsStreamSession.done = true;
      ttsSession.done = true;
      ttsSession.ttsAllDone = true;
    }
    res.write(`data: ${JSON.stringify({ done: true, ttsSessionId })}\n\n`);
    res.end();

    // 追加交互记录
    if (fullText && uid !== "anonymous") {
      appendTutoringHistory(uid, index, userMessage, fullText);
    }
  } catch (e) {
    console.error("[OAH] SSE 流错误:", e);
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    res.end();
  }
});

// ── API: 按 index 直接加载题目 ────────────────────────────────────────────────

app.post("/api/load", (req: Request, res: Response) => {
  const { index } = req.body as { index: number };
  const item = indexMap.get(index);
  if (!item) { res.status(404).json({ error: "not found" }); return; }
  const doc = loadDoc(item.index, item.subject);
  let problemImgUrl = doc?.problemImgUrl ?? null;
  // Fallback: if no problem_diagram.png on disk but item has base64 img, use data URL
  if (!problemImgUrl && (item as any).img) {
    problemImgUrl = `data:image/png;base64,${(item as any).img}`;
  }
  res.json({
    index: item.index,
    subject: item.subject,
    type: item.type,
    difficulty: item.difficulty,
    knowledge_point: item.knowledge_point,
    question: normalizeQuestion(item.question),
    scenes: doc?.scenes ?? [],
    problemImgUrl,
  });
});

// ── API: AI 合成讲解文档 ────────────────────────────────────────────────────────

app.post("/api/generate-doc", requireAuth, async (req: Request, res: Response) => {
  const { question, imagePath } = req.body as { question: string; imagePath?: string };
  if (!question) { res.status(400).json({ error: "question required" }); return; }

  // 优先复用已有 topic（normalize 后匹配），避免文本细微差异导致重复生成
  const allItems: BenchmarkItem[] = [...benchmark, ...customDb];
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const existing = allItems.find(x => normalize(x.question) === normalize(question) && x.topic);
  const topicHash = crypto.createHash("md5").update(normalize(question)).digest("hex").slice(0, 8);
  const topic = existing?.topic ?? `problem_${topicHash}_custom`;

  if (generatingTopics.has(topic)) {
    // 已有 worker 在跑，直接返回 taskId 让前端继续轮询
    res.json({ taskId: topic }); return;
  }
  generatingTopics.add(topic);

  const taskId = topic;
  genTasks.set(taskId, { status: "running", msg: "启动 AI 合成..." });

  // 如果前端没传 imagePath，尝试从题库中找到已有图片
  let finalImagePath = imagePath;
  if (!finalImagePath) {
    const matchItem = allItems.find(x => normalize(x.question) === normalize(question));
    if (matchItem && matchItem.img) {
      const tmpPath = path.join(UPLOADS_DIR, `gen_img_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, Buffer.from(matchItem.img, 'base64'));
      finalImagePath = tmpPath;
    }
  }

  const scriptArgs = [
    GENERATE_DOC_SCRIPT,
    MY_EXP_DIR,
    question,
    finalImagePath || "null",
    topic,
  ];

  const proc = spawn(PYTHON, scriptArgs, { cwd: path.resolve(__dirname, "../..") });

  let buf = "";
  let resultTopic = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.topic) resultTopic = evt.topic;
        if (evt.status) genTasks.set(taskId, { status: "running", msg: evt.msg || evt.status });
      } catch {}
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => console.error("[generate-doc]", chunk.toString().trim()));

  proc.on("close", async (code) => {
    generatingTopics.delete(topic);
    // 清理临时图片文件
    if (finalImagePath && finalImagePath.startsWith(UPLOADS_DIR)) {
      try { fs.unlinkSync(finalImagePath); } catch {}
    }
    if (code !== 0 || !resultTopic) {
      genTasks.set(taskId, { status: "error", msg: "生成失败，请稍后重试" }); return;
    }
    try {
      genTasks.set(taskId, { status: "running", msg: "正在加入题库..." });

      // 加入 custom_database.json
      const allItems: BenchmarkItem[] = [...benchmark, ...customDb];
      const exists = allItems.find(x => x.question.trim() === question.trim());
      let finalIndex: number;

      if (exists) {
        finalIndex = exists.index;
      } else {
        finalIndex = Math.max(0, ...allItems.map(x => x.index)) + 1;
        const newItem: BenchmarkItem = {
          hash_id: require("crypto").createHash("md5").update(question).digest("hex"),
          img: imagePath ? fs.readFileSync(imagePath).toString("base64") : "",
          question,
          format_answer: { format_solution: [], ground_truth: [] },
          img_caption: "",
          difficulty: "未知",
          type: "主观题",
          subject: "custom",
          knowledge_point: [],
          topic: `problem_${topicHash}_custom`,
          index: finalIndex,
        };
        customDb.push(newItem);
        fs.writeFileSync(CUSTOM_DB_PATH, JSON.stringify(customDb, null, 2), "utf-8");
        indexMap.set(finalIndex, newItem);
      }

      // 更新 embeddings
      genTasks.set(taskId, { status: "running", msg: "正在更新检索索引..." });
      if (!store.indices.includes(finalIndex)) {
        try {
          const vec = await embedText(question);
          store.indices.push(finalIndex);
          store.embeddings.push(vec);
          fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(store), "utf-8");
        } catch (e) { console.error("[generate-doc] embed error", e); }
      }

      const doc = loadDoc(finalIndex, "", topicHash);
      genTasks.set(taskId, {
        status: "done",
        msg: "合成完成！",
        index: finalIndex,
        scenes: doc?.scenes ?? [],
        problemImgUrl: doc?.problemImgUrl ?? null,
        hasDoc: doc !== null,
        question: normalizeQuestion(question),
      });
    } catch (e) {
      genTasks.set(taskId, { status: "error", msg: String(e) });
    }
  });

  res.json({ taskId });
});

app.get("/api/generate-doc/status/:taskId", requireAuth, (req: Request, res: Response) => {
  const { taskId } = req.params as { taskId: string };
  const task = genTasks.get(taskId);

  if (!task) {
    // genTasks 里没有（server 重启或进程已结束），直接查磁盘
    const topic = taskId; // taskId 即 topic
    const topicHash = topic.replace(/^problem_/, "").replace(/_custom$/, "");
    const found = findExpFolder(0, topicHash);
    if (found) {
      const solutionHtml = path.join(found.dir, found.folder, "doc", "solution.html");
      if (fs.existsSync(solutionHtml)) {
        // 已生成完成，返回 done
        const index = indexMap.get(
          [...indexMap.entries()].find(([, v]) => v.topic === topic)?.[0] ?? -1
        )?.index;
        const doc = loadDoc(index ?? 0, "", topicHash);
        res.json({
          status: "done",
          msg: "合成完成！",
          index: index ?? null,
          scenes: doc?.scenes ?? [],
          problemImgUrl: doc?.problemImgUrl ?? null,
          hasDoc: true,
          question: doc ? undefined : undefined,
        } as GenTask);
        return;
      }
      // 目录存在但没有 solution.html，且没有进程在跑
      if (generatingTopics.has(topic)) {
        res.json({ status: "running", msg: "生成中..." } as GenTask); return;
      }
      res.json({ status: "error", msg: "生成失败，请重试" } as GenTask); return;
    }
    // 完全找不到，可能还没开始
    if (generatingTopics.has(topic)) {
      res.json({ status: "running", msg: "生成中..." } as GenTask); return;
    }
    res.status(404).json({ error: "task not found" }); return;
  }

  res.json(task);
  // 完成或失败后清理
  if (task.status === "done" || task.status === "error") genTasks.delete(taskId);
});

// ── API: 相似题目 ──────────────────────────────────────────────────────────────

app.post("/api/similar", async (req: Request, res: Response) => {
  const { index, knowledge_point, subject, topN = 5 } = req.body as {
    index?: number;
    knowledge_point?: string[];
    subject?: string;
    topN?: number;
  };

  let candidates: { item: BenchmarkItem; score: number }[] = [];

  if (index !== undefined) {
    // 按向量相似度找相似题
    const idx = store.indices.indexOf(index);
    if (idx === -1) { res.status(404).json({ error: "index not found" }); return; }
    const queryVec = store.embeddings[idx];
    for (let i = 0; i < store.indices.length; i++) {
      if (store.indices[i] === index) continue;
      const score = cosineSimilarity(queryVec, store.embeddings[i]);
      const item = indexMap.get(store.indices[i]);
      if (item) candidates.push({ item, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, topN);
  } else if (subject) {
    // 按学科列出所有题目
    for (const item of benchmark) {
      if (item.subject === subject) candidates.push({ item, score: 1 });
    }
    candidates.sort((a, b) => a.item.index - b.item.index);
  } else if (knowledge_point && knowledge_point.length > 0) {
    // 按知识点关键词筛选
    const kps = knowledge_point.map(k => k.toLowerCase());
    for (const item of benchmark) {
      const itemKps = item.knowledge_point.map(k => k.toLowerCase()).join(" ");
      const hit = kps.some(kp => itemKps.includes(kp) || kp.split(/[；;、，,]/g).some(seg => itemKps.includes(seg.trim())));
      if (hit) candidates.push({ item, score: 1 });
    }
    // 随机打乱取前 N
    candidates = candidates.sort(() => Math.random() - 0.5).slice(0, topN);
  } else {
    res.status(400).json({ error: "需要 index、subject 或 knowledge_point" }); return;
  }

  res.json({
    results: candidates.map(({ item, score }) => ({
      index: item.index,
      subject: item.subject,
      type: item.type,
      difficulty: item.difficulty,
      knowledge_point: item.knowledge_point,
      question: normalizeQuestion(item.question),
      score: Math.round(score * 100),
      hasDoc: (() => {
        const f = findExpFolder(item.index);
        if (!f) return false;
        const docDir = path.join(f.dir, f.folder, "doc");
        return fs.existsSync(path.join(docDir, "solution.md")) || fs.existsSync(path.join(docDir, "solution.html"));
      })(),
    })),
  });
});

// ── API: 学科-知识点目录 ──────────────────────────────────────────────────────

app.get("/api/subjects", (_req: Request, res: Response) => {
  const SUBJECT_LABEL: Record<string, string> = {
    "math-g6": "小学数学", "math-g9": "初中数学", "math-g12": "高中数学",
    "physics-g9": "初中物理", "physics-g12": "高中物理",
    "chemistry-g9": "初中化学", "chemistry-g12": "高中化学",
    "biology-g9": "初中生物", "biology-g12": "高中生物",
    "geography-g9": "初中地理", "geography-g12": "高中地理",
    "history-g9": "初中历史", "history-g12": "高中历史",
  };
  // 统计每个 subject 的真实题目总数及知识点
  const subjectMap = new Map<string, { count: number; kpMap: Map<string, number> }>();
  for (const item of benchmark) {
    const s = item.subject?.trim();
    if (!s || s === "custom") continue;
    if (!subjectMap.has(s)) subjectMap.set(s, { count: 0, kpMap: new Map() });
    const entry = subjectMap.get(s)!;
    entry.count++;
    for (const kp of item.knowledge_point) {
      const last = kp.split(";").pop()?.trim() ?? "";
      if (!last || last === "--") continue;
      entry.kpMap.set(last, (entry.kpMap.get(last) ?? 0) + 1);
    }
  }
  const result = [...subjectMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subject, { count, kpMap }]) => ({
      subject,
      label: SUBJECT_LABEL[subject] ?? subject,
      count,
      kps: [...kpMap.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([kp, c]) => ({ kp, count: c })),
    }));
  res.json({ subjects: result });
});

// ── API: 批改分析（流式）──────────────────────────────────────────────────────

app.post("/api/grade", async (req: Request, res: Response) => {
  const { index, question, questionImage, studentAnswer } = req.body as {
    index?: number;
    question?: string;
    questionImage?: string;  // base64
    studentAnswer: string;
  };

  console.log(`[OAH] /api/grade called: index=${index}, question=${!!question}, questionImage=${!!questionImage}, OAH_API_URL=${OAH_API_URL}`);

  if (!OAH_API_URL) {
    res.status(500).json({ error: "OAH_API_URL not configured" }); return;
  }

  // 收集要上传的文件和消息内容
  const filesToUpload: { path: string; content: Buffer }[] = [];
  let hasStandardAnswer = false;
  let messageContent: string;

  if (index !== undefined && index !== null) {
    // 检索模式：从题库获取题目、图片、标准答案
    const item = indexMap.get(index);
    if (!item) { res.status(404).json({ error: "题目不存在" }); return; }
    const { format_solution, ground_truth } = item.format_answer;
    const questionText = normalizeQuestion(item.question);
    hasStandardAnswer = format_solution.length > 0 || ground_truth.length > 0;

    // 题目文本
    filesToUpload.push({ path: "question.md", content: Buffer.from(questionText) });

    // 题目图片
    if (item.img) {
      let imgBuf: Buffer;
      if (item.img.startsWith("http")) {
        try {
          const imgResp = await fetch(item.img);
          imgBuf = Buffer.from(await imgResp.arrayBuffer());
        } catch (e) {
          console.warn(`[OAH] 下载题目图片失败: ${item.img}`, e);
          imgBuf = Buffer.alloc(0);
        }
      } else {
        imgBuf = Buffer.from(item.img, "base64");
      }
      if (imgBuf.length > 0) {
        filesToUpload.push({ path: "question_image.png", content: imgBuf });
      }
    }

    // 标准答案
    if (hasStandardAnswer) {
      const stepsText = format_solution.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
      const answerText = ground_truth.join("；");
      filesToUpload.push({ path: "standard_answer.md", content: Buffer.from(`标准解题步骤：\n${stepsText}\n\n参考答案：${answerText}`) });
    }

    // 学生答案
    filesToUpload.push({ path: "student_answer.md", content: Buffer.from(studentAnswer) });

    messageContent = hasStandardAnswer
      ? "请读取 workspace 中的 question.md、standard_answer.md 和 student_answer.md，然后按照 XML 输出格式要求返回批改结果。"
      : "请读取 workspace 中的 question.md 和 student_answer.md。本题没有标准答案，请先自行解答题目制定标准答案，然后再批改学生答案。";
  } else {
    // 直接模式：用户直接输入题目和答案
    if (!question) { res.status(400).json({ error: "题目不能为空" }); return; }

    filesToUpload.push({ path: "question.md", content: Buffer.from(question) });

    if (questionImage) {
      filesToUpload.push({ path: "question_image.png", content: Buffer.from(questionImage, "base64") });
    }

    filesToUpload.push({ path: "student_answer.md", content: Buffer.from(studentAnswer) });

    messageContent = "请读取 workspace 中的 question.md 和 student_answer.md。本题没有标准答案，请先自行解答题目制定标准答案，然后再批改学生答案。";
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let workspaceId: string | undefined;

  try {
    // 1. 创建 workspace
    const wsName = `grader-${index ?? 'direct'}-${Date.now()}`;
    const wsResp = await fetch(`${OAH_API_URL}/api/v1/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: wsName, runtime: OAH_GRADER_TEMPLATE }),
    });
    if (!wsResp.ok) throw new Error(`create workspace failed: ${wsResp.status} ${await wsResp.text()}`);
    const wsData = await wsResp.json() as { id: string };
    workspaceId = wsData.id;
    console.log(`[OAH] 创建批改 workspace: ${workspaceId}`);

    // 2. 创建 session（需要先创建 session 使 workspace 拥有非空 session，文件上传才能正常工作）
    const title = index ? `题目 ${index} 批改` : "自由批改";
    const sesResp = await fetch(`${OAH_API_URL}/api/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!sesResp.ok) throw new Error(`create session failed: ${sesResp.status} ${await sesResp.text()}`);
    const sesData = await sesResp.json() as { id: string };
    const sessionId = sesData.id;
    console.log(`[OAH] 创建批改 session: ${sessionId}`);

    // 3. 发送一条初始化消息，确保 session 非空
    const initMsgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "初始化会话，暂时不要调用任何工具，只需回复【已就绪】。" }),
    });
    if (initMsgResp.ok) {
      const initMsgData = await initMsgResp.json() as { runId: string };
      console.log(`[OAH] 批改初始化消息已发送: run=${initMsgData.runId}`);
      const initRunDone = async (runId: string, maxMs = 30000): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          try {
            const r = await fetch(`${OAH_API_URL}/api/v1/runs/${runId}`);
            if (r.ok) {
              const run = await r.json() as { status: string };
              if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
                console.log(`[OAH] 批改初始化 run 完成: status=${run.status}`);
                return;
              }
            }
          } catch {}
          await new Promise(r => setTimeout(r, 500));
        }
        console.warn(`[OAH] 批改初始化 run 等待超时`);
      };
      await initRunDone(initMsgData.runId);
    } else {
      console.warn(`[OAH] 批改初始化消息发送失败: ${initMsgResp.status} ${await initMsgResp.text()}`);
    }

    // 4. 上传所有文件
    for (const f of filesToUpload) {
      await uploadBufferToWorkspace(workspaceId, f.content, f.path);
    }
    console.log(`[OAH] 已上传 ${filesToUpload.length} 个文件: ${filesToUpload.map(f => f.path).join(", ")}`);

    // 5. 等待文件同步到本地磁盘
    const waitForFile = async (wsId: string, filePath: string, maxMs = 15000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        try {
          const r = await fetch(`${OAH_API_URL}/api/v1/workspaces/${wsId}/files/content?path=${encodeURIComponent(filePath)}`);
          if (r.ok) { console.log(`[OAH] 文件同步完成: ${filePath} (${Date.now() - start}ms)`); return; }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      console.warn(`[OAH] 文件同步超时: ${filePath}`);
    };
    const gradeWaitTasks: Promise<void>[] = [];
    gradeWaitTasks.push(waitForFile(workspaceId, "question.md"));
    gradeWaitTasks.push(waitForFile(workspaceId, "student_answer.md"));
    if (hasStandardAnswer) gradeWaitTasks.push(waitForFile(workspaceId, "standard_answer.md"));
    await Promise.all(gradeWaitTasks);

    // 6. 发送实际消息
    const msgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageContent }),
    });
    if (!msgResp.ok) throw new Error(`send message failed: ${msgResp.status} ${await msgResp.text()}`);
    const msgData = await msgResp.json() as { runId: string; messageId: string; status: string };
    const runId = msgData.runId;
    console.log(`[OAH] 批改消息已发送: run=${runId}`);

    // 7. 监听 SSE 并转发 delta
    const eventsUrl = `${OAH_API_URL}/api/v1/sessions/${sessionId}/events?runId=${encodeURIComponent(runId)}`;
    const eventsResp = await fetch(eventsUrl);
    if (!eventsResp.ok || !eventsResp.body) throw new Error(`SSE connect failed: ${eventsResp.status}`);

    const reader = eventsResp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let runDone = false;

    while (!runDone) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          try {
            const data = JSON.parse(currentData);

            if (currentEvent === "message.delta") {
              const delta = data.delta as string || "";
              if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            } else if (currentEvent === "message.completed") {
              // 如果没有收到 delta 但 completed 有内容，一次性发送
              const content = data.content;
              let textContent = "";
              if (typeof content === "string") {
                textContent = content;
              } else if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === "text" && part.text) textContent += part.text;
                }
              }
              if (textContent) {
                res.write(`data: ${JSON.stringify({ delta: textContent })}\n\n`);
              }
            } else if (currentEvent === "run.completed" || currentEvent === "run.failed" || currentEvent === "run.cancelled") {
              runDone = true;
              if (currentEvent === "run.failed") {
                console.error(`[OAH] 批改 run failed:`, data);
              }
            }
          } catch {}
          currentEvent = "";
          currentData = "";
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

    // 6. 记录到待清理列表（2 小时后自动删除）
    graderWorkspaces.set(workspaceId, Date.now());
    console.log(`[OAH] 批改 workspace 保留中: ${workspaceId}（2h 后自动清理）`);
  } catch (e) {
    console.error("[OAH] 批改失败:", e);
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    res.end();
    // 失败时也加入待清理列表
    if (workspaceId) {
      graderWorkspaces.set(workspaceId, Date.now());
    }
  }
});

// ── 错题本 API ────────────────────────────────────────────────────────────────

const MISTAKES_PATH = path.join(__dirname, "../mistakes.json"); // 旧路径，保留兼容

interface MistakeRecord {
  id: string;
  index: number;
  subject: string;
  type: string;
  difficulty: string;
  knowledge_point: string[];
  question: string;
  studentAnswer?: string;
  gradeResult?: string;
  addedAt: string;
  note?: string;
}

function mistakesPath(uid: string): string {
  ensureUserDir(uid);
  return path.join(USERS_DIR, uid, "mistakes.json");
}
function loadMistakes(uid: string): MistakeRecord[] {
  const p = mistakesPath(uid);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}
function saveMistakes(uid: string, list: MistakeRecord[]) {
  fs.writeFileSync(mistakesPath(uid), JSON.stringify(list, null, 2), "utf-8");
}

// 加入错题
app.post("/api/mistakes", requireAuth, (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  const { index, question, imagePath, studentAnswer, gradeResult, note } = req.body as {
    index?: number; question?: string; imagePath?: string; studentAnswer?: string; gradeResult?: string; note?: string;
  };

  let item: BenchmarkItem | undefined;

  if (index !== undefined) {
    item = indexMap.get(index);
  } else if (question) {
    // 生成中还没有 index，用 question 文本查找或创建 custom_database 条目
    const trimmed = question.trim();
    const allItems: BenchmarkItem[] = [...benchmark, ...customDb];
    const existing = allItems.find(x => x.question.trim() === trimmed);
    if (existing) {
      item = existing;
    } else {
      const crypto = require("crypto");
      const topicHash = crypto.createHash("md5").update(normalizeQuestion(trimmed)).digest("hex").slice(0, 8);
      const newIndex = Math.max(0, ...allItems.map(x => x.index)) + 1;
      const imgB64 = imagePath && fs.existsSync(imagePath) ? fs.readFileSync(imagePath).toString("base64") : "";
      const newItem: BenchmarkItem = {
        hash_id: crypto.createHash("md5").update(trimmed).digest("hex"),
        img: imgB64, question: trimmed,
        format_answer: { format_solution: [], ground_truth: [] },
        img_caption: "", difficulty: "未知", type: "主观题", subject: "custom",
        knowledge_point: [], topic: `problem_${topicHash}_custom`, index: newIndex,
      };
      customDb.push(newItem);
      fs.writeFileSync(CUSTOM_DB_PATH, JSON.stringify(customDb, null, 2), "utf-8");
      indexMap.set(newIndex, newItem);
      item = newItem;
    }
  }

  if (!item) { res.status(404).json({ error: "题目不存在" }); return; }
  const list = loadMistakes(uid);
  const existingIdx = list.findIndex(m => m.index === item!.index);
  const record: MistakeRecord = {
    id: existingIdx >= 0 ? list[existingIdx].id : Date.now().toString(),
    index: item.index,
    subject: item.subject,
    type: item.type,
    difficulty: item.difficulty,
    knowledge_point: item.knowledge_point,
    question: normalizeQuestion(item.question),
    studentAnswer, gradeResult, note,
    addedAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) list[existingIdx] = record; else list.unshift(record);
  saveMistakes(uid, list);
  res.json({ ok: true, id: record.id, index: item.index, updated: existingIdx >= 0 });
});

app.get("/api/mistakes", requireAuth, (_req: Request, res: Response) => {
  const uid = getUidFromReq(_req)!;
  const list = loadMistakes(uid).map(m => ({
    ...m,
    hasDoc: loadDoc(m.index, m.subject) !== null,
  }));
  res.json(list);
});

app.delete("/api/mistakes/:id", requireAuth, (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  const { id } = req.params as { id: string };
  saveMistakes(uid, loadMistakes(uid).filter(m => m.id !== id));
  res.json({ ok: true });
});

app.post("/api/mistakes/analyze", requireAuth, async (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  const { id, profile } = req.body as { id: string; profile?: UserProfile };
  const list = loadMistakes(uid);
  const m = list.find(r => r.id === id);
  if (!m) { res.status(404).json({ error: "not found" }); return; }
  const item = indexMap.get(m.index);
  const { format_solution, ground_truth } = item?.format_answer ?? { format_solution: [], ground_truth: [] };

  const profileLines: string[] = [];
  if (profile?.nickname) profileLines.push(`学生姓名：${profile.nickname}`);
  if (profile?.grade) profileLines.push(`学段：${profile.grade}`);
  if (profile?.favoriteSubjects?.length) profileLines.push(`最喜爱的学科：${profile.favoriteSubjects.join("、")}`);
  if (profile?.selfLevel) profileLines.push(`知识水平自评：${profile.selfLevel}`);
  if (profile?.learningGoal) profileLines.push(`学习目标：${profile.learningGoal}`);
  const profileCtx = profileLines.length > 0 ? `## 学生信息\n${profileLines.join("\n")}\n` : "";
  const styleDetail = profile?.guidingStyle ? GUIDING_STYLE_DETAILS[profile.guidingStyle] : undefined;
  const styleInstr = styleDetail && profile?.guidingStyle ? `## 指导风格：${profile.guidingStyle}\n${Object.entries(styleDetail).map(([k, v]) => `- **${k}**：${v}`).join("\n")}` : "";

  const systemPrompt = `你是一位有经验的教师，正在对学生的错题进行深度分析。所有数学公式和符号必须用 $...$ 包裹（行内公式），不要输出裸的 LaTeX 命令。

${profileCtx}${styleInstr}

【题目】
${m.question}

【知识点】${m.knowledge_point.join("、")}

【标准解题步骤】
${format_solution.map((s, i) => `${i + 1}. ${s}`).join("\n")}

【参考答案】${ground_truth.join("；")}

${m.studentAnswer ? `【学生解答】\n${m.studentAnswer}` : ""}
${m.gradeResult ? `【批改记录】\n${m.gradeResult}` : ""}

## 分析要求
请根据学生的指导风格偏好（${profile?.guidingStyle ?? "平衡引导"}）和知识水平（${profile?.selfLevel ?? "未知"}）调整分析的深度与语气，给出深度错误分析，包括：
1. **核心错误点**：学生最关键的错误是什么
2. **知识漏洞**：反映出哪些概念或方法没有掌握
3. **思维误区**：学生可能存在的思维定势或误解
4. **针对性建议**：如何针对性地复习和练习（语气和详细程度参考上方风格指令）
5. **记忆口诀**：用一句话总结该知识点的核心，便于记忆`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    const stream = await client.chat.completions.create({
      model: MODEL, stream: true, temperature: 0.5,
      messages: [{ role: "system", content: systemPrompt },
                 { role: "user", content: "请对这道错题进行深度分析。" }],
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    res.write("data: [DONE]\n\n"); res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`); res.end();
  }
});

// ── 前端页面 ───────────────────────────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(getHTML());
});

// 前端日志收集
app.post("/api/log", (req: Request, res: Response) => {
  const { msg } = req.body as { msg: string };
  console.log("[BROWSER]", msg);
  res.json({ ok: true });
});

function getHTML(): string {
  const logoB64 = (() => {
    try { return 'data:image/webp;base64,' + fs.readFileSync(path.resolve(__dirname, '../static/header-logo.webp')).toString('base64'); } catch { return ''; }
  })();
  const iconB64 = (() => {
    try { return 'data:image/webp;base64,' + fs.readFileSync(path.resolve(__dirname, '../static/logo-icon.webp')).toString('base64'); } catch { return ''; }
  })();
  const imgB64 = (file: string, mime = 'image/png') => {
    try { return `data:${mime};base64,` + fs.readFileSync(path.resolve(__dirname, '../static', file)).toString('base64'); } catch { return ''; }
  };
  const teacherExplaining = imgB64('teacher_explaining.svg', 'image/svg+xml');
  const teacherListening = imgB64('teacher_listening.svg', 'image/svg+xml');
  const teacherThinking = imgB64('teacher_thinking.svg', 'image/svg+xml');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 作业辅导</title>
<link rel="icon" type="image/webp" href="${iconB64}">
<script>
  MathJax = {
    tex: { inlineMath: [['$','$'], ['\\\\(','\\\\)']], displayMath: [['$$','$$']] },
    options: { skipHtmlTags: ['script','noscript','style','textarea'] }
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js" async></script>
<style>
  :root {
    --primary: #555aff;
    --primary-hover: #4e53eb;
    --primary-active: #474cd6;
    --primary-light: #eeeeff;
    --primary-dark: #474cd6;
    --secondary: #8c55ff;
    --secondary-light: #f4eeff;
    --info: #3782ff;
    --info-light: #ebf2ff;
    --success: #1eb478;
    --success-light: #e8f8f2;
    --danger: #f02d2d;
    --danger-light: #feeaea;
    --warning: #ffb400;
    --warning-light: #fff8e6;
    --bg: #f7f8ff;
    --bg-muted: #f5f7fc;
    --card: #fff;
    --border: rgba(10,10,40,0.1);
    --border-strong: rgba(10,10,40,0.25);
    --text: #0a0a28;
    --text-2: rgba(10,10,40,0.8);
    --text-sub: rgba(10,10,40,0.55);
    --text-placeholder: rgba(10,10,40,0.4);
    --user-bg: #eeeeff;
    --ai-bg: #f7f8ff;
    --shadow-sm: 0 4px 12px rgba(10,10,40,0.06);
    --shadow-md: 0 8px 24px rgba(10,10,40,0.08);
    --shadow-lg: 0 16px 40px rgba(10,10,40,0.12);
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 24px;
    --radius-pill: 999px;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  /* ── Header ── */
  .app-header {
    height:64px; flex-shrink:0;
    background:#fff;
    border-bottom:1px solid var(--border);
    display:flex; align-items:center;
    padding:0 24px; gap:16px;
  }
  .app-header .logo-img { height:38px; object-fit:contain; }
  .app-header .divider { width:1px; height:28px; background:var(--border); margin:0 4px; }
  .app-header .app-name { font-size:1.05rem; font-weight:700; color:var(--primary); letter-spacing:.02em; }
  .app-header .user-area { margin-left:auto; display:flex; align-items:center; gap:10px; }
  .app-header .user-name { font-size:.88rem; color:var(--text-sub); }
  .logout-btn {
    padding:5px 16px; border:1px solid var(--border); border-radius:100px;
    background:#fff; color:var(--text-sub); cursor:pointer; font-size:.82rem;
    transition:.2s;
  }
  .logout-btn:hover { border-color:var(--primary); color:var(--primary); }
  .settings-btn {
    padding:5px 16px; border:1px solid var(--primary); border-radius:100px;
    background:#fff; color:var(--primary); cursor:pointer; font-size:.82rem;
    transition:.2s;
  }
  .settings-btn:hover { background:var(--primary-light); }

  /* ── Profile Modal ── */
  #profile-modal {
    display:none; position:fixed; inset:0; z-index:1100;
    background:rgba(10,10,40,.45); align-items:center; justify-content:center;
  }
  #profile-modal.open { display:flex; }
  .profile-card {
    background:#fff; border-radius:var(--radius-xl);
    padding:32px 36px 28px; width:480px; max-width:94vw; max-height:90vh;
    overflow-y:auto; box-shadow:var(--shadow-md);
    display:flex; flex-direction:column; gap:20px;
  }
  .profile-card h2 { font-size:1.1rem; font-weight:700; color:var(--text); }
  .pf-field { display:flex; flex-direction:column; gap:6px; }
  .pf-label { font-size:.82rem; font-weight:600; color:var(--text-sub); }
  .pf-input {
    padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm);
    font-size:.9rem; color:var(--text); outline:none; transition:.2s; background:#fff;
  }
  .pf-input:focus { border-color:var(--primary); }
  .pf-chips { display:flex; flex-wrap:wrap; gap:8px; }
  .pf-chip {
    padding:5px 14px; border:1px solid var(--border); border-radius:100px;
    font-size:.82rem; color:var(--text-sub); cursor:pointer; transition:.2s;
    background:#fff; user-select:none;
  }
  .pf-chip.selected { border-color:var(--primary); background:var(--primary-light); color:var(--primary); font-weight:600; }
  .pf-textarea {
    padding:8px 12px; border:1px solid var(--border); border-radius:var(--radius-sm);
    font-size:.9rem; color:var(--text); outline:none; transition:.2s;
    resize:none; height:72px; font-family:inherit;
  }
  .pf-textarea:focus { border-color:var(--primary); }
  .pf-char-count { font-size:.76rem; color:var(--text-sub); text-align:right; }
  .pf-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:4px; }


  .main { display:flex; flex:1; overflow:hidden; }

  /* ── 右侧内容 ── */
  .content { flex:1; display:flex; flex-direction:column; overflow:hidden; }
  .view { flex:1; display:none; flex-direction:column; overflow:hidden; position:relative; }
  .view.active { display:flex; }

  /* ── 首页 ── */
  .home-view {
    background:#f5f8ff;
    align-items:center; justify-content:center;
    flex-direction:column; gap:48px;
  }
  .home-welcome { text-align:center; }
  .home-welcome h1 { font-size:2.8rem; font-weight:700; color:var(--text); margin-bottom:10px; letter-spacing:2px; }
  .home-welcome p { font-size:1rem; color:var(--text-sub); }
  .home-cards { display:grid; grid-template-columns:repeat(4,200px); gap:30px; }
  .home-btn {
    background:rgba(255,255,255,.95);
    border-radius:var(--radius-lg); padding:40px 30px;
    text-align:center; cursor:pointer;
    transition:all .3s cubic-bezier(.4,0,.2,1);
    box-shadow:var(--shadow-sm);
    border:1px solid rgba(255,255,255,.2);
    display:flex; flex-direction:column; align-items:center; gap:0;
    position:relative; overflow:hidden;
  }
  .home-btn::before {
    content:''; position:absolute; top:0; left:-100%;
    width:100%; height:100%;
    background:linear-gradient(90deg,transparent,rgba(85,90,255,.08),transparent);
    transition:left .5s;
  }
  .home-btn:hover { transform:translateY(-8px); box-shadow:var(--shadow-lg); background:#fff; }
  .home-btn:hover::before { left:100%; }
  .home-btn:hover .home-btn-label { color:var(--primary); }
  .home-btn:active { transform:translateY(-4px); }
  .home-btn-icon { width:70px; height:70px; margin-bottom:20px; object-fit:contain; transition:transform .3s ease; }
  .home-btn:hover .home-btn-icon { transform:scale(1.1); }
  .home-btn-label { font-size:1.25rem; font-weight:600; color:var(--text); transition:color .3s ease; }

  /* ── 通用 topbar ── */
  .topbar {
    padding:12px 16px;
    border-bottom:1px solid var(--border);
    background:#fff; flex-shrink:0;
    display:flex; flex-direction:column; gap:8px;
  }
  .topbar-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .topbar-title { font-size:.88rem; font-weight:700; color:var(--text); display:flex; align-items:center; gap:6px; }
  .back-btn {
    padding:5px 14px; border:1px solid var(--border); border-radius:100px;
    background:#fff; cursor:pointer; font-size:.82rem; color:var(--text-sub);
    flex-shrink:0; transition:.2s;
  }
  .back-btn:hover { border-color:var(--primary); color:var(--primary); background:var(--primary-light); }
  .topbar textarea {
    width:100%; padding:9px 14px;
    border:1.5px solid var(--border); border-radius:var(--radius-sm);
    font-family:inherit; font-size:.9rem; resize:none; height:66px;
    transition:.2s; background:#fafaff;
  }
  .topbar textarea:focus { outline:none; border-color:var(--primary); background:#fff; box-shadow:0 0 0 3px rgba(85,90,255,.15); }

  /* ── topbar 折叠 ── */
  #topbar-collapsible {
    display:flex; flex-direction:column; gap:8px;
    max-height:500px; overflow:hidden;
    transition:max-height .3s ease, opacity .3s ease, padding .2s ease;
    opacity:1;
  }
  #topbar-collapsible.collapsed {
    max-height:0; opacity:0; pointer-events:none; padding:0;
  }
  .topbar-toggle { font-size:.75rem !important; padding:3px 12px !important; }
  .status { font-size:.8rem; flex:1; color:var(--text-sub); }
  .status.ok { color:var(--success); } .status.err { color:var(--danger); }

  /* ── 搜索框 ── */
  .search-bar {
    display:flex; align-items:center; gap:10px;
    border:2px solid #d4d5ff; border-radius:100px;
    background:#fff; padding:0 16px; height:44px;
    box-shadow:2px 2px 10px #e9f0fc; flex:1;
  }
  .search-bar input {
    border:none; outline:none; background:transparent;
    flex:1; font-size:.9rem; color:var(--text); font-family:inherit;
  }
  .search-bar input::placeholder { color:#b0b0c0; }

  /* ── 按钮 ── */
  .btn { padding:7px 18px; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:.85rem; font-weight:600; transition:.2s; white-space:nowrap; }
  .btn-primary { background:var(--primary); color:#fff; }
  .btn-primary:hover { background:var(--primary-hover); }
  .btn-primary:disabled { opacity:.4; cursor:not-allowed; }
  .btn-secondary { background:#fff; color:var(--primary); border:1.5px solid var(--primary); }
  .btn-secondary:hover { background:var(--primary-light); color:var(--primary-active); border-color:var(--primary-active); }
  .btn-success { background:var(--success); color:#fff; }
  .btn-success:hover { background:#179960; }
  .btn-success:disabled { opacity:.4; cursor:not-allowed; }
  .btn-outline { background:transparent; color:var(--primary); border:1.5px solid var(--primary); }
  .btn-outline:hover { background:var(--primary-light); }
  .btn-mistake { background:#fff7ed; color:#c2410c; border:1px solid #fed7aa; }
  .btn-mistake:hover { background:#ffedd5; }

  /* ── 对话 ── */
  .messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; background:var(--bg); }
  .msg-row { display:flex; gap:8px; align-items:flex-start; }
  .msg-row.user { flex-direction:row-reverse; }
  .msg-avatar { width:144px; height:144px; border-radius:50%; flex-shrink:0; object-fit:contain; }
  .msg { max-width:78%; padding:11px 16px; border-radius:var(--radius-md); line-height:1.8; font-size:.91rem; white-space:pre-wrap; }
  .msg.user { background:var(--primary); color:#fff; border-bottom-right-radius:4px; }
  .msg.ai { background:#fff; border-bottom-left-radius:4px; border:1px solid var(--border); box-shadow:0 1px 4px rgba(0,0,0,.05); }
  .msg.ai img.scene-inline { max-width:100%; border-radius:8px; margin:8px 0; display:block; border:1px solid var(--border); }
  .input-bar {
    position:absolute; right:20px; bottom:20px; z-index:50;
    padding:8px 12px; background:#fff; display:flex; gap:8px;
    border-radius:var(--radius-lg); box-shadow:var(--shadow-md);
    border:1px solid var(--border); max-width:400px; width:50%;
  }
  .input-bar textarea {
    flex:1; padding:9px 14px; border:1.5px solid var(--border);
    border-radius:var(--radius-sm); font-family:inherit; font-size:.9rem;
    resize:none; height:52px; transition:.2s; background:#fafaff;
  }
  .input-bar textarea:focus { outline:none; border-color:var(--primary); background:#fff; box-shadow:0 0 0 3px rgba(85,90,255,.15); }

  /* ── 题目解答：上下分栏重构（卡片化+折叠+响应式） ── */
  .guide-body { flex:1; display:flex; flex-direction:column; overflow:hidden; position:relative; background:var(--bg); }

  /* 上半：题目+图示（固定高度） */
  .guide-top {
    display:none; flex-shrink:0;
    background:transparent;
    flex-direction:row; gap:12px;
    padding:16px 16px 8px 16px;
    height:750px;
    transition:height 0.3s ease, padding 0.3s ease, opacity 0.3s ease;
    animation: fadeIn 0.3s ease forwards;
  }
  .guide-top.visible { display:flex; }
  .guide-top.collapsed {
    height:0; padding:0 16px; overflow:hidden; opacity:0; pointer-events:none;
  }

  /* 折叠按钮条 */
  .guide-collapse-bar {
    display:none; flex-shrink:0; justify-content:center; align-items:center;
    padding:4px 0; background:linear-gradient(to bottom, #fff, transparent);
    z-index:2; border-bottom:1px solid var(--border); box-shadow:0 2px 4px rgba(0,0,0,0.02);
  }
  .guide-collapse-bar.visible { display:flex; }
  .collapse-btn {
    background:#fff; border:1px solid var(--border); border-radius:100px;
    padding:4px 16px; font-size:0.75rem; font-weight:600; color:var(--text-sub);
    cursor:pointer; box-shadow:0 2px 6px rgba(85,90,255,.06); transition:0.2s;
    transform:translateY(-8px);
  }
  .collapse-btn:hover { color:var(--primary); border-color:var(--primary-light); background:#fafaff; transform:translateY(-9px); }

  /* 左：题目文本+原图（上下分栏） */
  .guide-problem {
    flex:1; width:33%; flex-shrink:0;
    background:#fff; border:1px solid var(--border); border-radius:12px;
    overflow:hidden;
    display:flex; flex-direction:column;
    box-shadow:0 2px 8px rgba(85,90,255,.04);
    min-height:0; height:100%;
  }
  .guide-problem-top {
    flex:1; min-height:0; overflow-y:auto;
    padding:12px 16px; border-bottom:1px solid var(--border);
    display:flex; flex-direction:column; gap:8px;
    transition:flex 0.3s;
  }
  .guide-problem-top.collapsed {
    flex:0 0 36px; overflow:hidden;
  }
  .guide-problem-top.collapsed #guide-problem-top-body { display:none; }
  .guide-problem-analysis {
    flex:1; min-height:0; overflow-y:auto;
    padding:10px 16px; background:#fafaff;
    display:flex; flex-direction:column; gap:6px;
    transition:flex 0.3s;
  }
  .guide-problem-analysis.collapsed {
    flex:0 0 36px; overflow:hidden;
  }
  .guide-problem-analysis.collapsed #guide-analysis-body { display:none; }
  .guide-panel-header {
    display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
  }
  .guide-collapse-btn {
    font-size:.7rem; color:var(--text-sub); background:none; border:none;
    cursor:pointer; padding:2px 6px; border-radius:4px;
  }
  .guide-collapse-btn:hover { color:var(--primary); background:var(--primary-light); }
  .guide-analysis-body {
    font-size:.88rem; line-height:1.75; color:var(--text);
    white-space:pre-wrap;
  }
  /* 右：步骤图示 */
  .guide-scene {
    flex:2; width:67%; flex-shrink:0;
    background:#fff; border:1px solid var(--border); border-radius:12px;
    padding:16px; overflow-y:auto;
    display:flex; flex-direction:column; gap:12px;
    box-shadow:0 2px 8px rgba(85,90,255,.04);
    min-height:0; height:100%;
  }

  /* 响应式：窄屏幕下卡片上下排列 */
  @media (max-width: 768px) {
    .guide-top { flex-direction:column; max-height:60%; }
    .guide-problem, .guide-scene { width:100%; flex:auto; }
  }

  .guide-problem-label, .guide-scene-label {
    font-size:.75rem; font-weight:700; color:var(--text-sub);
    letter-spacing:.05em; text-transform:uppercase;
  }
  .guide-problem-text { font-size:.95rem; line-height:1.85; color:var(--text); white-space:pre-wrap; }
  .guide-problem-img {
    max-width:60%; max-height:20vh; object-fit:contain;
    border-radius:8px; border:1px solid var(--border); display:block;
  }
  .guide-scene-img {
    max-width:100%; max-height:40vh; object-fit:contain;
    border-radius:8px; border:1px solid var(--border); display:block;
  }
  .guide-scene-iframe-wrap {
    width:100%; position:relative; overflow:hidden;
    border-radius:8px; border:1px solid var(--border);
    background:#fff;
    min-height:60px;
  }
  .guide-scene-iframe {
    border:none; display:block;
    width:800px; height:600px;
    transform-origin:0 0;
    max-width:none;
  }

  /* 右：当前步骤图示 */
  .guide-scene-img { transition:opacity .3s; cursor:zoom-in; }
  .guide-scene-name { font-size:.8rem; color:var(--primary); font-weight:600; align-self:flex-start; }
  .guide-scene-empty {
    color:#a1a1b5; font-size:.85rem; text-align:center; margin:auto; line-height:1.8;
    width:100%; height:120px; display:flex; align-items:center; justify-content:center;
    border:2px dashed #e0e1ff; border-radius:8px; background:#fafaff;
  }
  .scene-tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:4px; }
  .scene-tabs .scene-tab {
    padding:5px 14px; border:1.5px solid var(--border); border-radius:100px;
    background:#fff; cursor:pointer; font-size:.78rem; font-weight:600;
    color:var(--text-sub); transition:.2s; user-select:none;
  }
  .scene-tabs .scene-tab:hover { border-color:var(--primary); color:var(--primary); background:var(--primary-light); }
  .scene-tabs .scene-tab.active { background:var(--primary); color:#fff; border-color:var(--primary); }

  /* 动画 */
  @keyframes fadeIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
  /* ── 做题展示（独立全屏，覆盖 guide-body） ── */
  #practice-view {
    position:absolute; inset:0; z-index:10;
    background:var(--bg);
    display:flex; flex-direction:column; overflow:hidden;
    animation: fadeIn 0.3s ease forwards;
  }
  .practice-topbar {
    padding:14px 20px; background:#fff;
    border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:12px; flex-shrink:0;
    box-shadow:0 1px 4px rgba(0,0,0,0.02);
  }
  .practice-body { flex:1; overflow-y:auto; padding:32px 20px; display:flex; flex-direction:column; align-items:center; gap:20px; }
  .practice-card {
    background:#fff; border:1px solid var(--border);
    border-radius:16px; padding:32px 36px;
    width:100%; max-width:720px;
    box-shadow:0 4px 16px rgba(85,90,255,.06);
  }
  .practice-kp { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
  .kp-tag { background:var(--primary-light); color:var(--primary); padding:4px 12px; border-radius:100px; font-size:.78rem; font-weight:600; }
  .practice-img { max-width:100%; max-height:300px; object-fit:contain; border-radius:var(--radius-md); border:1px solid var(--border); margin-top:16px; display:block; }
  .practice-text { font-size:.95rem; line-height:1.85; color:var(--text); }
  .practice-actions { display:flex; gap:10px; width:100%; max-width:720px; flex-wrap:wrap; }

  /* ── 批改 ── */
  .grade-body { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; background:var(--bg); }
  .grade-body textarea {
    width:100%; padding:12px 14px; border:1.5px solid var(--border);
    border-radius:var(--radius-sm); font-family:inherit; font-size:.9rem;
    resize:vertical; min-height:130px; background:#fafaff; transition:.2s;
  }
  .grade-body textarea:focus { outline:none; border-color:var(--primary); background:#fff; box-shadow:0 0 0 3px rgba(85,90,255,.15); }
  .grade-result {
    background:#fff; border:1px solid var(--border);
    border-radius:12px; padding:18px; white-space:pre-wrap;
    line-height:1.85; font-size:.91rem;
    box-shadow:0 2px 8px rgba(85,90,255,.05);
  }

  /* ── 出题 ── */
  .similar-body { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; background:var(--bg); }
  .subject-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; padding:4px 0 8px; }
  .subject-card {
    background:#fff; border:1.5px solid var(--border); border-radius:12px;
    padding:16px 12px; cursor:pointer; transition:.2s; text-align:center;
    box-shadow:0 1px 4px rgba(85,90,255,.04);
  }
  .subject-card:hover { border-color:var(--primary); background:#fafaff; box-shadow:0 4px 14px rgba(85,90,255,.1); }
  .subject-card-name { font-size:.92rem; font-weight:700; color:var(--text); margin-bottom:4px; }
  .subject-card-count { font-size:.75rem; color:var(--text-sub); }
  .kp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:8px; padding:4px 0 8px; }
  .kp-card {
    background:#fff; border:1.5px solid var(--border); border-radius:var(--radius-md);
    padding:12px 14px; cursor:pointer; transition:.2s;
    box-shadow:0 1px 4px rgba(85,90,255,.04);
  }
  .kp-card:hover { border-color:var(--primary); background:#fafaff; box-shadow:0 4px 14px rgba(85,90,255,.1); }
  .kp-card-name { font-size:.85rem; font-weight:600; color:var(--text); line-height:1.4; margin-bottom:4px; }
  .kp-card-count { font-size:.74rem; color:var(--primary); }
  .browse-breadcrumb { display:flex; align-items:center; gap:6px; font-size:.82rem; color:var(--text-sub); margin-bottom:10px; flex-wrap:wrap; }
  .browse-breadcrumb .crumb { color:var(--primary); cursor:pointer; font-weight:600; }
  .browse-breadcrumb .crumb:hover { text-decoration:underline; }
  .browse-section-title { font-size:.78rem; font-weight:700; color:var(--text-sub); letter-spacing:.05em; text-transform:uppercase; margin-bottom:8px; }
  .q-card {
    background:#fff; border:1px solid var(--border);
    border-radius:var(--radius-md); padding:14px 16px; cursor:pointer; transition:.2s;
    box-shadow:0 1px 4px rgba(85,90,255,.04);
  }
  .q-card:hover { border-color:var(--primary); background:#fafaff; box-shadow:0 4px 14px rgba(85,90,255,.1); }
  .q-meta { font-size:.76rem; color:var(--text-sub); margin-bottom:6px; display:flex; gap:6px; flex-wrap:wrap; }
  .q-meta span { background:#f5f6ff; padding:2px 9px; border-radius:100px; border:1px solid #e0e1ff; }
  .q-text { font-size:.86rem; color:var(--text); line-height:1.65; }
  .q-kp { font-size:.76rem; color:var(--primary); margin-top:6px; }

  /* ── 错题本 ── */
  .mistakes-body { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; position:relative; background:var(--bg); }
  .mistake-card {
    background:#fff; border:1.5px solid #e0e1ff;
    border-radius:var(--radius-md); padding:14px 16px; cursor:pointer; transition:.2s;
    border-left:4px solid var(--primary);
    box-shadow:0 1px 4px rgba(85,90,255,.05);
  }
  .mistake-card:hover { border-color:var(--primary); box-shadow:0 4px 14px rgba(85,90,255,.12); }
  .mistake-meta { font-size:.76rem; color:var(--text-sub); margin-bottom:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .mistake-meta span { background:#f5f6ff; padding:2px 9px; border-radius:100px; border:1px solid #e0e1ff; }
  .mistake-date { font-size:.74rem; color:#b0b0c0; margin-left:auto; }
  .mistake-text { font-size:.86rem; color:var(--text); line-height:1.65; }
  .tag { display:inline-block; padding:2px 9px; border-radius:100px; font-size:.74rem; font-weight:600; }
  .tag-hard { background:var(--danger-light); color:var(--danger); }
  .tag-medium { background:#fff0ce; color:#b47800; }
  .tag-easy { background:var(--success-light); color:var(--success); }

  .placeholder { text-align:center; color:#c1c1c9; margin:auto; font-size:.9rem; padding:48px 24px; line-height:1.8; }

  /* ── TTS 播放按钮 ── */
  .tts-btn {
    display:inline-flex; align-items:center; gap:4px;
    background:transparent; border:1px solid var(--border); border-radius:100px;
    padding:3px 10px; cursor:pointer; font-size:.72rem; color:var(--text-sub);
    margin-top:6px; transition:.2s;
  }
  .tts-btn:hover { border-color:var(--primary); color:var(--primary); background:var(--primary-light); }
  .tts-btn.playing { border-color:var(--primary); color:var(--primary); background:var(--primary-light); }
  .tts-btn:disabled { opacity:.5; cursor:not-allowed; }

  /* ── 自动朗读开关 ── */
  .auto-read-wrap {
    display:flex; align-items:center; gap:6px; font-size:.78rem; color:var(--text-sub);
  }
  .auto-read-switch {
    position:relative; width:34px; height:18px; cursor:pointer;
  }
  .auto-read-switch input { opacity:0; width:0; height:0; }
  .auto-read-slider {
    position:absolute; inset:0; background:#ccc; border-radius:18px; transition:.2s;
  }
  .auto-read-slider::before {
    content:''; position:absolute; width:14px; height:14px;
    left:2px; bottom:2px; background:#fff; border-radius:50%; transition:.2s;
  }
  .auto-read-switch input:checked + .auto-read-slider { background:var(--primary); }
  .auto-read-switch input:checked + .auto-read-slider::before { transform:translateX(16px); }

  /* ── 麦克风按钮 ── */
  .mic-btn {
    width:42px; height:42px; border-radius:50%; border:1.5px solid var(--border);
    background:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
    transition:.2s; flex-shrink:0;
  }
  .mic-btn:hover { border-color:var(--primary); background:var(--primary-light); }
  .mic-btn.recording {
    border-color:var(--danger); background:var(--danger-light);
    animation: micPulse 1s ease-in-out infinite;
  }
  @keyframes micPulse {
    0%,100% { box-shadow:0 0 0 0 rgba(240,45,45,.3); }
    50% { box-shadow:0 0 0 8px rgba(240,45,45,0); }
  }
  .mic-btn svg { width:18px; height:18px; }

  /* ── 进度条 ── */
  .gen-progress-wrap {
    display:none; width:100%; margin-top:6px;
    flex-direction:column; gap:4px;
  }
  .gen-progress-wrap.visible { display:flex; }
  .gen-progress-bar-bg {
    width:100%; height:6px; background:#e8e8f0; border-radius:100px; overflow:hidden;
  }
  .gen-progress-bar {
    height:100%; background:var(--primary); border-radius:100px;
    transition:width 0.4s ease; width:0%;
  }
  .gen-progress-label {
    font-size:.76rem; color:var(--text-sub);
  }

  /* ── 登录页 ── */
  #login-mask {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    position:fixed; inset:0; z-index:999;
    background: linear-gradient(135deg, #e8eaff 0%, #f0f4ff 40%, #dde3ff 100%);
  }
  .login-header-logo {
    position:absolute; top:24px; left:32px; z-index:2;
  }
  .login-header-logo img { height:48px; width:auto; display:block; }
  .login-center {
    display:flex; flex-direction:column; align-items:center; gap:28px;
    z-index:1; width:100%;
  }
  .login-center-title {
    text-align:center;
  }
  .login-center-title h1 {
    font-size:2rem; font-weight:800; color:var(--primary); margin-bottom:6px;
  }
  .login-center-title p {
    font-size:.95rem; color:#545469;
  }
  .login-card {
    background:#fff; border-radius:var(--radius-xl);
    padding:36px 40px 40px; width:380px; max-width:92vw;
    display:flex; flex-direction:column; gap:20px;
    box-shadow:3px 3px 20px #dae9ff, 0 2px 8px rgba(0,0,0,.1);
  }
  .login-card-title {
    font-size:1.4rem; font-weight:700; color:#0a0a28; text-align:center; margin-bottom:-4px;
  }
  .auth-tabs { display:flex; gap:0; background:#f0f0f0; border-radius:100px; padding:4px; }
  .auth-tab {
    flex:1; padding:8px; border:none; border-radius:100px;
    background:transparent; color:#888;
    cursor:pointer; font-size:.9rem; font-weight:600; transition:.2s;
  }
  .auth-tab.active { background:var(--primary); color:#fff; box-shadow:0 2px 8px rgba(85,90,255,.3); }
  /* 输入框：胶囊形灰底，无边框 */
  .auth-field {
    background:#f6f6f6; border-radius:100px;
    padding:0 24px; height:54px;
    display:flex; align-items:center;
  }
  .auth-field input {
    border:none; outline:none; background:transparent;
    width:100%; font-size:.95rem; font-weight:500;
    color:#162452; font-family:inherit;
  }
  .auth-field input::placeholder { color:#a6a6a6; font-weight:400; }
  .auth-submit {
    height:44px; background:var(--primary); color:#fff;
    border:none; border-radius:100px; font-size:1rem; font-weight:600;
    cursor:pointer; transition:.2s; letter-spacing:.06em;
    box-shadow:0 4px 16px rgba(85,90,255,.35); margin-top:4px;
  }
  .auth-submit:hover { background:var(--primary-dark); box-shadow:0 6px 20px rgba(85,90,255,.45); }
  #auth-error { font-size:.82rem; color:var(--danger); min-height:16px; text-align:center; margin-top:-10px; }

  /* ── 浮动老师头像 ── */
  #teacher-fab {
    position:absolute; left:20px; bottom:20px; z-index:50;
    width:100px; height:100px; cursor:pointer;
    transition:transform .2s; display:none;
    filter:drop-shadow(0 4px 12px rgba(0,0,0,.15));
  }
  #teacher-fab:hover { transform:scale(1.1); }
  #teacher-fab-avatar { width:100%; height:100%; border-radius:50%; object-fit:contain; }

  /* ── 对话侧栏 ── */
  #chat-sidebar {
    position:absolute; left:0; top:0; bottom:0; width:400px;
    background:#fff; border-right:1px solid var(--border);
    box-shadow:2px 0 16px rgba(0,0,0,.1);
    display:flex; flex-direction:column;
    transform:translateX(-100%); transition:transform .3s ease;
    z-index:45;
  }
  #chat-sidebar.open { transform:translateX(0); }
  .sidebar-header {
    display:flex; align-items:center; gap:10px;
    padding:12px 16px; border-bottom:1px solid var(--border);
    flex-shrink:0; background:#fff;
  }
  .sidebar-header-avatar { width:36px; height:36px; border-radius:50%; object-fit:contain; }
  .sidebar-header-title { font-size:.95rem; font-weight:700; color:var(--text); flex:1; }
  .sidebar-close-btn {
    background:none; border:none; cursor:pointer;
    font-size:1.1rem; color:var(--text-sub); padding:4px 8px;
    border-radius:6px; transition:.2s;
  }
  .sidebar-close-btn:hover { background:var(--primary-light); color:var(--primary); }
  #chat-sidebar .messages { display:flex; }
  #chat-sidebar .msg-avatar { width:72px; height:72px; }
  @media (max-width:500px) {
    #chat-sidebar { width:100%; }
  }
</style>
</head>
<body>

<!-- Header -->
<header class="app-header">
  <img src="${logoB64}" class="logo-img" alt="华东师范大学 上海智能教育研究院">
  <div class="divider"></div>
  <span class="app-name">AI 作业辅导</span>
  <div class="user-area" id="user-info">
    <span class="user-name" id="user-name"></span>
    <button class="settings-btn" onclick="openProfileModal()">设置</button>
    <button class="logout-btn" onclick="logout()">退出</button>
  </div>
</header>

<!-- 登录页（全屏） -->
<div id="login-mask">
  <!-- 左上角 logo -->
  <div class="login-header-logo">
    <img src="${logoB64}" alt="华东师范大学 上海智能教育研究院">
  </div>

  <!-- 居中内容 -->
  <div class="login-center">
    <div class="login-center-title">
      <h1>AI 作业辅导</h1>
      <p>智能解题 · 批改反馈 · 错题积累</p>
    </div>
    <div class="login-card">
      <div class="login-card-title" id="login-subtitle">登录</div>
      <div class="auth-tabs">
        <button id="tab-login" class="auth-tab active" onclick="switchAuthTab('login')">登录</button>
        <button id="tab-register" class="auth-tab" onclick="switchAuthTab('register')">注册</button>
      </div>
      <div class="auth-field">
        <input id="auth-uid" type="text" placeholder="请输入用户名" autocomplete="username"
          onkeydown="if(event.key==='Enter')document.getElementById('auth-pwd').focus()">
      </div>
      <div class="auth-field">
        <input id="auth-pwd" type="password" placeholder="请输入密码（至少6位）" autocomplete="current-password"
          onkeydown="if(event.key==='Enter')doAuth()">
      </div>
      <div id="auth-error"></div>
      <button class="auth-submit" onclick="doAuth()"><span id="auth-btn-text">登 录</span></button>
    </div>
  </div>
</div>

<div class="main">

  <!-- 内容 -->
  <div class="content">

    <!-- 首页 -->
    <div class="view home-view active" id="view-home">
      <div class="home-welcome">
        <h1>AI 作业辅导</h1>
        <p>请选择你需要的功能</p>
      </div>
      <div class="home-cards">
        <button class="home-btn" onclick="enterView('guide')">
          <img class="home-btn-icon" src="${imgB64('shitiku-BykEoP7R.png')}" alt="题目解答">
          <span class="home-btn-label">题目解答</span>
        </button>
        <button class="home-btn" onclick="enterView('grade')">
          <img class="home-btn-icon" src="${imgB64('revision.svg', 'image/svg+xml')}" alt="题目批改">
          <span class="home-btn-label">题目批改</span>
        </button>
        <button class="home-btn" onclick="enterView('similar')">
          <img class="home-btn-icon" src="${imgB64('cuotiben-fr-B4KMA.png')}" alt="出题练习">
          <span class="home-btn-label">出题练习</span>
        </button>
        <button class="home-btn" onclick="enterView('mistakes')">
          <img class="home-btn-icon" src="${imgB64('zhishixuexi-ByfCL3Da.png')}" alt="错题本">
          <span class="home-btn-label">错题本</span>
        </button>
      </div>
    </div>

    <!-- 题目解答 -->
    <div class="view" id="view-guide">
      <div class="topbar" id="guide-topbar">
        <div class="topbar-row">
          <button class="back-btn" onclick="goHome()">← 返回</button>
          <span class="topbar-title">题目解答</span>
          <button class="btn btn-secondary topbar-toggle" id="topbar-toggle-btn" onclick="toggleTopbar()" style="display:none;margin-left:auto;">↑ 收起</button>
        </div>
        <div id="topbar-collapsible">
          <textarea id="q-input" placeholder="粘贴或输入题目文字...（可直接 Ctrl+V 粘贴截图）"></textarea>
          <div class="topbar-row" style="gap:6px;">
            <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
              📷 拍照识别题目
              <input type="file" accept="image/*" capture="environment" style="display:none" onchange="ocrImage(this,'q-input','question')">
            </label>
            <span id="ocr-q-status" class="status"></span>
          </div>
          <div class="topbar-row">
            <button class="btn btn-primary" id="search-btn" onclick="searchQuestion()">检索题目</button>
            <button class="btn btn-secondary" id="reset-btn" onclick="resetGuide()" style="display:none">重置</button>
            <button class="btn btn-primary"  id="guide-btn"    onclick="startGuide()"    style="display:none">开始讲题</button>
            <button class="btn btn-outline"  id="similar-cur-btn" onclick="showInlineSimilar()" style="display:none">相似题目</button>
            <button class="btn btn-mistake"  id="guide-add-mistake-btn" onclick="addMistake('guide')" style="display:none">加入错题本</button>
            <button class="btn btn-secondary" id="not-my-btn" onclick="onNotMyQuestion()" style="display:none">不是这个题目</button>
            <button class="btn btn-secondary" id="gen-doc-btn" onclick="generateDoc()" style="display:none">准备讲解材料</button>
            <span class="status" id="match-info" style="width:100%"></span>
            <div class="gen-progress-wrap" id="gen-progress-wrap">
              <div class="gen-progress-bar-bg"><div class="gen-progress-bar" id="gen-progress-bar"></div></div>
              <div class="gen-progress-label" id="gen-progress-label"></div>
            </div>
          </div>
        </div>
      </div>
      <!-- 讲题模式：题目+图示在上，对话在下 -->
      <div class="guide-body" id="guide-body">
        <!-- 上半：题目文本 + 当前步骤图示 -->
        <div class="guide-top" id="guide-top">
          <div class="guide-problem" id="guide-problem">
            <div class="guide-problem-top" id="guide-problem-top">
              <div class="guide-panel-header">
                <span class="guide-problem-label">题目</span>
                <button class="guide-collapse-btn" onclick="toggleProblemTop()" id="btn-collapse-problem-top">收起</button>
              </div>
              <div id="guide-problem-top-body">
                <div class="guide-problem-text" id="guide-problem-text"></div>
                <img id="guide-problem-img" class="guide-problem-img" style="display:none">
              </div>
            </div>
            <div class="guide-problem-analysis" id="guide-problem-analysis">
              <div class="guide-panel-header">
                <span class="guide-problem-label">解析</span>
                <button class="guide-collapse-btn" onclick="toggleProblemAnalysis()" id="btn-collapse-analysis">收起</button>
              </div>
              <div id="guide-analysis-body" class="guide-analysis-body"></div>
            </div>
          </div>
          <div class="guide-scene" id="guide-scene">
            <div class="guide-scene-label">步骤图示</div>
            <div class="scene-tabs" id="scene-tabs" style="display:none;"></div>
            <div class="guide-scene-empty" id="guide-scene-empty"><div>等待 AI 绘图...</div></div>
            <img id="guide-scene-img" class="guide-scene-img" style="display:none">
            <div id="guide-scene-iframe-wrap" class="guide-scene-iframe-wrap" style="display:none;">
              <iframe id="guide-scene-iframe" class="guide-scene-iframe" scrolling="no"></iframe>
            </div>
            <div id="guide-scene-name" class="guide-scene-name" style="display:none"></div>
          </div>
        </div>

        <!-- 做题视图（全屏覆盖，干净页面） -->
        <div id="practice-view" style="display:none;">
          <div class="practice-topbar">
            <button class="back-btn" onclick="switchToGuide()">← 返回讲题</button>
            <span style="font-size:.88rem;font-weight:700;color:var(--text);">做题</span>
            <div style="margin-left:auto;">
              <button class="btn btn-success" onclick="enterView('grade')">提交解答 → 去批改</button>
            </div>
          </div>
          <div class="practice-body">
            <div class="practice-card" id="practice-card">
              <div class="practice-kp" id="practice-kp"></div>
              <div class="practice-text" id="practice-text"></div>
              <img id="practice-img" class="practice-img" style="display:none">
            </div>
          </div>
        </div>
        <!-- 浮动老师头像 -->
        <div id="teacher-fab" onclick="toggleChatSidebar()">
          <img id="teacher-fab-avatar" src="${teacherListening}">
        </div>
        <!-- 对话侧栏 -->
        <div id="chat-sidebar">
          <div class="sidebar-header">
            <span class="sidebar-header-title">AI 讲解</span>
            <div class="auto-read-wrap">
              <label class="auto-read-switch">
                <input type="checkbox" id="auto-read-toggle" onchange="toggleAutoRead()" checked>
                <span class="auto-read-slider"></span>
              </label>
              <span>朗读</span>
            </div>
            <button class="sidebar-close-btn" onclick="toggleChatSidebar()">✕</button>
          </div>
          <div class="messages" id="messages">
            <div class="placeholder">检索到题目后<br>选择「开始讲题」</div>
          </div>
          <!-- 相似题目视图（与对话区互斥） -->
          <div id="inline-similar" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
            <div style="padding:10px 16px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;">
              <span style="font-size:.88rem;font-weight:700;color:var(--text);">相似题目</span>
              <span id="inline-similar-status" class="status" style="flex:1"></span>
              <button class="back-btn" onclick="closeInlineSimilar()">✕ 关闭</button>
            </div>
            <div id="inline-similar-body" style="flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px;background:var(--bg);"></div>
          </div>
        </div>
        <!-- 输入栏（侧栏外，底部固定） -->
        <div class="input-bar" id="input-bar" style="display:none">
          <textarea id="reply-input" placeholder="输入回答...（Enter 发送，Shift+Enter 换行）" onkeydown="handleKey(event)"></textarea>
          <button class="btn btn-primary" id="send-btn" onclick="sendMessage()">发送</button>
          <button class="mic-btn" id="mic-btn" onclick="toggleMic()" title="语音输入">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 题目批改 -->
    <div class="view" id="view-grade">
      <div class="topbar">
        <div class="topbar-row">
          <button class="back-btn" onclick="goHome()">← 返回</button>
          <span class="topbar-title">题目批改</span>
        </div>
        <textarea id="grade-q-input" placeholder="粘贴题目文字...（可直接 Ctrl+V 粘贴截图）"></textarea>
        <div id="grade-q-img-wrap" style="display:none;margin-top:4px;">
          <img id="grade-q-img" style="max-width:100%;max-height:200px;border-radius:8px;border:1px solid var(--border);">
          <button style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;" onclick="removeGradeQImg()">✕</button>
        </div>
        <div class="topbar-row" style="gap:6px;">
          <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
            📷 拍照识别题目
            <input type="file" accept="image/*" capture="environment" style="display:none" onchange="ocrImage(this,'grade-q-input','question')">
          </label>
          <span id="ocr-grade-q-status" class="status"></span>
        </div>
        <div class="topbar-row">
          <button class="btn btn-primary" id="grade-search-btn" onclick="searchForGrade()">检索题目</button>
          <button class="btn btn-secondary" id="grade-reset-btn" onclick="resetGrade()" style="display:none">重置</button>
          <button class="btn btn-mistake" id="grade-add-mistake-btn" onclick="addMistake('grade')" style="display:none">加入错题本</button>
          <button class="btn btn-primary" id="grade-to-guide-btn" onclick="gradeToGuide()" style="display:none">去讲题</button>
          <span class="status" id="grade-status"></span>
        </div>
      </div>
      <div class="grade-body" id="grade-body">
        <div class="placeholder" id="grade-placeholder">请输入题目和答案，或检索题目后批改</div>
        <div id="grade-input-wrap" style="display:none;flex-direction:column;gap:10px;">
          <textarea id="grade-input" placeholder="在此输入你的解题过程和答案...（可 Ctrl+V 粘贴解题过程截图）"></textarea>
          <div class="topbar-row" style="gap:6px;">
            <label class="btn btn-secondary" style="cursor:pointer;margin:0;">
              📷 拍照识别解题过程
              <input type="file" accept="image/*" capture="environment" style="display:none" onchange="ocrImage(this,'grade-input','answer')">
            </label>
            <span id="ocr-grade-ans-status" class="status"></span>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-success" id="grade-btn" onclick="gradeAnswer()">提交批改</button>
            <button class="btn btn-secondary" onclick="clearGrade()">清空</button>
          </div>
          <div class="grade-result" id="grade-result" style="display:none"></div>
        </div>
      </div>
    </div>

    <!-- 出题 -->
    <div class="view" id="view-similar">
      <div class="topbar">
        <div class="topbar-row">
          <button class="back-btn" onclick="goHome()">← 返回</button>
          <span class="topbar-title">出题练习</span>
        </div>
        <div class="topbar-row">
          <div class="search-bar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b0b0c0" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="text" id="kp-input" placeholder="输入知识点，例如：杠杆的平衡条件"
              onkeydown="if(event.key==='Enter') findSimilar('kp')">
          </div>
          <button class="btn btn-primary" onclick="findSimilar('kp')">按知识点出题</button>
          <span class="status" id="similar-status"></span>
        </div>
      </div>
      <div class="similar-body" id="similar-body">
        <div class="browse-breadcrumb" id="browse-breadcrumb" style="display:none"></div>
        <div id="browse-content"><div class="placeholder">加载中...</div></div>
      </div>
    </div>

    <!-- 错题本 -->
    <div class="view" id="view-mistakes">
      <div class="topbar">
        <div class="topbar-row">
          <button class="back-btn" onclick="goHome()">← 返回</button>
          <span class="topbar-title">错题本</span>
          <span class="status" id="mistakes-count"></span>
        </div>
      </div>
      <div class="mistakes-body" id="mistakes-body">
        <div class="placeholder" id="mistakes-placeholder">错题本为空，在「题目解答」或「题目批改」中点击「加入错题本」</div>
      </div>
      <!-- 错题分析弹层 -->
      <div id="mistake-detail" style="display:none;position:absolute;inset:0;background:rgba(10,10,40,.45);z-index:100;align-items:center;justify-content:center;backdrop-filter:blur(2px);">
        <div style="background:#fff;border-radius:16px;width:680px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px rgba(85,90,255,.18);">
          <div style="padding:18px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:.98rem;color:var(--text);" id="detail-title">错题分析</span>
            <button class="back-btn" onclick="closeDetail()">✕ 关闭</button>
          </div>
          <div style="flex:1;overflow-y:auto;padding:18px 24px;display:flex;flex-direction:column;gap:14px;">
            <div id="detail-q" style="background:#f5f6ff;border:1px solid #e0e1ff;border-radius:12px;padding:14px;font-size:.9rem;line-height:1.75;white-space:pre-wrap;color:var(--text);"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-primary" id="detail-analyze-btn" onclick="analyzeMistake()">AI 深度分析</button>
              <button class="btn btn-primary" id="detail-gen-btn" style="display:none" onclick="generateDocFromMistake()">生成讲解材料</button>
              <button class="btn btn-outline" id="detail-guide-btn" onclick="goToGuide()">从这题开始讲解</button>
              <button class="btn btn-secondary" id="detail-delete-btn" onclick="deleteMistake()">移出错题本</button>
            </div>
            <div class="gen-progress-wrap" id="detail-gen-progress-wrap">
              <div class="gen-progress-bar-bg"><div class="gen-progress-bar" id="detail-gen-progress-bar"></div></div>
              <div class="gen-progress-label" id="detail-gen-progress-label"></div>
            </div>
            <div id="detail-analysis" style="white-space:pre-wrap;line-height:1.85;font-size:.91rem;display:none;color:var(--text);"></div>
          </div>
        </div>
      </div>
    </div>

  </div>
</div>

<script>
// ── 前端日志上报到服务端 ──────────────────────────────────────────────────────
(function() {
  const _log = console.log.bind(console);
  console.log = function(...args) {
    _log(...args);
    try {
      fetch('api/log', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }) });
    } catch(e) {}
  };
})();
// ── 教师头像 ─────────────────────────────────────────────────────────────────
const AVATAR_EXPLAINING = '${teacherExplaining}';
const AVATAR_LISTENING = '${teacherListening}';
const AVATAR_THINKING = '${teacherThinking}';

// ── 浮动头像 & 侧栏 ────────────────────────────────────────────────────────
function toggleChatSidebar() {
  document.getElementById('chat-sidebar').classList.toggle('open');
}
function openChatSidebar() {
  document.getElementById('chat-sidebar').classList.add('open');
}
function closeChatSidebar() {
  document.getElementById('chat-sidebar').classList.remove('open');
}
function showFab() {
  document.getElementById('teacher-fab').style.display = 'block';
}
function hideFab() {
  document.getElementById('teacher-fab').style.display = 'none';
}
function updateFabAvatar(src) {
  document.getElementById('teacher-fab-avatar').src = src;
}

// ── 认证 ──────────────────────────────────────────────────────────────────────
let sessionToken = localStorage.getItem('session_token') || '';
let currentUid = '';

// 统一 fetch，自动带 token
function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      'x-session-token': sessionToken,
    },
  });
}

async function initAuth() {
  if (!sessionToken) { showLogin(); return; }
  try {
    const d = await apiFetch('api/me');
    if (!d.uid) { showLogin(); return; }
    currentUid = d.uid;
    hideLogin();
  } catch { showLogin(); }
}

function showLogin() {
  document.getElementById('login-mask').style.display = 'flex';
}
function hideLogin() {
  document.getElementById('login-mask').style.display = 'none';
  document.getElementById('user-name').textContent = currentUid;
  loadUserProfile();
}

let authMode = 'login';
function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').className = 'auth-tab' + (mode==='login' ? ' active' : '');
  document.getElementById('tab-register').className = 'auth-tab' + (mode==='register' ? ' active' : '');
  document.getElementById('login-subtitle').textContent = mode==='login' ? '登录' : '注册';
  document.getElementById('auth-btn-text').textContent = mode==='login' ? '登 录' : '注 册';
  document.getElementById('auth-error').textContent = '';
}

async function doAuth() {
  const uid = document.getElementById('auth-uid').value.trim();
  const pwd = document.getElementById('auth-pwd').value;
  const errEl = document.getElementById('auth-error');
  if (!uid || !pwd) { errEl.textContent = '请输入用户名和密码'; return; }
  errEl.textContent = '';
  const url = authMode === 'login' ? 'api/login' : 'api/register';
  let data;
  try {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({uid,password:pwd}) });
    data = await r.json();
  } catch { errEl.textContent = '网络错误，请重试'; return; }
  if (!data.ok) { errEl.textContent = data.error || '操作失败'; return; }
  sessionToken = data.token;
  currentUid = data.uid;
  localStorage.setItem('session_token', sessionToken);
  hideLogin();
}

async function logout() {
  await apiFetch('api/logout', { method:'POST' }).catch(()=>{});
  sessionToken = ''; currentUid = '';
  localStorage.removeItem('session_token');
  showLogin();
  goHome();
}

// ── 全局状态 ──────────────────────────────────────────────────────────────────
let currentIndex = null;
let currentQuestion = '';
let currentScenes = [];
let currentKP = [];
let currentOcrImagePath = null;  // OCR 时保存的服务端图片路径，供 generateDoc 使用
let gradeIndex = null;
let gradeResult = '';
let gradeQImageB64 = null;  // 题目图片 base64（首页直接批改模式）
let history = [];
let shownScenes = new Set();
let streaming = false;
let sceneScaleHandler = null;
let activeSceneName = null;
let currentMistakeId = null;

// ── 视图 ──────────────────────────────────────────────────────────────────────
function enterView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  if (name === 'grade') {
    document.getElementById('grade-reset-btn').style.display = gradeIndex !== null ? '' : 'none';
    if (gradeIndex === null && currentIndex !== null) {
      // 从题目解答页面跳转：已有题目，直接进入批改
      gradeIndex = currentIndex;
      document.getElementById('grade-q-input').value = currentQuestion;
      document.getElementById('grade-q-input').disabled = true;
      document.getElementById('grade-search-btn').style.display = 'none';
      document.getElementById('grade-reset-btn').style.display = '';
      document.getElementById('grade-add-mistake-btn').style.display = '';
      document.getElementById('grade-status').textContent = '✓ 来自题目解答 #' + currentIndex;
      document.getElementById('grade-status').className = 'status ok';
      document.getElementById('grade-placeholder').style.display = 'none';
      document.getElementById('grade-input-wrap').style.display = 'flex';
    } else if (gradeIndex === null) {
      // 从首页直接进入：无需检索题目，直接输入
      document.getElementById('grade-search-btn').style.display = 'none';
      document.getElementById('grade-placeholder').style.display = 'none';
      document.getElementById('grade-input-wrap').style.display = 'flex';
      document.getElementById('grade-q-input').placeholder = '粘贴或输入题目文字...（可直接 Ctrl+V 粘贴截图）';
    }
  }
  if (name === 'mistakes') loadMistakesList();
  if (name === 'similar') initBrowse();
}

function goHome() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-home').classList.add('active');
}

// ── 图示面板 ──────────────────────────────────────────────────────────────────
function showProblemImg(url) {
  const img = document.getElementById('guide-problem-img');
  img.src = url; img.style.display = 'block';
}

function showScene(name) {
  console.log('[showScene] called:', name, 'shownScenes:', [...shownScenes], 'currentScenes:', currentScenes.map(s=>s.name));
  if (shownScenes.has(name)) {
    // 已展示过的 scene，允许切换回去但不重复标记
    console.log('[showScene] re-switching to already shown scene:', name);
  } else {
    shownScenes.add(name);
  }
  activeSceneName = name;
  renderSceneTabs();
  const sc = currentScenes.find(x => x.name === name);
  if (!sc) { console.log('[showScene] skip: scene not found in currentScenes'); return; }
  console.log('[showScene] sc:', sc);
  // 展示上半图示区
  document.getElementById('guide-top').classList.add('visible');
  document.getElementById('guide-scene-empty').style.display = 'none';
  const img = document.getElementById('guide-scene-img');
  const iframeWrap = document.getElementById('guide-scene-iframe-wrap');
  const iframe = document.getElementById('guide-scene-iframe');
  if (sc.isHtml) {
    img.style.display = 'none'; img.src = '';
    iframe.src = sc.url;
    iframeWrap.style.display = 'block';
    if (sceneScaleHandler) { window.removeEventListener('resize', sceneScaleHandler); }
    const scaleScene = () => {
      const w = iframeWrap.clientWidth || iframeWrap.offsetWidth;
      if (!w) { requestAnimationFrame(scaleScene); return; }
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          doc.body.style.margin = '0';
          doc.body.style.padding = '0';
          doc.body.style.minHeight = '0';
          doc.body.style.display = 'block';
        }
        iframe.style.zoom = '1';
        // 用第一个子元素的尺寸，避免 body min-height:100vh 撑高 scrollHeight
        const firstEl = doc?.body?.firstElementChild;
        const contentW = firstEl ? (firstEl.scrollWidth || firstEl.offsetWidth) : (doc?.body?.scrollWidth || 800);
        const contentH = Math.max(
          firstEl ? (firstEl.scrollHeight || firstEl.offsetHeight) : 0,
          doc?.body?.scrollHeight || 0,
          500
        );
        const scale = w / contentW;
        iframe.style.zoom = String(scale);
        iframe.style.width = contentW + 'px';
        iframe.style.height = contentH + 'px';
        iframe.style.transform = '';
        iframeWrap.style.height = (contentH * scale) + 'px';
      } catch {
        const scale = w / 800;
        iframe.style.zoom = String(scale);
        iframe.style.width = '800px';
        iframe.style.height = '600px';
        iframe.style.transform = '';
        iframeWrap.style.height = (600 * scale) + 'px';
      }
    };
    iframe.onload = () => {
      // 用 rAF 等一帧，确保父容器完成布局后再计算宽度
      requestAnimationFrame(() => {
        scaleScene();
        // 再等一帧兜底（某些浏览器需要两帧）
        requestAnimationFrame(scaleScene);
      });
      // 延迟重算：确保按钮等 CSS 布局元素被包含在高度计算中
      setTimeout(scaleScene, 300);
      const ro = new ResizeObserver(() => {
        const w = iframeWrap.clientWidth || iframeWrap.offsetWidth;
        if (w > 0) { scaleScene(); }
      });
      ro.observe(iframeWrap);
    };
    sceneScaleHandler = scaleScene;
    window.addEventListener('resize', scaleScene);
  } else {
    if (sceneScaleHandler) { window.removeEventListener('resize', sceneScaleHandler); sceneScaleHandler = null; }
    iframeWrap.style.display = 'none'; iframe.src = '';
    img.style.opacity = '0';
    img.src = sc.url;
    img.style.display = 'block';
    img.onload = () => { img.style.opacity = '1'; };
  }
  const label = document.getElementById('guide-scene-name');
  label.style.display = 'none';
}

function renderSceneTabs() {
  const tabsEl = document.getElementById('scene-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  if (currentScenes.length === 0) { tabsEl.style.display = 'none'; return; }
  tabsEl.style.display = 'flex';
  currentScenes.forEach(sc => {
    const tab = document.createElement('div');
    tab.className = 'scene-tab' + (sc.name === activeSceneName ? ' active' : '');
    tab.textContent = '步骤 ' + sc.name.replace('scene', '');
    tab.addEventListener('click', () => showScene(sc.name));
    tabsEl.appendChild(tab);
  });
}

function resetPanel() {
  shownScenes = new Set();
  activeSceneName = null;
  document.getElementById('guide-top').classList.remove('visible');
  document.getElementById('guide-top').classList.remove('collapsed');

  document.getElementById('guide-problem-img').style.display = 'none';
  document.getElementById('guide-problem-text').textContent = '';
  // 清空解析区
  document.getElementById('guide-analysis-body').innerHTML = '';
  // 展开题目区
  document.getElementById('guide-problem-top').classList.remove('collapsed');
  document.getElementById('btn-collapse-problem-top').textContent = '收起';
  document.getElementById('guide-scene-empty').style.display = '';
  const tabsEl = document.getElementById('scene-tabs');
  if (tabsEl) { tabsEl.innerHTML = ''; tabsEl.style.display = 'none'; }
  const img = document.getElementById('guide-scene-img');
  img.style.display = 'none'; img.src = '';
  const iframe = document.getElementById('guide-scene-iframe');
  if (sceneScaleHandler) { window.removeEventListener('resize', sceneScaleHandler); sceneScaleHandler = null; }
  document.getElementById('guide-scene-iframe-wrap').style.display = 'none'; iframe.src = '';
  document.getElementById('guide-scene-name').style.display = 'none';
}

function toggleProblemTop() {
  const top = document.getElementById('guide-problem-top');
  const btn = document.getElementById('btn-collapse-problem-top');
  const collapsed = top.classList.toggle('collapsed');
  btn.textContent = collapsed ? '展开' : '收起';
}

function toggleProblemAnalysis() {
  const el = document.getElementById('guide-problem-analysis');
  const btn = document.getElementById('btn-collapse-analysis');
  const collapsed = el.classList.toggle('collapsed');
  btn.textContent = collapsed ? '展开' : '收起';
}

function appendKeypoint(text) {
  const body = document.getElementById('guide-analysis-body');
  // 追加内容，用分隔线分隔多条
  if (body.innerHTML) {
    const hr = document.createElement('hr');
    hr.style.cssText = 'border:none;border-top:1px solid #e8e8f0;margin:4px 0';
    body.appendChild(hr);
  }
  const p = document.createElement('div');
  p.innerHTML = renderAIText(text, false);
  body.appendChild(p);
  if (window.MathJax) MathJax.typesetPromise([p]);
}

let isGuideTopCollapsed = false;
function toggleGuideTop() {
  const top = document.getElementById('guide-top');
  const btn = document.getElementById('collapse-btn');
  isGuideTopCollapsed = !isGuideTopCollapsed;
  if (isGuideTopCollapsed) {
    top.classList.add('collapsed');
    btn.textContent = '↓ 展开题目与图示';
  } else {
    top.classList.remove('collapsed');
    btn.textContent = '↑ 收起题目与图示';
  }
}

// ── Topbar 折叠 ─────────────────────────────────────────────────────────────
let isTopbarCollapsed = false;
function toggleTopbar() {
  if (isTopbarCollapsed) expandTopbar(); else collapseTopbar();
}
function collapseTopbar() {
  isTopbarCollapsed = true;
  document.getElementById('topbar-collapsible').classList.add('collapsed');
  document.getElementById('topbar-toggle-btn').textContent = '↓ 展开';
}
function expandTopbar() {
  isTopbarCollapsed = false;
  document.getElementById('topbar-collapsible').classList.remove('collapsed');
  document.getElementById('topbar-toggle-btn').textContent = '↑ 收起';
}

// ── 题目解答 ──────────────────────────────────────────────────────────────────
async function searchQuestion() {
  const q = document.getElementById('q-input').value.trim();
  if (!q) return;
  const info = document.getElementById('match-info');
  document.getElementById('search-btn').disabled = true;
  info.textContent = '检索中...'; info.className = 'status';
  let data;
  try {
    const r = await apiFetch('api/search', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});
    data = await r.json();
  } catch { info.textContent = '连接失败'; info.className = 'status err'; document.getElementById('search-btn').disabled = false; return; }
  if (!data.found) {
    info.textContent = '未找到匹配题目，可用 AI 合成讲解';
    info.className = 'status err';
    document.getElementById('search-btn').disabled = false;
    document.getElementById('gen-doc-btn').style.display = '';
    return;
  }
  currentIndex = data.index; currentScenes = data.scenes; currentKP = data.knowledge_point || []; currentQuestion = data.question || q;
  renderSceneTabs();
  info.textContent = \`✓ #\${data.index} \${data.subject} \${data.difficulty} \${data.score}% \${currentKP.join('、')}\`;
  info.className = 'status ok';
  document.getElementById('q-input').disabled = true;
  document.getElementById('search-btn').style.display = 'none';
  document.getElementById('reset-btn').style.display = '';
  document.getElementById('guide-btn').style.display = data.hasDoc ? '' : 'none';
  document.getElementById('similar-cur-btn').style.display = '';
  document.getElementById('guide-add-mistake-btn').style.display = '';
  document.getElementById('topbar-toggle-btn').style.display = '';
  document.getElementById('gen-doc-btn').style.display = data.hasDoc ? 'none' : '';
  document.getElementById('not-my-btn').style.display = '';
  resetMistakeBtn('guide-add-mistake-btn');
  if (data.problemImgUrl) showProblemImg(data.problemImgUrl);
  history = [];
  startPractice();
}

async function showInlineSimilar() {
  if (!currentIndex && currentIndex !== 0) return;
  // 隐藏对话区、做题区，显示相似题目区
  document.getElementById('practice-view').style.display = 'none';
  closeChatSidebar();
  const area = document.getElementById('inline-similar');
  area.style.display = 'flex';
  const status = document.getElementById('inline-similar-status');
  const body = document.getElementById('inline-similar-body');
  status.textContent = '搜索中...'; status.className = 'status';
  body.innerHTML = '';

  let data;
  try {
    const r = await apiFetch('api/similar', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({index: currentIndex, topN: 8})});
    data = await r.json();
  } catch { status.textContent = '请求失败'; status.className = 'status err'; return; }

  if (!data.results?.length) { status.textContent = '未找到相似题目'; status.className = 'status err'; return; }
  status.textContent = \`共 \${data.results.length} 道\`; status.className = 'status ok';

  const diffTag = d => d==='难' ? '<span class="tag tag-hard">难</span>'
    : d==='较难' ? '<span class="tag tag-medium">较难</span>'
    : '<span class="tag tag-easy">'+d+'</span>';

  body.innerHTML = data.results.map(q => \`
    <div class="q-card" onclick="loadAndGo(\${q.index})">
      <div class="q-meta"><span>\${q.subject}</span><span>\${q.type}</span>\${diffTag(q.difficulty)}\${q.hasDoc?'<span style="color:var(--primary)">有图解</span>':''}</div>
      <div class="q-text">\${escapeHtml(q.question.slice(0,120))}\${q.question.length>120?'...':''}</div>
      <div class="q-kp">📌 \${q.knowledge_point.join('、')||'—'}</div>
    </div>
  \`).join('');
  if (window.MathJax) MathJax.typesetPromise([body]);
}

function closeInlineSimilar() {
  document.getElementById('inline-similar').style.display = 'none';
  openChatSidebar();
}

function onNotMyQuestion() {
  const info = document.getElementById('match-info');
  info.textContent = '将为你的题目准备专属讲解材料';
  info.className = 'status';
  document.getElementById('not-my-btn').style.display = 'none';
  document.getElementById('guide-btn').style.display = 'none';
  document.getElementById('gen-doc-btn').style.display = '';
  // 重置当前题目索引，但保留输入内容
  currentIndex = null; currentScenes = []; currentKP = []; currentQuestion = '';
  document.getElementById('q-input').disabled = false;
}

async function generateDoc() {
  const q = document.getElementById('q-input').value.trim();
  if (!q) return;
  const info = document.getElementById('match-info');
  const btn = document.getElementById('gen-doc-btn');
  const progressWrap = document.getElementById('gen-progress-wrap');
  const progressBar = document.getElementById('gen-progress-bar');
  const progressLabel = document.getElementById('gen-progress-label');

  const setProgress = (pct, msg) => {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = msg || '';
  };

  btn.disabled = true;
  info.textContent = ''; info.className = 'status';
  progressWrap.classList.add('visible');
  setProgress(5, '启动 AI 合成...');
  document.getElementById('guide-add-mistake-btn').style.display = '';
  resetMistakeBtn('guide-add-mistake-btn');

  try {
    const resp = await apiFetch('api/generate-doc', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ question: q, imagePath: currentOcrImagePath || undefined })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      info.textContent = '请求失败：' + (err.error || resp.status); info.className = 'status err';
      btn.disabled = false; return;
    }

    const { taskId } = await resp.json();
    if (!taskId) { info.textContent = '启动失败'; info.className = 'status err'; btn.disabled = false; return; }

    // 轮询进度
    let pct = 10;
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      let st;
      try {
        const r2 = await apiFetch('api/generate-doc/status/' + taskId);
        if (r2.status === 404) {
          info.textContent = '任务不存在，请重试'; info.className = 'status err';
          progressWrap.classList.remove('visible'); btn.disabled = false; return;
        }
        st = await r2.json();
      } catch(e) { continue; }

      if (st.status === 'error') {
        info.textContent = '失败：' + st.msg; info.className = 'status err';
        progressWrap.classList.remove('visible');
        btn.disabled = false; return;
      }
      if (st.status === 'done') {
        if (!st.hasDoc) {
          info.textContent = '生成失败，未产生讲解文件，请重试';
          info.className = 'status err';
          progressWrap.classList.remove('visible');
          btn.disabled = false; return;
        }
        setProgress(100, '完成！');
        setTimeout(() => progressWrap.classList.remove('visible'), 1000);
        info.textContent = '✓ 讲解材料已准备好，可以开始讲题';
        info.className = 'status ok';
        btn.style.display = 'none';
        currentIndex = st.index;
        currentScenes = st.scenes || [];
        renderSceneTabs();
        currentKP = [];
        currentQuestion = st.question || q;
        document.getElementById('q-input').disabled = true;
        document.getElementById('search-btn').style.display = 'none';
        document.getElementById('reset-btn').style.display = '';
        document.getElementById('guide-btn').style.display = '';
        document.getElementById('topbar-toggle-btn').style.display = '';
        document.getElementById('guide-add-mistake-btn').style.display = '';
        document.getElementById('similar-cur-btn').style.display = '';
        resetMistakeBtn('guide-add-mistake-btn');
        if (st.problemImgUrl) showProblemImg(st.problemImgUrl);
        history = [];
        startPractice();
        document.getElementById('messages').innerHTML = '<div class="placeholder">选择「开始讲题」让 AI 引导</div>';
        return;
      }
      // running：更新进度
      pct = Math.min(pct + 5, 90);
      setProgress(pct, st.msg || '生成中...');
      info.textContent = st.msg || '生成中...'; info.className = 'status';
    }
  } catch (e) {
    info.textContent = '请求失败：' + e; info.className = 'status err';
    progressWrap.classList.remove('visible');
    btn.disabled = false;
  }
}

function resetGuide() {
  currentIndex = null; currentScenes = []; activeSceneName = null; currentKP = []; currentQuestion = ''; currentOcrImagePath = null; history = []; streaming = false;
  resetPanel();
  ['q-input'].forEach(id => { document.getElementById(id).value = ''; document.getElementById(id).disabled = false; });
  document.getElementById('search-btn').disabled = false;
  document.getElementById('search-btn').style.display = '';
  ['reset-btn','guide-btn','similar-cur-btn','guide-add-mistake-btn','topbar-toggle-btn','gen-doc-btn','not-my-btn'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('match-info').textContent = '';
  document.getElementById('practice-view').style.display = 'none';
  document.getElementById('inline-similar').style.display = 'none';
  closeChatSidebar();
  hideFab();
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('messages').innerHTML = '<div class="placeholder">检索到题目后<br>选择「开始讲题」或「开始做题」</div>';

  // reset topbar collapse state
  expandTopbar();

  // reset collapse state
  isGuideTopCollapsed = false;
  document.getElementById('guide-top').classList.remove('collapsed');
}

let gradeContext = null; // 从批改页带来的上下文

async function startGuide() {
  document.getElementById('practice-view').style.display = 'none';
  showFab();
  document.getElementById('input-bar').style.display = 'flex';
  document.getElementById('messages').innerHTML = '';
  history = [];
  // 自动收起 topbar
  collapseTopbar();
  // 展示题目文本和原图到上半区，并显示折叠条
  document.getElementById('guide-top').classList.add('visible');
  document.getElementById('guide-problem-text').innerHTML = cleanLatex(escapeHtml(currentQuestion));
  if (window.MathJax) MathJax.typesetPromise([document.getElementById('guide-problem-text')]);
  if (currentScenes.length > 0) {
    showScene(currentScenes[0].name);
  }

  let prompt = '请开始引导学生解题。先简单介绍这道题的核心考查点，然后提出第一个引导问题。';
  if (gradeContext) {
    prompt = '学生刚刚做了这道题的批改，以下是学生的作答和批改结果，请根据批改中发现的问题，有针对性地引导学生理解错误并掌握正确解法。\\n\\n【学生作答】\\n' + gradeContext.studentAnswer + '\\n\\n【批改结果】\\n' + gradeContext.gradeResult;
    gradeContext = null;
  }
  await sendAI(prompt);
}

function gradeToGuide() {
  if (!gradeIndex) return;
  const studentAnswer = document.getElementById('grade-input').value.trim();
  // 保存批改上下文
  gradeContext = { studentAnswer: studentAnswer || '（未作答）', gradeResult: gradeResult || '（无批改结果）' };
  // 跳转到讲题，加载当前批改的题目
  if (currentIndex === gradeIndex) {
    enterView('guide');
    startGuide();
  } else {
    loadAndGo(gradeIndex);
  }
}

function startPractice() {
  closeChatSidebar();
  document.getElementById('input-bar').style.display = 'none';
  const pv = document.getElementById('practice-view');
  pv.style.display = 'flex'; pv.style.flexDirection = 'column';
  // 题目文本：用 innerHTML 让 MathJax 能渲染 LaTeX
  document.getElementById('practice-text').innerHTML = cleanLatex(escapeHtml(currentQuestion));
  document.getElementById('practice-kp').innerHTML = currentKP.map(k => \`<span class="kp-tag">\${k}</span>\`).join('');
  // 原示意图
  const pi = document.getElementById('practice-img');
  const problemImg = document.getElementById('guide-problem-img');
  if (problemImg.src && problemImg.style.display !== 'none') {
    pi.src = problemImg.src; pi.style.display = 'block';
  } else { pi.style.display = 'none'; }
  if (window.MathJax) MathJax.typesetPromise([document.getElementById('practice-card')]);
}

async function switchToGuide() {
  document.getElementById('practice-view').style.display = 'none';
  openChatSidebar();
  document.getElementById('input-bar').style.display = 'flex';
  if (history.length === 0) { document.getElementById('messages').innerHTML = ''; await sendAI('请开始引导学生解题。先简单介绍这道题的核心考查点，然后提出第一个引导问题。'); }
}

function handleKey(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} }
async function sendMessage() {
  if (streaming) return;
  stopCurrentAudio();
  const inp = document.getElementById('reply-input'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; appendMsg('user', text); await sendAI(text);
}

function appendMsg(role, text) {
  const msgs = document.getElementById('messages');
  const row = document.createElement('div'); row.className = 'msg-row ' + role;
  if (role === 'ai') {
    const avatar = document.createElement('img');
    avatar.className = 'msg-avatar';
    avatar.src = AVATAR_EXPLAINING;
    row.appendChild(avatar);
  }
  const div = document.createElement('div'); div.className = 'msg ' + role;
  if (role==='user') { div.textContent = text; } else { div.innerHTML = renderAIText(text); if(window.MathJax) MathJax.typesetPromise([div]); }
  row.appendChild(div);
  msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight;
}

function extractSceneNames(text) {
  const names = [];
  let idx = 0;
  while (true) {
    const start = text.indexOf('[SHOW_SCENE ', idx);
    if (start < 0) break;
    const end = text.indexOf(']', start);
    if (end < 0) break;
    names.push(text.slice(start + '[SHOW_SCENE '.length, end));
    idx = end + 1;
  }
  return names;
}
function extractSpotlights(text) {
  const items = []; let idx = 0;
  while (true) {
    const start = text.indexOf('[SPOTLIGHT ', idx);
    if (start < 0) break;
    const end = text.indexOf(']', start);
    if (end < 0) break;
    const payload = text.slice(start + '[SPOTLIGHT '.length, end);
    const parts = payload.split(' ');
    if (parts.length >= 2) items.push({ sceneName: parts[0], elementId: parts[1] });
    idx = end + 1;
  }
  return items;
}
function extractClicks(text) {
  const items = []; let idx = 0;
  while (true) {
    const start = text.indexOf('[CLICK ', idx);
    if (start < 0) break;
    const end = text.indexOf(']', start);
    if (end < 0) break;
    const payload = text.slice(start + '[CLICK '.length, end);
    const parts = payload.split(' ');
    if (parts.length >= 2) items.push({ sceneName: parts[0], elementId: parts[1] });
    idx = end + 1;
  }
  return items;
}
function stripMarkers(text) {
  // 移除 [KEYPOINT]...[/KEYPOINT] 块
  let t = text;
  while (true) {
    const s = t.indexOf('[KEYPOINT]');
    const e = t.indexOf('[/KEYPOINT]');
    if (s < 0 || e < 0 || e < s) break;
    t = t.slice(0, s) + t.slice(e + '[/KEYPOINT]'.length);
  }
  // 移除 [SPEECH]/[/SPEECH] 标签
  t = t.split('[SPEECH]').join('').split('[/SPEECH]').join('');
  // 移除 [SHOW_SCENE ...] 标记
  while (true) {
    const s = t.indexOf('[SHOW_SCENE ');
    if (s < 0) break;
    const e = t.indexOf(']', s);
    if (e < 0) { t = t.slice(0, s); break; }
    t = t.slice(0, s) + t.slice(e + 1);
  }
  // 移除 [SPOTLIGHT ...] 标记
  while (true) {
    const s = t.indexOf('[SPOTLIGHT ');
    if (s < 0) break;
    const e = t.indexOf(']', s);
    if (e < 0) { t = t.slice(0, s); break; }
    t = t.slice(0, s) + t.slice(e + 1);
  }
  // 移除 [CLICK ...] 标记
  while (true) {
    const s = t.indexOf('[CLICK ');
    if (s < 0) break;
    const e = t.indexOf(']', s);
    if (e < 0) { t = t.slice(0, s); break; }
    t = t.slice(0, s) + t.slice(e + 1);
  }
  // 移除 [LASER:...] 标记
  while (true) {
    const s = t.indexOf('[LASER:');
    if (s < 0) break;
    const e = t.indexOf(']', s);
    if (e < 0) { t = t.slice(0, s); break; }
    t = t.slice(0, s) + t.slice(e + 1);
  }
  return t;
}
// ── Click actions ────────────────────────────────────────────────────────────
function applyClicks(iframe, items) {
  var doc = iframe.contentDocument;
  if (!doc) return;
  for (var i = 0; i < items.length; i++) {
    var el = doc.getElementById(items[i].elementId);
    if (!el) continue;
    el.click();
  }
}

// ── Spotlight / Laser overlay ────────────────────────────────────────────────
let spotlightTimer = null;
var spotlightOriginals = [];

function applySpotlights(iframe, items) {
  clearSpotlight();
  var doc = iframe.contentDocument;
  if (!doc) { console.log('[applySpotlights] no contentDocument'); return; }
  for (var i = 0; i < items.length; i++) {
    var el = doc.getElementById(items[i].elementId);
    if (!el) { console.log('[applySpotlights] element not found:', items[i].elementId); continue; }
    var tag = el.tagName.toLowerCase();
    // Save original styles for restoration
    var orig = {
      el: el,
      stroke: el.getAttribute('stroke'),
      fill: el.getAttribute('fill'),
      strokeWidth: el.getAttribute('stroke-width'),
      opacity: el.getAttribute('opacity'),
      styleOpacity: el.style.opacity,
      fillOpacity: el.getAttribute('fill-opacity'),
      filter: el.style.filter,
      transition: el.style.transition,
      outline: el.style.outline,
      boxShadow: el.style.boxShadow,
      borderColor: el.style.borderColor,
      background: el.style.background,
    };
    spotlightOriginals.push(orig);
    var isShape = (tag === 'polygon' || tag === 'path' || tag === 'ellipse' || tag === 'rect');
    var isLine = (tag === 'line' || tag === 'polyline');
    var isHtmlElement = (tag === 'button' || tag === 'a' || tag === 'div' || tag === 'span');
    var highlightColor = '#ff6d00'; // orange
    // Highlight HTML elements (buttons etc.) with outline/glow, no click
    if (isHtmlElement) {
      el.style.outline = '3px solid ' + highlightColor;
      el.style.boxShadow = '0 0 8px ' + highlightColor;
      el.style.transition = 'all 0.3s ease';
      continue;
    }
    // Make hidden elements visible (override inline style="opacity:0")
    var curOpacity = parseFloat(el.style.opacity);
    if (isNaN(curOpacity)) curOpacity = parseFloat(el.getAttribute('opacity'));
    if (isNaN(curOpacity) || curOpacity === 0) {
      el.style.opacity = '1';
    }
    // Apply highlight
    if (isShape && el.getAttribute('fill') && el.getAttribute('fill') !== 'none') {
      el.setAttribute('fill', highlightColor);
      el.setAttribute('fill-opacity', '0.35');
    }
    if (el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
      el.setAttribute('stroke', highlightColor);
      var sw = parseFloat(el.getAttribute('stroke-width')) || 1.5;
      el.setAttribute('stroke-width', String(sw * 2));
    }
    if (isLine) {
      if (orig.fill === 'none' || !orig.fill) el.setAttribute('fill', 'none');
    }
    el.style.filter = 'drop-shadow(0 0 4px ' + highlightColor + ')';
    el.style.transition = 'all 0.3s ease';
  }
  spotlightTimer = setTimeout(clearSpotlight, 5000);
}

function clearSpotlight() {
  clearTimeout(spotlightTimer);
  for (var i = 0; i < spotlightOriginals.length; i++) {
    var o = spotlightOriginals[i];
    var el = o.el;
    // Restore original attributes
    if (o.stroke !== null) el.setAttribute('stroke', o.stroke); else el.removeAttribute('stroke');
    if (o.fill !== null) el.setAttribute('fill', o.fill); else el.removeAttribute('fill');
    if (o.strokeWidth !== null) el.setAttribute('stroke-width', o.strokeWidth); else el.removeAttribute('stroke-width');
    if (o.opacity !== null) el.setAttribute('opacity', o.opacity); else el.removeAttribute('opacity');
    el.style.opacity = o.styleOpacity || '';
    if (o.fillOpacity !== null) el.setAttribute('fill-opacity', o.fillOpacity); else el.removeAttribute('fill-opacity');
    el.style.filter = o.filter || '';
    el.style.transition = o.transition || '';
    el.style.outline = o.outline || '';
    el.style.boxShadow = o.boxShadow || '';
  }
  spotlightOriginals = [];
}

function renderAIText(text, triggerScenes = false) {
  if (triggerScenes) {
    const names = extractSceneNames(text);
    if (names.length > 0) {
      const lastName = names[names.length - 1];
      if (currentScenes.find(s => s.name === lastName)) showScene(lastName);
    }
    // Click buttons first (e.g. view-switch), then spotlight visual elements
    const clicks = extractClicks(text);
    const spotlights = extractSpotlights(text);
    const iframe = document.getElementById('guide-scene-iframe');
    if (iframe && iframe.contentDocument) {
      // Phase 1: Click buttons
      if (clicks.length) {
        applyClicks(iframe, clicks);
      }
      // Phase 2: Spotlight visual elements (after clicks have taken effect)
      if (spotlights.length) {
        applySpotlights(iframe, spotlights);
      }
    } else if (clicks.length || spotlights.length) {
      // iframe not ready yet, retry
      const retry = () => {
        const iframe2 = document.getElementById('guide-scene-iframe');
        if (iframe2 && iframe2.contentDocument) {
          if (clicks.length) applyClicks(iframe2, clicks);
          if (spotlights.length) applySpotlights(iframe2, spotlights);
        }
      };
      setTimeout(retry, 500);
    }
  }
  const displayText = stripMarkers(text);
  return cleanLatex(escapeHtml(displayText));
}
function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cleanLatex(t) {
  // 移除 MathJax 不支持的 LaTeX 环境标记
  return t.replace(/\\\\begin\\{(description|enumerate|itemize|figure|table|center|flushleft|flushright|minipage|tabular|array|verbatim|listing)\\}/g, '')
          .replace(/\\\\end\\{(description|enumerate|itemize|figure|table|center|flushleft|flushright|minipage|tabular|array|verbatim|listing)\\}/g, '')
          .replace(/\\\\item\\b/g, '• ');
}

// ── OCR 识别 ──────────────────────────────────────────────────────────────────

// 粘贴图片监听：q-input / grade-q-input / grade-input 都支持 Ctrl+V 粘贴图片
document.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imgItem = items.find(i => i.type.startsWith('image/'));
  if (!imgItem) return;

  // 找当前焦点在哪个输入框
  const active = document.activeElement;
  const map = {
    'q-input':       { statusId: 'ocr-q-status',          type: 'question' },
    'grade-q-input': { statusId: 'ocr-grade-q-status',    type: 'question' },
    'grade-input':   { statusId: 'ocr-grade-ans-status',  type: 'answer'   },
  };
  const cfg = active?.id && map[active.id];
  if (!cfg) return;   // 焦点不在目标输入框，忽略

  e.preventDefault();
  const blob = imgItem.getAsFile();
  if (!blob) return;

  // 如果是 grade-q-input，同时保存图片 base64 用于直接批改
  if (active.id === 'grade-q-input') {
    const b64 = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
    gradeQImageB64 = b64;
    const imgEl = document.getElementById('grade-q-img');
    imgEl.src = 'data:image/png;base64,' + b64;
    document.getElementById('grade-q-img-wrap').style.display = 'block';
  }

  await ocrBlob(blob, active.id, cfg.statusId, cfg.type);
});

async function ocrBlob(blob, targetId, statusId, type) {
  const status = document.getElementById(statusId);
  status.textContent = '识别中...'; status.className = 'status';

  const b64 = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });

  const prompt = type === 'answer'
    ? '请识别图片中的所有文字内容，原样输出。'
    : '请识别图片中的题目文字，数学公式和符号用 LaTeX 格式输出（用 $ 包裹行内公式），原样保留文字结构。';
  let data;
  try {
    const r = await apiFetch('api/ocr', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ image: b64, prompt })
    });
    data = await r.json();
  } catch {
    status.textContent = '识别失败'; status.className = 'status err'; return;
  }

  if (data.error) {
    status.textContent = '识别失败：' + data.error.slice(0, 40);
    status.className = 'status err'; return;
  }

  const textarea = document.getElementById(targetId);
  textarea.value = textarea.value ? textarea.value + '\\n' + data.text : data.text;
  status.textContent = '✓ 识别完成'; status.className = 'status ok';
  if (targetId === 'q-input' && data.imagePath) currentOcrImagePath = data.imagePath;
}

async function ocrImage(input, targetId, type) {
  const file = input.files[0]; if (!file) return;
  const statusId = targetId === 'q-input' ? 'ocr-q-status'
    : targetId === 'grade-q-input' ? 'ocr-grade-q-status' : 'ocr-grade-ans-status';
  await ocrBlob(file, targetId, statusId, type);
  input.value = '';
}

async function sendAI(msg) {
  if (streaming) return; streaming = true;
  history.push({role:'user',content:msg});
  const msgs = document.getElementById('messages');
  const row = document.createElement('div'); row.className = 'msg-row ai';
  const avatar = document.createElement('img'); avatar.className = 'msg-avatar';
  avatar.src = AVATAR_THINKING;
  updateFabAvatar(AVATAR_THINKING);
  row.appendChild(avatar);
  const div = document.createElement('div'); div.className='msg ai'; div.textContent='...';
  row.appendChild(div);
  msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight;
  try {

  const resp = await apiFetch('api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({index:currentIndex,history:history.slice(0,-1),userMessage:msg,profile:userProfile})});

  // 立即从响应头获取 ttsSessionId，启动音频轮询（与文字流并行）
  const ttsSessionId = resp.headers.get('X-TTS-Session');
  currentAudioStopped = false;

  // 流式音频播放：通过 SSE 接收音频数据，用 Web Audio API 无缝播放
  const audioTask = (async () => {
    if (!autoRead || !ttsSessionId) return;
    try {
      const streamResp = await fetch('api/tts-stream-direct/' + ttsSessionId, {
        headers: { 'x-session-token': sessionToken }
      });
      if (!streamResp.ok || !streamResp.body) return;

      const ctx = new AudioContext();
      await ctx.resume();
      let nextStartTime = 0;
      const reader = streamResp.body.getReader();
      const textDec = new TextDecoder();
      let sseBuf = '';

      while (!currentAudioStopped) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += textDec.decode(value, { stream: true });
        const lines = sseBuf.split('\\n');
        sseBuf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.chunkEnd || obj.error) continue;
            if (obj.done) break;
            if (!obj.audio) continue;

            // base64 → 二进制 → AudioBuffer
            const binary = atob(obj.audio);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            try {
              const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              const startAt = Math.max(nextStartTime, ctx.currentTime);
              source.start(startAt);
              nextStartTime = startAt + audioBuffer.duration;
              avatar.src = AVATAR_EXPLAINING;
              updateFabAvatar(AVATAR_EXPLAINING);
              currentAudio = source;
            } catch (e) { console.warn('[TTS] decodeAudioData failed:', e); }
          } catch {}
        }
      }
      // 等所有已调度的音频播完再关闭 AudioContext
      if (nextStartTime > ctx.currentTime) {
        await new Promise(r => setTimeout(r, (nextStartTime - ctx.currentTime) * 1000 + 200));
      }
      ctx.close();
    } catch (e) {
      console.warn('[TTS] stream error:', e);
    }
  })();

  // 文字流读取（与音频并行）
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let full='',buf='';
  let firstChunk = true;
  while(true){
    const{done,value}=await reader.read(); if(done)break;
    buf+=dec.decode(value,{stream:true}); const lines=buf.split('\\n'); buf=lines.pop();
    for(const l of lines){
      if(!l.startsWith('data: '))continue; const p=l.slice(6);
      try{
        const evt=JSON.parse(p);
        if(evt.delta){
          if(firstChunk){ if(!autoRead || !ttsSessionId){ avatar.src = AVATAR_EXPLAINING; updateFabAvatar(AVATAR_EXPLAINING); } firstChunk = false; }
          full+=evt.delta;div.innerHTML=renderAIText(full,false);msgs.scrollTop=msgs.scrollHeight;
        }
        if(evt.keypoint){ appendKeypoint(evt.keypoint); }
      }catch{}
    }
  }
  // 文字流结束
  renderAIText(full, true);
  div.innerHTML = renderAIText(full, false);
  if(window.MathJax)MathJax.typesetPromise([div]);
  const ttsBtn = addTTSButton(div, full);

  history.push({role:'assistant',content:full});

  // 音频继续异步播放，不阻塞 streaming
  audioTask.then(() => {
    avatar.src = AVATAR_LISTENING;
    updateFabAvatar(AVATAR_LISTENING);
  });

  } catch(e) {
    div.textContent = '请求失败，请重试。';
    avatar.src = AVATAR_LISTENING; updateFabAvatar(AVATAR_LISTENING);
  } finally {
    streaming = false;
    document.getElementById('reply-input').focus();
  }
}

// ── 题目批改 ──────────────────────────────────────────────────────────────────
function resetGrade() {
  gradeIndex = null; gradeResult = ''; gradeQImageB64 = null;
  document.getElementById('grade-q-input').value = '';
  document.getElementById('grade-q-input').disabled = false;
  document.getElementById('grade-search-btn').disabled = false;
  document.getElementById('grade-search-btn').style.display = '';
  document.getElementById('grade-reset-btn').style.display = 'none';
  document.getElementById('grade-add-mistake-btn').style.display = 'none';
  document.getElementById('grade-to-guide-btn').style.display = 'none';
  document.getElementById('grade-status').textContent = '';
  document.getElementById('grade-placeholder').style.display = 'block';
  document.getElementById('grade-input-wrap').style.display = 'none';
  document.getElementById('grade-input').value = '';
  document.getElementById('grade-result').style.display = 'none';
  document.getElementById('grade-result').innerHTML = '';
  document.getElementById('grade-q-img-wrap').style.display = 'none';
  document.getElementById('grade-q-img').src = '';
}

function removeGradeQImg() {
  gradeQImageB64 = null;
  document.getElementById('grade-q-img-wrap').style.display = 'none';
  document.getElementById('grade-q-img').src = '';
}

async function searchForGrade() {
  const q = document.getElementById('grade-q-input').value.trim(); if (!q) return;
  const status = document.getElementById('grade-status');
  document.getElementById('grade-search-btn').disabled = true;
  status.textContent = '检索中...'; status.className = 'status';
  let data;
  try {
    const r = await apiFetch('api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});
    data = await r.json();
  } catch { status.textContent = '连接失败'; status.className = 'status err'; document.getElementById('grade-search-btn').disabled=false; return; }
  if (!data.found) { status.textContent = '未找到题目'; status.className = 'status err'; document.getElementById('grade-search-btn').disabled=false; return; }
  gradeIndex = data.index;
  status.textContent = \`✓ #\${data.index} \${data.subject} \${data.difficulty}\`; status.className = 'status ok';
  document.getElementById('grade-q-input').disabled = true;
  document.getElementById('grade-search-btn').style.display = 'none';
  document.getElementById('grade-add-mistake-btn').style.display = '';
  document.getElementById('grade-reset-btn').style.display = '';
  document.getElementById('grade-placeholder').style.display = 'none';
  document.getElementById('grade-input-wrap').style.display = 'flex';
}

function clearGrade() {
  document.getElementById('grade-input').value = '';
  document.getElementById('grade-result').style.display = 'none';
  document.getElementById('grade-result').textContent = '';
}

async function gradeAnswer() {
  const ans = document.getElementById('grade-input').value.trim(); if (!ans) return;
  const q = document.getElementById('grade-q-input').value.trim();
  if (!gradeIndex && !q) return;  // 必须有题目（检索的或直接输入的）
  document.getElementById('grade-btn').disabled = true;
  const result = document.getElementById('grade-result');
  result.style.display = 'block'; result.innerHTML = '<div style="color:var(--text-sub);text-align:center;padding:20px;">批改中...</div>';

  const body = gradeIndex
    ? { index: gradeIndex, studentAnswer: ans }
    : { question: q, questionImage: gradeQImageB64 || undefined, studentAnswer: ans };

  const resp = await apiFetch('api/grade',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)});
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let full='',buf=''; result.textContent='';
  while(true){
    const{done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true}); const lines=buf.split('\\n'); buf=lines.pop();
    for(const l of lines){
      if(!l.startsWith('data: '))continue; const p=l.slice(6); if(p==='[DONE]')continue;
      try{const{delta}=JSON.parse(p);if(delta){full+=delta;result.textContent=full;}}catch{}
    }
  }
  // 解析 XML 并渲染为结构化卡片
  result.innerHTML = renderGradeXML(full);
  if(window.MathJax)MathJax.typesetPromise([result]);
  gradeResult = full;
  document.getElementById('grade-add-mistake-btn').style.display = '';
  document.getElementById('grade-to-guide-btn').style.display = '';
  document.getElementById('grade-btn').disabled=false;
}

function renderGradeXML(raw) {
  // 清理：去掉 markdown 代码块包裹和前后多余文字
  let xml = raw;
  const resultMatch = xml.match(/<result>[\\s\\S]*<\\/result>/);
  if (resultMatch) xml = resultMatch[0];
  xml = xml.replace(/\`\`\`xml/g, '').replace(/\`\`\`/g, '').trim();

  const get = (tag) => {
    const m = xml.match(new RegExp('<' + tag + '>([\\\\s\\\\S]*?)</' + tag + '>'));
    return m ? m[1].trim() : '';
  };
  const getItems = (tag) => {
    const block = get(tag);
    const items = [];
    const re = /<item>([\\s\\S]*?)<\\/item>/g;
    let m;
    while ((m = re.exec(block)) !== null) items.push(m[1].trim());
    return items;
  };

  const code = get('result_code');
  const isCorrect = code === '200';
  const errorType = get('error_type');
  const judgement = get('one_sentence_judgement');
  const errors = getItems('error_analysis');
  const suggestions = getItems('improvement_suggestions');
  const exercise = get('recommended_exercise');
  const reason = get('recommendation_reason');

  // 如果 XML 解析失败，直接显示原文
  if (!judgement && !errorType) {
    return '<div style="white-space:pre-wrap;line-height:1.85;">' + escapeHtml(xml) + '</div>';
  }

  const statusColor = isCorrect ? 'var(--success)' : 'var(--danger)';
  const statusBg = isCorrect ? 'var(--success-light)' : 'var(--danger-light)';
  const statusIcon = isCorrect ? '✓' : '✗';
  const statusText = isCorrect ? '回答正确' : errorType;

  let html = '';
  // 状态栏
  html += '<div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-radius:12px;background:' + statusBg + ';margin-bottom:14px;">';
  html += '<span style="font-size:1.6rem;color:' + statusColor + ';">' + statusIcon + '</span>';
  html += '<div><div style="font-weight:700;font-size:1rem;color:' + statusColor + ';">' + escapeHtml(statusText) + '</div>';
  html += '<div style="font-size:.88rem;color:var(--text);margin-top:2px;">' + cleanLatex(escapeHtml(judgement)) + '</div></div></div>';

  // 错误分析
  if (errors.length > 0 && !(errors.length === 1 && errors[0] === '无错误')) {
    html += '<div style="margin-bottom:12px;"><div style="font-weight:700;font-size:.88rem;color:var(--danger);margin-bottom:6px;">错误分析</div>';
    errors.forEach(e => {
      html += '<div style="padding:8px 12px;background:#fff5f5;border-left:3px solid var(--danger);border-radius:6px;margin-bottom:6px;font-size:.88rem;line-height:1.7;">' + cleanLatex(escapeHtml(e)) + '</div>';
    });
    html += '</div>';
  }

  // 改进建议
  if (suggestions.length > 0) {
    html += '<div style="margin-bottom:12px;"><div style="font-weight:700;font-size:.88rem;color:var(--primary);margin-bottom:6px;">改进建议</div>';
    suggestions.forEach((s, i) => {
      html += '<div style="padding:8px 12px;background:var(--primary-light);border-radius:6px;margin-bottom:6px;font-size:.88rem;line-height:1.7;">' + (i+1) + '. ' + cleanLatex(escapeHtml(s)) + '</div>';
    });
    html += '</div>';
  }

  // 推荐习题
  if (exercise) {
    html += '<div style="margin-bottom:8px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;">';
    html += '<div style="font-weight:700;font-size:.88rem;color:#92400e;margin-bottom:6px;">推荐练习</div>';
    html += '<div style="font-size:.9rem;line-height:1.8;color:var(--text);">' + cleanLatex(escapeHtml(exercise)) + '</div>';
    if (reason) html += '<div style="font-size:.82rem;color:var(--text-sub);margin-top:6px;">' + cleanLatex(escapeHtml(reason)) + '</div>';
    html += '</div>';
  }

  return html;
}

// ── 出题 ──────────────────────────────────────────────────────────────────────

// 浏览状态
let browseSubjects = []; // 全量数据缓存
let browseCurrentSubject = null;

async function initBrowse() {
  const content = document.getElementById('browse-content');
  content.innerHTML = '<div class="placeholder">加载中...</div>';
  if (!browseSubjects.length) {
    try {
      const r = await apiFetch('api/subjects');
      const d = await r.json();
      browseSubjects = d.subjects || [];
    } catch {
      content.innerHTML = '<div class="placeholder">加载失败，请刷新重试</div>';
      return;
    }
  }
  showSubjectGrid();
}

function showSubjectGrid() {
  browseCurrentSubject = null;
  const crumb = document.getElementById('browse-breadcrumb');
  crumb.style.display = 'none';
  const content = document.getElementById('browse-content');
  document.getElementById('similar-status').textContent = '';
  if (!browseSubjects.length) {
    content.innerHTML = '<div class="placeholder">暂无题目数据</div>'; return;
  }
  content.innerHTML = \`
    <div class="browse-section-title">选择学科</div>
    <div class="subject-grid">
      \${browseSubjects.map(s => \`
        <div class="subject-card" onclick="showSubjectQuestions('\${s.subject}')">
          <div class="subject-card-name">\${s.label}</div>
          <div class="subject-card-count">\${s.count} 道题</div>
        </div>
      \`).join('')}
    </div>
  \`;
}

async function showSubjectQuestions(subject) {
  const s = browseSubjects.find(x => x.subject === subject);
  const crumb = document.getElementById('browse-breadcrumb');
  crumb.style.display = 'flex';
  crumb.innerHTML = \`<span class="crumb" onclick="showSubjectGrid()">全部学科</span> › <span>\${s?.label||subject}</span>\`;
  const content = document.getElementById('browse-content');
  const status = document.getElementById('similar-status');
  content.innerHTML = '<div class="placeholder">加载中...</div>';
  status.textContent = '';
  let data;
  try {
    const r = await apiFetch('api/similar', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({subject})});
    data = await r.json();
  } catch {
    content.innerHTML = '<div class="placeholder">加载失败</div>'; return;
  }
  if (!data.results?.length) {
    content.innerHTML = '<div class="placeholder">暂无题目</div>'; return;
  }
  status.textContent = \`共 \${data.results.length} 道\`; status.className = 'status ok';
  const diffTag = d => d==='难'?'<span class="tag tag-hard">难</span>':d==='较难'?'<span class="tag tag-medium">较难</span>':'<span class="tag tag-easy">'+d+'</span>';
  content.innerHTML = \`
    <div class="browse-section-title">\${s?.label||subject}</div>
    \${data.results.map(q => \`
      <div class="q-card" onclick="loadAndGo(\${q.index})">
        <div class="q-meta"><span>\${q.type}</span>\${diffTag(q.difficulty)}\${q.hasDoc?'<span style="color:var(--primary)">有图解</span>':''}</div>
        <div class="q-text">\${escapeHtml(q.question.slice(0,120))}\${q.question.length>120?'...':''}</div>
        <div class="q-kp">📌 \${q.knowledge_point.filter(k=>k.split(';').pop()?.trim()).map(k=>escapeHtml(k.split(';').pop().trim())).join('、')||'—'}</div>
      </div>
    \`).join('')}
  \`;
  if (window.MathJax) MathJax.typesetPromise([content]);
}

async function findSimilar(mode) {
  const status = document.getElementById('similar-status');
  const content = document.getElementById('browse-content');
  const crumb = document.getElementById('browse-breadcrumb');
  status.textContent='搜索中...'; status.className='status'; content.innerHTML='';
  let reqBody={};
  if (mode==='kp') {
    const kp=document.getElementById('kp-input').value.trim();
    if(!kp){status.textContent='请输入知识点';status.className='status err';return;}
    reqBody={knowledge_point:kp.split(/[,，、;；]+/).map(s=>s.trim()).filter(Boolean),topN:8};
  } else {
    if(!currentIndex)return; reqBody={index:currentIndex,topN:8};
  }
  let data;
  try{
    const r=await apiFetch('api/similar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reqBody)});
    data=await r.json();
  }catch{status.textContent='请求失败';status.className='status err';return;}
  if(!data.results?.length){status.textContent='未找到相关题目';status.className='status err';return;}
  status.textContent=\`共 \${data.results.length} 道\`; status.className='status ok';
  // 更新面包屑为搜索结果
  crumb.style.display='flex';
  crumb.innerHTML=\`<span class="crumb" onclick="showSubjectGrid()">全部学科</span> › <span>搜索结果</span>\`;
  const diffTag=d=>d==='难'?'<span class="tag tag-hard">难</span>':d==='较难'?'<span class="tag tag-medium">较难</span>':'<span class="tag tag-easy">'+d+'</span>';
  content.innerHTML=data.results.map(q=>\`
    <div class="q-card" onclick="loadAndGo(\${q.index})">
      <div class="q-meta"><span>\${q.subject}</span><span>\${q.type}</span>\${diffTag(q.difficulty)}\${q.hasDoc?'<span style="color:var(--primary)">有图解</span>':''}</div>
      <div class="q-text">\${escapeHtml(q.question.slice(0,120))}\${q.question.length>120?'...':''}</div>
      <div class="q-kp">📌 \${q.knowledge_point.join('、')||'—'}</div>
    </div>
  \`).join('');
  if(window.MathJax)MathJax.typesetPromise([content]);
}

async function loadAndGo(index) {
  document.getElementById('inline-similar').style.display = 'none';
  enterView('guide');
  if (currentIndex!==null) resetGuide();
  const status=document.getElementById('match-info');
  document.getElementById('search-btn').disabled=true;
  status.textContent='加载中...'; status.className='status';
  let data;
  try{
    const r=await apiFetch('api/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index})});
    data=await r.json();
  }catch{status.textContent='加载失败';status.className='status err';document.getElementById('search-btn').disabled=false;return;}
  currentIndex=data.index; currentScenes=data.scenes; currentKP=data.knowledge_point||[]; currentQuestion=data.question;
  renderSceneTabs();
  document.getElementById('q-input').value=data.question; document.getElementById('q-input').disabled=true;
  status.textContent=\`✓ #\${data.index} \${data.subject} \${data.difficulty} \${currentKP.join('、')}\`; status.className='status ok';
  document.getElementById('search-btn').style.display='none';
  ['reset-btn','guide-btn','similar-cur-btn','guide-add-mistake-btn','topbar-toggle-btn'].forEach(id=>document.getElementById(id).style.display='');
  resetMistakeBtn('guide-add-mistake-btn');
  if(data.problemImgUrl) showProblemImg(data.problemImgUrl);
  startPractice();
  history=[];
  // 如果从批改页跳转来的，自动开始讲题
  if (gradeContext) startGuide();
}

// ── 错题本 ────────────────────────────────────────────────────────────────────
function resetMistakeBtn(id) {
  const btn = document.getElementById(id);
  btn.textContent = '加入错题本';
  btn.disabled = false;
  btn.style.background = '';
  btn.style.color = '';
  btn.style.borderColor = '';
}

async function addMistake(source) {
  const idx = source === 'grade' ? gradeIndex : currentIndex;
  const btn = document.getElementById(source === 'grade' ? 'grade-add-mistake-btn' : 'guide-add-mistake-btn');
  btn.disabled = true; btn.textContent = '保存中...';

  // 生成中 currentIndex 还没有，用 question 文本加入
  const q = document.getElementById('q-input')?.value?.trim();
  const body = {
    index: (idx || idx === 0) ? idx : undefined,
    question: (!idx && idx !== 0 && source === 'guide') ? q : undefined,
    imagePath: (!idx && idx !== 0 && source === 'guide') ? (currentOcrImagePath || undefined) : undefined,
    studentAnswer: source === 'grade' ? (document.getElementById('grade-input').value.trim() || undefined) : undefined,
    gradeResult: source === 'grade' ? (gradeResult || undefined) : undefined,
    note: source === 'guide' ? (history.length > 0 ? JSON.stringify(history) : undefined) : undefined,
  };

  try {
    const r = await apiFetch('api/mistakes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d = await r.json();
    btn.textContent = d.updated ? '✓ 已更新' : '✓ 已加入';
    btn.style.background = '#dcfce7'; btn.style.color = 'var(--success)'; btn.style.borderColor = '#86efac';
  } catch {
    btn.textContent = '加入错题本'; btn.disabled = false;
  }
}

async function loadMistakesList() {
  const body = document.getElementById('mistakes-body');
  const placeholder = document.getElementById('mistakes-placeholder');
  body.innerHTML = '<div class="placeholder">加载中...</div>';
  let list;
  try {
    const r = await apiFetch('api/mistakes'); list = await r.json();
  } catch { body.innerHTML = '<div class="placeholder">加载失败</div>'; return; }
  if (!list.length) {
    body.innerHTML = ''; body.appendChild(placeholder); placeholder.style.display = 'block'; return;
  }
  document.getElementById('mistakes-count').textContent = \`共 \${list.length} 道\`;
  const diffTag = d => d==='难'?'<span style="background:#fee2e2;color:var(--danger);padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">难</span>'
    : d==='较难'?'<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">较难</span>'
    : '<span style="background:#dcfce7;color:var(--success);padding:2px 7px;border-radius:6px;font-size:.74rem;font-weight:600">'+d+'</span>';
  body.innerHTML = list.map(m => \`
    <div class="mistake-card" onclick="openDetail('\${m.id}')">
      <div class="mistake-meta">
        <span>\${m.subject}</span><span>\${m.type}</span>\${diffTag(m.difficulty)}
        \${m.gradeResult ? '<span style="background:#dcfce7;color:var(--success)">有批改记录</span>' : ''}
        \${m.hasDoc ? '<span style="background:var(--success-light);color:var(--success)">有讲解</span>' : '<span style="background:var(--warning-light);color:#b47800">待生成</span>'}
        <span class="mistake-date">\${new Date(m.addedAt).toLocaleDateString('zh-CN')}</span>
      </div>
      <div class="mistake-text">\${escapeHtml(m.question.slice(0,100))}\${m.question.length>100?'...':''}</div>
      <div style="font-size:.76rem;color:var(--primary);margin-top:5px;">📌 \${m.knowledge_point.join('、')||'—'}</div>
    </div>
  \`).join('');
  if(window.MathJax) MathJax.typesetPromise([body]);
}

let _mistakesList = [];

async function openDetail(id) {
  const r = await apiFetch('api/mistakes'); _mistakesList = await r.json();
  const m = _mistakesList.find(x => x.id === id); if (!m) return;
  currentMistakeId = id;
  document.getElementById('detail-title').textContent = \`错题 #\${m.index} \${m.subject}\`;
  document.getElementById('detail-q').textContent = m.question;
  document.getElementById('detail-guide-btn').onclick = () => { closeDetail(); loadAndGo(m.index); };
  document.getElementById('detail-delete-btn').dataset.id = id;
  const analysis = document.getElementById('detail-analysis');
  analysis.style.display = 'none'; analysis.textContent = '';
  document.getElementById('detail-analyze-btn').textContent = 'AI 深度分析';
  document.getElementById('detail-analyze-btn').disabled = false;
  // 按 hasDoc 控制按钮显示
  document.getElementById('detail-guide-btn').style.display = m.hasDoc ? '' : 'none';
  document.getElementById('detail-gen-btn').style.display = m.hasDoc ? 'none' : '';
  document.getElementById('detail-gen-btn').disabled = false;
  document.getElementById('detail-gen-btn').textContent = m.hasDoc ? '生成讲解材料' : '继续生成讲解材料';
  document.getElementById('detail-gen-progress-wrap').classList.remove('visible');
  // 保存当前 mistake 的 question 供生成用
  document.getElementById('detail-gen-btn').dataset.question = m.question;
  document.getElementById('detail-gen-btn').dataset.index = m.index;
  const detail = document.getElementById('mistake-detail');
  detail.style.display = 'flex';
  if(window.MathJax) MathJax.typesetPromise([document.getElementById('detail-q')]);
}

function closeDetail() {
  document.getElementById('mistake-detail').style.display = 'none';
  document.getElementById('detail-gen-progress-wrap').classList.remove('visible');
  currentMistakeId = null;
}

async function generateDocFromMistake() {
  const btn = document.getElementById('detail-gen-btn');
  const question = btn.dataset.question;
  if (!question) return;

  const progressWrap = document.getElementById('detail-gen-progress-wrap');
  const progressBar = document.getElementById('detail-gen-progress-bar');
  const progressLabel = document.getElementById('detail-gen-progress-label');
  const setProgress = (pct, msg) => {
    progressBar.style.width = pct + '%';
    progressLabel.textContent = msg || '';
  };

  btn.disabled = true; btn.textContent = '生成中...';
  progressWrap.classList.add('visible');
  setProgress(5, '启动 AI 合成...');

  try {
    const resp = await apiFetch('api/generate-doc', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ question })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      progressLabel.textContent = '请求失败：' + (err.error || resp.status);
      btn.disabled = false; btn.textContent = '重试生成'; return;
    }

    const { taskId } = await resp.json();
    if (!taskId) { progressLabel.textContent = '启动失败'; btn.disabled = false; btn.textContent = '重试生成'; return; }

    // 轮询进度
    let pct = 10;
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      let st;
      try {
        const r2 = await apiFetch('api/generate-doc/status/' + taskId);
        if (r2.status === 404) {
          progressLabel.textContent = '任务不存在，请重试';
          progressWrap.classList.remove('visible');
          btn.disabled = false; btn.textContent = '重试生成'; return;
        }
        st = await r2.json();
      } catch(e) { continue; }

      if (st.status === 'error') {
        progressLabel.textContent = '失败：' + st.msg;
        progressWrap.classList.remove('visible');
        btn.disabled = false; btn.textContent = '重试生成'; return;
      }
      if (st.status === 'done') {
        if (!st.hasDoc) {
          progressLabel.textContent = '生成失败，未产生讲解文件，请重试';
          btn.disabled = false; btn.textContent = '重试生成'; return;
        }
        setProgress(100, '完成！');
        setTimeout(() => progressWrap.classList.remove('visible'), 1000);
        btn.style.display = 'none';
        document.getElementById('detail-guide-btn').style.display = '';
        document.getElementById('detail-guide-btn').onclick = () => { closeDetail(); loadAndGo(st.index); };
        loadMistakesList();
        return;
      }
      // running
      pct = Math.min(pct + 5, 90);
      setProgress(pct, st.msg || '生成中...');
    }
  } catch (e) {
    progressLabel.textContent = '请求失败：' + e;
    progressWrap.classList.remove('visible');
    btn.disabled = false; btn.textContent = '重试生成';
  }
}

async function analyzeMistake() {
  if (!currentMistakeId) return;
  const btn = document.getElementById('detail-analyze-btn');
  btn.disabled = true; btn.textContent = '分析中...';
  const analysis = document.getElementById('detail-analysis');
  analysis.style.display = 'block'; analysis.textContent = '';

  const resp = await apiFetch('api/mistakes/analyze', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:currentMistakeId,profile:userProfile})});
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let full='',buf='';
  while(true){
    const{done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true}); const lines=buf.split('\\n'); buf=lines.pop();
    for(const l of lines){
      if(!l.startsWith('data: '))continue; const p=l.slice(6); if(p==='[DONE]')continue;
      try{const{delta}=JSON.parse(p);if(delta){full+=delta;analysis.textContent=full;}}catch{}
    }
  }
  if(window.MathJax) MathJax.typesetPromise([analysis]);
  btn.textContent = '重新分析'; btn.disabled = false;
}

async function deleteMistake() {
  if (!currentMistakeId) return;
  if (!confirm('确认移出错题本？')) return;
  await apiFetch(\`api/mistakes/\${currentMistakeId}\`, {method:'DELETE'});
  closeDetail();
  loadMistakesList();
}

// ── TTS 语音播放 ─────────────────────────────────────────────────────────────
let autoRead = true;
let currentAudio = null;
let currentAudioStopped = false;

function stopCurrentAudio() {
  currentAudioStopped = true;
  if (currentAudio) {
    try { currentAudio.pause ? currentAudio.pause() : currentAudio.stop(); } catch {}
    currentAudio = null;
  }
}

function toggleAutoRead() {
  autoRead = document.getElementById('auto-read-toggle').checked;
}

// 将文本拆分为短句
function splitTTSSentences(text) {
  // 按句号、问号、感叹号、换行等拆分，保留标点
  const raw = text
    .replace(/\\[SHOW_SCENE\\s+scene\\d+\\]/g, '')
    .replace(/\\[scene\\d+\\]/g, '')
    .replace(/\\[\\d+\\]/g, '');
  const parts = raw.match(/[^。！？；\\n]*[。！？；\\n]|[^。！？；\\n]+$/g) || [raw];
  // 合并过短的句子（< 5字的和下一句合并）
  const merged = [];
  let buf = '';
  for (const p of parts) {
    buf += p;
    if (buf.length >= 15) { merged.push(buf); buf = ''; }
  }
  if (buf) { if (merged.length > 0 && merged[merged.length-1].length < 30) merged[merged.length-1] += buf; else merged.push(buf); }
  return merged.length > 0 ? merged : [raw];
}

let ttsAbort = null;

async function playTTS(text, btn) {
  // 找到对应的头像元素
  const row = btn.closest('.msg-row');
  const avatar = row ? row.querySelector('.msg-avatar') : null;

  // 停止当前播放
  stopCurrentAudio();
  if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }
  // 如果正在播放同一个，点击就停止
  if (btn.classList.contains('playing')) {
    btn.classList.remove('playing');
    btn.innerHTML = '🔊 播放';
    if (avatar) avatar.src = AVATAR_LISTENING;
    updateFabAvatar(AVATAR_LISTENING);
    return;
  }
  // 重置所有播放按钮和头像
  document.querySelectorAll('.tts-btn.playing').forEach(b => {
    b.classList.remove('playing'); b.innerHTML = '🔊 播放';
  });
  document.querySelectorAll('.msg-row.ai .msg-avatar').forEach(a => { a.src = AVATAR_LISTENING; });

  if (avatar) avatar.src = AVATAR_EXPLAINING;
  updateFabAvatar(AVATAR_EXPLAINING);
  const sentences = splitTTSSentences(text);
  const abort = new AbortController();
  ttsAbort = abort;
  currentAudioStopped = false;
  btn.disabled = true; btn.innerHTML = '⏳ 加载...';

  try {
    // 创建 AudioContext（在用户点击手势中创建，避免 autoplay 限制）
    const ctx = new AudioContext();
    await ctx.resume();
    let nextStartTime = 0;

    for (let i = 0; i < sentences.length; i++) {
      if (abort.signal.aborted || currentAudioStopped) break;

      // 为每段句子创建流式 TTS 会话
      const sessId = "tts-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      // 先在服务端触发流式合成
      const startResp = await fetch('api/tts-stream-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ text: sentences[i], sid: sessId }),
        signal: abort.signal,
      });
      if (!startResp.ok) continue;

      // 通过 SSE 接收流式音频数据
      const streamResp = await fetch('api/tts-stream-direct/' + sessId, {
        headers: { 'x-session-token': sessionToken },
        signal: abort.signal,
      });
      if (!streamResp.ok || !streamResp.body) continue;

      const reader = streamResp.body.getReader();
      const textDec = new TextDecoder();
      let sseBuf = '';

      while (!abort.signal.aborted && !currentAudioStopped) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += textDec.decode(value, { stream: true });
        const lines = sseBuf.split('\\n');
        sseBuf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.done || obj.chunkEnd || obj.error) continue;
            if (!obj.audio) continue;

            const binary = atob(obj.audio);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
            try {
              const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              const startAt = Math.max(nextStartTime, ctx.currentTime);
              source.start(startAt);
              nextStartTime = startAt + audioBuffer.duration;
              currentAudio = source;
              btn.disabled = false;
              btn.classList.add('playing');
              btn.innerHTML = '⏸ 暂停';
            } catch (e) { console.warn('[TTS] decodeAudioData failed:', e); }
          } catch {}
        }
      }
    }
    // 等所有已调度的音频播完再关闭 AudioContext
    if (nextStartTime > ctx.currentTime) {
      await new Promise(r => setTimeout(r, (nextStartTime - ctx.currentTime) * 1000 + 200));
    }
    ctx.close();
  } catch (e) {
    if (e.name !== 'AbortError') console.error('TTS error:', e);
  }
  btn.disabled = false;
  btn.innerHTML = '🔊 播放';
  btn.classList.remove('playing');
  if (avatar) avatar.src = AVATAR_LISTENING;
  updateFabAvatar(AVATAR_LISTENING);
  currentAudio = null;
  ttsAbort = null;
}

function addTTSButton(msgDiv, text) {
  const btn = document.createElement('button');
  btn.className = 'tts-btn';
  btn.innerHTML = '🔊 播放';
  btn.onclick = () => playTTS(text, btn);
  msgDiv.appendChild(btn);
  return btn;
}

// ── ASR 语音输入（流式分段识别）───────────────────────────────────────────────
let audioCtx = null;
let micStream = null;
let scriptNode = null;
let pcmChunks = [];
let isRecording = false;
let asrTimer = null;
let asrSending = false;

async function toggleMic() {
  if (isRecording) { stopRecording(); return; }
  startRecording();
}

function encodeWAV(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function collectPCM() {
  if (pcmChunks.length === 0) return null;
  let totalLen = 0;
  for (const c of pcmChunks) totalLen += c.length;
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

async function sendASRSegment() {
  if (asrSending || pcmChunks.length === 0) return;
  asrSending = true;
  const rate = audioCtx ? audioCtx.sampleRate : 16000;
  const merged = collectPCM();
  pcmChunks = []; // 清空已取走的数据
  if (!merged) { asrSending = false; return; }
  const wavBlob = encodeWAV(merged, rate);
  try {
    const resp = await fetch('api/asr', {
      method: 'POST',
      headers: { 'x-session-token': sessionToken, 'Content-Type': wavBlob.type },
      body: wavBlob
    });
    const data = await resp.json();
    if (data.text) {
      const inp = document.getElementById('reply-input');
      inp.value = inp.value ? inp.value + data.text : data.text;
      inp.focus();
    }
  } catch (e) {
    console.error('ASR segment error:', e);
  }
  asrSending = false;
}

async function startRecording() {
  const btn = document.getElementById('mic-btn');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(micStream);
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    pcmChunks = [];
    scriptNode.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(data));
    };
    source.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
    isRecording = true;
    btn.classList.add('recording');
    btn.title = '点击停止录音';
    // 每3秒发送一段
    asrTimer = setInterval(() => { sendASRSegment(); }, 1000);
  } catch (e) {
    alert('无法访问麦克风，请检查浏览器权限设置');
    console.error('Mic error:', e);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  const btn = document.getElementById('mic-btn');
  btn.classList.remove('recording');
  btn.title = '语音输入';
  if (asrTimer) { clearInterval(asrTimer); asrTimer = null; }
  if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  const rate = audioCtx ? audioCtx.sampleRate : 16000;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  // 发送最后剩余的音频
  if (pcmChunks.length > 0) {
    const merged = collectPCM();
    pcmChunks = [];
    if (merged) {
      const wavBlob = encodeWAV(merged, rate);
      transcribeAudio(wavBlob);
    }
  }
}

async function transcribeAudio(blob) {
  const btn = document.getElementById('mic-btn');
  btn.disabled = true; btn.title = '识别中...';
  try {
    const resp = await fetch('api/asr', {
      method: 'POST',
      headers: { 'x-session-token': sessionToken, 'Content-Type': blob.type },
      body: blob
    });
    const data = await resp.json();
    if (data.text) {
      const inp = document.getElementById('reply-input');
      inp.value = inp.value ? inp.value + data.text : data.text;
      inp.focus();
    }
  } catch (e) {
    console.error('ASR error:', e);
  }
  btn.disabled = false; btn.title = '语音输入';
}

// ── Profile Modal ─────────────────────────────────────────────────────────────
let userProfile = {};

async function loadUserProfile() {
  try {
    const data = await apiFetch('api/profile').then(r => r.json());
    if (data && !data.error) userProfile = data;
  } catch {}
}

async function openProfileModal() {
  // 每次打开都拉取最新 profile
  try {
    const data = await apiFetch('api/profile').then(r => r.json());
    if (data && !data.error) userProfile = data;
  } catch {}

  // 填充表单
  const p = userProfile;
  document.getElementById('pf-nickname').value = p.nickname || '';
  document.getElementById('pf-bio').value = p.learningGoal || '';
  document.getElementById('pf-bio-count').textContent = (p.learningGoal || '').length;

  // 单选 chips（grade, selfLevel, guidingStyle）
  [['pf-role-chips', p.grade], ['pf-level-chips', p.selfLevel], ['pf-style-chips', p.guidingStyle]].forEach(([id, val]) => {
    document.querySelectorAll('#' + id + ' .pf-chip').forEach(chip => {
      chip.classList.toggle('selected', chip.dataset.val === val);
    });
  });

  // 多选 chips（favoriteSubjects）
  const subs = Array.isArray(p.favoriteSubjects) ? p.favoriteSubjects : [];
  document.querySelectorAll('#pf-subject-chips .pf-chip').forEach(chip => {
    chip.classList.toggle('selected', subs.includes(chip.dataset.val));
  });

  document.getElementById('profile-modal').classList.add('open');
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.remove('open');
}

async function saveProfile() {
  const nickname = document.getElementById('pf-nickname').value.trim();
  const learningGoal = document.getElementById('pf-bio').value.trim();

  const gradeChip = document.querySelector('#pf-role-chips .pf-chip.selected');
  const grade = gradeChip ? gradeChip.dataset.val : '';
  const levelChip = document.querySelector('#pf-level-chips .pf-chip.selected');
  const selfLevel = levelChip ? levelChip.dataset.val : '';
  const styleChip = document.querySelector('#pf-style-chips .pf-chip.selected');
  const guidingStyle = styleChip ? styleChip.dataset.val : '';
  const favoriteSubjects = [...document.querySelectorAll('#pf-subject-chips .pf-chip.selected')].map(c => c.dataset.val);

  const payload = { nickname, grade, favoriteSubjects, selfLevel, guidingStyle, learningGoal };
  const resp = await apiFetch('api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await resp.json();
  if (result && result.ok) {
    userProfile = result.profile;
    closeProfileModal();
    showToast('设置已保存');
  } else {
    showToast('保存失败，请重试');
  }
}

function showToast(msg) {
  let t = document.getElementById('pf-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pf-toast';
    t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:10px 22px;border-radius:100px;font-size:.88rem;z-index:9999;opacity:0;transition:opacity .25s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}

// 单选 chip 点击事件（role / level / style）
document.addEventListener('DOMContentLoaded', () => {
  ['pf-role-chips', 'pf-level-chips', 'pf-style-chips'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const chip = e.target.closest('.pf-chip');
      if (!chip) return;
      document.querySelectorAll('#' + id + ' .pf-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
  });

  // 多选 chip 点击事件（subjects）
  document.getElementById('pf-subject-chips').addEventListener('click', e => {
    const chip = e.target.closest('.pf-chip');
    if (!chip) return;
    chip.classList.toggle('selected');
  });

  // 点击遮罩关闭
  document.getElementById('profile-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('profile-modal')) closeProfileModal();
  });
});

// 启动时验证登录状态
initAuth();
</script>

<!-- Profile 设置弹窗 -->
<div id="profile-modal">
  <div class="profile-card">
    <h2>个人设置</h2>

    <div class="pf-field">
      <label class="pf-label">昵称（选填）</label>
      <input id="pf-nickname" class="pf-input" type="text" placeholder="你的昵称" maxlength="30">
    </div>

    <div class="pf-field">
      <label class="pf-label">学段</label>
      <div class="pf-chips" id="pf-role-chips">
        <span class="pf-chip" data-val="小学">小学</span>
        <span class="pf-chip" data-val="初中">初中</span>
        <span class="pf-chip" data-val="高中">高中</span>
        <span class="pf-chip" data-val="大学">大学</span>
        <span class="pf-chip" data-val="教师">教师</span>
        <span class="pf-chip" data-val="其他">其他</span>
      </div>
    </div>

    <div class="pf-field">
      <label class="pf-label">最喜爱的学科（可多选）</label>
      <div class="pf-chips" id="pf-subject-chips">
        <span class="pf-chip" data-val="数学">数学</span>
        <span class="pf-chip" data-val="物理">物理</span>
        <span class="pf-chip" data-val="化学">化学</span>
        <span class="pf-chip" data-val="生物">生物</span>
        <span class="pf-chip" data-val="语文">语文</span>
        <span class="pf-chip" data-val="英语">英语</span>
        <span class="pf-chip" data-val="历史">历史</span>
        <span class="pf-chip" data-val="地理">地理</span>
      </div>
    </div>

    <div class="pf-field">
      <label class="pf-label">知识水平自评</label>
      <div class="pf-chips" id="pf-level-chips">
        <span class="pf-chip" data-val="基础">基础</span>
        <span class="pf-chip" data-val="中等">中等</span>
        <span class="pf-chip" data-val="较强">较强</span>
        <span class="pf-chip" data-val="优秀">优秀</span>
      </div>
    </div>

    <div class="pf-field">
      <label class="pf-label">喜欢的指导风格</label>
      <div class="pf-chips" id="pf-style-chips">
        <span class="pf-chip" data-val="详细讲解">详细讲解</span>
        <span class="pf-chip" data-val="简洁直接">简洁直接</span>
        <span class="pf-chip" data-val="苏格拉底式追问">苏格拉底式追问</span>
        <span class="pf-chip" data-val="鼓励式">鼓励式</span>
      </div>
    </div>

    <div class="pf-field">
      <label class="pf-label">学习目标（选填）</label>
      <textarea id="pf-bio" class="pf-textarea" placeholder="写下你的学习目标…" maxlength="100"
        oninput="document.getElementById('pf-bio-count').textContent=this.value.length"></textarea>
      <span class="pf-char-count"><span id="pf-bio-count">0</span>/100</span>

    </div>

    <div class="pf-actions">
      <button class="btn btn-secondary" onclick="closeProfileModal()">取消</button>
      <button class="btn btn-primary" onclick="saveProfile()">保存</button>
    </div>
  </div>
</div>
</body>
</html>`;
}
// ── 启动 ──────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.TUTOR_PORT || "7896");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Tutor] 启动：http://0.0.0.0:${PORT}`);
});
