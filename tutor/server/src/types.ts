export interface UserProfile {
  nickname?: string;
  grade?: string;
  favoriteSubjects?: string[];
  selfLevel?: string;
  guidingStyle?: string;
  guidingStyleDetail?: Record<string, string>;
  learningGoal?: string;
}

export interface UserRecord {
  uid: string;
  password_hash: string;
  created_at: string;
}

export type UsersDB = Record<string, UserRecord>;

export interface SessionRecord {
  uid: string;
  created_at: string;
}

export type SessionsDB = Record<string, SessionRecord>;

export interface GenTask {
  status: "running" | "done" | "error";
  msg: string;
  index?: number;
  scenes?: object[];
  problemImgUrl?: string | null;
  hasDoc?: boolean;
  question?: string;
}

export interface BenchmarkItem {
  index: number;
  question: string;
  answer: string;
  subject: string;
  type: string;
  difficulty: string;
  score: number;
  knowledge_point: string[];
  hash?: string;
}

export interface DocData {
  scenes: { name: string; url: string; isHtml: boolean }[];
  answer: string;
  subject: string;
  type: string;
  difficulty: string;
  score: number;
  knowledge_point: string[];
  question: string;
  problemImgUrl?: string | null;
}

export interface MistakeRecord {
  id: string;
  index: number | null;
  question: string;
  subject: string;
  type: string;
  difficulty: string;
  knowledge_point: string[];
  hasDoc: boolean;
  studentAnswer?: string;
  gradeResult?: string;
  note?: string;
  addedAt: string;
  imagePath?: string;
}
