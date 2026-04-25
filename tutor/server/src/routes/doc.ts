import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { EXP_DIR, MY_EXP_DIR } from "../config";
import { getIndexMap, BenchmarkItemFull } from "../services/embedding";

const router = Router();

export function findExpFolder(index: number, hash?: string): { dir: string; folder: string } | null {
  const indexMap = getIndexMap();
  const topic = hash ? `problem_${hash}_custom` : indexMap.get(index)?.topic;
  for (const baseDir of [MY_EXP_DIR, EXP_DIR]) {
    if (!fs.existsSync(baseDir)) continue;
    const folders = fs.readdirSync(baseDir);
    if (topic) {
      const byTopic = folders.find(f => f === topic);
      if (byTopic) return { dir: baseDir, folder: byTopic };
    }
    const folder = folders.find(f => {
      const match = f.match(/^problem_(\d+)_/);
      return match && parseInt(match[1]) === index;
    });
    if (folder) return { dir: baseDir, folder };
  }
  return null;
}

export interface DocData {
  solutionMd: string;
  scenes: { name: string; url: string; isHtml: boolean }[];
  problemImgUrl: string | null;
}

export function loadDoc(index: number, subject: string, hash?: string): DocData | null {
  const found = findExpFolder(index, hash);
  if (!found) return null;
  const { dir, folder } = found;
  const docDir = path.join(dir, folder, "doc");

  const solutionHtmlPath = path.join(docDir, "solution.html");
  const solutionMdPath = path.join(docDir, "solution.md");
  let solutionMd = "";
  if (fs.existsSync(solutionHtmlPath)) {
    const raw = fs.readFileSync(solutionHtmlPath, "utf-8");
    solutionMd = raw.replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s{2,}/g, "\n").trim();
  } else if (fs.existsSync(solutionMdPath)) {
    solutionMd = fs.readFileSync(solutionMdPath, "utf-8");
  } else {
    return null;
  }

  const scenes = fs.readdirSync(docDir)
    .filter(f => f.match(/^scene\d+\.(png|html)$/))
    .sort()
    .map(f => ({
      name: f.replace(/\.(png|html)$/, ""),
      url: `doc/${index}/${f}`,
      isHtml: f.endsWith(".html"),
    }));

  const probImg = path.join(dir, folder, "problem_diagram.png");
  const problemImgUrl = fs.existsSync(probImg) ? `doc/${index}/problem_diagram.png` : null;

  return { solutionMd, scenes, problemImgUrl };
}

router.get("/doc/:index/:file", (req: Request, res: Response) => {
  const index = parseInt(req.params["index"] as string);
  const file = req.params["file"] as string;
  const found = findExpFolder(index);
  if (!found) { res.status(404).send("not found"); return; }
  const { dir, folder } = found;
  const docDir = path.join(dir, folder, "doc");
  const filePath = path.join(docDir, file);
  if (!fs.existsSync(filePath)) {
    const alt = path.join(dir, folder, file);
    if (fs.existsSync(alt)) { res.sendFile(alt); return; }
    res.status(404).send("not found"); return;
  }
  res.sendFile(filePath);
});

export default router;
