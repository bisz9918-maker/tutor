import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { OAH_API_URL, OAH_GRADER_TEMPLATE } from "../config";
import { normalizeQuestion, indexMap } from "../services/embedding";
import { graderWorkspaces, uploadBufferToWorkspace } from "../services/oah";

const router = Router();

router.post("/api/grade", async (req: Request, res: Response) => {
  const { index, question, questionImage, studentAnswer } = req.body as {
    index?: number; question?: string; questionImage?: string; studentAnswer: string;
  };

  console.log(`[OAH] /api/grade called: index=${index}, question=${!!question}, questionImage=${!!questionImage}, OAH_API_URL=${OAH_API_URL}`);

  if (!OAH_API_URL) { res.status(500).json({ error: "OAH_API_URL not configured" }); return; }

  const filesToUpload: { path: string; content: Buffer }[] = [];
  let messageContent: string;
  let imageBase64: string | undefined;

  if (index !== undefined && index !== null) {
    const item = indexMap.get(index);
    if (!item) { res.status(404).json({ error: "题目不存在" }); return; }
    const { format_solution, ground_truth } = item.format_answer || { format_solution: [], ground_truth: [] };
    const questionText = normalizeQuestion(item.question);
    const hasStandardAnswer = format_solution.length > 0 || ground_truth.length > 0;

    filesToUpload.push({ path: "question.md", content: Buffer.from(questionText) });

    if ((item as any).img) {
      let imgB64: string;
      if ((item as any).img.startsWith("http")) {
        try { const imgResp = await fetch((item as any).img); imgB64 = Buffer.from(await imgResp.arrayBuffer()).toString("base64"); }
        catch (e) { console.warn(`[OAH] 下载题目图片失败: ${(item as any).img}`, e); imgB64 = ""; }
      } else { imgB64 = (item as any).img; }
      if (imgB64) imageBase64 = imgB64;
    }

    if (hasStandardAnswer) {
      const stepsText = format_solution.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
      const answerText = ground_truth.join("；");
      filesToUpload.push({ path: "standard_answer.md", content: Buffer.from(`标准解题步骤：\n${stepsText}\n\n参考答案：${answerText}`) });
    }

    filesToUpload.push({ path: "student_answer.md", content: Buffer.from(studentAnswer) });
    messageContent = hasStandardAnswer
      ? "请读取 workspace 中的 question.md、standard_answer.md 和 student_answer.md，然后按照 XML 输出格式要求返回批改结果。"
      : "请读取 workspace 中的 question.md 和 student_answer.md。本题没有标准答案，请先自行解答题目制定标准答案，然后再批改学生答案。";
  } else {
    if (!question) { res.status(400).json({ error: "题目不能为空" }); return; }
    filesToUpload.push({ path: "question.md", content: Buffer.from(question) });
    if (questionImage) imageBase64 = questionImage;
    filesToUpload.push({ path: "student_answer.md", content: Buffer.from(studentAnswer) });
    messageContent = "请读取 workspace 中的 question.md 和 student_answer.md。本题没有标准答案，请先自行解答题目制定标准答案，然后再批改学生答案。";
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let workspaceId: string | undefined;

  try {
    const wsName = `grader-${index ?? 'direct'}-${Date.now()}`;
    const wsResp = await fetch(`${OAH_API_URL}/api/v1/workspaces`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: wsName, runtime: OAH_GRADER_TEMPLATE }),
    });
    if (!wsResp.ok) throw new Error(`create workspace failed: ${wsResp.status} ${await wsResp.text()}`);
    const wsData = await wsResp.json() as { id: string };
    workspaceId = wsData.id;
    graderWorkspaces.set(workspaceId, Date.now());

    const sesResp = await fetch(`${OAH_API_URL}/api/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: index ? `题目 ${index} 批改` : "自由批改" }),
    });
    if (!sesResp.ok) throw new Error(`create session failed: ${sesResp.status} ${await sesResp.text()}`);
    const sesData = await sesResp.json() as { id: string };
    const sessionId = sesData.id;

    // Init message
    await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "初始化会话，暂时不要调用任何工具，只需回复【已就绪】。" }),
    });

    // Wait for init
    await new Promise(r => setTimeout(r, 2000));

    // Upload files
    for (const f of filesToUpload) {
      await uploadBufferToWorkspace(workspaceId, f.content, f.path);
    }

    // Wait for file sync
    await new Promise(r => setTimeout(r, 2000));

    // Send grade message (with image in content if available)
    const messagePayload: any = imageBase64
      ? { content: [
          { type: "text", text: messageContent },
          { type: "image", image: imageBase64, mediaType: "image/png" }
        ]}
      : { content: messageContent };
    const msgResp = await fetch(`${OAH_API_URL}/api/v1/sessions/${sessionId}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
    });
    if (!msgResp.ok) throw new Error(`send message failed: ${msgResp.status} ${await msgResp.text()}`);
    const msgData = await msgResp.json() as { runId: string };
    const runId = msgData.runId;

    // Stream OAH events
    const eventsUrl = `${OAH_API_URL}/api/v1/sessions/${sessionId}/events?runId=${encodeURIComponent(runId)}`;
    const eventsResp = await fetch(eventsUrl);
    if (!eventsResp.ok || !eventsResp.body) throw new Error(`SSE connect failed: ${eventsResp.status}`);

    const reader = eventsResp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let runDone = false;
    // Track text already sent per step to avoid duplicates between delta and completed
    let stepSentText = "";

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
              let delta = data.delta as string || "";
              if (!delta && data.content) {
                let fullContent = "";
                if (typeof data.content === "string") fullContent = data.content;
                else if (Array.isArray(data.content)) { for (const part of data.content) { if (part.type === "text" && part.text) fullContent += part.text; } }
                // content is cumulative, send only the new part
                if (fullContent.length > stepSentText.length) {
                  delta = fullContent.slice(stepSentText.length);
                  stepSentText = fullContent;
                }
              } else if (delta) {
                stepSentText += delta;
              }
              if (delta) {
                res.write(`data: ${JSON.stringify({ delta })}\n\n`);
              }
            } else if (currentEvent === "message.completed") {
              const content = data.content;
              let textContent = "";
              if (typeof content === "string") textContent = content;
              else if (Array.isArray(content)) { for (const part of content) { if (part.type === "text" && part.text) textContent += part.text; } }
              if (textContent && textContent.length > stepSentText.length) {
                const remaining = textContent.slice(stepSentText.length);
                if (remaining) res.write(`data: ${JSON.stringify({ delta: remaining })}\n\n`);
              }
              stepSentText = "";
            } else if (currentEvent === "run.completed" || currentEvent === "run.failed" || currentEvent === "run.cancelled") {
              runDone = true;
            }
          } catch {}
          currentEvent = "";
          currentData = "";
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.error("[OAH] 批改错误:", e);
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    res.end();
  }
});

export default router;
