#!/usr/bin/env python3
"""
交互式教学网页生成器
用法: python generate.py <content> <output_dir>
"""

import os
import sys
import json
import time
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

API_URL = os.getenv("API_URL", "https://api.openai.com/v1")
API_KEY = os.getenv("API_KEY", "")
MODEL = os.getenv("MODEL", "gpt-4o")

client = OpenAI(base_url=API_URL, api_key=API_KEY)


# ── LLM 调用 ────────────────────────────────────────────────────────────────

def chat(system_prompt: str, user_prompt: str, label: str = "") -> str:
    """调用 OpenAI 风格 API，返回文本内容。遇到限流自动等待重试。"""
    print(f"  [API] 正在生成{label}...")
    wait = 10
    for attempt in range(5):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_prompt},
                ],
                temperature=0.7,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            if "429" in str(e) or "rate" in str(e).lower() or "quota" in str(e).lower():
                if attempt == 4:
                    raise
                print(f"  [限流] 等待 {wait}s 后重试（第{attempt+2}次）...")
                time.sleep(wait)
                wait *= 2
            else:
                raise


def chat_json(system_prompt: str, user_prompt: str, label: str = "") -> dict | list:
    """调用 API 并解析 JSON，失败自动重试最多3次。"""
    for attempt in range(3):
        raw = chat(system_prompt, user_prompt, label)
        # 去掉可能的 ```json ... ``` 包裹
        if "```" in raw:
            lines = raw.splitlines()
            start = next((i + 1 for i, l in enumerate(lines) if l.strip().startswith("```")), 0)
            end   = next((start + j for j, l in enumerate(lines[start:]) if l.strip() == "```"), len(lines))
            raw = "\n".join(lines[start:end])
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            if attempt == 2:
                raise RuntimeError(f"JSON解析失败（已重试3次）: {e}\n原始内容: {raw[:200]}") from e
            print(f"  [重试] JSON解析失败，第{attempt+2}次尝试...")


# ── 各阶段生成 ───────────────────────────────────────────────────────────────

KNOWLEDGE_SYSTEM = """你是一位专业教学设计专家。根据用户提供的教学内容，生成结构化的知识点讲解。
返回严格的 JSON 数组，每个元素包含：
{
  "id": 1,
  "title": "知识点标题",
  "explanation": "详细讲解（支持换行）",
  "key_points": ["要点1", "要点2"],
  "example": "具体示例",
  "needs_svg": true
}
needs_svg 为 true 表示该知识点适合配示意图（几何、物理、数学图形、流程等），false 表示纯文字概念不需要配图。
只返回 JSON 数组，不要其他文字。"""

SVG_SYSTEM = """你是一位精通 SVG 动画的教学可视化专家。为给定知识点生成一段教学示意图 SVG。
要求：
- 直接输出 SVG 代码，不要任何解释，不要 markdown 代码块
- width="100%" viewBox="0 0 500 200"（高度可在 160-260 之间调整）
- 使用 <animate> 或 <animateTransform> 制作动画使图示生动
- 用中文 <text> 标注关键部分
- 配色：主色 #4f46e5，绿 #16a34a，红 #dc2626，黄 #f59e0b，背景透明
- 不依赖外部资源，纯内联 SVG
- SVG 字符串内不要出现未转义的双引号嵌套问题，属性值统一用双引号"""

QUIZ_SYSTEM = """你是一位专业出题老师。根据教学内容生成多种题型的习题。
返回严格的 JSON 数组，每个元素为以下格式之一：

单选题:
{"id":1,"type":"single","question":"题目","options":["A.选项","B.选项","C.选项","D.选项"],"answer":"A","explanation":"解析","needs_svg":false}

多选题:
{"id":2,"type":"multiple","question":"题目","options":["A.选项","B.选项","C.选项","D.选项"],"answer":["A","C"],"explanation":"解析","needs_svg":false}

判断题:
{"id":3,"type":"truefalse","question":"题目","answer":true,"explanation":"解析","needs_svg":false}

填空题:
{"id":4,"type":"fillblank","question":"题目（用___表示空白）","answer":"正确答案","explanation":"解析","needs_svg":false}

needs_svg 为 true 表示该题目涉及几何图形、坐标系、函数图像等，适合配示意图辅助理解；否则为 false。
生成 8-12 道题，题型均衡。只返回 JSON 数组，不要其他文字。"""

