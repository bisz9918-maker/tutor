#!/usr/bin/env python3
"""
预计算 benchmark.json 中所有题目的 BGE-M3 向量，保存为 embeddings.json。
用法: python build_embeddings.py
"""

import json
import re
import numpy as np
from pathlib import Path
from sentence_transformers import SentenceTransformer

BASE = Path(__file__).parent
BENCHMARK = BASE / "resources" / "database.json"
MODEL_PATH = BASE / "tutor" / "bge-m3"
OUTPUT = BASE / "tutor" / "embeddings.json"


def normalize(q: str) -> str:
    q = re.sub(r"<image>", "", q)
    q = re.sub(r"\s+", " ", q).strip()
    return q


def main():
    print("[1/3] 加载 benchmark...")
    items = json.loads(BENCHMARK.read_text(encoding="utf-8"))
    texts = [normalize(item["question"]) for item in items]
    indices = [item["index"] for item in items]
    print(f"  共 {len(texts)} 道题")

    print(f"[2/3] 加载模型：{MODEL_PATH}")
    model = SentenceTransformer(str(MODEL_PATH))

    print("[3/3] 计算向量（首次较慢）...")
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=True, normalize_embeddings=True)

    result = {
        "indices": indices,
        "embeddings": embeddings.tolist(),
    }
    OUTPUT.write_text(json.dumps(result), encoding="utf-8")
    print(f"\n✅ 完成，保存至：{OUTPUT}  ({OUTPUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
