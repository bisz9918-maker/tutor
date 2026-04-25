import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { GENERATE_DOC_SCRIPT, RESOURCES } from "../config";
import { GenTask } from "../types";

export const genTasks = new Map<string, GenTask>();
export const generatingTopics = new Set<string>();

export function startGenerateDoc(question: string, imagePath?: string): string {
  const taskId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  genTasks.set(taskId, { status: "running", msg: "启动中..." });

  const args = [GENERATE_DOC_SCRIPT, "--question", question];
  if (imagePath) {
    args.push("--image", imagePath);
  }

  const cwd = path.resolve(GENERATE_DOC_SCRIPT, "..");
  const proc = spawn("python3", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

  let output = "";
  proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  proc.stderr.on("data", (data: Buffer) => { console.error("[generate-doc]", data.toString()); });

  proc.on("close", (code) => {
    if (code !== 0) {
      const task = genTasks.get(taskId);
      if (task) { task.status = "error"; task.msg = output.slice(-200) || "生成失败"; }
      generatingTopics.delete(question);
      return;
    }
    try {
      const result = JSON.parse(output.trim().split("\n").pop()!);
      const task = genTasks.get(taskId);
      if (task) {
        task.status = "done";
        task.msg = "完成";
        task.index = result.index;
        task.scenes = result.scenes;
        task.question = result.question;
        task.problemImgUrl = result.problemImgUrl || null;
        task.hasDoc = true;
      }
    } catch {
      const task = genTasks.get(taskId);
      if (task) { task.status = "error"; task.msg = "解析输出失败"; }
    }
    generatingTopics.delete(question);
  });

  return taskId;
}
