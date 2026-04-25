import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const TUTOR_ROOT = process.env.TUTOR_ROOT || path.resolve(__dirname, "../..");

export const RESOURCES = path.resolve(TUTOR_ROOT, "../resources");
export const BENCHMARK_PATH = path.join(RESOURCES, "database.json");
export const CUSTOM_DB_PATH = path.join(RESOURCES, "custom_database.json");
export const EXP_DIR = path.join(RESOURCES, "exp_gemini-3-pro-preview");
export const MY_EXP_DIR = path.join(RESOURCES, "my_experiment");
export const UPLOADS_DIR = path.join(RESOURCES, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
export const EMBEDDINGS_PATH = path.join(TUTOR_ROOT, "embeddings.json");
export const PYTHON = process.env.PYTHON || path.resolve(TUTOR_ROOT, "../.venv/bin/python");
export const MODEL_PATH = path.resolve(TUTOR_ROOT, "bge-m3");
export const USERS_PATH = path.join(TUTOR_ROOT, "users.json");
export const SESSIONS_PATH = path.join(TUTOR_ROOT, "sessions.json");
export const GENERATE_DOC_SCRIPT = path.resolve(TUTOR_ROOT, "../generate_doc_direct.py");
export const USERS_DIR = path.resolve(TUTOR_ROOT, "users");

export const ASR_URL = process.env.ASR_URL || "";
export const ASR_KEY = process.env.ASR_KEY || process.env.API_KEY || "";
export const TTS_URL = process.env.TTS_URL || "";
export const TTS_KEY = process.env.TTS_KEY || process.env.API_KEY || "";
export const OAH_API_URL = process.env.OAH_API_URL || "";
export const OAH_WORKSPACE_TEMPLATE = process.env.OAH_WORKSPACE_TEMPLATE || "question-tutor";
export const OAH_GRADER_TEMPLATE = process.env.OAH_GRADER_TEMPLATE || "question-grader";
