import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { UPLOADS_DIR } from "../config";

const router = Router();

const ocrClient = new OpenAI({
  baseURL: process.env.OCR_URL || "",
  apiKey: process.env.OCR_KEY || "",
});

router.post("/api/ocr", async (req: Request, res: Response) => {
  const { image, prompt = "Text Recognition:" } = req.body as {
    image: string;
    prompt?: string;
  };
  if (!image) { res.status(400).json({ error: "image required" }); return; }
  try {
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

export default router;