SURVEY_SYSTEM = """你是一位学习效果评估专家。根据教学内容生成学习效果调查问卷。
返回严格的 JSON 数组，每个元素：
{
  "id": 1,
  "question": "问题文字",
  "type": "rating",        // rating=1-5星评分 | text=文字输入 | choice=单选
  "options": ["选项1","选项2"]  // 仅 choice 类型需要
}
生成 5-7 个问题，涵盖：理解程度、学习难度、内容实用性、学习建议。只返回 JSON 数组，不要其他文字。"""



def _generate_one_svg(item: dict, idx: int, total: int, context: str) -> tuple[int, str]:
    """为单个条目生成 SVG，返回 (idx, svg_str)。在线程池中调用。"""
    label = f"SVG图 {idx+1}/{total}「{item.get('title', item.get('question','')[:20])}」"
    user_prompt = (
        f"教学内容：{context}\n\n"
        f"知识点/题目：{item.get('title', item.get('question', ''))}\n"
        f"说明：{item.get('explanation', item.get('question', ''))}"
    )
    svg = chat(SVG_SYSTEM, user_prompt, label)
    # 去掉可能的代码块包裹
    if "```" in svg:
        lines = svg.splitlines()
        start = next((i + 1 for i, l in enumerate(lines) if l.strip().startswith("```")), 0)
        end   = next((start + j for j, l in enumerate(lines[start:]) if l.strip() == "```"), len(lines))
        svg = "\n".join(lines[start:end])
    return idx, svg.strip()


def attach_svgs(items: list, content: str) -> list:
    """并发为 needs_svg=True 的条目生成并嵌入 SVG。"""
    targets = [(orig_idx, item) for orig_idx, item in enumerate(items) if item.get("needs_svg")]
    if not targets:
        return items
    total = len(targets)
    print(f"  [SVG] 并发生成 {total} 张示意图...")
    with ThreadPoolExecutor(max_workers=min(total, 6)) as pool:
        futures = {
            pool.submit(_generate_one_svg, item, seq, total, content): orig_idx
            for seq, (orig_idx, item) in enumerate(targets)
        }
        for future in as_completed(futures):
            orig_idx = futures[future]
            try:
                _, svg = future.result()
                items[orig_idx]["svg"] = svg
                print(f"  [SVG] ✓ {items[orig_idx].get('title', items[orig_idx].get('question',''))[:30]}")
            except Exception as e:
                print(f"  [SVG] ✗ 生成失败（索引{orig_idx}）: {e}")
                items[orig_idx]["svg"] = ""
    return items


def generate_knowledge(content: str) -> list:
    return chat_json(KNOWLEDGE_SYSTEM, f"教学内容：\n{content}", "知识点")


def generate_quiz(content: str) -> list:
    return chat_json(QUIZ_SYSTEM, f"教学内容：\n{content}", "习题")


def generate_survey(content: str) -> list:
    return chat_json(SURVEY_SYSTEM, f"教学内容：\n{content}", "学习效果问卷")


def generate_title(content: str) -> str:
    return chat(
        "你是课程命名专家，根据教学内容生成简洁的课程标题（10字以内），只返回标题文字。",
        f"教学内容：\n{content}",
        "课程标题",
    )


# ── 保存中间文件 ─────────────────────────────────────────────────────────────

def save_json(data, path: Path, label: str):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  [保存] {label} → {path}")


# ── HTML 生成 ────────────────────────────────────────────────────────────────

