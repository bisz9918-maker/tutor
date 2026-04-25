import { Router, Request, Response } from "express";
import { transcribeAudio } from "../services/asr";

const router = Router();

router.post("/api/asr", async (req: Request, res: Response) => {
  console.log("[ASR] 收到请求, content-type:", req.headers["content-type"], "body length:", req.body?.length ?? 0);
  if (!process.env.ASR_URL) { res.status(400).json({ error: "ASR not configured" }); return; }
  const audioBuffer = req.body as Buffer;
  if (!audioBuffer || audioBuffer.length === 0) { res.status(400).json({ error: "empty audio" }); return; }
  try {
    const text = await transcribeAudio(audioBuffer);
    res.json({ text });
  } catch (e) {
    console.error("[ASR] 错误:", e);
    res.status(500).json({ error: String(e) });
  }
});

export default router;
