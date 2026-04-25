import fs from "fs";
import path from "path";
import { OAH_API_URL, OAH_WORKSPACE_TEMPLATE, OAH_GRADER_TEMPLATE, USERS_DIR } from "../config";
import { UserProfile } from "../types";

export function ensureUserDir(uid: string): string {
  const dir = path.join(USERS_DIR, uid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const files: Record<string, string> = {
    "profile.json": "{}",
    "mistakes.json": "[]",
    "tutoring_history.jsonl": "",
    "grading_history.jsonl": "",
  };
  for (const [name, defaultContent] of Object.entries(files)) {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, defaultContent, "utf-8");
  }
  return dir;
}

export function readUserProfile(uid: string): UserProfile {
  const fp = path.join(USERS_DIR, uid, "profile.json");
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { return {}; }
}

export function appendTutoringHistory(uid: string, index: number, userMsg: string, assistantMsg: string) {
  const fp = path.join(USERS_DIR, uid, "tutoring_history.jsonl");
  const entry = { index, userMessage: userMsg, assistantMessage: assistantMsg, ts: new Date().toISOString() };
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}

// OAH workspace cache
export const oahCache = new Map<string, { workspaceId: string; sessionId: string; lastUsed: number }>();
export const graderWorkspaces = new Map<string, number>();
const GRADER_WS_TTL = 2 * 60 * 60 * 1000;

// Cleanup interval
setInterval(async () => {
  const now = Date.now();
  for (const [k, v] of oahCache) {
    if (now - v.lastUsed > 24 * 60 * 60 * 1000) {
      oahCache.delete(k);
      try {
        await fetch(`${OAH_API_URL}/api/v1/workspaces/${v.workspaceId}`, { method: "DELETE" });
        console.log(`[OAH] 清理过期 workspace: ${v.workspaceId}`);
      } catch {}
    }
  }
  for (const [wsId, createdAt] of graderWorkspaces) {
    if (now - createdAt > GRADER_WS_TTL) {
      graderWorkspaces.delete(wsId);
      try {
        await fetch(`${OAH_API_URL}/api/v1/workspaces/${wsId}`, { method: "DELETE" });
        console.log(`[OAH] 清理过期批改 workspace: ${wsId}`);
      } catch {}
    }
  }
}, 10 * 60 * 1000);

export async function uploadFileToWorkspace(workspaceId: string, filePath: string, workspacePath: string): Promise<void> {
  const fileBuf = fs.readFileSync(filePath);
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(workspacePath)}&overwrite=true`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: fileBuf }
  );
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[OAH] upload file failed: ${workspacePath}`, resp.status, text);
  }
}

export async function uploadBufferToWorkspace(workspaceId: string, buf: Buffer, workspacePath: string): Promise<void> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(workspacePath)}&overwrite=true`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: buf }
  );
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[OAH] upload buffer failed: ${workspacePath}`, resp.status, text);
  }
}

export async function readWorkspaceFile(workspaceId: string, workspacePath: string): Promise<string> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(workspacePath)}`
  );
  if (!resp.ok) throw new Error(`read workspace file failed: ${resp.status}`);
  const data = await resp.json() as { content: string };
  return data.content;
}

export async function downloadWorkspaceFile(workspaceId: string, workspacePath: string): Promise<Buffer> {
  const resp = await fetch(
    `${OAH_API_URL}/api/v1/workspaces/${workspaceId}/files/download?path=${encodeURIComponent(workspacePath)}`
  );
  if (!resp.ok) throw new Error(`download workspace file failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
