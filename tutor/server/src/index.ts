import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import { TUTOR_ROOT } from "./config";

// Routes
import authRoutes from "./routes/auth";
import mediaRoutes from "./routes/media";
import ttsRoutes from "./routes/tts";
import asrRoutes from "./routes/asr";
import docRoutes from "./routes/doc";
import searchRoutes from "./routes/search";
import generateRoutes from "./routes/generate";
import chatRoutes from "./routes/chat";
import gradeRoutes from "./routes/grade";
import mistakesRoutes from "./routes/mistakes";
import logRoutes from "./routes/log";

const app = express();
app.use(cors({ origin: true, credentials: true, exposedHeaders: ["X-TTS-Session"] }));
app.use(express.json({ limit: "20mb" }));
app.use("/static", express.static(path.resolve(TUTOR_ROOT, "static")));

// Mount all route modules
app.use(authRoutes);
app.use(mediaRoutes);
app.use(ttsRoutes);
app.use(asrRoutes);
app.use(docRoutes);
app.use(searchRoutes);
app.use(generateRoutes);
app.use(chatRoutes);
app.use(gradeRoutes);
app.use(mistakesRoutes);
app.use(logRoutes);

// Serve Vue SPA
const clientDist = path.resolve(TUTOR_ROOT, "client/dist");
if (fs.existsSync(clientDist)) {
  app.use("/assets", express.static(path.join(clientDist, "assets"), {
    maxAge: "30d", immutable: true,
  }));
  app.use(express.static(clientDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html"))
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    },
  }));
  app.get("/{*path}", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const PORT = parseInt(process.env.TUTOR_PORT || "7896");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Tutor] http://0.0.0.0:${PORT}`);
});
