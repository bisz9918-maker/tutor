import { spawn } from "child_process";
import { PYTHON, ASR_URL, ASR_KEY } from "../config";

export function convertTo16kWav(inputBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const script = `
import sys, wave, array, struct, io

data = sys.stdin.buffer.read()

try:
    inp = wave.open(io.BytesIO(data), 'r')
    rate = inp.getframerate()
    channels = inp.getnchannels()
    sampwidth = inp.getsampwidth()
    frames = inp.readframes(inp.getnframes())
    inp.close()

    if sampwidth == 1:
        samples = array.array('b', frames)
        samples = array.array('h', [s * 256 for s in samples])
    elif sampwidth == 2:
        samples = array.array('h', frames)
    elif sampwidth == 4:
        raw = array.array('i', frames)
        samples = array.array('h', [s >> 16 for s in raw])
    else:
        samples = array.array('h', frames[:len(frames)//2*2])

    if channels > 1:
        mono = array.array('h', [samples[i] for i in range(0, len(samples), channels)])
        samples = mono

    if rate != 16000 and rate > 0:
        ratio = rate / 16000
        new_len = int(len(samples) / ratio)
        resampled = array.array('h', [samples[min(int(i * ratio), len(samples)-1)] for i in range(new_len)])
        samples = resampled

    out = io.BytesIO()
    w = wave.open(out, 'w')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(samples.tobytes())
    w.close()
    sys.stdout.buffer.write(out.getvalue())
except Exception as e:
    sys.stdout.buffer.write(data)
`;
    const proc = spawn(PYTHON, ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => console.error("[ASR resample]", c.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error("resample failed"));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(inputBuf);
    proc.stdin.end();
  });
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!ASR_URL) throw new Error("ASR not configured");
  const wavBuffer = await convertTo16kWav(audioBuffer);
  const boundary = "----AudioBoundary" + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), wavBuffer, Buffer.from(footer)]);
  const resp = await fetch(`${ASR_URL}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Authorization": `Bearer ${ASR_KEY}`,
    },
    body,
  });
  if (!resp.ok) throw new Error(`ASR error: ${resp.status}`);
  const data = await resp.json() as { text: string };
  return data.text || "";
}
