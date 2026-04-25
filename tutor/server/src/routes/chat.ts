import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getUidFromReq } from "../middleware/auth";
import { OAH_API_URL, OAH_WORKSPACE_TEMPLATE, USERS_DIR } from "../config";
import { ensureUserDir, readUserProfile, appendTutoringHistory, oahCache, uploadFileToWorkspace, uploadBufferToWorkspace } from "../services/oah";
import { ttsStreams, ttsSessions, synthesizeTTSStream, cleanTTSText } from "../services/tts";
import { loadDoc, findExpFolder } from "./doc";
import { UserProfile } from "../types";

const router = Router();

interface Message {
  role: "user" | "assistant";
  content: string;
}

router.post("/api/chat", async (req: Request, res: Response) => {
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

  ensureUserDir(uid);

  const effectiveProfile = profile && Object.keys(profile).length > 0 ? profile : readUserProfile(uid);

  // OAH workspace cache logic
  const cacheKey = `${uid}:${index}`;
  let workspaceId: string;
  let sessionId: string;
  let probImgBase64: string | undefined;

  const cached = oahCache.get(cacheKey);
  if (cached) {
    workspaceId = cached.workspaceId;
    sessionId = cached.sessionId;
    cached.lastUsed = Date.now();
    console.log(`[OAH] 缓存命中: ws=${workspaceId} ses=${sessionId}`);
  } else {
    try {
      // 1. Create workspace
      const wsName = `tutor-${uid}-${index}-${Date.now()}`;
      const wsResp = await fetch(`${OAH_API_URL}/api/v1/workspaces`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wsName, runtime: OAH_WORKSPACE_TEMPLATE }),
      });
      if (!wsResp.ok) throw new Error(`create workspace failed: ${wsResp.status} ${await wsResp.text()}`);
      const wsData = await wsResp.json() as { id: string };
      workspaceId = wsData.id;
      console.log(`[OAH] 创建 workspace: ${workspaceId}`);

      // 2. Create session
      const sesResp = await fetch(`${OAH_API_URL}/api/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `题目 ${index} 讲解` }),
      });
      if (!sesResp.ok) throw new Error(`create session failed: ${sesResp.status} ${await sesResp.text()}`);
      const sesData = await sesResp.json() as { id: string };
      sessionId = sesData.id;
      console.log(`[OAH] 创建 session: ${sessionId}`);

      // 3. Send init message
      const initMsgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "初始化会话，暂时不要调用任何工具，只需回复【已就绪】。" }),
      });
      if (initMsgResp.ok) {
        const initMsgData = await initMsgResp.json() as { runId: string };
        console.log(`[OAH] 初始化消息已发送: run=${initMsgData.runId}`);
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
      }

      // 4. Upload doc files
      const found = findExpFolder(index);
      if (found) {
        const { dir, folder } = found;
        const docDir = path.join(dir, folder, "doc");
        const solMdPath = path.join(docDir, "solution.md");
        const solHtmlPath = path.join(docDir, "solution.html");
        if (fs.existsSync(solMdPath)) await uploadFileToWorkspace(workspaceId, solMdPath, "solution.md");
        else if (fs.existsSync(solHtmlPath)) await uploadFileToWorkspace(workspaceId, solHtmlPath, "solution.html");

        const sceneFiles = fs.readdirSync(docDir).filter(f => f.match(/^scene\d+\.(png|html)$/));
        for (const sf of sceneFiles) await uploadFileToWorkspace(workspaceId, path.join(docDir, sf), sf);

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

        const probImgPath = path.join(dir, folder, "problem_diagram.png");
        if (fs.existsSync(probImgPath)) probImgBase64 = fs.readFileSync(probImgPath).toString("base64");
      }

      // 5. Upload user data files
      const profilePath = path.join(USERS_DIR, uid, "profile.json");
      const mistakesPath = path.join(USERS_DIR, uid, "mistakes.json");
      if (fs.existsSync(profilePath)) await uploadFileToWorkspace(workspaceId, profilePath, "profile.json");
      if (fs.existsSync(mistakesPath)) await uploadFileToWorkspace(workspaceId, mistakesPath, "mistakes.json");

      // 6. Wait for file sync
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
      const solFileName = found ? (fs.existsSync(path.join(found.dir, found.folder, "doc", "solution.md")) ? "solution.md" : fs.existsSync(path.join(found.dir, found.folder, "doc", "solution.html")) ? "solution.html" : "") : "";
      if (solFileName) fileWaitTasks.push(waitForFile(workspaceId, solFileName));
      await Promise.all(fileWaitTasks);

      // 7. Cache
      oahCache.set(cacheKey, { workspaceId, sessionId, lastUsed: Date.now() });
    } catch (e) {
      console.error("[OAH] 初始化失败:", e);
      res.status(500).json({ error: `OAH init failed: ${String(e)}` });
      return;
    }
  }

  // Send message to OAH (with image in content if available)
  let runId: string;
  try {
    const messagePayload: any = probImgBase64
      ? { content: [
          { type: "text", text: userMessage },
          { type: "image", image: probImgBase64, mediaType: "image/png" }
        ]}
      : { content: userMessage };
    const msgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
    });
    if (!msgResp.ok) throw new Error(`send message failed: ${msgResp.status} ${await msgResp.text()}`);
    const msgData = await msgResp.json() as { runId: string; messageId: string };
    runId = msgData.runId;
  } catch (e) {
    console.error("[OAH] 发送消息失败:", e);
    res.status(500).json({ error: `OAH send message failed: ${String(e)}` });
    return;
  }

  // Create TTS stream session
  const ttsSessionId = "tts-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const ttsStreamSession = { streams: [] as (ReadableStream | null)[], currentIdx: 0, done: false, ttsAllDone: false, ts: Date.now() };
  ttsStreams.set(ttsSessionId, ttsStreamSession);
  const ttsSession = { audioIds: [] as string[], done: false, ttsAllDone: false, ts: Date.now() };
  ttsSessions.set(ttsSessionId, ttsSession);

  // SSE streaming output
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-TTS-Session", ttsSessionId);

  try {
    const eventsUrl = `${OAH_API_URL}/api/v1/sessions/${sessionId}/events?runId=${encodeURIComponent(runId)}`;
    const eventsResp = await fetch(eventsUrl);
    if (!eventsResp.ok || !eventsResp.body) throw new Error(`SSE connect failed: ${eventsResp.status}`);

    const reader = eventsResp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let fullText = "";
    let ttsBuf = "";
    let ttsSessionDone = false;
    let ttsStreamSlotIdx = 0;

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
          const speechText = afterOpen.slice(0, closeIdx);
          if (speechText.trim() && process.env.TTS_URL) {
            const slotIdx = ttsStreamSlotIdx++;
            ttsStreamSession.streams.push(null);
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
        } else { break; }
      }
    };

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
        if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
        else if (line.startsWith("data: ")) currentData = line.slice(6);
        else if (line === "" && currentEvent && currentData) {
          try {
            const data = JSON.parse(currentData);
            if (currentEvent === "message.delta") {
              const delta = data.delta as string || "";
              if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ delta })}\n\n`); processTtsFromDelta(delta); }
            } else if (currentEvent === "message.completed") {
              const content = data.content;
              let textContent = "";
              if (typeof content === "string") textContent = content;
              else if (Array.isArray(content)) { for (const part of content) { if (part.type === "text" && part.text) textContent += part.text; } }
              if (!fullText && textContent) { fullText = textContent; res.write(`data: ${JSON.stringify({ delta: textContent })}\n\n`); processTtsFromDelta(textContent); }
              const keypointRe = /\[KEYPOINT\]([\s\S]*?)\[\/KEYPOINT\]/g;
              let m;
              while ((m = keypointRe.exec(fullText)) !== null) { const kp = m[1].trim(); if (kp) res.write(`data: ${JSON.stringify({ keypoint: kp })}\n\n`); }
            } else if (currentEvent === "run.completed" || currentEvent === "run.failed" || currentEvent === "run.cancelled") {
              runDone = true;
              if (currentEvent === "run.failed") console.error(`[OAH] run failed:`, data);
            }
          } catch {}
          currentEvent = "";
          currentData = "";
        }
      }
    }

    ttsSessionDone = true;
    if (ttsStreamSession.streams.every(s => s !== null)) {
      ttsStreamSession.ttsAllDone = true; ttsStreamSession.done = true;
      ttsSession.done = true; ttsSession.ttsAllDone = true;
    }
    res.write(`data: ${JSON.stringify({ done: true, ttsSessionId })}\n\n`);
    res.end();

    if (fullText && uid !== "anonymous") appendTutoringHistory(uid, index, userMessage, fullText);
  } catch (e) {
    console.error("[OAH] SSE 流错误:", e);
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    res.end();
  }
});

export default router;
