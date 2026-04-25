import { Router, Request, Response } from "express";

const router = Router();

router.post("/api/log", (req: Request, res: Response) => {
  console.log("[client-log]", (req.body as { msg?: string }).msg || "");
  res.json({ ok: true });
});

export default router;
