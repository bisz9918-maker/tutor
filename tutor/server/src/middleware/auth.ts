import { Request, Response, NextFunction } from "express";
import fs from "fs";
import crypto from "crypto";
import { USERS_PATH, SESSIONS_PATH } from "../config";
import { UsersDB, SessionsDB, UserRecord } from "../types";

export function loadUsers(): UsersDB {
  if (!fs.existsSync(USERS_PATH)) return {};
  return JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
}

export function saveUsers(db: UsersDB) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(db, null, 2));
}

export function hashPassword(pwd: string): string {
  return crypto.createHash("sha256").update(pwd).digest("hex");
}

export function loadSessions(): SessionsDB {
  if (!fs.existsSync(SESSIONS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
}

export function saveSessions(db: SessionsDB) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(db, null, 2));
}

export function getUidFromReq(req: Request): string | null {
  const token = req.headers["x-session-token"] as string;
  if (!token) return null;
  const sessions = loadSessions();
  return sessions[token]?.uid || null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const uid = getUidFromReq(req);
  if (!uid) { res.status(401).json({ error: "未登录" }); return; }
  (req as any).uid = uid;
  next();
}
