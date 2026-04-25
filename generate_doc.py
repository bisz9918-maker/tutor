#!/usr/bin/env python3
"""
通过 MCP SSE 调用 VisualSolver 生成题目讲解文档。
用法：python generate_doc.py <mcp_url> <output_dir> <question> [image_path]
流式输出进度到 stdout（JSON lines）。

用 urllib + threading 手动实现 MCP SSE 协议，绕开 httpx/anyio 与反向代理
的 SSL 读取兼容性问题：
  - 线程1：保持 SSE 长连接，监听服务端推送的结果
  - 线程2：发 POST /messages（initialize、tools/call）
"""
import sys, json, asyncio, hashlib, ssl, threading, queue, time
import urllib.request
from pathlib import Path


def _ssl_ctx():
    return ssl.create_default_context()


def _post_json(url: str, payload: dict, timeout: float = 30) -> tuple[int, str]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=timeout) as resp:
        return resp.status, resp.read().decode()


def _mcp_call_sync(base_url: str, tool_name: str, arguments: dict,
                   timeout: float = 1000) -> dict:
    """
    同步执行完整 MCP SSE 会话：
    1. GET /sse → 拿到 messages_url，并保持连接监听结果
    2. POST initialize
    3. POST tools/call
    4. 从 SSE 流中读取 tools/call 结果
    """
    sse_url = base_url.rstrip("/") + "/sse"
    result_q: queue.Queue = queue.Queue()
    messages_url_holder: list = []
    endpoint_event = threading.Event()

    def sse_listener():
        """在独立线程中维持 SSE 长连接，收集结果事件"""
        try:
            req = urllib.request.Request(sse_url, headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=timeout) as resp:
                event_type = None
                data_lines: list[str] = []
                for raw in resp:
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
                    elif line == "":
                        # 空行 = 事件结束
                        data = "\n".join(data_lines)
                        data_lines = []
                        if event_type == "endpoint":
                            url = (base_url.rstrip("/") + data) if data.startswith("/") else data
                            messages_url_holder.append(url)
                            endpoint_event.set()
                        elif event_type == "message":
                            try:
                                result_q.put(json.loads(data))
                            except Exception:
                                pass
                        event_type = None
        except Exception as e:
            result_q.put({"__error__": str(e)})

    t = threading.Thread(target=sse_listener, daemon=True)
    t.start()

    # 等待 endpoint 事件
    if not endpoint_event.wait(timeout=15):
        raise RuntimeError("等待 MCP endpoint 事件超时（15s）")

    messages_url = messages_url_holder[0]

    # initialize
    status, _ = _post_json(messages_url, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "generate_doc", "version": "1.0"},
        },
    })
    if status not in (200, 202):
        raise RuntimeError(f"initialize 失败，HTTP {status}")

    # initialized notification
    _post_json(messages_url, {
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {},
    })

    # tools/call
    status, _ = _post_json(messages_url, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }, timeout=timeout)
    if status not in (200, 202):
        raise RuntimeError(f"tools/call 失败，HTTP {status}")

    # 等待 SSE 推送结果（id=2 的响应）
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            msg = result_q.get(timeout=min(remaining, 10))
        except queue.Empty:
            continue
        if "__error__" in msg:
            raise RuntimeError(f"SSE 监听异常: {msg['__error__']}")
        if msg.get("id") == 2:
            if "error" in msg:
                raise RuntimeError(f"MCP 工具错误: {msg['error']}")
            content = msg.get("result", {}).get("content", [{}])
            text = content[0].get("text", "{}") if content else "{}"
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                # 服务端可能返回多个 JSON 对象拼接，取最后一个有效行
                import sys as _sys
                print(f"[DEBUG] raw text: {repr(text[:500])}", file=_sys.stderr, flush=True)
                lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
                return json.loads(lines[-1]) if lines else {}

    raise RuntimeError("等待工具调用结果超时")


async def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(json.dumps({"error": "参数不足"}), flush=True)
        sys.exit(1)

    mcp_url    = args[0]
    output_dir = args[1]
    question   = args[2]
    image_path = args[3] if len(args) > 3 and args[3] != "null" else None
    topic      = args[4] if len(args) > 4 else "problem_custom_" + hashlib.md5(question.encode()).hexdigest()[:8]

    print(json.dumps({"status": "connecting", "msg": "连接生成服务..."}), flush=True)

    try:
        call_args = {
            "problem": question,
            "output_dir": output_dir,
            "topic": topic,
        }
        if image_path:
            call_args["image_path"] = image_path

        print(json.dumps({"status": "generating", "msg": "开始生成..."}), flush=True)
        print(json.dumps({"status": "generating", "msg": "AI 正在生成图文讲解（约1-3分钟）..."}), flush=True)

        loop = asyncio.get_event_loop()
        result_data = await loop.run_in_executor(
            None, lambda: _mcp_call_sync(mcp_url, "generate_diagram_and_text", call_args)
        )

        if not result_data.get("success"):
            print(json.dumps({"error": True, "msg": result_data.get("error", "生成失败")}), flush=True)
            sys.exit(1)

        print(json.dumps({
            "status": "done",
            "topic": topic,
            "output_dir": result_data.get("output_dir", ""),
        }), flush=True)

    except Exception as e:
        import traceback
        print(json.dumps({"error": True, "msg": str(e), "traceback": traceback.format_exc()}), flush=True)
        sys.exit(1)

asyncio.run(main())
