import fs from "fs";
import { BENCHMARK_PATH, CUSTOM_DB_PATH, EMBEDDINGS_PATH } from "../config";
import { BenchmarkItem } from "../types";

export interface BenchmarkItemFull extends BenchmarkItem {
  hash_id?: string;
  img?: string;
  img_caption?: string;
  topic?: string;
  format_answer?: {
    format_solution: string[];
    ground_truth: string[];
  };
}

export const benchmark: BenchmarkItemFull[] = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf-8"));
export const customDb: BenchmarkItemFull[] = fs.existsSync(CUSTOM_DB_PATH) ? JSON.parse(fs.readFileSync(CUSTOM_DB_PATH, "utf-8")) : [];

export function normalizeQuestion(q: string): string {
  return q.replace(/<image>/g, "").replace(/\s+/g, " ").trim();
}

interface EmbeddingStore {
  indices: number[];
  embeddings: number[][];
}

export const store: EmbeddingStore = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf-8"));
export const indexMap = new Map<number, BenchmarkItemFull>([...benchmark, ...customDb].map(item => [item.index, item]));

export function getStore() { return store; }

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const EMBED_URL = (process.env.EMBED_URL || "").replace(/\/$/, "");
const EMBED_KEY = process.env.EMBED_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";

export async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(`${EMBED_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EMBED_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: [normalizeQuestion(text)] }),
  });
  if (!resp.ok) throw new Error(`embed API error: ${resp.status}`);
  const data = await resp.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

export async function findBestMatch(userQ: string): Promise<{ item: BenchmarkItemFull; score: number } | null> {
  const queryVec = await embedText(userQ);
  let bestScore = 0, bestIdx = -1;
  for (let i = 0; i < store.indices.length; i++) {
    const score = cosineSimilarity(queryVec, store.embeddings[i]);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestScore < 0.6) return null;
  const item = indexMap.get(store.indices[bestIdx]);
  return item ? { item, score: bestScore } : null;
}

export function getIndexMap() { return indexMap; }
