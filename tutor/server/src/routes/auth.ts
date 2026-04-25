import { Router, Request, Response } from "express";
import crypto from "crypto";
import { loadUsers, saveUsers, hashPassword, loadSessions, saveSessions, getUidFromReq, requireAuth } from "../middleware/auth";
import { readUserProfile, ensureUserDir } from "../services/oah";
import { UserProfile } from "../types";
import { USERS_DIR } from "../config";

const router = Router();

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

router.post("/api/login", (req: Request, res: Response) => {
  const { uid, password } = req.body as { uid: string; password: string };
  if (!uid || !password) { res.status(400).json({ error: "uid 和 password 不能为空" }); return; }
  const users = loadUsers();
  const user = users[uid];
  if (!user || user.password_hash !== hashPassword(password)) {
    res.status(401).json({ error: "用户名或密码错误" }); return;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = loadSessions();
  sessions[token] = { uid, created_at: new Date().toISOString() };
  saveSessions(sessions);
  res.json({ ok: true, token, uid });
});

router.post("/api/register", (req: Request, res: Response) => {
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
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = loadSessions();
  sessions[token] = { uid, created_at: new Date().toISOString() };
  saveSessions(sessions);
  res.json({ ok: true, token, uid });
});

router.post("/api/logout", (req: Request, res: Response) => {
  const token = req.headers["x-session-token"] as string | undefined;
  if (token) {
    const sessions = loadSessions();
    delete sessions[token];
    saveSessions(sessions);
  }
  res.json({ ok: true });
});

router.get("/api/me", (req: Request, res: Response) => {
  const uid = getUidFromReq(req);
  if (!uid) { res.status(401).json({ error: "未登录" }); return; }
  res.json({ uid, profile: readUserProfile(uid) });
});

router.get("/api/profile", requireAuth, (req: Request, res: Response) => {
  const uid = getUidFromReq(req)!;
  res.json(readUserProfile(uid));
});

router.put("/api/profile", requireAuth, (req: Request, res: Response) => {
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
  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(path.join(USERS_DIR, uid, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
  res.json({ ok: true, profile });
});

export default router;
