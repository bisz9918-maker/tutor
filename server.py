#!/usr/bin/env python3
"""
教学网页服务器
用法: python server.py <output_dir> [--port 7895]
功能:
  - 静态托管 output_dir/index.html
  - POST /api/record  接收前端交互事件，追加到 output_dir/records.jsonl
  - GET  /api/records 查看所有记录（JSON）
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

app = Flask(__name__)
OUTPUT_DIR: Path = Path(".")   # 由 main() 设置
RECORDS_DIR: Path = Path(".")  # 由 main() 设置，可单独指定


# ── 静态页面 ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(OUTPUT_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(OUTPUT_DIR, filename)


# ── 记录接口 ─────────────────────────────────────────────────────────────────

@app.route("/api/record", methods=["POST"])
def record():
    """
    接收前端上报的交互事件，追加到 records.jsonl。
    期望 JSON body:
    {
      "type": "quiz_answer" | "survey_submit" | "page_view" | ...,
      "session_id": "...",
      "data": { ... }
    }
    """
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"error": "invalid json"}), 400

    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "ip": request.remote_addr,
        **payload,
    }

    records_path = RECORDS_DIR / "records.jsonl"
    with records_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return jsonify({"ok": True})


@app.route("/api/records", methods=["GET"])
def get_records():
    """返回所有记录（JSON 数组）"""
    records_path = RECORDS_DIR / "records.jsonl"
    if not records_path.exists():
        return jsonify([])
    records = []
    for line in records_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return jsonify(records)


@app.route("/api/save_results", methods=["POST"])
def save_results():
    """将前端完整学习结果保存为独立 JSON 文件到 records-dir。"""
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"error": "invalid json"}), 400

    session_id = payload.get("session_id", datetime.utcnow().strftime("%Y%m%d_%H%M%S"))
    payload["saved_at"] = datetime.utcnow().isoformat() + "Z"
    payload["ip"] = request.remote_addr

    filename = f"result_{session_id}.json"
    out_path = RECORDS_DIR / filename
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 同时追加一条摘要到 records.jsonl
    summary = {
        "timestamp": payload["saved_at"],
        "ip": request.remote_addr,
        "type": "full_result",
        "session_id": session_id,
        "file": filename,
        "quiz_score": payload.get("quiz_score"),
    }
    (RECORDS_DIR / "records.jsonl").open("a", encoding="utf-8").write(
        json.dumps(summary, ensure_ascii=False) + "\n"
    )

    return jsonify({"ok": True, "file": filename})


# ── 入口 ─────────────────────────────────────────────────────────────────────

def main():
    global OUTPUT_DIR, RECORDS_DIR

    parser = argparse.ArgumentParser(description="教学网页服务器")
    parser.add_argument("output_dir", help="generate.py 的输出目录绝对路径")
    parser.add_argument("--port", type=int, default=7895)
    parser.add_argument("--records-dir", default=None,
                        help="交互记录保存目录（默认与 output_dir 相同）")
    args = parser.parse_args()

    OUTPUT_DIR = Path(args.output_dir).resolve()
    RECORDS_DIR = Path(args.records_dir).resolve() if args.records_dir else OUTPUT_DIR
    RECORDS_DIR.mkdir(parents=True, exist_ok=True)

    if not (OUTPUT_DIR / "index.html").exists():
        print(f"[错误] 未找到 {OUTPUT_DIR}/index.html，请先运行 generate.py")
        raise SystemExit(1)

    print(f"[服务器] 托管目录：{OUTPUT_DIR}")
    print(f"[服务器] 记录目录：{RECORDS_DIR}")
    print(f"[服务器] 访问地址：http://0.0.0.0:{args.port}")
    print(f"[服务器] 查看记录：http://0.0.0.0:{args.port}/api/records")
    app.run(host="0.0.0.0", port=args.port, debug=False)


if __name__ == "__main__":
    main()