def render_html(title: str, knowledge: list, quiz: list, survey: list) -> str:
    # SVG 中若含 </script> 会破坏 HTML，转义掉
    def safe_json(data):
        return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")

    knowledge_json = safe_json(knowledge)
    quiz_json      = safe_json(quiz)
    survey_json    = safe_json(survey)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<script>
  MathJax = {{
    tex: {{ inlineMath: [['$','$'], ['\\\\(','\\\\)']], displayMath: [['$$','$$']] }},
    options: {{ skipHtmlTags: ['script','noscript','style','textarea'] }}
  }};
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js" async></script>
<style>
  :root{{--primary:#4f46e5;--success:#16a34a;--danger:#dc2626;--warn:#ca8a04;--bg:#f8fafc;--card:#fff;--border:#e2e8f0;}}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:#1e293b;line-height:1.7}}
  .container{{max-width:860px;margin:0 auto;padding:24px 16px}}
  h1{{text-align:center;color:var(--primary);margin-bottom:8px;font-size:1.8rem}}
  .subtitle{{text-align:center;color:#64748b;margin-bottom:32px;font-size:.95rem}}

  /* 导航 Tab */
  .tabs{{display:flex;gap:4px;background:#e2e8f0;border-radius:12px;padding:4px;margin-bottom:28px}}
  .tab-btn{{flex:1;padding:10px;border:none;background:transparent;border-radius:8px;cursor:pointer;font-size:.95rem;color:#64748b;transition:.2s}}
  .tab-btn.active{{background:#fff;color:var(--primary);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.1)}}
  .tab-panel{{display:none}}.tab-panel.active{{display:block}}

  /* 卡片 */
  .card{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}}
  .card-title{{font-size:1.1rem;font-weight:700;color:var(--primary);margin-bottom:12px;display:flex;align-items:center;gap:8px}}
  .badge{{display:inline-block;background:var(--primary);color:#fff;font-size:.75rem;padding:2px 8px;border-radius:20px}}

  /* 知识点 */
  .kp-explanation{{white-space:pre-wrap;color:#374151;margin-bottom:12px}}
  .kp-keypoints{{list-style:none;padding:0}}
  .kp-keypoints li{{padding:4px 0 4px 20px;position:relative;color:#374151}}
  .kp-keypoints li::before{{content:"✦";position:absolute;left:0;color:var(--primary);font-size:.75rem;top:6px}}
  .kp-example{{background:#f1f5f9;border-left:3px solid var(--primary);padding:10px 14px;border-radius:0 8px 8px 0;font-size:.9rem;color:#475569;margin-top:10px}}
  .kp-svg{{background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:12px;margin:14px 0;overflow:hidden;text-align:center}}
  .kp-svg svg{{max-width:100%;height:auto}}

  /* 习题 */
  .quiz-header{{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}}
  .quiz-progress{{font-size:.9rem;color:#64748b}}
  .progress-bar{{height:6px;background:#e2e8f0;border-radius:3px;margin-top:6px}}
  .progress-fill{{height:100%;background:var(--primary);border-radius:3px;transition:.3s}}
  .question-type{{font-size:.8rem;color:#fff;padding:2px 8px;border-radius:20px;background:var(--primary)}}
  .options{{display:flex;flex-direction:column;gap:8px;margin:14px 0}}
  .option-btn{{padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer;text-align:left;transition:.2s;font-size:.95rem}}
  .option-btn:hover{{border-color:var(--primary);background:#eef2ff}}
  .option-btn.selected{{border-color:var(--primary);background:#eef2ff;font-weight:600}}
  .option-btn.correct{{border-color:var(--success);background:#dcfce7;color:var(--success)}}
  .option-btn.wrong{{border-color:var(--danger);background:#fee2e2;color:var(--danger)}}
  .fill-input{{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:.95rem;margin:10px 0}}
  .fill-input:focus{{outline:2px solid var(--primary);border-color:transparent}}
  .tf-options{{display:flex;gap:12px;margin:14px 0}}
  .tf-btn{{flex:1;padding:12px;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer;font-size:.95rem;transition:.2s}}
  .tf-btn:hover{{border-color:var(--primary)}}
  .feedback-box{{padding:10px 14px;border-radius:8px;font-size:.9rem;margin-top:8px;display:none}}
  .feedback-box.show{{display:block}}
  .feedback-correct{{background:#dcfce7;color:var(--success)}}
  .feedback-wrong{{background:#fee2e2;color:var(--danger)}}
  .nav-btns{{display:flex;gap:10px;margin-top:16px}}
  .btn{{padding:10px 22px;border:none;border-radius:8px;cursor:pointer;font-size:.95rem;font-weight:600;transition:.2s}}
  .btn-primary{{background:var(--primary);color:#fff}}.btn-primary:hover{{background:#4338ca}}
  .btn-secondary{{background:#e2e8f0;color:#374151}}.btn-secondary:hover{{background:#cbd5e1}}
  .btn:disabled{{opacity:.4;cursor:not-allowed}}
  .score-box{{text-align:center;padding:32px;display:none}}
  .score-num{{font-size:3rem;font-weight:800;color:var(--primary)}}
  .score-label{{color:#64748b;margin-top:4px}}
  .score-detail{{margin-top:16px;font-size:.9rem;color:#475569}}

  /* 问卷 */
  .survey-q{{margin-bottom:20px}}
  .survey-label{{font-weight:600;margin-bottom:10px;color:#1e293b}}
  .star-row{{display:flex;gap:6px;font-size:1.6rem;cursor:pointer}}
  .star{{color:#d1d5db;transition:.1s}}.star.lit{{color:#f59e0b}}
  .choice-options{{display:flex;flex-direction:column;gap:6px}}
  .choice-opt{{padding:8px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:.2s}}
  .choice-opt:hover,.choice-opt.chosen{{border-color:var(--primary);background:#eef2ff}}
  .survey-textarea{{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;resize:vertical;min-height:80px;font-family:inherit;font-size:.95rem}}
  .survey-textarea:focus{{outline:2px solid var(--primary);border-color:transparent}}
  .submit-survey{{width:100%;padding:14px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:8px;transition:.2s}}
  .submit-survey:hover{{background:#4338ca}}
  .survey-done{{text-align:center;padding:32px;display:none}}
  .survey-done .icon{{font-size:3rem}}.survey-done p{{color:#475569;margin-top:8px}}
</style>
</head>
<body>
<div class="container">
  <h1>📚 {title}</h1>
  <p class="subtitle">交互式学习 · 边学边练</p>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('knowledge',this)">📖 知识讲解</button>
    <button class="tab-btn" onclick="switchTab('quiz',this)">✏️ 习题练习</button>
    <button class="tab-btn" onclick="switchTab('survey',this)">📝 学习反馈</button>
  </div>

  <!-- 知识点 -->
  <div id="tab-knowledge" class="tab-panel active">
    <div id="knowledge-list"></div>
  </div>

  <!-- 习题 -->
  <div id="tab-quiz" class="tab-panel">
    <div class="quiz-header">
      <div>
        <div class="quiz-progress">题目 <span id="q-cur">1</span> / <span id="q-tot">0</span></div>
        <div class="progress-bar"><div class="progress-fill" id="q-bar" style="width:0%"></div></div>
      </div>
      <span id="q-type-badge" class="question-type">单选</span>
    </div>
    <div id="quiz-area"></div>
    <div id="score-box" class="score-box">
      <div class="score-num" id="score-num">0</div>
      <div class="score-label">/ <span id="score-tot">0</span> 分</div>
      <div class="score-detail" id="score-detail"></div>
      <button class="btn btn-primary" style="margin-top:20px" onclick="restartQuiz()">重新练习</button>
    </div>
  </div>

  <!-- 问卷 -->
  <div id="tab-survey" class="tab-panel">
    <div class="card">
      <div id="survey-form"></div>
      <button class="submit-survey" onclick="submitSurvey()">提交反馈</button>
    </div>
    <div class="survey-done card" id="survey-done">
      <div class="icon">🎉</div>
      <p>感谢您的反馈！您的学习记录已保存。</p>
      <p id="saved-path" style="font-size:.85rem;color:#94a3b8;margin-top:8px"></p>
    </div>
  </div>
</div>

<script>
// ── 数据 ──────────────────────────────────────────────────────────────────
const KNOWLEDGE = {knowledge_json};
const QUIZ      = {quiz_json};
const SURVEY    = {survey_json};

// 结果存储（通过 localStorage，同时下载 JSON）
const SESSION_KEY = "edu_session_" + Date.now();
let results = {{
  session_id: SESSION_KEY,
  title: document.title,
  started_at: new Date().toISOString(),
  quiz_answers: [],
  quiz_score: null,
  survey_answers: [],
  completed_at: null
}};

// ── Tab 切换 ──────────────────────────────────────────────────────────────
function switchTab(name, btn) {{
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  btn.classList.add("active");
}}

// ── 知识点渲染 ────────────────────────────────────────────────────────────
function renderKnowledge() {{
  const el = document.getElementById("knowledge-list");
  el.innerHTML = KNOWLEDGE.map((kp, i) => `
    <div class="card">
      <div class="card-title">
        <span class="badge">${{i+1}}</span> ${{kp.title}}
      </div>
      <p class="kp-explanation">${{kp.explanation}}</p>
      ${{kp.svg ? `<div class="kp-svg">${{kp.svg}}</div>` : ""}}
      <ul class="kp-keypoints">${{kp.key_points.map(p=>`<li>${{p}}</li>`).join("")}}</ul>
      ${{kp.example ? `<div class="kp-example">💡 <strong>示例：</strong>${{kp.example}}</div>` : ""}}
    </div>`).join("");
}}

// ── 习题 ──────────────────────────────────────────────────────────────────
let qIdx = 0;
let answered = new Array(QUIZ.length).fill(null);

function typeLabel(t) {{
  return {{single:"单选题",multiple:"多选题",truefalse:"判断题",fillblank:"填空题"}}[t] || t;
}}

function renderQuiz() {{
  const tot = QUIZ.length;
  document.getElementById("q-tot").textContent = tot;
  document.getElementById("score-tot").textContent = tot;
  showQuestion(0);
}}

function showQuestion(idx) {{
  qIdx = idx;
  const q = QUIZ[idx];
  const tot = QUIZ.length;
  document.getElementById("q-cur").textContent = idx + 1;
  document.getElementById("q-bar").style.width = ((idx+1)/tot*100) + "%";
  document.getElementById("q-type-badge").textContent = typeLabel(q.type);

  let html = `<div class="card"><p style="font-weight:600;font-size:1rem;margin-bottom:4px">Q${{idx+1}}. ${{q.question}}</p>`;
  if (q.svg) html += `<div class="kp-svg">${{q.svg}}</div>`;

  if (q.type === "single") {{
    html += `<div class="options">${{q.options.map((opt,i)=>
      `<button class="option-btn" onclick="selectSingle(this,'${{String.fromCharCode(65+i)}}',this.textContent)">${{opt}}</button>`
    ).join("")}}</div>`;
  }} else if (q.type === "multiple") {{
    html += `<p style="font-size:.85rem;color:#64748b;margin-bottom:8px">可多选</p>
      <div class="options">${{q.options.map((opt,i)=>
        `<button class="option-btn" onclick="toggleMulti(this,'${{String.fromCharCode(65+i)}}')">${{opt}}</button>`
      ).join("")}}</div>
      <button class="btn btn-secondary" onclick="confirmMulti()" style="margin-top:4px">确认选择</button>`;
  }} else if (q.type === "truefalse") {{
    html += `<div class="tf-options">
      <button class="tf-btn" onclick="selectTF(this,true)">✅ 正确</button>
      <button class="tf-btn" onclick="selectTF(this,false)">❌ 错误</button>
    </div>`;
  }} else if (q.type === "fillblank") {{
    html += `<input class="fill-input" id="fill-input" placeholder="请输入答案..." />
      <button class="btn btn-primary" onclick="confirmFill()" style="margin-top:4px">提交答案</button>`;
  }}

  html += `<div class="feedback-box" id="feedback"></div>`;
  html += `<div class="nav-btns">
    <button class="btn btn-secondary" id="prev-btn" onclick="navigate(-1)" ${{idx===0?"disabled":""}}>上一题</button>
    <button class="btn btn-primary"   id="next-btn" onclick="navigate(1)"  ${{idx===tot-1?"":""}}>${{idx===tot-1?"查看结果":"下一题"}}</button>
  </div></div>`;

  document.getElementById("quiz-area").innerHTML = html;
  if (window.MathJax) MathJax.typesetPromise([document.getElementById("quiz-area")]);

  // 恢复已作答状态
  if (answered[idx] !== null) restoreAnswer(idx);
}}

let multiSelected = [];

function selectSingle(btn, letter) {{
  if (answered[qIdx] !== null) return;
  document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  checkAnswer(letter);
}}

function toggleMulti(btn, letter) {{
  if (answered[qIdx] !== null) return;
  const i = multiSelected.indexOf(letter);
  if (i === -1) {{ multiSelected.push(letter); btn.classList.add("selected"); }}
  else {{ multiSelected.splice(i,1); btn.classList.remove("selected"); }}
}}

function confirmMulti() {{
  if (answered[qIdx] !== null || multiSelected.length === 0) return;
  checkAnswer([...multiSelected].sort());
}}

function selectTF(btn, val) {{
  if (answered[qIdx] !== null) return;
  checkAnswer(val);
}}

function confirmFill() {{
  if (answered[qIdx] !== null) return;
  const v = document.getElementById("fill-input").value.trim();
  if (!v) return;
  checkAnswer(v);
}}

function checkAnswer(userAns) {{
  const q = QUIZ[qIdx];
  let correct = false;

  if (q.type === "single") {{
    correct = userAns === q.answer;
    document.querySelectorAll(".option-btn").forEach((b,i) => {{
      const letter = String.fromCharCode(65+i);
      if (letter === q.answer) b.classList.add("correct");
      else if (letter === userAns && !correct) b.classList.add("wrong");
      b.onclick = null;
    }});
  }} else if (q.type === "multiple") {{
    const ua = [...userAns].sort(); const ca = [...q.answer].sort();
    correct = JSON.stringify(ua) === JSON.stringify(ca);
    document.querySelectorAll(".option-btn").forEach((b,i) => {{
      const letter = String.fromCharCode(65+i);
      if (ca.includes(letter)) b.classList.add("correct");
      else if (ua.includes(letter)) b.classList.add("wrong");
      b.onclick = null;
    }});
  }} else if (q.type === "truefalse") {{
    correct = userAns === q.answer;
    document.querySelectorAll(".tf-btn").forEach(b => {{
      const isTrue = b.textContent.includes("正确");
      if (isTrue === q.answer) b.style.cssText="border-color:var(--success);background:#dcfce7";
      else if (isTrue === userAns && !correct) b.style.cssText="border-color:var(--danger);background:#fee2e2";
      b.onclick = null;
    }});
  }} else if (q.type === "fillblank") {{
    correct = userAns.toLowerCase() === String(q.answer).toLowerCase();
    const inp = document.getElementById("fill-input");
    inp.disabled = true;
    inp.style.borderColor = correct ? "var(--success)" : "var(--danger)";
  }}

  answered[qIdx] = {{ user: userAns, correct }};

  // 构建详细记录
  const record = {{
    q_id: q.id,
    q_index: qIdx + 1,
    q_type: q.type,
    question: q.question,
    options: q.options || null,
    user_answer: userAns,
    correct_answer: q.answer,
    is_correct: correct,
    explanation: q.explanation || null,
    answered_at: new Date().toISOString()
  }};

  const existing = results.quiz_answers.findIndex(a => a.q_id === q.id);
  if (existing>=0) results.quiz_answers[existing] = record;
  else results.quiz_answers.push(record);
  saveLocal();
  // 每题答完立即保存到服务器
  saveToServer("quiz_answer", record);

  const fb = document.getElementById("feedback");
  fb.className = "feedback-box show " + (correct ? "feedback-correct" : "feedback-wrong");
  fb.innerHTML = (correct ? "✅ 正确！" : "❌ 错误。") +
    (q.explanation ? ` <strong>解析：</strong>${{q.explanation}}` : "");

  multiSelected = [];
}}

function restoreAnswer(idx) {{
  // 答过的题显示锁定状态（简化：直接重渲不可点击）
}}

function navigate(dir) {{
  const next = qIdx + dir;
  const tot = QUIZ.length;
  if (next < 0 || next > tot) return;
  if (next === tot) {{ showResult(); return; }}
  multiSelected = [];
  showQuestion(next);
}}

function showResult() {{
  document.getElementById("quiz-area").style.display = "none";
  document.getElementById("q-bar").style.width = "100%";
  const correct = answered.filter(a => a && a.correct).length;
  const tot = QUIZ.length;
  const score = Math.round(correct/tot*100);
  document.getElementById("score-num").textContent = correct;
  document.getElementById("score-detail").textContent =
    `正确 ${{correct}} 题，错误 ${{tot-correct}} 题，得分率 ${{score}}%`;
  document.getElementById("score-box").style.display = "block";
  results.quiz_score = {{ correct, total: tot, score_pct: score, finished_at: new Date().toISOString() }};
  saveLocal();
  saveToServer("quiz_complete", {{
    score: results.quiz_score,
    all_answers: results.quiz_answers
  }});
}}

function restartQuiz() {{
  answered = new Array(QUIZ.length).fill(null);
  results.quiz_answers = [];
  results.quiz_score = null;
  document.getElementById("quiz-area").style.display = "block";
  document.getElementById("score-box").style.display = "none";
  showQuestion(0);
}}

// ── 问卷 ──────────────────────────────────────────────────────────────────
function renderSurvey() {{
  const el = document.getElementById("survey-form");
  el.innerHTML = SURVEY.map((q, i) => {{
    let input = "";
    if (q.type === "rating") {{
      input = `<div class="star-row" id="stars-${{i}}" data-val="0">
        ${{[1,2,3,4,5].map(n=>`<span class="star" onclick="setStar(${{i}},${{n}})" data-n="${{n}}">★</span>`).join("")}}
      </div>`;
    }} else if (q.type === "text") {{
      input = `<textarea class="survey-textarea" id="sq-${{i}}" placeholder="请输入您的想法..."
        onblur="reportSurveyItem(${{i}})"></textarea>`;
    }} else if (q.type === "choice" && q.options) {{
      input = `<div class="choice-options">${{q.options.map((opt,j)=>
        `<div class="choice-opt" onclick="chooseOpt(this,${{i}},'${{opt}}')" data-qi="${{i}}">${{opt}}</div>`
      ).join("")}}</div>`;
    }}
    return `<div class="survey-q"><div class="survey-label">Q${{i+1}}. ${{q.question}}</div>${{input}}</div>`;
  }}).join("");
}}

function setStar(qi, n) {{
  const row = document.getElementById("stars-"+qi);
  row.dataset.val = n;
  row.querySelectorAll(".star").forEach(s => {{
    s.classList.toggle("lit", parseInt(s.dataset.n) <= n);
  }});
  reportSurveyItem(qi);
}}

function chooseOpt(el, qi, val) {{
  document.querySelectorAll(`[data-qi="${{qi}}"]`).forEach(e=>e.classList.remove("chosen"));
  el.classList.add("chosen");
  el.dataset.val = val;
  reportSurveyItem(qi);
}}

function reportSurveyItem(i) {{
  const q = SURVEY[i];
  let val = null;
  if (q.type === "rating") {{
    val = parseInt(document.getElementById("stars-"+i).dataset.val) || null;
  }} else if (q.type === "text") {{
    val = document.getElementById("sq-"+i).value.trim() || null;
  }} else if (q.type === "choice") {{
    const chosen = document.querySelector(`[data-qi="${{i}}"].chosen`);
    val = chosen ? chosen.dataset.val : null;
  }}
  if (val === null) return;
  saveToServer("survey_item", {{
    q_id: q.id,
    q_index: i + 1,
    q_type: q.type,
    question: q.question,
    answer: val,
    answered_at: new Date().toISOString()
  }});
}}

function submitSurvey() {{
  const answers = [];

  SURVEY.forEach((q, i) => {{
    let val = null;
    if (q.type === "rating") {{
      val = parseInt(document.getElementById("stars-"+i).dataset.val) || null;
    }} else if (q.type === "text") {{
      val = document.getElementById("sq-"+i).value.trim() || null;
    }} else if (q.type === "choice") {{
      const chosen = document.querySelector(`[data-qi="${{i}}"].chosen`);
      val = chosen ? chosen.dataset.val : null;
    }}
    answers.push({{ q_id: q.id, q_index: i+1, q_type: q.type, question: q.question, answer: val }});
  }});

  results.survey_answers = answers;
  results.completed_at = new Date().toISOString();
  saveLocal();

  // 保存完整学习记录（含所有题目详情 + 问卷）
  saveToServer("full_result", results);

  document.getElementById("survey-form").style.display = "none";
  document.querySelector(".submit-survey").style.display = "none";
  const done = document.getElementById("survey-done");
  done.style.display = "block";
  document.getElementById("saved-path").textContent = "学习记录已自动保存到服务器。";
}}

// ── 本地存储 ──────────────────────────────────────────────────────────────
function saveLocal() {{
  try {{ localStorage.setItem("edu_results_" + SESSION_KEY, JSON.stringify(results)); }} catch(e) {{}}
}}

function downloadResults() {{}}  // 已废弃，保留避免调用报错

// ── 服务器保存（适配反向代理）────────────────────────────────────────────
function saveToServer(type, data) {{
  // 取当前页面路径前缀，自动适配任意反向代理子路径
  const base = window.location.href.replace(/[/]?(?:index[.]html)?([?].*)?$/, "");
  const payload = {{
    type,
    session_id: SESSION_KEY,
    title: results.title,
    timestamp: new Date().toISOString(),
    data
  }};
  fetch(base + "/api/record", {{
    method: "POST",
    headers: {{"Content-Type": "application/json"}},
    body: JSON.stringify(payload)
  }}).catch(() => {{}});

  // full_result 同时写独立文件
  if (type === "full_result") {{
    fetch(base + "/api/save_results", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify({{ ...data, session_id: SESSION_KEY }})
    }}).catch(() => {{}});
  }}
}}

// ── 初始化 ────────────────────────────────────────────────────────────────
saveToServer("page_view", {{ title: document.title, ua: navigator.userAgent }});
renderKnowledge();
renderQuiz();
renderSurvey();
if (window.MathJax) MathJax.typesetPromise();
</script>
</body>
</html>"""


# ── 主流程 ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="交互式教学网页生成器")
    parser.add_argument("content",    help="教学内容文本（或文本文件路径）")
    parser.add_argument("output_dir", help="输出目录的绝对路径")
    args = parser.parse_args()

    # 支持传文件路径
    content_path = Path(args.content)
    if content_path.exists() and content_path.is_file():
        content = content_path.read_text(encoding="utf-8")
        print(f"[输入] 读取文件：{content_path}")
    else:
        content = args.content
        print(f"[输入] 使用文本内容（{len(content)} 字符）")

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"[输出] 目录：{out.resolve()}")

    if not API_KEY:
        print("[错误] 未设置 API_KEY，请在 .env 文件中配置。")
        sys.exit(1)

    # ── 调用 API 生成各模块 ────────────────────────────────────────────────
    print("\n── 开始生成教学内容 ──")
    title     = generate_title(content)
    knowledge = generate_knowledge(content)
    quiz      = generate_quiz(content)
    survey    = generate_survey(content)

    # ── 并发生成 SVG 示意图 ────────────────────────────────────────────────
    print("\n── 生成 SVG 示意图 ──")
    knowledge = attach_svgs(knowledge, content)
    quiz      = attach_svgs(quiz, content)

    # ── 保存中间文件 ───────────────────────────────────────────────────────
    print("\n── 保存中间文件 ──")
    save_json({"title": title, "content_preview": content[:200]},
              out / "meta.json", "元信息")
    save_json(knowledge, out / "knowledge.json", "知识点")
    save_json(quiz,      out / "quiz.json",      "习题")
    save_json(survey,    out / "survey.json",    "问卷")

    # ── 生成 HTML ─────────────────────────────────────────────────────────
    print("\n── 生成 HTML 网页 ──")
    html = render_html(title, knowledge, quiz, survey)
    html_path = out / "index.html"
    html_path.write_text(html, encoding="utf-8")
    print(f"  [保存] 网页 → {html_path}")

    # ── 创建空的结果记录文件 ───────────────────────────────────────────────
    results_path = out / "results.json"
    if not results_path.exists():
        save_json([], results_path, "学习结果记录（初始化）")

    print(f"\n✅ 完成！请用浏览器打开：{html_path.resolve()}")


if __name__ == "__main__":
    main()
