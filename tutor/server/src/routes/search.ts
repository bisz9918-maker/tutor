import { Router, Request, Response } from "express";
import { findBestMatch, normalizeQuestion, getIndexMap, benchmark, customDb } from "../services/embedding";
import { loadDoc } from "./doc";

const router = Router();

router.post("/api/search", async (req: Request, res: Response) => {
  const { question } = req.body as { question: string };
  if (!question) { res.status(400).json({ error: "question required" }); return; }

  let result: { item: any; score: number } | null = null;
  try {
    result = await findBestMatch(question);
  } catch (e) {
    res.status(500).json({ error: String(e) }); return;
  }

  if (!result) { res.json({ found: false }); return; }

  const { item: match, score } = result;
  const doc = loadDoc(match.index, match.subject);
  let searchImgUrl = doc?.problemImgUrl ?? null;
  if (!searchImgUrl && match.img) {
    searchImgUrl = `data:image/png;base64,${match.img}`;
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

router.post("/api/load", (req: Request, res: Response) => {
  const { index } = req.body as { index: number };
  const indexMap = getIndexMap();
  const item = indexMap.get(index);
  if (!item) { res.status(404).json({ error: "not found" }); return; }
  const doc = loadDoc(item.index, item.subject);
  let problemImgUrl = doc?.problemImgUrl ?? null;
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

router.post("/api/similar", async (req: Request, res: Response) => {
  const { index, knowledge_point, subject, topN = 5 } = req.body as {
    index?: number; knowledge_point?: string[]; subject?: string; topN?: number;
  };
  const indexMap = getIndexMap();

  // Import embedding store directly to avoid circular deps
  const { getStore } = await import("../services/embedding");
  const store = getStore();

  let candidates: { item: any; score: number }[] = [];

  if (index !== undefined) {
    const idx = store.indices.indexOf(index);
    if (idx === -1) { res.status(404).json({ error: "index not found" }); return; }
    const queryVec = store.embeddings[idx];
    for (let i = 0; i < store.indices.length; i++) {
      if (store.indices[i] === index) continue;
      let dot = 0;
      for (let j = 0; j < queryVec.length; j++) dot += queryVec[j] * store.embeddings[i][j];
      const item = indexMap.get(store.indices[i]);
      if (item) candidates.push({ item, score: dot });
    }
    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, topN);
  } else if (subject) {
    for (const item of benchmark) {
      if (item.subject === subject) candidates.push({ item, score: 1 });
    }
    candidates.sort((a, b) => a.item.index - b.item.index);
  } else if (knowledge_point && knowledge_point.length > 0) {
    const kps = knowledge_point.map(k => k.toLowerCase());
    for (const item of benchmark) {
      const itemKps = item.knowledge_point.map(k => k.toLowerCase()).join(" ");
      const hit = kps.some(kp => itemKps.includes(kp) || kp.split(/[；;、，,]/g).some(seg => itemKps.includes(seg.trim())));
      if (hit) candidates.push({ item, score: 1 });
    }
    candidates = candidates.sort(() => Math.random() - 0.5).slice(0, topN);
  } else {
    res.status(400).json({ error: "需要 index、subject 或 knowledge_point" }); return;
  }

  const { findExpFolder } = await import("./doc");
  const fs = await import("fs");
  const path = await import("path");

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

router.get("/api/subjects", (_req: Request, res: Response) => {
  const SUBJECT_LABEL: Record<string, string> = {
    "math-g6": "小学数学", "math-g9": "初中数学", "math-g12": "高中数学",
    "physics-g9": "初中物理", "physics-g12": "高中物理",
    "chemistry-g9": "初中化学", "chemistry-g12": "高中化学",
    "biology-g9": "初中生物", "biology-g12": "高中生物",
    "geography-g9": "初中地理", "geography-g12": "高中地理",
    "history-g9": "初中历史", "history-g12": "高中历史",
  };
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
      kps: [...kpMap.entries()].sort(([, a], [, b]) => b - a).map(([kp, c]) => ({ kp, count: c })),
    }));
  res.json({ subjects: result });
});

export default router;
