import { Router, Request, Response } from "express";
import { synthesizeTTS, synthesizeTTSStream, ttsStreams, ttsSessions, ttsCache } from "../services/tts";

const router = Router();

router.post("/api/tts", async (req: Request, res: Response) => {
  const { text } = req.body as { text: string };
  if (!text || !process.env.TTS_URL) { res.status(400).json({ error: "text required or TTS not configured" }); return; }
  const buf = await synthesizeTTS(text);
  if (!buf) { res.status(502).json({ error: "TTS failed" }); return; }
  res.setHeader("Content-Type", "audio/wav");
  res.send(buf);
});

router.post("/api/tts-stream-start", async (req: Request, res: Response) => {
  const { text, sid } = req.body as { text: string; sid: string };
  if (!text || !process.env.TTS_URL) { res.status(400).json({ error: "text required or TTS not configured" }); return; }
  const { cleanTTSText } = await import("../services/tts");
  const clean = cleanTTSText(text);
  if (!clean) { res.status(400).json({ error: "text too short after cleaning" }); return; }

  const streamSession = { streams: [] as (ReadableStream | null)[], currentIdx: 0, done: false, ttsAllDone: false, ts: Date.now() };
  ttsStreams.set(sid, streamSession);

  synthesizeTTSStream(clean).then((stream) => {
    if (stream) { streamSession.streams.push(stream); } else { streamSession.streams.push(null as any); }
    streamSession.ttsAllDone = true;
    streamSession.done = true;
  }).catch(() => {
    streamSession.streams.push(null as any);
    streamSession.ttsAllDone = true;
    streamSession.done = true;
  });

  res.json({ ok: true, sid });
});

router.get("/api/tts-stream/:sid", (req: Request, res: Response) => {
  const sess = ttsSessions.get(req.params.sid as string);
  if (!sess) { res.json({ audioIds: [], done: true }); return; }
  res.json({ audioIds: sess.audioIds, done: sess.done, ttsAllDone: sess.ttsAllDone || false });
});

router.get("/api/tts-cache/:id", (req: Request, res: Response) => {
  const item = ttsCache.get(req.params.id as string);
  if (!item) { res.status(404).send("not found"); return; }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-cache");
  res.send(item.data);
});

router.get("/api/tts-stream-direct/:sid", async (req: Request, res: Response) => {
  const sess = ttsStreams.get(req.params.sid as string);
  if (!sess) { res.status(404).json({ error: "session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  while (sess.currentIdx < sess.streams.length || !sess.ttsAllDone) {
    if (sess.currentIdx >= sess.streams.length) {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    const stream = sess.streams[sess.currentIdx];
    if (!stream) {
      if (!sess.ttsAllDone) { await new Promise(r => setTimeout(r, 100)); continue; }
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
          if (line.startsWith("data: ")) res.write(line + "\n\n");
        }
      }
      if (sseBuf.startsWith("data: ")) res.write(sseBuf + "\n\n");
      res.write(`data: ${JSON.stringify({ chunkEnd: true })}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ error: "stream read failed" })}\n\n`);
    }
  }
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

export default router;
