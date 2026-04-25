#!/usr/bin/env python3
"""
教学网页生成 MCP Server（SSE 通信）
工具：generate_lesson
输入：
  - content    : 教学主题/内容文本
  - output_dir : 网页输出目录（绝对路径）
  - records_dir: 学习记录保存目录（绝对路径）

端口和对外地址均从 .env 读取：
  WEB_PORT     = 7895
  WEB_BASE_URL = https://...（反向代理地址）
"""

import asyncio
import json
import os
import socket
from pathlib import Path

from dotenv import load_dotenv
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, Mount
import uvicorn

load_dotenv()

BASE_DIR     = Path(__file__).parent.resolve()
PYTHON       = str(BASE_DIR / ".venv" / "bin" / "python")
WEB_PORT     = int(os.getenv("WEB_PORT", "7895"))
WEB_BASE_URL = os.getenv("WEB_BASE_URL", "").rstrip("/")

# ── MCP Server ────────────────────────────────────────────────────────────────

mcp = Server("edu-lesson-generator")


@mcp.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="generate_lesson",
            description=(
                "根据教学内容生成交互式教学网页，并自动启动 Web 服务器。"
                "网页包含知识点讲解、多种题型习题、学习效果问卷，"
                "用户的答题和反馈会实时保存到 records_dir。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "教学主题或详细内容文本（也可传文本文件的绝对路径）"
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "网页输出目录的绝对路径，不存在会自动创建"
                    },
                    "records_dir": {
                        "type": "string",
                        "description": "学习记录保存目录的绝对路径，不存在会自动创建"
                    }
                },
                "required": ["content", "output_dir", "records_dir"]
            }
        )
    ]


@mcp.call_tool()
async def call_tool(name: str, arguments: dict):
    if name != "generate_lesson":
        raise ValueError(f"未知工具: {name}")

    content     = arguments["content"]
    output_dir  = arguments["output_dir"]
    records_dir = arguments["records_dir"]

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    Path(records_dir).mkdir(parents=True, exist_ok=True)

    lines = []

    # ── Step 1: 生成网页 ──────────────────────────────────────────────────────
    lines.append("▶ 开始生成教学网页...")
    print("[MCP] ▶ 开始生成教学网页...", flush=True)
    gen_proc = await asyncio.create_subprocess_exec(
        PYTHON, str(BASE_DIR / "generate.py"), content, output_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    gen_lines = []
    async for raw_line in gen_proc.stdout:
        line = raw_line.decode("utf-8", errors="replace").rstrip()
        gen_lines.append(line)
        print(f"[MCP] {line}", flush=True)
    await gen_proc.wait()
    gen_output = "\n".join(gen_lines)
    lines.append(gen_output.strip())

    if gen_proc.returncode != 0:
        return [TextContent(type="text", text="\n".join(lines) + "\n\n❌ 网页生成失败")]

    # ── Step 2: 停止旧服务器（同端口）────────────────────────────────────────
    kill_proc = await asyncio.create_subprocess_exec(
        "pkill", "-f", f"server.py.*--port {WEB_PORT}",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await kill_proc.wait()
    await asyncio.sleep(1)

    # ── Step 3: 启动 Web 服务器 ───────────────────────────────────────────────
    log_path = Path(records_dir) / "server.log"
    lines.append(f"▶ 启动 Web 服务器（端口 {WEB_PORT}）...")

    await asyncio.create_subprocess_exec(
        PYTHON, str(BASE_DIR / "server.py"),
        output_dir,
        "--port", str(WEB_PORT),
        "--records-dir", records_dir,
        stdout=open(log_path, "a"),
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,  # 与 MCP 进程解绑，MCP 退出后继续运行
    )

    # 等待服务器就绪
    ok = False
    for _ in range(20):
        try:
            with socket.create_connection(("127.0.0.1", WEB_PORT), timeout=1):
                ok = True
                break
        except OSError:
            await asyncio.sleep(0.5)

    if not ok:
        lines.append("❌ Web 服务器启动失败，请查看日志：" + str(log_path))
        return [TextContent(type="text", text="\n".join(lines))]

    # ── 读取课程标题 ──────────────────────────────────────────────────────────
    meta_path = Path(output_dir) / "meta.json"
    title = "教学网页"
    if meta_path.exists():
        try:
            title = json.loads(meta_path.read_text(encoding="utf-8")).get("title", title)
        except Exception:
            pass

    # ── 拼装对外地址 ──────────────────────────────────────────────────────────
    if WEB_BASE_URL:
        url         = WEB_BASE_URL + "/"
        records_url = WEB_BASE_URL + "/api/records"
    else:
        host_ip     = _get_local_ip()
        url         = f"http://{host_ip}:{WEB_PORT}/"
        records_url = f"http://{host_ip}:{WEB_PORT}/api/records"

    summary = (
        f"✅ 教学网页已生成并启动！\n\n"
        f"📚 课程标题：{title}\n"
        f"🌐 访问地址：{url}\n"
        f"📁 网页目录：{output_dir}\n"
        f"📊 记录目录：{records_dir}\n"
        f"📋 查看记录：{records_url}\n\n"
        f"── 生成详情 ──\n{gen_output.strip()}"
    )

    return [TextContent(type="text", text=summary)]


def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── SSE 应用 ──────────────────────────────────────────────────────────────────

def make_app() -> Starlette:
    sse = SseServerTransport("/messages/")

    async def handle_sse(request: Request):
        async with sse.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await mcp.run(
                streams[0], streams[1],
                mcp.create_initialization_options()
            )
        return Response()  # 必须返回，否则客户端断开时报 NoneType 错误

    return Starlette(routes=[
        Route("/sse", endpoint=handle_sse),
        Mount("/messages/", app=sse.handle_post_message),
    ])


def main():
    import argparse
    parser = argparse.ArgumentParser(description="教学网页生成 MCP Server（SSE）")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765, help="MCP SSE 监听端口")
    args = parser.parse_args()

    print(f"[MCP] SSE 服务启动：http://{args.host}:{args.port}/sse")
    print(f"[MCP] 网页端口：{WEB_PORT}  对外地址：{WEB_BASE_URL or '（本机IP）'}")
    uvicorn.run(make_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
