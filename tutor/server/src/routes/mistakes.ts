import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { requireAuth, getUidFromReq } from "../middleware/auth";
import { USERS_DIR } from "../config";
import { normalizeQuestion, indexMap } from "../services/embedding";
import { loadDoc, findExpFolder } from "./doc";
import { MistakeRecord } from "../types";

const router = Router();

const client = new OpenAI({
  baseURL: process.env.API_URL || "https://api.openai.com/v1",
  apiKey: process.env.API_KEY || "",
});
const MODEL = process.env.MODEL || "gpt-4o";

function mistakesPath(uid: string): string {
  return path.join(USERS_DIR, uid, "mistakes.json");
}

function loadMistakes(uid: string): MistakeRecord[] {
  const fp = mistakesPath(uid);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { return []; }
}

function saveMistakes(uid: string, list: MistakeRecord[]) {
  fs.writeFileSync(mistakesPath(uid), JSON.stringify(list, null, 2), "utf-8");
}

router.post("/api/mistakes", requireAuth, (req: Request, res: Response) => {
  const uid = (req as any).uid;
  const { index, question, imagePath, studentAnswer, gradeResult, note } = req.body as {
    index?: number; question?: string; imagePath?: string;
    studentAnswer?: string; gradeResult?: string; note?: string;
  };
  const list = loadMistakes(uid);
  const id = crypto.randomBytes(8).toString("hex");

  let subject = "custom", type = "主观题", difficulty = "未知", knowledge_point: string[] = [], hasDoc = false, finalQuestion = question || "";

  if (index !== undefined && index !== null) {
    const item = indexMap.get(index);
    if (item) {
      subject = item.subject; type = item.type; difficulty = item.difficulty;
      knowledge_point = item.knowledge_point; finalQuestion = normalizeQuestion(item.question);
      const doc = loadDoc(item.index, item.subject);
      hasDoc = doc !== null;
    }
  }

  const existing = list.find(m => m.index === index && index !== null);
  if (existing) {
    if (gradeResult !== undefined) existing.gradeResult = gradeResult;
    if (studentAnswer !== undefined) existing.studentAnswer = studentAnswer;
    if (note !== undefined) existing.note = note;
    saveMistakes(uid, list);
    res.json({ ok: true, updated: true, id: existing.id });
    return;
  }

  list.push({
    id, index: index ?? null, question: finalQuestion, subject, type, difficulty,
    knowledge_point, hasDoc, studentAnswer, gradeResult, note,
    addedAt: new Date().toISOString(), imagePath,
  });
  saveMistakes(uid, list);
  res.json({ ok: true, id });
});

router.get("/api/mistakes", requireAuth, (_req: Request, res: Response) => {
  const uid = (_req as any).uid;
  const list = loadMistakes(uid);
  // Recompute hasDoc for each mistake since materials may have been generated since last save
  for (const m of list) {
    if (m.index != null) {
      const item = indexMap.get(m.index);
      if (item) {
        const doc = loadDoc(item.index, item.subject);
        m.hasDoc = doc !== null;
      }
    } else if (m.question) {
      // For custom questions (no index), check by topic hash via loadDoc
      const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
      const topicHash = crypto.createHash("md5").update(normalize(m.question)).digest("hex").slice(0, 8);
      const doc = loadDoc(0, "custom", topicHash);
      m.hasDoc = doc !== null;
    }
  }
  res.json(list);
});

router.delete("/api/mistakes/:id", requireAuth, (req: Request, res: Response) => {
  const uid = (req as any).uid;
  const id = req.params["id"] as string;
  const list = loadMistakes(uid);
  const idx = list.findIndex(m => m.id === id);
  if (idx >= 0) { list.splice(idx, 1); saveMistakes(uid, list); }
  res.json({ ok: true });
});

router.post("/api/mistakes/analyze", requireAuth, async (req: Request, res: Response) => {
  const uid = (req as any).uid;
  const { id, profile } = req.body as { id: string; profile?: Record<string, string> };
  const list = loadMistakes(uid);
  const mistake = list.find(m => m.id === id);
  if (!mistake) { res.status(404).json({ error: "not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const profileHint = profile ? `\n学生画像：${JSON.stringify(profile)}` : "";
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: [{
        role: "system",
        content: `你是一位经验丰富的教师，专门分析学生的错题。请根据题目和学生的作答/批改记录，深入分析错误根因，并给出针对性的学习建议。${profileHint}`,
      }, {
        role: "user",
        content: `题目：${mistake.question}\n\n${mistake.studentAnswer ? "学生作答：" + mistake.studentAnswer + "\n\n" : ""}${mistake.gradeResult ? "批改结果：" + mistake.gradeResult : ""}`,
      }],
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    res.end();
  }
});

export default router;
