import { Router, Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { requireAuth, getUidFromReq } from "../middleware/auth";
import { GENERATE_DOC_SCRIPT, MY_EXP_DIR, UPLOADS_DIR, CUSTOM_DB_PATH, EMBEDDINGS_PATH, PYTHON, TUTOR_ROOT, USERS_DIR } from "../config";
import { GenTask } from "../types";
import { benchmark, customDb, normalizeQuestion, embedText, indexMap, store } from "../services/embedding";
import { loadDoc, findExpFolder } from "./doc";

const router = Router();

export const genTasks = new Map<string, GenTask>();
export const generatingTopics = new Set<string>();

router.post("/api/generate-doc", requireAuth, async (req: Request, res: Response) => {
  const { question, imagePath } = req.body as { question: string; imagePath?: string };
  if (!question) { res.status(400).json({ error: "question required" }); return; }

  const allItems = [...benchmark, ...customDb];
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const existing = allItems.find(x => normalize(x.question) === normalize(question) && x.topic);
  const topicHash = crypto.createHash("md5").update(normalize(question)).digest("hex").slice(0, 8);
  const topic = existing?.topic ?? `problem_${topicHash}_custom`;

  if (generatingTopics.has(topic)) {
    res.json({ taskId: topic }); return;
  }
  generatingTopics.add(topic);

  const taskId = topic;
  genTasks.set(taskId, { status: "running", msg: "启动 AI 合成..." });

  let finalImagePath = imagePath;
  // Resolve URL-style imagePath (e.g. "doc/385/problem_diagram.png") to actual file path
  if (finalImagePath && finalImagePath.startsWith("doc/")) {
    const parts = finalImagePath.split("/");
    const docIndex = parseInt(parts[1]);
    const docFile = parts.slice(2).join("/");
    if (!isNaN(docIndex) && docFile) {
      const found = findExpFolder(docIndex);
      if (found) {
        const realPath = path.join(found.dir, found.folder, "doc", docFile);
        const altPath = path.join(found.dir, found.folder, docFile);
        finalImagePath = fs.existsSync(realPath) ? realPath : fs.existsSync(altPath) ? altPath : undefined;
      }
    }
    if (finalImagePath?.startsWith("doc/")) finalImagePath = undefined;
  }
  if (!finalImagePath || !fs.existsSync(finalImagePath)) {
    finalImagePath = undefined;
    const matchItem = allItems.find(x => normalize(x.question) === normalize(question));
    if (matchItem && (matchItem as any).img) {
      const tmpPath = path.join(UPLOADS_DIR, `gen_img_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, Buffer.from((matchItem as any).img, "base64"));
      finalImagePath = tmpPath;
    }
  }

  const scriptArgs = [GENERATE_DOC_SCRIPT, MY_EXP_DIR, question, finalImagePath || "null", topic];
  const spawnEnv = { ...process.env, PYTHONPATH: path.resolve(TUTOR_ROOT, "../VisualSolver") };
  console.log("[generate-doc] spawn:", PYTHON, scriptArgs, "cwd:", path.resolve(TUTOR_ROOT, ".."), "PYTHONPATH:", spawnEnv.PYTHONPATH);
  const proc = spawn(PYTHON, scriptArgs, { cwd: path.resolve(TUTOR_ROOT, ".."), env: spawnEnv });
  proc.on("error", (err) => { console.error("[generate-doc] SPAWN ERROR:", err); });

  let buf = "";
  let resultTopic = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.topic) { resultTopic = evt.topic; console.log("[generate-doc] got topic:", evt.topic); }
        if (evt.status) genTasks.set(taskId, { status: "running", msg: evt.msg || evt.status });
      } catch {}
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => console.error("[generate-doc] stderr:", chunk.toString().trim()));
  proc.stdout.on("end", () => {
    if (buf.trim()) console.log("[generate-doc] stdout leftover:", buf.trim());
  });

  proc.on("close", async (code) => {
    generatingTopics.delete(topic);
    // Read image before deleting temp file
    let imgBase64 = "";
    if (finalImagePath && fs.existsSync(finalImagePath)) {
      try { imgBase64 = fs.readFileSync(finalImagePath).toString("base64"); } catch {}
    }
    if (finalImagePath && finalImagePath.startsWith(UPLOADS_DIR)) {
      try { fs.unlinkSync(finalImagePath); } catch {}
    }
    console.log("[generate-doc] close: code=", code, "resultTopic=", resultTopic);
    if (code !== 0 || !resultTopic) {
      genTasks.set(taskId, { status: "error", msg: "生成失败，请稍后重试" }); return;
    }
    try {
      genTasks.set(taskId, { status: "running", msg: "正在加入题库..." });
      const allItems = [...benchmark, ...customDb];
      const exists = allItems.find(x => x.question.trim() === question.trim());
      let finalIndex: number;

      if (exists) {
        finalIndex = exists.index;
      } else {
        finalIndex = Math.max(0, ...allItems.map(x => x.index)) + 1;
        const newItem = {
          hash_id: crypto.createHash("md5").update(question).digest("hex"),
          img: imgBase64,
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
        customDb.push(newItem as any);
        fs.writeFileSync(CUSTOM_DB_PATH, JSON.stringify(customDb, null, 2), "utf-8");
        indexMap.set(finalIndex, newItem as any);
      }

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
      // Update mistake records that have null index for this question
      try {
        const uid = getUidFromReq(req);
        if (uid) {
          const mistakesPath = path.join(USERS_DIR, uid, "mistakes.json");
          if (fs.existsSync(mistakesPath)) {
            const mistakes = JSON.parse(fs.readFileSync(mistakesPath, "utf-8"));
            let updated = false;
            for (const m of mistakes) {
              if (m.index == null && normalizeQuestion(m.question || "") === normalizeQuestion(question)) {
                m.index = finalIndex;
                m.hasDoc = true;
                updated = true;
              }
            }
            if (updated) fs.writeFileSync(mistakesPath, JSON.stringify(mistakes, null, 2), "utf-8");
          }
        }
      } catch (e) { console.error("[generate-doc] update mistakes error", e); }

      genTasks.set(taskId, {
        status: "done", msg: "合成完成！", index: finalIndex,
        scenes: doc?.scenes ?? [], problemImgUrl: doc?.problemImgUrl ?? null,
        hasDoc: doc !== null, question: normalizeQuestion(question),
      });
    } catch (e) {
      genTasks.set(taskId, { status: "error", msg: String(e) });
    }
  });

  res.json({ taskId });
});

router.get("/api/generate-doc/status/:taskId", requireAuth, (req: Request, res: Response) => {
  const { taskId } = req.params as { taskId: string };
  const task = genTasks.get(taskId);

  if (!task) {
    const topic = taskId;
    const topicHash = topic.replace(/^problem_/, "").replace(/_custom$/, "");
    const found = findExpFolder(0, topicHash);
    if (found) {
      const solutionHtml = path.join(found.dir, found.folder, "doc", "solution.html");
      if (fs.existsSync(solutionHtml)) {
        const index = indexMap.get(
          [...indexMap.entries()].find(([, v]) => v.topic === topic)?.[0] ?? -1
        )?.index;
        const doc = loadDoc(index ?? 0, "", topicHash);
        res.json({ status: "done", msg: "合成完成！", index: index ?? null, scenes: doc?.scenes ?? [], problemImgUrl: doc?.problemImgUrl ?? null, hasDoc: true } as GenTask);
        return;
      }
      if (generatingTopics.has(topic)) { res.json({ status: "running", msg: "生成中..." } as GenTask); return; }
      // Folder exists but generation is incomplete — treat as not found so the caller re-triggers generation
    }
    if (generatingTopics.has(topic)) { res.json({ status: "running", msg: "生成中..." } as GenTask); return; }
    res.status(404).json({ error: "task not found" }); return;
  }

  res.json(task);
  if (task.status === "done" || task.status === "error") genTasks.delete(taskId);
});

export default router;
