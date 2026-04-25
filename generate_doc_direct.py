#!/usr/bin/env python3
"""
直接调用 VisualSolver 生成题目讲解文档（不依赖 MCP URL）。
用法：python generate_doc_direct.py <output_dir> <question> [image_path] [topic] [--no_oah]
流式输出进度到 stdout（JSON lines）。
"""
import sys
import json
import asyncio
import hashlib
import os
import re
from pathlib import Path

# 加载 VisualSolver/.env，确保 CUSTOM_API_BASE / CUSTOM_API_KEY 等变量生效
VISUAL_SOLVER_DIR = Path(__file__).parent / "VisualSolver"
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=VISUAL_SOLVER_DIR / ".env", override=True)
except ImportError:
    pass


def emit(data: dict):
    print(json.dumps(data, ensure_ascii=False), flush=True)


async def main():
    args = sys.argv[1:]
    use_oah = "--no_oah" not in args
    args = [a for a in args if a != "--no_oah"]

    if len(args) < 2:
        emit({"error": True, "msg": "参数不足：需要 <output_dir> <question> [image_path] [topic] [--no_oah]"})
        sys.exit(1)

    output_dir = args[0]
    question   = args[1]
    image_path = args[2] if len(args) > 2 and args[2] != "null" else None
    topic      = args[3] if len(args) > 3 else None

    if not topic:
        topic = "problem_" + hashlib.md5(question.encode()).hexdigest()[:8] + "_custom"

    # 规范化 topic（与 mcp_server.py 保持一致）
    topic = re.sub(r'[^a-z0-9_]+', '_', topic.lower()).strip('_') or "problem"

    emit({"status": "connecting", "msg": f"初始化 AI 生成器... (OAH={'开启' if use_oah else '关闭'})"})

    try:
        from visual_solver.mllm_tools.litellm import LiteLLMWrapper
        from visual_solver import ExplanationGenerator
        from PIL import Image as PILImage
    except ImportError as e:
        emit({"error": True, "msg": f"导入模块失败：{e}"})
        sys.exit(1)

    emit({"status": "generating", "msg": "开始生成..."})
    emit({"status": "generating", "msg": "AI 正在生成图文讲解（约10-20分钟）..."})

    try:
        model = os.environ.get("VISUAL_SOLVER_MODEL", "Kimi-K25")

        planner_model = LiteLLMWrapper(
            model_name=model,
            temperature=0.7,
            print_cost=True,
            verbose=False,
            use_langfuse=False
        )
        scene_model = LiteLLMWrapper(
            model_name=model,
            temperature=0.7,
            print_cost=True,
            verbose=False,
            use_langfuse=False
        )
        helper_model = LiteLLMWrapper(
            model_name=model,
            temperature=0.7,
            print_cost=True,
            verbose=False,
            use_langfuse=False
        )

        # 加载图片（可选）
        problem_image = None
        if image_path and image_path != "null":
            if not os.path.exists(image_path):
                print(f"[WARN] 图片文件不存在，跳过：{image_path}", file=sys.stderr)
            else:
                try:
                    problem_image = PILImage.open(image_path)
                except Exception as e:
                    print(f"[WARN] 打开图片失败，跳过：{e}", file=sys.stderr)

        explanation_generator = ExplanationGenerator(
            planner_model=planner_model,
            scene_model=scene_model,
            helper_model=helper_model,
            output_dir=output_dir,
            verbose=False,
            use_rag=False,
            use_context_learning=False,
            use_visual_fix_code=False,
            use_langfuse=False,
            max_scene_concurrency=5,
            translate_to_chinese=False,
            use_oah=use_oah,
        )

        description = question
        if problem_image:
            description += "\n(Note: The attached image is the original diagram.)"
            output_topic_dir = os.path.join(output_dir, topic)
            os.makedirs(output_topic_dir, exist_ok=True)
            problem_image.save(os.path.join(output_topic_dir, "problem_diagram.png"))

        await explanation_generator.generate_html_diagrams(
            topic,
            description,
            max_retries=3,
            only_plan=False,
            problem_image=problem_image,
        )

        emit({"status": "done", "topic": topic, "output_dir": os.path.join(output_dir, topic)})

    except Exception as e:
        import traceback
        emit({"error": True, "msg": str(e), "traceback": traceback.format_exc()})
        sys.exit(1)


asyncio.run(main())
