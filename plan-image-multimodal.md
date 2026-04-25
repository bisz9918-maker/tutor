# Plan: 把图片从 workspace 上传改为用户消息多模态 content

## Context

OAH 的 `openai-compatible` provider 对 tool-result 中的 `content` 类型执行 `JSON.stringify()`，导致图片数据丢失。只有用户消息的多模态 content 才能被模型真正"看到"。目前讲解和 VisualSolver 3 个场景都把图片上传到 workspace，agent 无法主动查看。需要改为像批改一样，把图片放在用户消息的 `{ type: "image", image: base64, mediaType: "image/png" }` 中。

## 修改清单

### 1. chat.ts — 讲解

**文件**: `/Users/bisz/Documents/tutor2_code/tutor/server/src/routes/chat.ts`

- 读取 `problem_diagram.png` 为 base64（不再上传到 workspace）
- 发送用户消息时，改为多模态 content 格式：
  ```typescript
  {
    content: [
      { type: "text", text: userMessage },
      { type: "image", image: base64Str, mediaType: "image/png" }
    ]
  }
  ```
- 删除上传 `problem_diagram.png` 到 workspace 的代码（第131-132行）
- 需要在缓存命中时也能获取图片 base64，所以在创建 workspace 时就读取图片并缓存

### 2. oah_client.py — VisualSolver（大纲）

**文件**: `/Users/bisz/Documents/tutor2_code/VisualSolver/oah_client.py`

- ~~添加 `send_multimodal_message` 方法，支持 `{ content: [{ type: "text", text: ... }, { type: "image", image: base64, mediaType: "image/png" }] }` 格式~~ ✅ 已完成
- `generate_scene_outline`: ✅ 已完成
  - 不再上传 `problem_image.png` 到 workspace，改为将图片转 base64 通过 `send_multimodal_message` 附带在消息中
  - prompt 改为"请先仔细查看附带的题目图片，结合 spec.json 生成详细的图片描述，写入 problem_img_description.txt；然后读取 spec.json，根据题目描述生成完整的教学图示大纲，写入 scene_outline.txt。完成后立即结束。"
  - 运行完成后从 workspace 读取 `problem_img_description.txt`
  - 返回值从 `str` 改为 `(outline, img_description)` tuple
- `generate_implementation_plan` (第354行): 待改
- `generate_scene_html` (第222行): 待改

### 3. runtime agent 提示词更新

**文件**:
- `/Users/bisz/Documents/test_oah_server2/source/runtimes/micro-learning/.openharness/agents/learn.md`
- `/Users/bisz/Documents/test_oah_server2/source/runtimes/question-tutor/` （如有相关提示词）
- `/Users/bisz/Documents/test_oah_server2/source/runtimes/visual-solver-*/` （如有相关提示词）

更新提示词：告诉 agent 图片会在消息中直接发送，无需从 workspace 读取图片文件。

### 4. 微调

- chat.ts 中 `problem_diagram.png` 不再上传后，workspace 中不再有此文件，但自动附件机制仍然可用（如果用户消息中包含路径）
- 保留 `uploadFileToWorkspace` 中的其他文件上传（solution.md, scene files, profile.json, mistakes.json 等）

## 验证

1. 重启 tutor 服务，发起讲解请求，确认模型能看到题目图片
2. 运行 VisualSolver pipeline，确认大纲/计划/代码生成都能正确传递图片
3. 检查 OAH session 消息，确认图片以 `{ type: "image" }` 形式出现在用户消息中
