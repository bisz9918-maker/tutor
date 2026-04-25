import { TTS_URL, TTS_KEY } from "../config";

export function cleanTTSText(text: string): string {
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

export async function synthesizeTTS(text: string): Promise<Buffer | null> {
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

export async function synthesizeTTSStream(text: string): Promise<ReadableStream | null> {
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

// TTS stream sessions
export const ttsStreams = new Map<string, { streams: (ReadableStream | null)[]; currentIdx: number; done: boolean; ttsAllDone: boolean; ts: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsStreams) { if (now - v.ts > 10 * 60 * 1000) ttsStreams.delete(k); }
}, 60 * 1000);

export const ttsSessions = new Map<string, { audioIds: string[]; done: boolean; ttsAllDone: boolean; ts: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsSessions) { if (now - v.ts > 10 * 60 * 1000) ttsSessions.delete(k); }
}, 60 * 1000);

export const ttsCache = new Map<string, { data: Buffer; ts: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsCache) { if (now - v.ts > 5 * 60 * 1000) ttsCache.delete(k); }
}, 60 * 1000);
