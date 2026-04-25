import os
import re
import json
from typing import Union, List, Dict, Optional
from PIL import Image

from mllm_tools.utils import _prepare_text_inputs
from task_generator import (
    get_prompt_code_generation,
    get_prompt_code_generation_diff,
    get_banned_reasonings,
)


class CodeGenerator:
    """A class for generating and managing HTML/CSS/JS educational diagram code."""

    def __init__(self, scene_model, helper_model, output_dir="output", print_response=False,
                 use_rag=False, use_context_learning=False, context_learning_path="data/context_learning",
                 chroma_db_path="rag/chroma_db", manim_docs_path="rag/manim_docs",
                 embedding_model="azure/text-embedding-3-large", use_visual_fix_code=False,
                 use_langfuse=True, session_id=None, use_diff_patch: bool = True):
        self.scene_model = scene_model
        self.helper_model = helper_model
        self.output_dir = output_dir
        self.print_response = print_response
        self.use_visual_fix_code = use_visual_fix_code
        self.use_diff_patch = use_diff_patch
        self.banned_reasonings = get_banned_reasonings()
        self.session_id = session_id

    async def _load_scene1_reference_code(self, topic: str, file_prefix: str) -> Optional[str]:
        """Load the successfully saved Scene 1 HTML code as a reference.

        Args:
            topic (str): Topic name
            file_prefix (str): File prefix for the topic

        Returns:
            Optional[str]: Scene 1 HTML code if found, None otherwise
        """
        import asyncio

        scene1_dir = os.path.join(self.output_dir, file_prefix, "scene1")
        scene1_code_dir = os.path.join(scene1_dir, "code")

        # Wait for Scene 1 to be successfully saved (with timeout)
        max_wait_time = 600  # Maximum 10 minutes wait
        wait_interval = 5    # Check every 5 seconds
        total_waited = 0

        succ_marker = os.path.join(scene1_dir, "succ_rendered.txt")
        done_marker = os.path.join(scene1_code_dir, "scene1_code_tokens.json")

        while not os.path.exists(succ_marker) and total_waited < max_wait_time:
            if os.path.exists(done_marker):
                raise RuntimeError(
                    f"Scene 1 processing finished but saving failed for {file_prefix}, skipping topic"
                )
            if total_waited == 0:
                print(f"⏳ Waiting for Scene 1 to be successfully saved before generating scene code...")
            else:
                print(f"⏳ Still waiting for Scene 1... ({total_waited}s elapsed)")

            await asyncio.sleep(wait_interval)
            total_waited += wait_interval

        if not os.path.exists(succ_marker):
            print(f"⚠️  Scene 1 not successfully saved after {max_wait_time}s, proceeding without reference")
            return None

        print(f"✓ Scene 1 successfully saved after {total_waited}s, loading reference code")

        # Read the successful version number
        try:
            with open(succ_marker, 'r') as f:
                version_str = f.read().strip()
                version_num = int(version_str[1:]) if version_str.startswith('v') else int(version_str)
        except Exception:
            version_num = 0

        # Find the HTML code file
        code_file = os.path.join(scene1_code_dir, f"{file_prefix}_scene1_v{version_num}.html")

        if not os.path.exists(code_file):
            # Try to find any saved version
            if os.path.isdir(scene1_code_dir):
                code_files = [f for f in os.listdir(scene1_code_dir)
                              if f.endswith('.html') and 'scene1' in f]
                if code_files:
                    code_files.sort(
                        key=lambda x: int(re.search(r'_v(\d+)\.html$', x).group(1))
                        if re.search(r'_v(\d+)\.html$', x) else 0
                    )
                    code_file = os.path.join(scene1_code_dir, code_files[-1])
                else:
                    return None
            else:
                return None

        try:
            with open(code_file, 'r') as f:
                code = f.read()
                print(f"✓ Loaded Scene 1 reference code from: {code_file}")
                return code
        except Exception as e:
            print(f"❌ Failed to load Scene 1 code: {e}")
            return None

    def _apply_diff_patch(self, code: str, diff_text: str) -> str:
        """Apply a <DIFF> patch to HTML code using exact string matching.

        Each <EDIT> block contains <old> and <new> sub-blocks.
        - <old> must match exactly once in the current code.
        - <new> replaces the matched substring.
        - Edits are applied top-to-bottom in order.

        Args:
            code (str): The original source code (Scene 1 HTML).
            diff_text (str): The raw text containing the <DIFF>...</DIFF> block.

        Returns:
            str: The patched code.

        Raises:
            ValueError: If any <old> string is not found or matches multiple times.
        """
        diff_match = re.search(r'<DIFF>(.*?)</DIFF>', diff_text, re.DOTALL)
        if not diff_match:
            raise ValueError("No <DIFF>...</DIFF> block found in response")

        diff_block = diff_match.group(1)
        edits = re.findall(r'<EDIT>\s*<old>(.*?)</old>\s*<new>(.*?)</new>\s*</EDIT>', diff_block, re.DOTALL)

        if not edits:
            raise ValueError("No <EDIT> blocks found inside <DIFF>")

        for i, (old_str, new_str) in enumerate(edits):
            # Strip exactly one leading/trailing newline added by the XML formatting
            if old_str.startswith('\n'):
                old_str = old_str[1:]
            if old_str.endswith('\n'):
                old_str = old_str[:-1]
            if new_str.startswith('\n'):
                new_str = new_str[1:]
            if new_str.endswith('\n'):
                new_str = new_str[:-1]

            count = code.count(old_str)
            if count == 0:
                raise ValueError(f"Edit #{i+1}: <old> string not found in code:\n{old_str[:200]}")
            if count > 1:
                raise ValueError(
                    f"Edit #{i+1}: <old> string matches {count} locations (must be unique):\n{old_str[:200]}"
                )

            code = code.replace(old_str, new_str, 1)

        return code

    async def _apply_diff_with_retry(self, scene1_code: str, response_text: str, scene_number: int,
                                      scene_trace_id: str, session_id: str,
                                      diff_prompt: str, max_retries: int = 2) -> Optional[str]:
        """Apply diff patch with retry on failure. Returns patched code or None if all retries fail."""
        current_response = response_text

        for attempt in range(max_retries + 1):
            try:
                patched = self._apply_diff_patch(scene1_code, current_response)
                if attempt > 0:
                    print(f"✓ Diff patch succeeded on retry attempt {attempt}")
                return patched
            except ValueError as e:
                if attempt == max_retries:
                    print(f"✗ Diff patch failed after {max_retries} retries: {e}")
                    return None

                print(f"⚠️  Diff apply error (attempt {attempt+1}): {e}")
                print(f"   Retrying: asking model to fix the failing <EDIT>...")

                retry_messages = [
                    {"type": "text", "content": diff_prompt},
                    {"type": "text", "content": f"[Assistant's previous response]\n{current_response}"},
                    {"type": "text", "content": (
                        f"The diff could not be applied. Error:\n{e}\n\n"
                        "Please output a corrected <DIFF> block. "
                        "For the failing <EDIT>, copy the <old> string **character-for-character** "
                        "from the Scene 1 code provided above — do not paraphrase or reconstruct it."
                    )}
                ]

                current_response = await self.scene_model(
                    retry_messages,
                    metadata={
                        "generation_name": f"code_generation_diff_retry_{attempt+1}",
                        "trace_id": scene_trace_id,
                        "session_id": session_id,
                    }
                )

        return None

    async def _extract_code_with_retries(self, response_text: str, pattern: str,
                                          generation_name: str = None, trace_id: str = None,
                                          session_id: str = None, max_retries: int = 10) -> str:
        """Extract code from response text with retry logic."""
        retry_prompt = (
            "Please extract the HTML code in the correct format using the pattern: {pattern}. "
            "You MUST NOT include any other text or comments. "
            "You MUST return the exact same code as in the previous response, NO CONTENT EDITING is allowed.\n"
            "Previous response:\n{response_text}"
        )

        for attempt in range(max_retries):
            code_match = re.search(pattern, response_text, re.DOTALL)
            if code_match:
                return code_match.group(1)

            if attempt < max_retries - 1:
                print(f"Attempt {attempt + 1}: Failed to extract code pattern. Retrying...")
                response_text = await self.scene_model(
                    _prepare_text_inputs(retry_prompt.format(pattern=pattern, response_text=response_text)),
                    metadata={
                        "generation_name": f"{generation_name}_format_retry_{attempt + 1}",
                        "trace_id": trace_id,
                        "session_id": session_id
                    }
                )

        raise ValueError(f"Failed to extract code pattern after {max_retries} attempts. Pattern: {pattern}")

    async def generate_html_code(self,
                                 topic: str,
                                 description: str,
                                 scene_outline: str,
                                 scene_implementation: str,
                                 scene_number: int,
                                 additional_context: Union[str, List[str]] = None,
                                 scene_trace_id: str = None,
                                 session_id: str = None,
                                 problem_image: Union[Image.Image, None] = None,
                                 file_prefix: str = None,
                                 use_diff_patch: bool = True) -> tuple:
        """Generate HTML/CSS/JS code for a scene.

        Returns:
            Tuple[str, str]: Generated code and response text
        """
        # --- Diff-patch branch for scene2+ ---
        if use_diff_patch and self.use_diff_patch and scene_number > 1 and file_prefix:
            scene1_code = await self._load_scene1_reference_code(topic, file_prefix)
            if scene1_code:
                print(f"✓ Using diff-patch mode for scene {scene_number}")

                diff_prompt = get_prompt_code_generation_diff(
                    topic=topic,
                    description=description,
                    scene_outline=scene_outline,
                    scene_implementation=scene_implementation,
                    scene_number=scene_number,
                    scene1_code=scene1_code,
                    additional_context=additional_context
                )

                messages = _prepare_text_inputs(diff_prompt)
                response_text = await self.scene_model(
                    messages,
                    metadata={
                        "generation_name": "code_generation_diff",
                        "trace_id": scene_trace_id,
                        "tags": [topic, f"scene{scene_number}"],
                        "session_id": session_id
                    }
                )

                code = await self._apply_diff_with_retry(
                    scene1_code=scene1_code,
                    response_text=response_text,
                    scene_number=scene_number,
                    scene_trace_id=scene_trace_id,
                    session_id=session_id,
                    diff_prompt=diff_prompt,
                )

                if code is not None:
                    return code, response_text

                # Diff failed after retries → fallback to full code generation
                print(f"⚠️  Diff-patch failed for scene {scene_number}, falling back to full code generation")

        # --- Full code generation (scene1, or fallback for scene2+) ---
        if scene_number > 1 and file_prefix:
            scene1_code_ref = await self._load_scene1_reference_code(topic, file_prefix)
            if scene1_code_ref:
                if additional_context is None:
                    additional_context = []
                scene1_reference = (
                    "**Scene 1 参考代码**（用于风格一致性）：\n"
                    "请保持与 Scene 1 相同的视觉风格、配色方案和布局原则。\n\n"
                    f"```html\n{scene1_code_ref}\n```\n\n"
                    "重要：保持与 Scene 1 的一致性：\n"
                    "- 使用相同的背景色\n"
                    "- 使用相同的线宽和字号\n"
                    "- 遵循相似的元素定位和间距\n"
                    "- 遵循相同的代码结构和组织方式\n"
                )
                additional_context.append(scene1_reference)

        prompt = get_prompt_code_generation(
            scene_outline=scene_outline,
            scene_implementation=scene_implementation,
            topic=topic,
            description=description,
            scene_number=scene_number,
            additional_context=additional_context
        )

        if problem_image and scene_number == 1:
            messages = [
                {"type": "text", "content": prompt},
                {"type": "image", "content": problem_image}
            ]
            print(f"Including problem diagram in code generation for scene {scene_number}")
        else:
            messages = _prepare_text_inputs(prompt)

        response_text = await self.scene_model(
            messages,
            metadata={
                "generation_name": "code_generation",
                "trace_id": scene_trace_id,
                "tags": [topic, f"scene{scene_number}"],
                "session_id": session_id
            }
        )

        # Extract HTML from <CODE>...</CODE> block, then from ```html...``` fences
        code = None
        code_block_match = re.search(r'<CODE>(.*?)</CODE>', response_text, re.DOTALL)
        if code_block_match:
            inner = code_block_match.group(1)
            html_match = re.search(r'```html(.*?)```', inner, re.DOTALL)
            if html_match:
                code = html_match.group(1).strip()
            else:
                code = inner.strip()
        else:
            # Fallback: extract from ```html...``` anywhere in response
            try:
                code = await self._extract_code_with_retries(
                    response_text,
                    r'```html(.*?)```',
                    generation_name="code_generation",
                    trace_id=scene_trace_id,
                    session_id=session_id
                )
                code = code.strip()
            except ValueError:
                pass

        if not code:
            raise ValueError("Failed to extract HTML code from model response")

        return code, response_text

    # Keep old name as alias for compatibility during migration
    async def generate_manim_code(self, *args, **kwargs):
        return await self.generate_html_code(*args, **kwargs)
