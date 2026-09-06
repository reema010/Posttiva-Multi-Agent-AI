# ═══════════════════════════════════════════════════════════════════
#  models/loader.py
#  Loads SAM · CLIP · Qwen ONCE at server startup.
#  All agents import from here — models never reload between requests.
# ═══════════════════════════════════════════════════════════════════

import os, torch
_WORKSPACE = os.environ.get("WORKSPACE", "/workspace")

# ── Singleton holders ─────────────────────────────────────────────
_sam_engine   = None
_clip_model   = None
_clip_prep    = None
_qwen_model   = None
_qwen_proc    = None


# ════════════════════════════════════════════════════════════════════
# SAM — SAMEngineHQ
# Identical class from Colab notebook Cell 3
# Only change: checkpoint path uses WORKSPACE instead of /content
# ════════════════════════════════════════════════════════════════════
def get_sam_engine():
    global _sam_engine
    if _sam_engine is not None:
        return _sam_engine

    import numpy as np
    from PIL import Image
    from scipy import ndimage
    from segment_anything_hq import sam_model_registry, SamPredictor
    from datetime import datetime

    checkpoint_dir  = os.path.join(_WORKSPACE, "checkpoints")
    checkpoint_path = os.path.join(checkpoint_dir, "sam_hq_vit_l.pth")
    os.makedirs(checkpoint_dir, exist_ok=True)

    if not os.path.exists(checkpoint_path):
        print("Downloading SAM-HQ ViT-L checkpoint (~2.5 GB)...")
        import urllib.request
        urllib.request.urlretrieve(
            "https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_l.pth",
            checkpoint_path
        )
        print("✅ Done!")
    else:
        print("✅ SAM checkpoint already downloaded.")

    save_folder = os.path.join(_WORKSPACE, "sam_results")
    os.makedirs(save_folder, exist_ok=True)

    # ── SAMEngineHQ class — IDENTICAL to Colab notebook ──────────
    class SAMEngineHQ:
        def __init__(self, checkpoint_path=checkpoint_path):
            self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
            print(f'Using device: {self.device}')
            self.save_folder = save_folder
            os.makedirs(self.save_folder, exist_ok=True)
            print('Loading HQ-SAM model...')
            sam = sam_model_registry['vit_l'](checkpoint=checkpoint_path)
            sam.to(device=self.device)
            self.predictor = SamPredictor(sam)
            print('✅ HQ-SAM loaded!')
            self.image_np = None
            self.h, self.w = 0, 0

        def load_image(self, image_input):
            if isinstance(image_input, str):
                image = Image.open(image_input).convert('RGB')
            elif isinstance(image_input, Image.Image):
                image = image_input.convert('RGB')
            else:
                image = Image.fromarray(image_input).convert('RGB')
            img_rgb = image.convert("RGB")
            self.image_np = np.array(img_rgb, dtype="uint8").copy()
            self.h, self.w = self.image_np.shape[:2]
            self.predictor.set_image(self.image_np)
            print(f'Image loaded: {self.w}x{self.h}')

        def get_mask(self, x, y, scale='refined'):
            if scale == 'small':       return self._predict_basic(x, y)
            elif scale == 'medium':    return self._predict_largest(x, y)
            elif scale == 'large':     return self._predict_with_box(x, y)
            elif scale == 'auto_grid': return self._predict_grid(x, y)
            elif scale == 'refined':   return self._predict_refined(x, y)

        def _predict_basic(self, x, y):
            masks, scores, _ = self.predictor.predict(
                point_coords=np.array([[x, y]]), point_labels=np.array([1]),
                multimask_output=True, hq_token_only=False)
            best = np.argmax(scores)
            return masks[best], scores[best]

        def _predict_largest(self, x, y):
            masks, scores, _ = self.predictor.predict(
                point_coords=np.array([[x, y]]), point_labels=np.array([1]),
                multimask_output=True, hq_token_only=False)
            valid = [(m, s) for m, s in zip(masks, scores) if s > 0.5]
            if not valid:
                best = np.argmax(scores)
                return masks[best], scores[best]
            valid.sort(key=lambda x: x[0].sum(), reverse=True)
            return valid[0][0], valid[0][1]

        def _predict_with_box(self, x, y):
            size = max(self.h, self.w) // 3
            box = np.array([max(0, x-size), max(0, y-size),
                            min(self.w, x+size), min(self.h, y+size)])
            masks, scores, _ = self.predictor.predict(
                point_coords=np.array([[x, y]]), point_labels=np.array([1]),
                box=box, multimask_output=True, hq_token_only=False)
            valid = [(m, s) for m, s in zip(masks, scores) if s > 0.5]
            if not valid:
                best = np.argmax(scores)
                return masks[best], scores[best]
            valid.sort(key=lambda x: x[0].sum(), reverse=True)
            return valid[0][0], valid[0][1]

        def _predict_grid(self, x, y):
            mask, _ = self._predict_largest(x, y)
            rows, cols = np.any(mask, axis=1), np.any(mask, axis=0)
            if not rows.any(): return mask, 0
            y_min, y_max = np.where(rows)[0][[0, -1]]
            x_min, x_max = np.where(cols)[0][[0, -1]]
            bh, bw = y_max - y_min, x_max - x_min
            box = np.array([max(0, x_min-int(bw*0.3)), max(0, y_min-int(bh*0.3)),
                            min(self.w, x_max+int(bw*0.3)), min(self.h, y_max+int(bh*0.3))])
            pts = np.array([[x, y], [x, y_min+bh//4], [x, y_max-bh//4],
                            [x_min+bw//4, y], [x_max-bw//4, y]])
            masks, scores, _ = self.predictor.predict(
                point_coords=pts, point_labels=np.array([1]*len(pts)),
                box=box, multimask_output=True, hq_token_only=False)
            best = np.argmax(scores)
            return masks[best], scores[best]

        def _predict_refined(self, x, y):
            masks, scores, logits = self.predictor.predict(
                point_coords=np.array([[x, y]]), point_labels=np.array([1]),
                multimask_output=True, hq_token_only=True)
            valid = [(m, s, l) for m, s, l in zip(masks, scores, logits) if s > 0.5]
            if not valid: return masks[np.argmax(scores)], scores[np.argmax(scores)]
            valid.sort(key=lambda x: x[0].sum(), reverse=True)
            best_mask, best_logit = valid[0][0], valid[0][2]
            rows, cols = np.any(best_mask, axis=1), np.any(best_mask, axis=0)
            y_min, y_max = np.where(rows)[0][[0, -1]]
            x_min, x_max = np.where(cols)[0][[0, -1]]
            bh, bw = y_max - y_min, x_max - x_min
            pts = np.array([[x, y], [(x_min+x_max)//2, y_min+5],
                            [(x_min+x_max)//2, y_max-5]])
            masks2, scores2, _ = self.predictor.predict(
                point_coords=pts, point_labels=np.array([1]*len(pts)),
                box=np.array([max(0, x_min-int(bw*0.2)), max(0, y_min-int(bh*0.2)),
                              min(self.w, x_max+int(bw*0.2)), min(self.h, y_max+int(bh*0.2))]),
                mask_input=best_logit[None, :, :],
                multimask_output=True, hq_token_only=True)
            final_mask = self._postprocess(masks2[np.argmax(scores2)])
            return final_mask, scores2[np.argmax(scores2)]

        def _postprocess(self, mask):
            mask_bool = mask.astype(bool)
            filled = ndimage.binary_fill_holes(mask_bool)
            closed = ndimage.binary_closing(filled, iterations=5)
            labeled, num = ndimage.label(closed)
            if num > 1:
                sizes = ndimage.sum(closed, labeled, range(1, num + 1))
                closed = (labeled == np.argmax(sizes) + 1)
            return ndimage.binary_dilation(closed, iterations=1).astype(np.uint8)

        def extract_and_save(self, mask):
            h, w = self.image_np.shape[:2]
            result = np.zeros((h, w, 4), dtype=np.uint8)
            result[:, :, :3] = self.image_np * mask[:, :, np.newaxis]
            result[:, :, 3] = (mask * 255).astype(np.uint8)
            rows = np.any(mask, axis=1)
            cols = np.any(mask, axis=0)
            if not rows.any():
                print('Empty mask — nothing to save.')
                return None
            pad = 10
            y_min, y_max = np.where(rows)[0][[0, -1]]
            x_min, x_max = np.where(cols)[0][[0, -1]]
            y_min, y_max = max(0, y_min-pad), min(h-1, y_max+pad)
            x_min, x_max = max(0, x_min-pad), min(w-1, x_max+pad)
            cropped = result[y_min:y_max+1, x_min:x_max+1]
            out = Image.fromarray(cropped, 'RGBA')
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:20]
            filename = f'cut_{timestamp}.png'
            full_path = os.path.join(self.save_folder, filename)
            out.save(full_path, 'PNG')
            print(f'Saved: {full_path}')
            return out, full_path

    _sam_engine = SAMEngineHQ()
    return _sam_engine


# ════════════════════════════════════════════════════════════════════
# CLIP
# ════════════════════════════════════════════════════════════════════
def get_clip():
    global _clip_model, _clip_prep
    if _clip_model is not None:
        return _clip_model, _clip_prep
    import clip
    print('Loading CLIP ViT-L/14...')
    _clip_model, _clip_prep = clip.load('ViT-L/14', device='cuda')
    _clip_model.eval()
    print('CLIP ready ✓')
    return _clip_model, _clip_prep


# ════════════════════════════════════════════════════════════════════
# QWEN
# ════════════════════════════════════════════════════════════════════
def get_qwen():
    global _qwen_model, _qwen_proc
    if _qwen_model is not None:
        return _qwen_model, _qwen_proc
    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    print('Loading Qwen2-VL-7B...')
    _qwen_proc  = AutoProcessor.from_pretrained('Qwen/Qwen2-VL-7B-Instruct')
    _qwen_model = Qwen2VLForConditionalGeneration.from_pretrained(
        'Qwen/Qwen2-VL-7B-Instruct',
        torch_dtype=torch.bfloat16,
        device_map='auto'
    ).eval()
    print('Qwen2-VL ready ✓')
    return _qwen_model, _qwen_proc
