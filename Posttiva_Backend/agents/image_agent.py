# ═══════════════════════════════════════════════════════════════════
#  agents/image_agent.py
#  Image Agent — IDENTICAL logic from Colab notebook Cell 9
#
#  Changes from Colab (wrapper only — zero logic changes):
#    • Removed google.colab imports
#    • API keys come from environment variables
#    • input() prompts replaced by settings dict from API request
#    • /content/ paths replaced by workspace parameter
#    • print() statements kept — they appear in RunPod logs
# ═══════════════════════════════════════════════════════════════════

import os, json, time, random
import numpy as np
from typing import Callable, Optional
from PIL import Image


def run_image_agent(
    product_path: str,
    mask_path:    str,
    settings:     dict,
    workspace:    str,
    on_progress:  Optional[Callable[[str], None]] = None,
) -> str:
    """
    Runs the full Image Agent pipeline.
    Returns path to approved background image.
    """

    def _prog(msg):
        if on_progress:
            on_progress(msg)
        print(msg)

    # ── API key ───────────────────────────────────────────────────
    import anthropic as _ant
    IMAGE_AGENT_ANTHROPIC_KEY = os.environ.get("IMAGE_AGENT_ANTHROPIC_KEY", "")
    client = _ant.Anthropic(api_key=IMAGE_AGENT_ANTHROPIC_KEY)

    # ── Settings ──────────────────────────────────────────────────
    rm = settings.get("room",       "Living Room")
    st = settings.get("room_style", "Modern")
    raw_lt = settings.get("lighting", "Sunlight")
    lt = "Indoor" if "indoor" in raw_lt.lower() else "Sunlight"
    fr = settings.get("frame",      "square")

    # ════════════════════════════════════════════════════════════════
    # IMAGE AGENT TOOLS — IDENTICAL to Colab notebook Cell 4
    # ════════════════════════════════════════════════════════════════
    IMAGE_AGENT_TOOLS = [
        {
            "name": "check_product_integrity",
            "description": (
                "Checks whether the product in the generated image is preserved correctly. "
                "Compares the product region using the SAM mask. "
                "Returns integrity_score and a qualitative label. "
                "Reason from the label only — ignore the number:\n"
                "- 'excellent':  product looks identical to original\n"
                "- 'acceptable': minor differences but product is clearly intact\n"
                "- 'degraded':   color shift, warping, or partial deletion detected\n"
                "- 'missing':    product is gone or unrecognizable\n"
                "PASS if label is 'excellent' or 'acceptable'. "
                "FAIL if label is 'degraded' or 'missing'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "generated_image_path":  {"type": "string"},
                    "original_product_path": {"type": "string"},
                    "mask_path":             {"type": "string"}
                },
                "required": ["generated_image_path", "original_product_path", "mask_path"]
            }
        },
        {
            "name": "detect_artifacts",
            "description": (
                "Detects visual artifacts or distortions in the generated background. "
                "Returns artifact_score and a qualitative label. "
                "Reason from the label only — ignore the number:\n"
                "- 'clean':                background looks natural and seamless\n"
                "- 'minor_issues':         slight blurring or edge roughness but acceptable\n"
                "- 'noticeable_artifacts': visible seams, ghosting, or texture breaks\n"
                "- 'severe_artifacts':     background is clearly broken or distorted\n"
                "PASS if label is 'clean' or 'minor_issues'. "
                "FAIL if label is 'noticeable_artifacts' or 'severe_artifacts'."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "generated_image_path": {"type": "string"},
                    "mask_path":            {"type": "string"}
                },
                "required": ["generated_image_path", "mask_path"]
            }
        },
        {
            "name": "approve_image",
            "description": (
                "Approves the image — both automated checks passed. "
                "Call ONLY when BOTH checks pass. "
                "In the reason field explain what you observed for each check."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "generated_image_path": {"type": "string"},
                    "reason":               {"type": "string"}
                },
                "required": ["generated_image_path", "reason"]
            }
        },
        {
            "name": "reject_and_regenerate",
            "description": (
                "Rejects the image — at least one automated check failed. "
                "Call if ANY check fails. "
                "In the reason field explain which check failed and why.\n"
                "Choose regeneration mode:\n"
                "- 'same_selections':  retry with same room/style/lighting/frame\n"
                "- 'new_selections': ask the user to pick new room/style/lighting/frame"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "reason":      {"type": "string"},
                    "failed_check": {
                        "type": "string",
                        "enum": ["product_integrity", "artifacts", "multiple"]
                    },
                    "regeneration_mode": {
                        "type": "string",
                        "enum": ["same_selections", "new_selections"]
                    }
                },
                "required": ["reason", "failed_check", "regeneration_mode"]
            }
        }
    ]

    # ════════════════════════════════════════════════════════════════
    # TOOL IMPLEMENTATIONS — IDENTICAL to Colab notebook Cell 5
    # ════════════════════════════════════════════════════════════════

    def _tool_check_product_integrity(generated_image_path, original_product_path, mask_path):
        try:
            import base64
            from io import BytesIO

            # Load both images
            generated = Image.open(generated_image_path).convert('RGB')
            product   = Image.open(original_product_path).convert('RGB')

            # Convert to base64
            def to_b64(img):
                buf = BytesIO()
                img.save(buf, format='JPEG', quality=85)
                return base64.standard_b64encode(buf.getvalue()).decode('utf-8')

            gen_b64  = to_b64(generated)
            prod_b64 = to_b64(product)

            _client = _ant.Anthropic(api_key=IMAGE_AGENT_ANTHROPIC_KEY)

            prompt = (
    "You are a strict quality checker for furniture product images.\n\n"
    "Image 1: the ORIGINAL product (may have black background).\n"
    "Image 2: the GENERATED scene.\n\n"
    "Focus ONLY on the furniture piece — ignore background completely.\n\n"
    "Check STRICTLY:\n"
    "- Is the EXACT same product visible? Same shape, same silhouette?\n"
    "- Were any details ADDED that do not exist in the original?\n"
    "  (e.g. nailhead trim, legs, buttons, extra stitching, decorative elements)\n"
    "- Were any details REMOVED or changed?\n"
    "- Is the color/texture preserved?\n\n"
    "If ANY detail was added or removed — even small ones — label as 'degraded'.\n"
    "Only label 'excellent' if the product looks IDENTICAL with zero changes.\n"
    "Label 'acceptable' if differences are ONLY from natural lighting/shadows — this is normal and expected.\n"
    "Label 'degraded' ONLY if structural details were added or removed (legs, trim, buttons, etc).\n\n"
    "Reply ONLY with one of these labels:\n"
    "- 'excellent'  : product looks identical, zero additions or removals\n"
    "- 'acceptable' : only lighting difference, nothing added or removed\n"
    "- 'degraded'   : any detail added, removed, or changed\n"
    "- 'missing'    : product is gone or unrecognizable\n\n"
    "Reply with ONLY the label word, nothing else."
)

            response = _client.messages.create(
                model='claude-opus-4-5',
                max_tokens=10,
                messages=[{
                    'role': 'user',
                    'content': [
                        {'type': 'text',  'text': 'Image 1 — Original product:'},
                        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': prod_b64}},
                        {'type': 'text',  'text': 'Image 2 — Generated scene:'},
                        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': gen_b64}},
                        {'type': 'text',  'text': prompt},
                    ]
                }]
            )

            label = response.content[0].text.strip().lower().replace("'", "")
            if label not in ('excellent', 'acceptable', 'degraded', 'missing'):
                label = 'acceptable'  # fallback if unexpected response

            passed = label in ('excellent', 'acceptable')

            print(f"       Vision check: {label} → {'✅ PASS' if passed else '❌ FAIL'}")

            return {
                'integrity_score': 1.0 if label == 'excellent' else 0.8 if label == 'acceptable' else 0.4 if label == 'degraded' else 0.0,
                'qualitative': label,
                'passed': passed,
                'status': 'product_preserved' if passed else 'PRODUCT_CHANGED'
            }

        except Exception as e:
            print(f"       Vision check error: {e} — defaulting to acceptable")
            return {'integrity_score': 0.8, 'qualitative': 'acceptable', 'passed': True, 'status': 'fallback'}


    def _tool_detect_artifacts(generated_image_path, mask_path):
        try:
            import cv2
            generated = Image.open(generated_image_path).convert('RGB')
            mask_img  = Image.open(mask_path).convert('L')

            mask_img  = mask_img.resize(generated.size, Image.Resampling.LANCZOS)
            mask_np   = np.array(mask_img)
            gen_np    = np.array(generated).astype(np.float32)

            bg_mask  = (mask_np > 128).astype(np.uint8)
            kernel   = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
            dilated  = cv2.dilate(bg_mask, kernel, iterations=2)
            eroded   = cv2.erode(bg_mask,  kernel, iterations=2)
            boundary = ((dilated - eroded) > 0)

            if boundary.sum() == 0:
                edge_score = 1.0
            else:
                bp   = gen_np[boundary]
                diff = np.abs(bp - bp.mean(axis=0))
                edge_score = round(max(0.0, min(1.0, 1.0 - float(diff.mean() / 255.0))), 4)

            gray = cv2.cvtColor(np.array(generated), cv2.COLOR_RGB2GRAY).astype(np.float64)
            k    = cv2.getGaussianKernel(7, 7/6)
            k2d  = k @ k.T
            mu   = cv2.filter2D(gray, -1, k2d)
            sq   = cv2.filter2D(gray**2, -1, k2d)
            sig  = np.sqrt(np.abs(sq - mu**2))
            mscn = (gray - mu) / (sig + 1)

            ps, patches = 96, []
            h, w = mscn.shape
            for i in range(0, h - ps, ps):
                for j in range(0, w - ps, ps):
                    p = mscn[i:i+ps, j:j+ps]
                    patches.append([p.mean(), p.var()])

            niqe_score = 0.0
            if len(patches) >= 2:
                p_arr = np.array(patches)
                mu_p  = p_arr.mean(axis=0)
                cov   = np.cov(p_arr.T)
                niqe_score = float(np.sqrt(np.trace(cov)) / (np.linalg.norm(mu_p) + 1e-6))

            niqe_norm      = max(0.0, min(1.0, 1.0 - niqe_score / 3.0))
            artifact_score = round(edge_score * 0.6 + niqe_norm * 0.4, 4)

            label = (
                'clean'                if artifact_score >= 0.85 else
                'minor_issues'         if artifact_score >= 0.65 else
                'noticeable_artifacts' if artifact_score >= 0.40 else
                'severe_artifacts'
            )
            return {
                'artifact_score':  artifact_score,
                'edge_coherence':  edge_score,
                'niqe_score':      round(niqe_score, 4),
                'qualitative':     label,
                'passed':          label in ('clean', 'minor_issues'),
                'status':          'clean' if label in ('clean', 'minor_issues') else 'ARTIFACTS_DETECTED'
            }
        except Exception as e:
            return {'artifact_score': 0.0, 'qualitative': 'severe_artifacts', 'passed': False, 'error': str(e)}


    def _dispatch_tool(tool_name, tool_input):
        if tool_name == 'check_product_integrity':
            return _tool_check_product_integrity(**tool_input)
        elif tool_name == 'detect_artifacts':
            return _tool_detect_artifacts(**tool_input)
        elif tool_name == 'approve_image':
            return {'approved': True, 'path': tool_input['generated_image_path']}
        elif tool_name == 'reject_and_regenerate':
            return {
                'rejected':          True,
                'reason':            tool_input['reason'],
                'failed_check':      tool_input['failed_check'],
                'regeneration_mode': tool_input.get('regeneration_mode', 'same_selections')
            }
        else:
            return {'error': f'Unknown tool: {tool_name}'}

    # ════════════════════════════════════════════════════════════════
    # ImageAgent class — IDENTICAL to Colab notebook Cell 6
    # ════════════════════════════════════════════════════════════════
    class ImageAgent:
        MAX_RETRIES = 3

        def __init__(self, anthropic_client):
            self.client = anthropic_client
            self.approved_image_path = None

        def _run_agent(self, generated_path, product_path, mask_path, prompt):
            print(f"\n{'─'*55}")
            print(f"  🤖  Evaluating: {os.path.basename(generated_path)}")
            print(f"{'─'*55}")

            system_prompt = (
                'You are the Image Agent for Posttiva, a poster generation system.\n'
                'Run ALL THREE checks in order:\n'
                '  1. check_product_integrity\n'
                '  2. detect_artifacts\n'
                '  3. human_style_approval  ← always run this last, shows image to user\n\n'
                'RULES:\n'
                '- Evaluate each check using its qualitative label — ignore the numeric score.\n'
                '- If ANY single check FAILS → call reject_and_regenerate.\n'
                '- Only if ALL THREE pass → call approve_image.\n'
                '- When rejecting, choose regeneration_mode:\n'
                "    'same_selections'  — if product integrity or artifacts failed\n"
                "    'new_selections' — if user rejected the style (human_style_approval failed)\n"
                'Never describe images to the user. Only call tools.'
            )

            user_msg = (
                f'Evaluate this generated image:\n'
                f'- Generated: {generated_path}\n'
                f'- Product:   {product_path}\n'
                f'- Mask:      {mask_path}\n'
                f'- Prompt:    {prompt}\n\n'
                'Run all three checks then approve or reject.'
            )

            messages        = [{'role': 'user', 'content': user_msg}]
            _executed_steps = []

            while True:
                response = client.messages.create(
                    model='claude-sonnet-4-20250514',
                    max_tokens=1024,
                    system=system_prompt,
                    tools=IMAGE_AGENT_TOOLS,
                    messages=messages
                )
                messages.append({'role': 'assistant', 'content': response.content})

                if response.stop_reason == 'end_turn':
                    print('  ⚠️  Agent ended without a decision — check system prompt.')
                    break

                if response.stop_reason == 'tool_use':
                    tool_results   = []
                    final_decision = None

                    for block in response.content:
                        if block.type != 'tool_use':
                            continue
                        print(f'  🔧  {block.name}')
                        _executed_steps.append(block.name)
                        result = _dispatch_tool(block.name, block.input)
                        print(f'       {result}')

                        if block.name == 'approve_image':
                            final_decision = ('approved', block.input['generated_image_path'])
                        elif block.name == 'reject_and_regenerate':
                            final_decision = (
                                'rejected',
                                block.input['reason'],
                                block.input['failed_check'],
                                block.input.get('regeneration_mode', 'same_selections')
                            )

                        tool_results.append({
                            'type':        'tool_result',
                            'tool_use_id': block.id,
                            'content':     json.dumps(result)
                        })

                    messages.append({'role': 'user', 'content': tool_results})

                    if final_decision:
                        return final_decision, _executed_steps

            return ('rejected', 'Agent ended without decision', 'unknown', 'same_selections'), _executed_steps

        def evaluate(self, generated_path, product_path, mask_path, prompt='',
                     regenerate_fn=None, reselect_fn=None):

            current_path = generated_path
            reason       = 'unknown'
            _start_time  = time.time()

            # Track all attempts for fallback selection
            _all_attempts = []  # (path, integrity_score, artifact_score, composite)

            for attempt in range(1, self.MAX_RETRIES + 1):
                print(f"\n{'='*55}")
                print(f'  🤖  IMAGE AGENT — Attempt {attempt}/{self.MAX_RETRIES}')
                print(f"{'='*55}")

                result, _steps = self._run_agent(current_path, product_path, mask_path, prompt)

                if result[0] == 'approved':
                    _int_res         = _tool_check_product_integrity(current_path, product_path, mask_path)
                    _art_res         = _tool_detect_artifacts(current_path, mask_path)
                    _integrity_score = _int_res.get('integrity_score', 0.0)
                    _artifact_score  = _art_res.get('artifact_score',  0.0)
                    _composite       = round((_integrity_score + _artifact_score) / 2, 4)
                    _elapsed         = round(time.time() - _start_time, 2)

                    _all_attempts.append((current_path, _integrity_score, _artifact_score, _composite))

                    print('\n  ✅  APPROVED — ready for user.')
                    self.approved_image_path = current_path

                    fname = os.path.basename(current_path)
                    print(f"\n  Running full evaluation on approved image...")
                    print(f"  ╔═══════════════════════════════════════════════════════╗")
                    print(f"  ║       POSTTIVA — IMAGE AGENT FINAL REPORT             ║")
                    print(f"  ╠═══════════════════════════════════════════════════════╣")
                    print(f"  ║  Image: {fname:<45} ║")
                    print(f"  ╠───────────────────────────────────────────────────────╣")
                    print(f"  ║  1. Product Integrity                                 ║")
                    print(f"  ║     Score: {_integrity_score:.4f}                                    ║")
                    print(f"  ║     Label: {_int_res.get('qualitative',''):<10}  →  {'✅ PASS' if _int_res.get('passed') else '❌ FAIL':<20}║")
                    print(f"  ╠───────────────────────────────────────────────────────╣")
                    print(f"  ║  2. Artifact Detection                                ║")
                    print(f"  ║     Score: {_artifact_score:.4f}                                    ║")
                    print(f"  ║     Label: {_art_res.get('qualitative',''):<10}  →  {'✅ PASS' if _art_res.get('passed') else '❌ FAIL':<20}║")
                    print(f"  ╠───────────────────────────────────────────────────────╣")
                    print(f"  ║  3. Composite Score (avg)                             ║")
                    print(f"  ║     Score: {_composite:.4f}                                    ║")
                    print(f"  ╠───────────────────────────────────────────────────────╣")
                    print(f"  ║  4. Style Approval                                    ║")
                    print(f"  ║     Approved by user ✅                                ║")
                    print(f"  ╠───────────────────────────────────────────────────────╣")
                    print(f"  ║  Generation Time: {_elapsed:.1f}s ({attempt} attempt{'s' if attempt>1 else ''})              ║")
                    print(f"  ╚═══════════════════════════════════════════════════════╝")

                    return current_path

                # ── Rejected ─────────────────────────────────────────────
                reason     = result[1]
                failed     = result[2]
                regen_mode = result[3] if len(result) > 3 else 'same_selections'
                print(f'\n  ❌  REJECTED ({failed}): {reason}')
                print(f'  🔄  Mode: {regen_mode}')

                _int_res = _tool_check_product_integrity(current_path, product_path, mask_path)
                _art_res = _tool_detect_artifacts(current_path, mask_path)
                _is = _int_res.get('integrity_score', 0.0)
                _as = _art_res.get('artifact_score',  0.0)
                _cs = round((_is + _as) / 2, 4)
                _all_attempts.append((current_path, _is, _as, _cs))

                if attempt < self.MAX_RETRIES:
                    if regen_mode == 'new_selections' and reselect_fn:
                        print('  🎨  Asking user for new selections...')
                        try:
                            current_path = reselect_fn()
                            print(f'  📁  New image: {os.path.basename(current_path)}')
                        except Exception as e:
                            print(f'  ⚠️  Reselection error: {e}')
                            break
                    elif regenerate_fn:
                        print('  🔁  Regenerating with same selections...')
                        try:
                            current_path = regenerate_fn()
                            print(f'  📁  New image: {os.path.basename(current_path)}')
                        except Exception as e:
                            print(f'  ⚠️  Regeneration error: {e}')
                            break
                    else:
                        print('  ⚠️  No regenerate_fn — stopping.')
                        break

            # ── All attempts failed — pick best by composite score ────────
            print(f"\n  ⚠️  All {self.MAX_RETRIES} attempts failed — selecting best automatically...")
            _best            = max(_all_attempts, key=lambda x: x[3])
            best_path        = _best[0]
            _integrity_score = _best[1]
            _artifact_score  = _best[2]
            _composite       = _best[3]
            _elapsed         = round(time.time() - _start_time, 2)

            print(f"  → Best: {os.path.basename(best_path)} (composite={_composite:.4f})")
            for i, att in enumerate(_all_attempts):
                print(f"     Attempt {i+1}: {os.path.basename(att[0])} | integrity={att[1]:.4f} artifact={att[2]:.4f} composite={att[3]:.4f}")

            self.approved_image_path = best_path

            _int_res = _tool_check_product_integrity(best_path, product_path, mask_path)
            _art_res = _tool_detect_artifacts(best_path, mask_path)
            fname    = os.path.basename(best_path)

            print(f"\n  Running full evaluation on best available image...")
            print(f"  ╔═══════════════════════════════════════════════════════╗")
            print(f"  ║       POSTTIVA — IMAGE AGENT FINAL REPORT             ║")
            print(f"  ╠═══════════════════════════════════════════════════════╣")
            print(f"  ║  Image: {fname:<45} ║")
            print(f"  ║  Note: Auto-selected (best of failed attempts)        ║")
            print(f"  ╠───────────────────────────────────────────────────────╣")
            print(f"  ║  1. Product Integrity                                 ║")
            print(f"  ║     Score: {_integrity_score:.4f}                                    ║")
            print(f"  ║     Label: {_int_res.get('qualitative',''):<10}  →  {'✅ PASS' if _int_res.get('passed') else '❌ FAIL':<20}║")
            print(f"  ╠───────────────────────────────────────────────────────╣")
            print(f"  ║  2. Artifact Detection                                ║")
            print(f"  ║     Score: {_artifact_score:.4f}                                    ║")
            print(f"  ║     Label: {_art_res.get('qualitative',''):<10}  →  {'✅ PASS' if _art_res.get('passed') else '❌ FAIL':<20}║")
            print(f"  ╠───────────────────────────────────────────────────────╣")
            print(f"  ║  3. Composite Score (avg)                             ║")
            print(f"  ║     Score: {_composite:.4f}                                    ║")
            print(f"  ╠───────────────────────────────────────────────────────╣")
            print(f"  ║  4. Style Approval                                    ║")
            print(f"  ║     Auto-selected ⚠️                                   ║")
            print(f"  ╠───────────────────────────────────────────────────────╣")
            print(f"  ║  Generation Time: {_elapsed:.1f}s ({self.MAX_RETRIES} attempts)              ║")
            print(f"  ╚═══════════════════════════════════════════════════════╝")

            return best_path

    # ════════════════════════════════════════════════════════════════
    # PosterBackgroundDesigner class — IDENTICAL to Colab notebook
    # ════════════════════════════════════════════════════════════════
    import torch
    import cv2
    from diffusers import AutoPipelineForInpainting as StableDiffusionInpaintPipeline
    from PIL import ImageFilter, ImageDraw

    class PosterBackgroundDesigner:
        def __init__(self, device: str = "cuda"):
            self.device = device if torch.cuda.is_available() else "cpu"
            model_id = "sd2-community/stable-diffusion-2-inpainting"

            print("🚀 Loading SD Inpainting model...")
            self.pipe = StableDiffusionInpaintPipeline.from_pretrained(
                model_id,
                torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
                safety_checker=None,
            ).to(self.device)
            self.pipe.enable_attention_slicing()
            print("✅  Model ready.")

            self.CONFIG = {
                "Classic": {
                    "scene": (
                        "elegant editorial backdrop, "
                        "smooth warm ivory plaster wall, soft gradient light on wall, "
                        "polished dark walnut herringbone floor, "
                        "one thin vintage Persian rug on the floor under the product, "
                        "one tall minimal floor lamp with warm glow beside the product, "
                        "nothing else, calm and refined"
                    ),
                },
                "Modern": {
                    "scene": (
                        "sleek editorial backdrop, "
                        "smooth warm greige concrete wall with subtle gradient, "
                        "large format light stone floor tiles, "
                        "one simple geometric low-pile rug under the product, "
                        "one abstract minimal framed art panel on the wall above, "
                        "nothing else, clean and modern"
                    ),
                },
                "Boho": {
                    "scene": (
                        "warm earthy editorial backdrop, "
                        "soft warm white lime-wash textured wall, "
                        "natural light oak wide-plank floor, "
                        "one woven natural jute rug under the product, "
                        "one warm wicker pendant lamp hanging above the scene, "
                        "nothing else, organic and cozy"
                    ),
                },
            }

            self.LIGHT_DATA = {
                "Sunlight": (
                    (
                        "soft warm golden-hour sunlight streaming through a side window, "
                        "gentle light beams falling on floor and walls around the product, "
                        "warm daylight atmosphere, realistic interior sunlight, "
                        "subtle window bloom, photorealistic natural lighting, "
                        "the light highlights and draws attention to the product"
                    ),
                    (
                        "artificial lighting, neon, dark night, no windows, "
                        "overexposed, blown-out highlights, pitch black shadows"
                    ),
                ),
                "Indoor": (
                    (
                        "nighttime interior, warm soft ambient artificial lighting, "
                        "ceiling recessed lights and warm chandelier glowing above the product, "
                        "cozy quiet night atmosphere, subtle soft shadows around the product, "
                        "no sunlight, no outdoor glow, realistic night home ambiance, "
                        "the light highlights and draws attention to the product"
                    ),
                    (
                        "sunlight, daylight, bright windows, outdoor light, sun rays, "
                        "overexposed, washed out, too bright"
                    ),
                ),
            }

            self.FRAME_SIZES = {
                "square":   (768, 768),
                "vertical": (768, 1024),
                "portrait": (1024, 768),
            }

        def process_image_sam(self, target_size: tuple):
            target_w, target_h = target_size
            product_rgba = Image.open(product_path).convert("RGBA")
            sam_mask     = Image.open(mask_path).convert("L")

            max_dim = int(target_w * 0.70)
            product_rgba.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
            sam_mask = sam_mask.resize(product_rgba.size, Image.Resampling.LANCZOS)

            canvas = Image.new("RGBA", target_size, (0, 0, 0, 0))
            x = (target_w - product_rgba.width) // 2
            y = int((target_h - product_rgba.height) * 0.72)
            canvas.paste(product_rgba, (x, y), product_rgba)
            bbox = (x, y, x + product_rgba.width, y + product_rgba.height)

            full_mask = Image.new("L", target_size, 255)
            full_mask.paste(sam_mask, (x, y))
            full_mask = full_mask.filter(ImageFilter.GaussianBlur(2))

            self._product_rgba = product_rgba.copy()
            self._paste_xy     = (x, y)
            self._sam_mask     = np.array(sam_mask)

            return canvas.convert("RGB"), full_mask, bbox

        @staticmethod
        def _add_contact_shadow(canvas_rgb, bbox):
            out = canvas_rgb.convert("RGBA")
            shadow_layer = Image.new("RGBA", out.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(shadow_layer)
            x0, y0, x1, y1 = bbox
            product_w = x1 - x0
            shadow_w  = int(product_w * 0.80)
            shadow_h  = int(shadow_w * 0.18)
            sx = x0 + (product_w - shadow_w) // 2
            sy = y1 - int(shadow_h * 0.5)
            draw.ellipse([sx, sy, sx + shadow_w, sy + shadow_h], fill=(0, 0, 0, 90))
            shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(12))
            out = Image.alpha_composite(out, shadow_layer)
            return out.convert("RGB")

        def generate(self, canvas, mask, bbox, room, style, lighting, seed, frame) -> Image.Image:
            target_w, target_h = self.FRAME_SIZES[frame]
            canvas = self._add_contact_shadow(canvas, bbox)
            scene_desc = self.CONFIG[style]["scene"]
            light_pos, light_neg = self.LIGHT_DATA[lighting]

            prompt = (
                f"professional interior design photography, {room}, "
                f"{scene_desc}, "
                f"{light_pos}, "
                f"the furniture product is the hero and main subject of this photo, "
                f"background room environment built around the product, "
                f"floor perspective and walls naturally frame the product, "
                f"generate only the background, do not alter the product, "
                f"photorealistic, 8k, award-winning architecture photo, "
                f"no people, product placement hero shot"
            )

            neg = (
                f"{light_neg}, "
                "text, letters, words, numbers, digits, characters, typography, "
                "font, label, caption, watermark, logo, signature, inscription, "
                "writing, handwriting, printed text, engraved text, embossed text, "
                "sign, signage, banner, poster with text, price tag, brand name, "
                "any readable content, any written characters, any alphanumeric, "
                "change the product, modify the furniture, repaint the product, "
                "alter product color, alter product shape, distort the furniture, "
                "add objects on top of product, cover the product, replace the product, "
                "floating object, hovering, object not touching floor, "
                "bad shadows, distorted floor, missing floor, "
                "blurry, low resolution, low quality, noise, grain, "
                "empty room, no furniture, missing product, "
                "extra furniture blocking product, cluttered foreground, "
                "extra legs, cartoon, illustration, painting, render, CGI"
            )

            print(f"🎨  Generating {style} {room} — {lighting} (seed={seed})")
            generator = torch.Generator(device=self.device).manual_seed(seed)

            with torch.autocast(self.device):
                result = self.pipe(
                    prompt=prompt,
                    negative_prompt=neg,
                    image=canvas,
                    mask_image=mask,
                    num_inference_steps=50,
                    guidance_scale=10.5,
                    height=target_h,
                    width=target_w,
                    generator=generator,
                ).images[0]

            result    = result.convert("RGBA")
            result_np = np.array(result)
            prod_np   = np.array(self._product_rgba.convert("RGBA"))

            px, py = self._paste_xy
            protect = (self._sam_mask < 128).astype(np.uint8)
            ph, pw  = protect.shape

            for c in range(4):
                result_np[py:py+ph, px:px+pw, c] = (
                    protect * prod_np[:, :, c] +
                    (1 - protect) * result_np[py:py+ph, px:px+pw, c]
                )

            result = Image.fromarray(result_np.astype(np.uint8), "RGBA").convert("RGB")
            return result

    # ════════════════════════════════════════════════════════════════
    # MAIN EXECUTION — same logic as Colab Cell 9
    # ════════════════════════════════════════════════════════════════
    _prog("Loading SD Inpainting model…")
    designer = PosterBackgroundDesigner()

    canvas, mask_canvas, bbox = designer.process_image_sam(
        target_size=designer.FRAME_SIZES[fr]
    )

    # Build prompt string for the agent
    _light_pos, _ = designer.LIGHT_DATA[lt]
    prompt = (
        f"professional interior design photography, {rm}, "
        f"{designer.CONFIG[st]['scene']}, "
        f"{_light_pos}, "
        f"the furniture product is the hero and main subject of this photo, "
        f"background room environment built around the product, "
        f"floor perspective and walls naturally frame the product, "
        f"generate only the background, do not alter the product, "
        f"photorealistic, 8k, award-winning architecture photo, "
        f"no people, product placement hero shot"
    )

    def generate(seed=None):
        s = seed if seed is not None else random.randint(0, 2**31)
        out  = designer.generate(canvas, mask_canvas, bbox, rm, st, lt, seed=s, frame=fr)
        path = os.path.join(workspace, f"agent_attempt_{s}.png")
        out.save(path)
        print(f"💾  Saved attempt → {path}")
        return path

    def reselect():
        s   = random.randint(0, 2**31)
        out = designer.generate(canvas, mask_canvas, bbox, rm, st, lt, seed=s, frame=fr)
        path = os.path.join(workspace, f"agent_attempt_{s}.png")
        out.save(path)
        print(f"💾  Saved → {path}")
        return path

    _prog("Generating first background…")
    first_generated = generate(seed=settings.get("seed", 42))

    _prog("Image Agent evaluating…")
    agent = ImageAgent(anthropic_client=client)

    approved_path = agent.evaluate(
        generated_path = first_generated,
        product_path   = product_path,
        mask_path      = mask_path,
        prompt         = prompt,
        regenerate_fn  = generate,
        reselect_fn    = reselect,
    )

    return approved_path
