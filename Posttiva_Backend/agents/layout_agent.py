# ═══════════════════════════════════════════════════════════════════
#  agents/layout_agent.py
#  Layout Agent v11 — IDENTICAL logic from Colab notebook Cell 11
#
#  Changes from Colab (wrapper only — zero logic changes):
#    • Removed google.colab imports
#    • API keys come from environment variables
#    • input() for human rating removed (not needed in API)
#    • /content/ paths replaced by workspace parameter
#    • Qwen/CLIP loaded from models/loader.py (already in memory)
#    • Returns result dict instead of displaying in notebook
# ═══════════════════════════════════════════════════════════════════

import os, json, time, urllib.request
import numpy as np
import cv2
import torch
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from sklearn.cluster import KMeans
from typing import Callable, Optional


def run_layout_agent(
    approved_path: str,
    product_path:  str,
    mask_path:     str,
    texts:         dict,
    settings:      dict,
    workspace:     str,
    on_progress:   Optional[Callable[[str], None]] = None,
) -> dict:
    """
    Runs the full Layout Agent pipeline.
    Returns {
        poster_b64, bg_b64,
        text_coords: { tx_pct, ty_pct, tw_pct, th_pct },
        poster_config: { headline, headlineFont, color, ... }
    }
    """
    import base64
    from io import BytesIO

    def _prog(msg):
        if on_progress:
            on_progress(msg)
        print(msg)

    # ── API key ───────────────────────────────────────────────────
    import anthropic as _ant
    IMAGE_AGENT_ANTHROPIC_KEY = os.environ.get("IMAGE_AGENT_ANTHROPIC_KEY", "")

    # ── Models from loader ────────────────────────────────────────
    from models.loader import get_clip, get_qwen
    _CLIP_MODEL, _CLIP_PREP = get_clip()
    _QWEN_MODEL, _QWEN_PROC = get_qwen()

    # ── Inputs ────────────────────────────────────────────────────
    _img   = Image.open(approved_path).convert("RGB")
    W, H   = _img.size
    _texts = {
        "headline":    texts.get("headline",    ""),
        "description": texts.get("description", ""),
        "cta":         texts.get("cta",         "Shop Now"),
    }

    print(f"\n   Image:       {W}×{H}  ←  Image Agent")
    print(f"   Headline:    {_texts['headline']}  ←  Text Agent")
    print(f"   Description: {_texts['description']}")
    print(f"   CTA:         {_texts['cta']}")

    # ── Product mask rebuild — same logic as Colab Cell 11 ────────
    _prog("Loading product mask…")
    _mask_crop   = Image.open(mask_path).convert("L")
    _prod_rgba   = Image.open(product_path).convert("RGBA")

    _max_dim     = int(W * 0.70)
    _prod_rgba.thumbnail((_max_dim, _max_dim), Image.LANCZOS)
    _mask_crop   = _mask_crop.resize(_prod_rgba.size, Image.NEAREST)

    _px = (W - _prod_rgba.width)  // 2
    _py = int((H - _prod_rgba.height) * 0.72)

    _full_mask_img = Image.new("L", (W, H), 255)
    _full_mask_img.paste(_mask_crop, (_px, _py))
    _product_mask = (np.array(_full_mask_img) < 128).astype(np.uint8)

    _coverage = _product_mask.mean()
    if _coverage > 0.80:
        print(f"   ⚠ Coverage={_coverage*100:.1f}% too high — inverting mask")
        _product_mask = (1 - _product_mask).astype(np.uint8)
        _coverage = _product_mask.mean()
    print(f"   Product coverage: {_coverage*100:.1f}% of image")

    # ── Logo — not used in API flow (logo comes from frontend) ────
    _logo_img = None
    _logo_pos = _logo_size = None

    # ════════════════════════════════════════════════════════════════
    # ALL HELPER FUNCTIONS — IDENTICAL to Colab notebook Cell 11
    # ════════════════════════════════════════════════════════════════

    def _qwen(img_pil, question, max_tokens=300):
        """Send image + question to Qwen2-VL and return text response."""
        from qwen_vl_utils import process_vision_info
        messages=[{"role":"user","content":[
            {"type":"image","image":img_pil},
            {"type":"text","text":question}
        ]}]
        text=_QWEN_PROC.apply_chat_template(messages,tokenize=False,add_generation_prompt=True)
        img_in,_=process_vision_info(messages)
        inputs=_QWEN_PROC(text=[text],images=img_in,padding=True,return_tensors="pt").to("cuda")
        with torch.no_grad():
            out=_QWEN_MODEL.generate(**inputs,max_new_tokens=max_tokens,
                                      do_sample=True,
                                      temperature=0.7,
                                      top_p=0.9,
                                      repetition_penalty=1.15)
        return _QWEN_PROC.decode(out[0][inputs.input_ids.shape[1]:],skip_special_tokens=True).strip()


    def qwen_find_placement(img_pil, product_mask, exclude_zones=None):
        """Ask Qwen to find the best empty wall zone for text, given the product bbox from SAM mask."""
        H,W=product_mask.shape

        rows=np.any(product_mask,axis=1); cols=np.any(product_mask,axis=0)
        if rows.any() and cols.any():
            y_min,y_max=np.where(rows)[0][[0,-1]]
            x_min,x_max=np.where(cols)[0][[0,-1]]
            prod_info=(
                f"The main product bounding box: "
                f"x={x_min/W:.2f}→{x_max/W:.2f}, y={y_min/H:.2f}→{y_max/H:.2f} "
                f"(as fraction of image). Coverage: {product_mask.mean()*100:.1f}%."
            )
        else:
            prod_info="Product location unclear."

        exclude_hint=""
        if exclude_zones:
            exclude_hint=(f"\n\nIMPORTANT: These zones already FAILED: {exclude_zones}. "
                          f"Choose a COMPLETELY DIFFERENT zone.")

        q=f"""You are placing advertising text on a furniture product image.

PRODUCT LOCATION (from segmentation):
{prod_info}

Find the LARGEST clean wall/background area that is:
- FAR from the product bounding box
- FREE from furniture, lamps, plants, paintings
- UNIFORM color suitable for text overlay
- Big enough for: large headline + description + button{exclude_hint}

Reply ONLY with valid JSON:
{{
  "zone": "top" or "bottom" or "left" or "right",
  "y_start_pct": 0.0 to 1.0,
  "y_end_pct": 0.0 to 1.0,
  "x_start_pct": 0.0 to 1.0,
  "x_end_pct": 0.0 to 1.0,
  "confidence": "high" or "medium" or "low",
  "reason": "describe the empty area and why it avoids the product"
}}"""

        try:
            resp=_qwen(img_pil,q,250)
            s0=resp.find("{"); s1=resp.rfind("}")+1
            if s0>=0 and s1>s0:
                p=json.loads(resp[s0:s1])
                for k in ["y_start_pct","y_end_pct","x_start_pct","x_end_pct"]:
                    p[k]=float(np.clip(p.get(k,0.05 if "start" in k else 0.95),0.0,1.0))
                if p["y_end_pct"]-p["y_start_pct"]<0.18:
                    p["y_end_pct"]=min(1.0,p["y_start_pct"]+0.35)
                if p["x_end_pct"]-p["x_start_pct"]<0.50:
                    p["x_start_pct"]=0.04; p["x_end_pct"]=0.96
                print(f"   Zone: {p.get('zone')} y={p['y_start_pct']:.2f}→{p['y_end_pct']:.2f} conf={p.get('confidence')}")
                print(f"   Reason: {p.get('reason','')}")
                return p
        except Exception as e:
            print(f"   Placement error: {e}")
        return {"zone":"top","y_start_pct":0.02,"y_end_pct":0.38,
                "x_start_pct":0.04,"x_end_pct":0.96,"confidence":"low","reason":"fallback"}


    def qwen_design_decision(img_pil, theme, placement_info,
                              text_x=None, text_y=None, tw=None, th=None):
        """Ask Qwen to choose fonts, colors, sizes, and mood for the poster typography."""
        palette_hex=[f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}" for c in theme["palette"][:6]]
        attempt_num=1
        if "attempt=" in placement_info:
            try: attempt_num=int(placement_info.split("attempt=")[1].split()[0])
            except: pass

        accent_hex="#{:02x}{:02x}{:02x}".format(*theme["accent"])
        bg_hex=None
        if text_x is not None and text_y is not None and tw is not None and th is not None:
            try:
                _arr=np.array(img_pil.convert("RGB"))
                _H,_W=_arr.shape[:2]
                _patch=_arr[text_y:min(text_y+th,_H),text_x:min(text_x+tw,_W)]
                if _patch.size>0:
                    _bg=tuple(int(v) for v in _patch.reshape(-1,3).mean(axis=0))
                    bg_hex="#{:02x}{:02x}{:02x}".format(*_bg)
            except: pass

        if bg_hex:
            bg_note="The wall background color is "+bg_hex+". ONLY use colors from the safe list."
        elif theme["dark_bg"]:
            bg_note="Background is DARK. ONLY use colors from the safe list below."
        else:
            bg_note="Background is LIGHT. ONLY use colors from the safe list below."

        def _lum_f(c):
            r,g,b=[v/255 for v in c]
            r=r/12.92 if r<=0.04045 else ((r+0.055)/1.055)**2.4
            g=g/12.92 if g<=0.04045 else ((g+0.055)/1.055)**2.4
            b=b/12.92 if b<=0.04045 else ((b+0.055)/1.055)**2.4
            return 0.2126*r+0.7152*g+0.0722*b
        def _cr_f(c1,c2):
            l1=_lum_f(c1)+0.05; l2=_lum_f(c2)+0.05
            return max(l1,l2)/min(l1,l2)

        if bg_hex:
            try: h=bg_hex.lstrip("#"); bg_rgb_f=tuple(int(h[i:i+2],16) for i in (0,2,4))
            except: bg_rgb_f=(180,175,170)
        else:
            bg_rgb_f=(40,35,30) if theme["dark_bg"] else (200,195,190)

        safe_colors=[f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}"
                     for c in theme["palette"] if _cr_f(c,bg_rgb_f)>=3.0]
        if len(safe_colors)<2:
            safe_colors=(["#faf5ee","#f0e8d8","#e8ddd0","#ffffff"]
                         if _lum_f(bg_rgb_f)<0.45
                         else ["#1c1008","#2a1a0a","#3a2a1a","#000000"])

        safe_str=", ".join(safe_colors[:5])
        default_headline_hex=safe_colors[0]
        default_desc_hex=safe_colors[1] if len(safe_colors)>1 else safe_colors[0]

        json_template=(
            '{\n'
            '  "headline_font": "playfair",\n'
            '  "headline_size_ratio": 0.100,\n'
            '  "headline_case": "normal",\n'
            '  "headline_letter_spacing": 1,\n'
            '  "headline_color_hex": "'+default_headline_hex+'",\n'
            '  "description_font": "lato_bold",\n'
            '  "description_size_ratio": 0.038,\n'
            '  "description_color_hex": "'+(safe_colors[2] if len(safe_colors)>2 else safe_colors[-1])+'",\n'
            '  "cta_font": "lato_bold",\n'
            '  "cta_case": "uppercase",\n'
            '  "cta_size_ratio": 0.026,\n'
            '  "design_mood": "luxury",\n'
            '  "cta_bg_hex": "'+accent_hex+'",\n'
            '  "decorative_line": true,\n'
            '  "reasoning": "one sentence"\n'
            '}'
        )

        q="\n".join([
            "You are a senior art director for luxury furniture brands.",
            "Design perfect poster typography. Attempt "+str(attempt_num)+".",
            "",
            "Placement: "+placement_info,
            bg_note,
            "Safe color list (good contrast guaranteed): "+safe_str,
            "Accent: "+accent_hex,
            "",
            "Available fonts (MUST vary between attempts):",
            "HEADLINE fonts — large editorial: playfair, libre_caslon, dm_serif",
            "DESCRIPTION fonts — clear at small sizes: lato_bold, lato_black, nunito, josefin",
            "CTA font: lato_bold or lato_black only",
            "RULE: description_font MUST be from description list — never serif for description",
            "RULE: if attempt > 1 choose a DIFFERENT headline_font than previous attempt",
            "",
            "CRITICAL RULE 1 — SIZE: headline_size_ratio MUST be >= 0.090. Description MUST be <= 0.042.",
            "CRITICAL RULE 2 — SIZE RATIO: description_size_ratio MUST be <= headline_size_ratio * 0.40.",
            "CRITICAL RULE 3 — COLOR CONTRAST: headline and description MUST look CLEARLY DIFFERENT.",
            "  → If headline is LIGHT: description MUST be at least 40% darker (much lower brightness).",
            "  → If headline is DARK: description MUST be at least 40% lighter (much higher brightness).",
            "  → NEVER pick two colors that look similar — viewer must instantly tell them apart.",
            "CRITICAL RULE 4 — DOMINANCE: headline must be the FIRST thing the eye sees. Bold + large + high contrast.",
            "BAD EXAMPLE: headline=#f0e8d8, description=#e8ddd0 — TOO SIMILAR, REJECTED.",
            "GOOD EXAMPLE: headline=#1c1008 (dark bold), description=#8a7060 (medium), clear difference.",
            "GOOD EXAMPLE: headline=#faf5ee (bright), description=#4a3828 (dark), clear difference.",
            "TIP: headline=0.100, description=0.038, headline dark + description medium = ideal hierarchy",
            "IMPORTANT: headline_color_hex and description_color_hex MUST be from the safe color list.",
            "IMPORTANT: Vary fonts AND colors between attempts — never repeat same headline_color.",
            "COLOR VARIETY — rotate styles between attempts:",
            "  Style A: headline=darkest safe color, description=medium safe color",
            "  Style B: headline=lightest safe color, description=darkest safe color",
            "  Style C: headline=warm/accent tone, description=dark safe color",
            "",
            "Reply ONLY with this exact JSON structure:",
            json_template,
        ])

        try:
            resp=_qwen(img_pil,q,400)
            s0=resp.find("{"); s1=resp.rfind("}")+1
            if s0>=0 and s1>s0:
                raw=resp[s0:s1]
                import re as _re
                raw=_re.sub(r'(#[0-9a-fA-F]{3,6})\s*[—–-][^"]*',r'\1',raw)
                raw=_re.sub(r'(#[0-9a-fA-F]{3,6})\s+[a-zA-Z][^"]*',r'\1',raw)
                raw=raw.replace('"True"','true').replace('"False"','false')
                raw=raw.replace(': True',': true').replace(': False',': false')
                try: s=json.loads(raw)
                except Exception as _je:
                    import re as _re2; s={}
                    for field,pattern in [
                        ("headline_font",         r'"headline_font"\s*:\s*"([^"]+)"'),
                        ("headline_color_hex",    r'"headline_color_hex"\s*:\s*"(#[0-9a-fA-F]{3,6})'),
                        ("description_font",      r'"description_font"\s*:\s*"([^"]+)"'),
                        ("description_color_hex", r'"description_color_hex"\s*:\s*"(#[0-9a-fA-F]{3,6})'),
                        ("cta_bg_hex",            r'"cta_bg_hex"\s*:\s*"(#[0-9a-fA-F]{3,6})'),
                        ("design_mood",           r'"design_mood"\s*:\s*"([^"]+)"'),
                        ("headline_size_ratio",   r'"headline_size_ratio"\s*:\s*([0-9.]+)'),
                        ("description_size_ratio",r'"description_size_ratio"\s*:\s*([0-9.]+)'),
                        ("decorative_line",       r'"decorative_line"\s*:\s*(true|false)'),
                    ]:
                        m=_re2.search(pattern,raw)
                        if m:
                            v=m.group(1)
                            if field.endswith("_ratio"): s[field]=float(v)
                            elif field=="decorative_line": s[field]=v=="true"
                            else: s[field]=v
                    if not s: raise _je

                vf_h=["playfair","libre_caslon","dm_serif","lato_black"]
                vf_d=["lato_bold","lato_black","nunito","josefin"]

                if s.get("headline_font") not in vf_h:
                    bad_font = s.get("headline_font","unknown")
                    print(f"   ⚠ headline_font '{bad_font}' not available — asking Qwen to retry")
                    retry_q = (
                        f"You chose font '{bad_font}' which is NOT available.\n"
                        f"Choose from this exact list: {vf_h}\n"
                        "Reply ONLY with one font name from the list."
                    )
                    try:
                        retry_resp = _qwen(img_pil, retry_q, 15).strip().lower()
                        matched = next((f for f in vf_h if f in retry_resp), None)
                        s["headline_font"] = matched if matched else "playfair"
                        print(f"   ✓ Qwen retry headline_font: {bad_font} → {s['headline_font']}")
                    except:
                        s["headline_font"] = "playfair"

                if s.get("description_font") not in vf_d:
                    bad_font = s.get("description_font","unknown")
                    print(f"   ⚠ description_font '{bad_font}' not available — asking Qwen to retry")
                    retry_q = (
                        f"You chose font '{bad_font}' which is NOT available for description.\n"
                        f"Choose from this exact list: {vf_d}\n"
                        "Reply ONLY with one font name from the list."
                    )
                    try:
                        retry_resp = _qwen(img_pil, retry_q, 15).strip().lower()
                        matched = next((f for f in vf_d if f in retry_resp), None)
                        s["description_font"] = matched if matched else "lato_bold"
                        print(f"   ✓ Qwen retry description_font: {bad_font} → {s['description_font']}")
                    except:
                        s["description_font"] = "lato_bold"

                if s.get("cta_font") not in ["lato_bold","lato_black"]: s["cta_font"]="lato_bold"

                h_r=float(np.clip(s.get("headline_size_ratio",0.100),0.090,0.115))
                d_r=float(np.clip(s.get("description_size_ratio",0.036),0.032,0.044))
                if d_r > h_r*0.45: d_r=h_r*0.45
                s["headline_size_ratio"]=h_r; s["description_size_ratio"]=d_r
                s["cta_size_ratio"]=float(np.clip(s.get("cta_size_ratio",0.026),0.022,0.032))
                s["headline_letter_spacing"]=int(np.clip(s.get("headline_letter_spacing",1),0,5))

                def _h(hx):
                    try: h=hx.lstrip("#"); return tuple(int(h[i:i+2],16) for i in (0,2,4))
                    except: return None
                s["headline_color_rgb"]=_h(s.get("headline_color_hex",""))
                s["description_color_rgb"]=_h(s.get("description_color_hex",""))
                s["cta_bg_rgb"]=_h(s.get("cta_bg_hex",""))
                print(f"   Typography: {s['headline_font']}/{s['description_font']} | {s.get('design_mood')}")
                print(f"   Colors: txt={s.get('headline_color_hex')} desc={s.get('description_color_hex')} cta={s.get('cta_bg_hex')}")
                return s
        except Exception as e:
            print(f"   Typography error: {e}")

        return {"headline_font":"playfair","headline_size_ratio":0.095,"headline_case":"normal",
                "headline_letter_spacing":1,"description_font":"lato_bold","description_size_ratio":0.036,
                "description_case":"normal","cta_font":"lato_bold","cta_case":"uppercase","cta_size_ratio":0.026,
                "design_mood":"luxury","decorative_line":True,"reasoning":"fallback",
                "headline_color_rgb":None,"description_color_rgb":None,"cta_bg_rgb":None}


    def qwen_analyze_failure(poster_pil, score, attempt):
        """Ask Qwen to inspect a rejected poster and suggest what to fix on the next attempt."""
        q=f"""You are reviewing a furniture advertisement poster that scored {score:+.3f} (poor).

Identify the main problem:
1. Text overlapping the product?
2. Text color hard to read?
3. Text in wrong position?
4. Headline smaller than description?

Reply ONLY with valid JSON:
{{
  "problem": "overlap" or "color" or "position" or "hierarchy",
  "description": "one sentence",
  "fix": "move_text_down" or "move_text_up" or "change_color" or "try_different_zone" or "fix_hierarchy",
  "new_y_start_pct": 0.0 to 1.0,
  "new_y_end_pct": 0.0 to 1.0
}}"""
        try:
            resp=_qwen(poster_pil,q,200)
            s0=resp.find("{"); s1=resp.rfind("}")+1
            if s0>=0 and s1>s0:
                fb=json.loads(resp[s0:s1])
                print(f"   Problem: {fb.get('problem')} — {fb.get('description')}")
                print(f"   Fix: {fb.get('fix')}")
                return fb
        except Exception as e:
            print(f"   Analysis error: {e}")
        return {"problem":"position","fix":"try_different_zone"}


    def refine_placement(img_pil, product_mask, qwen_zone):
        """Refine Qwen zone choice pixel by pixel — find the cleanest spot that avoids the product."""
        img_arr=np.array(img_pil.convert("RGB"))
        H,W=product_mask.shape
        y0=int(qwen_zone["y_start_pct"]*H); y1=int(qwen_zone["y_end_pct"]*H)
        x0=int(qwen_zone["x_start_pct"]*W); x1=int(qwen_zone["x_end_pct"]*W)
        zone_h=y1-y0; zone_w=x1-x0
        tw=int(np.clip(zone_w*0.90,W*0.55,W*0.92))
        th=int(np.clip(zone_h*0.90,H*0.30,H*0.48))
        pad=int(W*0.03); step=max(1,int(W*0.02))

        best_score=-9999; best_rect=(max(pad,x0),max(pad,y0),tw,th)

        for y in range(max(pad,y0), min(H-th-pad,y1+int(H*0.03))+1, step):
            for x in range(max(pad,x0-int(W*0.02)), min(W-tw-pad,x1+int(W*0.02))+1, max(1,int(W*0.04))):
                pm=product_mask[y:y+th,x:x+tw]
                prod_pct=float(pm.mean()) if pm.size>0 else 1.0
                if prod_pct>0.12: continue

                patch=img_arr[y:y+th,x:x+tw]
                if patch.size==0: continue
                bg_std=float(patch.std()); bg_mean=float(patch.mean())
                if bg_mean<35 or bg_mean>238: continue

                score=(1.0-min(bg_std/75.0,1.0))*5.0 - prod_pct*8.0
                score-=abs((x+tw/2)-W/2)/W*1.5
                score-=abs((y+th/2)-(y0+y1)/2)/H*2.0
                if score>best_score: best_score=score; best_rect=(x,y,tw,th)

        if best_score<-100:
            bx=max(pad,x0); by=max(pad,y0)
            for _dy in range(0,int(H*0.3),int(H*0.03)):
                _ty=max(pad,y0-_dy)
                pm=product_mask[_ty:_ty+th,bx:bx+tw]
                if pm.size==0 or float(pm.mean())<0.08: by=_ty; break
            best_rect=(bx,by,tw,th)
            print("   Refine: using adjusted zone directly")
        else:
            print("   Refine: optimal position found")

        bx,by,btw,bth=best_rect
        occ=float(product_mask[by:by+bth,bx:bx+btw].mean())
        print(f"   Rect: ({bx},{by}) {btw}×{bth} | product={occ*100:.1f}%")
        return bx,by,btw,bth


    def compute_overlap_ratio(text_x,text_y,tw,th,product_mask):
        """Compute what fraction of the product mask is covered by the text zone."""
        H,W=product_mask.shape
        tm=np.zeros((H,W),dtype=np.uint8)
        tm[text_y:min(text_y+th,H),text_x:min(text_x+tw,W)]=1
        inter=np.logical_and(tm,product_mask).sum()
        prod_area=product_mask.sum()
        return float(inter/prod_area) if prod_area>0 else 0.0


    def compute_composite_score(clip_score,overlap,bg_std,cta_furn_pct,
                                 hierarchy_ok=True,placement_ok=True):
        """Compute a weighted composite score to rank candidates."""
        clip_norm=float(np.clip((clip_score+0.10)/0.25,0.0,1.0))
        overlap_norm=float(np.clip(1.0-overlap,0.0,1.0))
        bg_norm=float(np.clip(1.0-bg_std/60.0,0.0,1.0))
        cta_norm=float(np.clip(1.0-cta_furn_pct,0.0,1.0))
        score=clip_norm*0.30+overlap_norm*0.35+bg_norm*0.20+cta_norm*0.15
        if not placement_ok: score*=0.50
        if not hierarchy_ok: score*=0.70
        return round(score,4)


    def kmeans_palette(img_pil,k=8):
        """Extract the top K dominant colors from the image using K-Means clustering."""
        arr=np.array(img_pil.convert("RGB")).reshape(-1,3).astype(np.float32)
        if len(arr)>12000: arr=arr[np.random.choice(len(arr),12000,replace=False)]
        km=KMeans(n_clusters=k,random_state=42,n_init=10); km.fit(arr)
        centers=km.cluster_centers_.astype(int); counts=np.bincount(km.labels_)
        return [tuple(centers[i]) for i in np.argsort(-counts)]


    def _force_contrast(color,bg,min_ratio=3.5):
        """Iteratively adjust a color until it reaches the minimum contrast ratio against the background."""
        def bri(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
        def cr(c1,c2):
            b1=bri(c1)/255+0.05; b2=bri(c2)/255+0.05
            return max(b1,b2)/min(b1,b2)
        c=list(color); bg_b=bri(bg)
        for _ in range(50):
            if cr(tuple(c),bg)>=min_ratio: break
            f=1.08 if bri(tuple(c))>bg_b else 0.90
            c=[min(255,max(0,int(v*f))) for v in c]
        return tuple(c)


    def build_smart_theme(img_pil):
        """Build the full color theme from the palette."""
        palette=kmeans_palette(img_pil,k=8)
        def bri(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
        def sat(c): mx=max(c)/255; mn=min(c)/255; return (mx-mn)/mx if mx>0 else 0
        def cr(c1,c2):
            b1=bri(c1)/255+0.05; b2=bri(c2)/255+0.05
            return max(b1,b2)/min(b1,b2)
        raw_bg=sorted(palette,key=bri)[0]; bg_b=bri(raw_bg)
        if bg_b<35: bg=tuple(min(255,int(c*1.7+25)) for c in raw_bg)
        elif bg_b>200: bg=tuple(min(255,int(c*1.04)) for c in sorted(palette,key=bri)[-1])
        else: bg=raw_bg
        dark_bg=bri(bg)<128
        accent=None
        for c in sorted(palette,key=sat,reverse=True):
            if cr(c,bg)>=3.5 and bri(c)<230 and bri(c)>30 and sat(c)>0.05:
                accent=tuple(c); break
        if accent is None:
            accent=(185,155,115) if dark_bg else (90,68,45)
            accent=_force_contrast(accent,bg,3.5)
        bg=tuple(int(v) for v in bg); accent=tuple(int(v) for v in accent)
        palette=[tuple(int(v) for v in c) for c in palette]
        acc_b=bri(accent); cta_text=tuple(int(v) for v in ((12,8,4) if acc_b>160 else (242,236,228)))
        print(f"   Theme → accent={accent} | dark={dark_bg}")
        return {"bg":bg,"accent":accent,"cta_bg":accent,"cta_text":cta_text,"dark_bg":dark_bg,"palette":palette}


    _FONTS={}
    def load_fonts():
        """Download and cache all available fonts from Google Fonts."""
        d="/tmp/fonts_la11"; os.makedirs(d,exist_ok=True)
        for k,f,u in [
            ("playfair","Playfair.ttf","https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"),
            ("cormorant","Cormorant.ttf","https://github.com/google/fonts/raw/main/ofl/cormorantgaramond/CormorantGaramond-SemiBold.ttf"),
            ("libre_caslon","LibreCaslon.ttf","https://github.com/google/fonts/raw/main/ofl/librecaslontext/LibreCaslonText%5Bwght%5D.ttf"),
            ("lato_bold","LatoBold.ttf","https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf"),
            ("lato_black","LatoBlack.ttf","https://github.com/google/fonts/raw/main/ofl/lato/Lato-Black.ttf"),
            ("montserrat","Montserrat.ttf","https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf"),
            ("raleway","Raleway.ttf","https://github.com/google/fonts/raw/main/ofl/raleway/Raleway%5Bwght%5D.ttf"),
            ("josefin","Josefin.ttf","https://github.com/google/fonts/raw/main/ofl/josefinsans/JosefinSans%5Bwght%5D.ttf"),
            ("dm_serif","DMSerif.ttf","https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf"),
            ("nunito","Nunito.ttf","https://github.com/google/fonts/raw/main/ofl/nunito/Nunito%5Bwght%5D.ttf"),
        ]:
            p=os.path.join(d,f)
            if not os.path.exists(p):
                try: urllib.request.urlretrieve(u,p)
                except: p=None
            _FONTS[k]=p
        print("   Fonts loaded ✓")

    def gf(key,size):
        """Return a PIL font object by name and size."""
        p=_FONTS.get(key)
        if p and os.path.exists(p):
            try: return ImageFont.truetype(p,max(8,int(size)))
            except: pass
        return ImageFont.load_default()

    def wrap(draw,text,font,max_w):
        """Word-wrap text to fit within max_w pixels."""
        words,lines,cur=text.split(),[],""
        for w in words:
            t=(cur+" "+w).strip()
            if draw.textlength(t,font=font)>max_w and cur:
                lines.append(cur); cur=w
            else:
                cur=t
        if cur: lines.append(cur)
        return lines

    def fit_text(draw,text,font_key,max_w,max_h,start_size,min_size=18):
        """Find the largest font size that fits text fully within max_h without overlap."""
        size=start_size
        while size>=min_size:
            font=gf(font_key,size)
            lines=wrap(draw,text,font,max_w)
            total_h=len(lines)*int(font.size*1.30)
            if total_h<=max_h:
                return font,lines,total_h
            size=int(size*0.92)
        font=gf(font_key,min_size)
        lines=wrap(draw,text,font,max_w)
        return font,lines,len(lines)*int(font.size*1.30)

    def draw_text_block(canvas,text,font,cx,y,color,max_w,lh=1.20,
        align="center",shadow=0,ls=0):
        """Draw a wrapped text block on the canvas with optional drop shadow."""
        draw=ImageDraw.Draw(canvas); lines=wrap(draw,text,font,max_w); line_h=int(font.size*lh)
        if shadow>0:
            sl=Image.new("RGBA",canvas.size,(0,0,0,0)); sd=ImageDraw.Draw(sl); sy=y
            for line in lines:
                lw=sd.textlength(line,font=font); sx=cx-lw//2 if align=="center" else cx
                sd.text((sx+2,sy+2),line,font=font,fill=(0,0,0,shadow)); sy+=line_h
            sl=sl.filter(ImageFilter.GaussianBlur(radius=4))
            ca=canvas.convert("RGBA"); ca=Image.alpha_composite(ca,sl); canvas=ca.convert("RGB")
            draw=ImageDraw.Draw(canvas)
        for line in lines:
            lw=draw.textlength(line,font=font); sx=cx-lw//2 if align=="center" else cx
            draw.text((sx,y),line,font=font,fill=color); y+=line_h
        return canvas,y

    def pick_text_color(img_pil,tx,ty,tw,th,palette,style):
        """Validate Qwen color choices — give Qwen a second chance if weak, fallback only if both fail."""
        img_arr=np.array(img_pil.convert("RGB")); H_img,W_img=img_arr.shape[:2]
        def get_bg(y,h):
            y1=min(y+h,H_img); x1=min(tx+tw,W_img)
            p=img_arr[y:y1,tx:x1]
            return tuple(int(v) for v in p.reshape(-1,3).mean(axis=0)) if p.size>0 else (128,128,128)
        def lum(c):
            r,g,b=[v/255 for v in c]
            r=r/12.92 if r<=0.04045 else ((r+0.055)/1.055)**2.4
            g=g/12.92 if g<=0.04045 else ((g+0.055)/1.055)**2.4
            b=b/12.92 if b<=0.04045 else ((b+0.055)/1.055)**2.4
            return 0.2126*r+0.7152*g+0.0722*b
        def cr(c1,c2): l1=lum(c1)+0.05; l2=lum(c2)+0.05; return max(l1,l2)/min(l1,l2)
        def colorfulness(c): r,g,b=c; mx=max(r,g,b); mn=min(r,g,b); return (mx-mn)/(mx+1)
        def hex_of(c): return "#{:02x}{:02x}{:02x}".format(*c)

        bg_h=get_bg(ty,max(1,th//4)); bg_d=get_bg(ty+th//2,max(1,th//4))
        WARM_DARK=[(12,6,2),(22,12,4),(35,20,8),(50,32,16),(70,48,28)]
        WARM_LIGHT=[(252,248,242),(245,238,228),(235,225,210),(220,208,190),(200,185,165)]

        def guaranteed_color(bg_c,excl=None):
            on_d=lum(bg_c)<0.50
            cands=[c for c in palette if c!=excl] if excl else list(palette)
            if on_d: scored=sorted(cands,key=lambda c:cr(c,bg_c)*2+colorfulness(c)*0.3,reverse=True)
            else:    scored=sorted(cands,key=lambda c:cr(c,bg_c),reverse=True)
            best=scored[0] if scored else None
            if best is None or cr(best,bg_c)<3.0:
                pool=WARM_LIGHT if on_d else WARM_DARK
                if excl: pool=[c for c in pool if c!=excl]
                fb=max(pool,key=lambda c:cr(c,bg_c))
                if best is None or cr(fb,bg_c)>cr(best,bg_c): best=fb
            return tuple(int(v) for v in best)

        def safe_colors_for(bg_c, excl=None):
            pool = palette + WARM_DARK + WARM_LIGHT
            safe = [c for c in pool if cr(c,bg_c)>=3.0 and c!=excl]
            return [hex_of(c) for c in safe[:6]] if safe else [hex_of(guaranteed_color(bg_c,excl))]

        def qwen_retry_color(role, bg_c, bad_hex, excl=None):
            safe_list = safe_colors_for(bg_c, excl)
            bg_hex    = hex_of(bg_c)
            q = (
                f"You chose {bad_hex} for the {role} text but it has LOW CONTRAST "
                f"against the background {bg_hex}.\n\n"
                f"Choose a DIFFERENT color from this safe list (all have good contrast):\n"
                f"{safe_list}\n\n"
                f"Reply ONLY with one hex color code, e.g.: #1c1008"
            )
            try:
                resp = _qwen(img_pil, q, 20).strip()
                import re
                m = re.search(r'#[0-9a-fA-F]{6}', resp)
                if m:
                    hx = m.group(0)
                    h  = hx.lstrip("#")
                    c  = tuple(int(h[i:i+2],16) for i in (0,2,4))
                    if cr(c, bg_c) >= 2.5:
                        print(f"   ✓ Qwen retry {role}: {bad_hex} → {hx} (cr={cr(c,bg_c):.1f}x)")
                        return c
            except Exception as e:
                print(f"   Qwen retry error: {e}")
            return None

        MIN_CR = 2.5

        qwen_txt = style.get("headline_color_rgb")
        if qwen_txt:
            qc = tuple(int(v) for v in qwen_txt)
            if cr(qc, bg_h) >= MIN_CR:
                txt_col = qc
            else:
                print(f"   ⚠ Headline color {hex_of(qc)} weak (cr={cr(qc,bg_h):.1f}x) — asking Qwen to retry")
                retry = qwen_retry_color("headline", bg_h, hex_of(qc))
                txt_col = retry if retry else guaranteed_color(bg_h)
        else:
            txt_col = guaranteed_color(bg_h)

        qwen_sub = style.get("description_color_rgb")
        sub_col  = None
        if qwen_sub:
            sc = tuple(int(v) for v in qwen_sub)
            contrast_ok = cr(sc, bg_d) >= MIN_CR and sc != txt_col
            bri_diff = abs(lum(sc) - lum(txt_col))
            hierarchy_ok = bri_diff >= 0.15
            if contrast_ok and hierarchy_ok:
                sub_col = sc
            else:
                reason = "weak contrast" if not contrast_ok else "too similar to headline"
                print(f"   ⚠ Description color {hex_of(sc)} {reason} — asking Qwen to retry")
                safe_list = safe_colors_for(bg_d, excl=txt_col)
                bg_hex    = hex_of(bg_d)
                hl_hex    = hex_of(txt_col)
                retry_q = (
                    f"You chose {hex_of(sc)} for description but it looks TOO SIMILAR to the headline {hl_hex}.\n"
                    f"The viewer cannot tell them apart — this makes the poster look unprofessional.\n\n"
                    f"Background color: {bg_hex}\n"
                    f"Headline color: {hl_hex}\n\n"
                    f"Choose a description color that is CLEARLY DIFFERENT from the headline.\n"
                    f"If headline is light → choose a medium/dark color.\n"
                    f"If headline is dark → choose a medium color.\n\n"
                    f"Safe options with good contrast: {safe_list}\n\n"
                    "Reply ONLY with one hex color code, e.g.: #8a7060"
                )
                try:
                    retry_resp = _qwen(img_pil, retry_q, 20).strip()
                    import re as _re
                    m = _re.search(r'#[0-9a-fA-F]{6}', retry_resp)
                    if m:
                        hx = m.group(0); h = hx.lstrip("#")
                        rc = tuple(int(h[i:i+2],16) for i in (0,2,4))
                        bri_diff2 = abs(lum(rc) - lum(txt_col))
                        if cr(rc,bg_d)>=MIN_CR and bri_diff2>=0.12:
                            print(f"   ✓ Qwen retry description: {hex_of(sc)} → {hx} (diff={bri_diff2:.2f})")
                            sub_col = rc
                except Exception as _e:
                    print(f"   Qwen desc retry error: {_e}")
        if sub_col is None:
            sub_col = guaranteed_color(bg_d, excl=txt_col)

        bg_std = float(np.array(img_arr[ty:ty+th,tx:tx+tw]).std()) if th>0 else 40.0
        shadow = int(np.clip(120+bg_std*1.8,110,190))
        print(f"   txt={txt_col} cr={cr(txt_col,bg_h):.1f}x | sub={sub_col} cr={cr(sub_col,bg_d):.1f}x")
        return txt_col,sub_col,shadow


    def qwen_logo_position(img_pil, text_x, text_y, tw, th):
        """Ask Qwen to choose the best logo corner and size based on where the text is placed."""
        W,H=img_pil.size
        text_zone="top" if text_y < H*0.4 else "bottom"
        text_side="left" if text_x < W*0.4 else "right"

        q=(
            f"This is a {W}x{H} furniture advertisement poster.\n"
            f"Text block is in the {text_zone}-{text_side} area "
            f"(x={text_x}→{text_x+tw}, y={text_y}→{text_y+th}).\n\n"
            "Decide the best logo placement:\n"
            "1. Choose a corner FAR from the text\n"
            "2. Choose a size that looks balanced — not too big, not too small\n"
            "   Small image: logo_width = 10-13% of image width\n"
            "   Medium image: logo_width = 13-17% of image width\n"
            "   Large image: logo_width = 15-20% of image width\n"
            "3. Prefer bottom corners for brand logos\n\n"
            "Reply ONLY with valid JSON:\n"
            '{\n'
            '  "corner": "bottom_left" or "bottom_right" or "top_left" or "top_right",\n'
            '  "logo_width_pct": 0.10 to 0.20\n'
            '}'
        )
        try:
            resp=_qwen(img_pil,q,80)
            s0=resp.find("{"); s1=resp.rfind("}")+1
            if s0>=0 and s1>s0:
                res=json.loads(resp[s0:s1])
                corner=res.get("corner","bottom_left")
                pct=float(np.clip(res.get("logo_width_pct",0.15),0.10,0.22))

                logo_w=int(W*pct)
                logo_h=logo_w
                pad=int(W*0.025)

                corners={
                    "bottom_left":  (pad,       H-logo_h-pad),
                    "bottom_right": (W-logo_w-pad, H-logo_h-pad),
                    "top_left":     (pad,       pad),
                    "top_right":    (W-logo_w-pad, pad),
                }
                lx,ly=corners.get(corner, (pad, H-logo_h-pad))

                if not(lx+logo_w<text_x or lx>text_x+tw or ly+logo_h<text_y or ly>text_y+th):
                    best=min(corners.items(),
                             key=lambda kv: abs(kv[1][0]-text_x)+abs(kv[1][1]-text_y))
                    corner,(lx,ly)=best

                print(f"   Logo: {corner} ({lx},{ly}) size={logo_w}px ({pct*100:.0f}% of W)")
                return lx,ly,logo_w,logo_w
        except Exception as e:
            print(f"   Logo Qwen error: {e}")

        pad=int(W*0.025); logo_w=int(W*0.15)
        print(f"   Logo: fallback bottom_left size={logo_w}px")
        return pad, H-logo_w-pad, logo_w, logo_w


    def render_poster(img_pil,text_x,text_y,tw,th,style,texts,theme,
                      product_mask,logo_img=None,logo_pos=None,logo_size=None):
        """Render the final poster: headline, description, CTA button, logo."""
        W,H=img_pil.size; canvas=img_pil.convert("RGB").copy()
        txt_col,sub_col,shadow=pick_text_color(img_pil,text_x,text_y,tw,th,theme["palette"],style)
        cx=text_x+tw//2; max_tw=tw-int(W*0.06)
        h_case=(lambda t:t.upper()) if style.get("headline_case")=="uppercase" else (lambda t:t)
        d_case=(lambda t:t.upper()) if style.get("description_case")=="uppercase" else (lambda t:t)
        c_case=(lambda t:t.upper()) if style.get("cta_case")=="uppercase" else (lambda t:t)
        h_ls=style.get("headline_letter_spacing",0)
        bw,bh=int(W*0.30),int(H*0.068)
        h_ratio=style["headline_size_ratio"]; d_ratio=style["description_size_ratio"]; c_ratio=style["cta_size_ratio"]

        _tmp=ImageDraw.Draw(canvas)

        it=int(th*0.06)
        gt=int(th*0.04)
        dv=2
        gb=int(th*0.03)
        gd=int(th*0.05)
        ib=int(th*0.03)
        margins=it+gt+dv+gb+gd+ib

        available=th-margins-bh

        h_space=int(available*0.55)
        d_space=int(available*0.45)

        h_font,_hl,_=fit_text(_tmp,h_case(texts["headline"]),
                               style["headline_font"],max_tw,h_space,
                               int(H*h_ratio),min_size=int(H*0.060))

        d_font,_dl,_=fit_text(_tmp,d_case(texts["description"]),
                               style["description_font"],max_tw,d_space,
                               int(H*d_ratio),min_size=int(H*0.028))

        if d_font.size>=h_font.size:
            d_font=gf(style["description_font"],max(int(H*0.028),h_font.size-8))
            _dl=wrap(_tmp,d_case(texts["description"]),d_font,max_tw)

        c_font=gf(style["cta_font"],int(H*c_ratio))

        y=text_y+it
        if style.get("decorative_line"):
            draw=ImageDraw.Draw(canvas); dw=int(W*0.04)
            draw.rectangle([cx-dw//2,y,cx+dw//2,y+2],fill=theme["accent"]); y+=int(th*0.05)
        canvas,y=draw_text_block(canvas,h_case(texts["headline"]),h_font,cx,y,txt_col,max_tw,1.18,"center",shadow,h_ls)
        y+=gt; draw=ImageDraw.Draw(canvas); dw2=int(W*0.07)
        draw.rectangle([cx-dw2//2,y,cx+dw2//2,y+dv],fill=theme["accent"]); y+=dv+gb
        _sub_y_start=y
        canvas,y=draw_text_block(canvas,d_case(texts["description"]),d_font,cx,y,sub_col,max_tw,1.55,"center",max(shadow-30,110))
        y+=gd; draw=ImageDraw.Draw(canvas)
        bx=int(np.clip(cx-bw//2,text_x+int(W*0.02),text_x+tw-bw-int(W*0.02)))
        y_cta=min(y,text_y+th-bh-int(H*0.01))

        _cf=product_mask[y_cta:y_cta+bh,bx:bx+bw] if product_mask is not None else None
        if _cf is not None and _cf.size>0 and float(_cf.mean())>0.10:
            _moved=False
            for _shift in range(int(H*0.01),int(H*0.60),int(H*0.01)):
                _try=y_cta-_shift
                if _try<int(H*0.04): break
                _cf2=product_mask[_try:_try+bh,bx:bx+bw]
                if _cf2.size>0 and float(_cf2.mean())<0.10:
                    y_cta=_try; _moved=True
                    print(f"   ⚡ CTA moved up {_shift}px — off product"); break
            if not _moved:
                _hl_h=len(_hl)*int(h_font.size*1.18)
                y_cta=text_y+it+_hl_h+gt+dv+gb+int(th*0.04)
                print(f"   ⚡ CTA placed below headline y={y_cta}")

        _bg_arr=np.array(img_pil.convert("RGB"))
        _bg_p=_bg_arr[y_cta:y_cta+bh,bx:bx+bw]
        _bg_cta=tuple(int(v) for v in _bg_p.reshape(-1,3).mean(axis=0)) if _bg_p.size>0 else (200,200,200)
        def _lum2(c):
            r,g,b=[v/255 for v in c]
            r=r/12.92 if r<=0.04045 else ((r+0.055)/1.055)**2.4
            g=g/12.92 if g<=0.04045 else ((g+0.055)/1.055)**2.4
            b=b/12.92 if b<=0.04045 else ((b+0.055)/1.055)**2.4
            return 0.2126*r+0.7152*g+0.0722*b
        def _cr2(c1,c2): l1=_lum2(c1)+0.05; l2=_lum2(c2)+0.05; return max(l1,l2)/min(l1,l2)
        qwen_cta=style.get("cta_bg_rgb"); cta_bg=qwen_cta if qwen_cta else theme["cta_bg"]
        cta_bg=tuple(int(v) for v in cta_bg)
        if _cr2(cta_bg,_bg_cta)<2.0:
            alts=[c for c in theme["palette"] if _cr2(c,_bg_cta)>=2.0]
            cta_bg=max(alts,key=lambda c:_cr2(c,_bg_cta)) if alts else theme["accent"]
            cta_bg=tuple(int(v) for v in cta_bg)
            print(f"   CTA adjusted: {cta_bg} (cr={_cr2(cta_bg,_bg_cta):.1f}x)")
        cta_fg=(15,12,8) if _lum2(cta_bg)>0.4 else (245,240,232)
        draw.rounded_rectangle([bx,y_cta,bx+bw,y_cta+bh],radius=12,fill=cta_bg)
        cta_text_str=c_case(texts["cta"]); cw=draw.textlength(cta_text_str,font=c_font)
        draw.text((cx-cw//2,y_cta+(bh-c_font.size)//2-1),cta_text_str,font=c_font,fill=cta_fg)
        if logo_img and logo_pos and logo_size:
            lx,ly=logo_pos; lw,lh=logo_size
            lr=logo_img.convert("RGBA").resize((lw,lh),Image.LANCZOS)
            ca=canvas.convert("RGBA"); ca.paste(lr,(lx,ly),lr); canvas=ca.convert("RGB")

        _render_info = {
            "headline_size_px":      h_font.size,
            "description_size_px":   d_font.size,
            "cta_size_px":           c_font.size,
            "headline_color_hex":    "#{:02x}{:02x}{:02x}".format(*txt_col),
            "description_color_hex": "#{:02x}{:02x}{:02x}".format(*sub_col),
            "cta_bg_hex":            "#{:02x}{:02x}{:02x}".format(*cta_bg),
            "cta_fg_hex":            "#{:02x}{:02x}{:02x}".format(*cta_fg),
            "headline_y_px":         text_y + it + (int(th*0.05) if style.get("decorative_line") else 0),
            "sub_y_px":              _sub_y_start,
            "cta_y_px":              y_cta,
            "cta_x_px":              bx + bw // 2,
        }
        return canvas, _render_info


    def claude_evaluate_poster(poster_pil,clip_score,overlap_ratio):
        """Ask Claude to evaluate the poster on 5 criteria and decide accept/reject."""
        import base64
        from io import BytesIO
        try:
            buf=BytesIO(); poster_pil.convert("RGB").save(buf,format="JPEG",quality=85)
            img_b64=base64.standard_b64encode(buf.getvalue()).decode("utf-8")
            _client=_ant.Anthropic(api_key=IMAGE_AGENT_ANTHROPIC_KEY)
            prompt=(
                "You are a strict QA evaluator for luxury furniture advertisement posters.\n\n"
                f"System metrics: CLIP_score={clip_score:+.3f}, Overlap_ratio={overlap_ratio:.3f}\n\n"
                "Evaluate on FIVE criteria:\n"
                "1. PLACEMENT: ALL text on clean background — NOT on the product?\n"
                "2. HIERARCHY: Headline SIGNIFICANTLY larger than description (at least 1.5x)?\n"
                "3. READABILITY: Every text element clearly legible?\n"
                "4. COLORS: Good contrast for all text?\n"
                "5. OVERALL: Professional luxury furniture ad?\n\n"
                "REJECT if: text on product, button on product, headline≈description size, text unreadable.\n\n"
                'Reply ONLY: {"placement_ok":true,"hierarchy_ok":true,"readability_ok":true,'
                '"colors_ok":true,"overall_quality":8,"accept":true,"reason":"summary"}'
            )
            resp=_client.messages.create(
                model="claude-opus-4-5",max_tokens=200,
                messages=[{"role":"user","content":[
                    {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":img_b64}},
                    {"type":"text","text":prompt}
                ]}]
            )
            rt=resp.content[0].text; s0=rt.find("{"); s1=rt.rfind("}")+1
            if s0>=0 and s1>s0:
                res=json.loads(rt[s0:s1])
                placement=res.get("placement_ok",True); hierarchy=res.get("hierarchy_ok",True)
                readability=res.get("readability_ok",True); colors=res.get("colors_ok",True)
                quality=res.get("overall_quality",5); accept=res.get("accept",True)
                reason=res.get("reason","")
                if not hierarchy or not readability or not placement:
                    accept=False
                    if not hierarchy: reason="REJECTED: headline not dominant"
                    elif not readability: reason="REJECTED: text not readable"
                    elif not placement: reason="REJECTED: text on product"
                print(f"\n   ┌─── Claude Evaluation ───────────────────┐")
                print(f"   │ Placement:  {'✓ OK' if placement else '✗ on product':<28}│")
                print(f"   │ Hierarchy:  {'✓ OK' if hierarchy else '✗ not dominant':<28}│")
                print(f"   │ Readability:{'✓ OK' if readability else '✗ not readable':<28}│")
                print(f"   │ Colors:     {'✓ OK' if colors else '✗ Low contrast':<28}│")
                print(f"   │ Quality:    {quality}/10{' '*(26-len(str(quality)))}│")
                print(f"   │ Decision:   {'✓ ACCEPT' if accept else '✗ REJECT':<28}│")
                print(f"   │ Reason:     {reason[:36]:<36}│")
                print(f"   └─────────────────────────────────────────┘")
                return accept,res
        except Exception as e:
            print(f"   Claude evaluation error: {e}")
        return True,{}


    def claude_pick_best(candidates):
        """Ask Claude to visually compare all candidate posters and pick the best one."""
        import base64
        from io import BytesIO
        if len(candidates)==1: return 0
        try:
            _client=_ant.Anthropic(api_key=IMAGE_AGENT_ANTHROPIC_KEY)
            content=[]
            for idx,entry in enumerate(candidates):
                pil=entry[0]; buf=BytesIO()
                pil.convert("RGB").save(buf,format="JPEG",quality=80)
                b64=base64.standard_b64encode(buf.getvalue()).decode("utf-8")
                content.append({"type":"text","text":f"=== POSTER {idx+1} ==="})
                content.append({"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":b64}})
            content.append({"type":"text","text":(
                f"Compare {len(candidates)} luxury furniture ad posters. Visual judgment only.\n\n"
                "Pick BEST based on:\n"
                "• ALL text on clean wall — NOT on the product\n"
                "• HEADLINE clearly the largest text\n"
                "• SHOP NOW button NOT on the product\n"
                "• Professional luxury appearance\n\n"
                'Reply ONLY: {"best_poster_index":1,"visual_reason":"reason","ranking":[1,2]}'
            )})
            resp=_client.messages.create(
                model="claude-opus-4-5",max_tokens=150,
                messages=[{"role":"user","content":content}]
            )
            rt=resp.content[0].text; s0=rt.find("{"); s1=rt.rfind("}")+1
            if s0>=0 and s1>s0:
                res=json.loads(rt[s0:s1])
                best_idx=max(0,min(int(res.get("best_poster_index",1))-1,len(candidates)-1))
                print(f"\n   ┌─── Claude: Visual Selection ─────────────┐")
                print(f"   │ Winner:  Poster {best_idx+1} (Attempt {candidates[best_idx][1]}){'':<18}│")
                print(f"   │ Ranking: {str(res.get('ranking',[])):<42}│")
                print(f"   │ Reason:  {str(res.get('visual_reason',''))[:42]:<42}│")
                print(f"   └──────────────────────────────────────────┘")
                return best_idx
        except Exception as e:
            print(f"   claude_pick_best error: {e}")
        return max(range(len(candidates)),key=lambda i:candidates[i][4])


    # ════════════════════════════════════════════════════════════════
    # MAIN EXECUTION — same logic as Colab Cell 11
    # ════════════════════════════════════════════════════════════════

    _prog("Loading fonts…")
    load_fonts()
    _prog("Building color theme…")
    _theme=build_smart_theme(_img)

    # CLIP scoring
    _prog("Loading CLIP for scoring…")
    try:
        import clip as _clip_lib
        _good_tok=_clip_lib.tokenize(["professional luxury furniture ad","clean readable headline on wall"]).cuda()
        _bad_tok =_clip_lib.tokenize(["text on furniture","tiny headline","unreadable text"]).cuda()
        with torch.no_grad():
            _gf_enc=_CLIP_MODEL.encode_text(_good_tok).float(); _gf_enc/=_gf_enc.norm(dim=-1,keepdim=True)
            _bf_enc=_CLIP_MODEL.encode_text(_bad_tok).float();  _bf_enc/=_bf_enc.norm(dim=-1,keepdim=True)
        def clip_score(pil):
            img=_CLIP_PREP(pil.convert("RGB")).unsqueeze(0).cuda()
            with torch.no_grad():
                f=_CLIP_MODEL.encode_image(img).float(); f/=f.norm(dim=-1,keepdim=True)
            return float((f@_gf_enc.T).mean()-(f@_bf_enc.T).mean())
        print("   CLIP ready ✓")
    except Exception as _e:
        print(f"   CLIP not available ({_e}) — fallback")
        def clip_score(pil): return 0.05

    MAX_ATTEMPTS=3; GOOD_SCORE=0.030
    _best_poster=None; _best_score=-9999
    _all_candidates=[]; _failed_zones=[]; _claude_result={}
    _tx=_ty=_tw=_th=0; _overlap=0.0; _bg_std=50.0
    _style={}; _render_info={}
    # Track coords for the overall best poster (may have score < GOOD_SCORE)
    _best_tx=_best_ty=_best_tw=_best_th=0; _best_render_info={}

    for _attempt in range(1,MAX_ATTEMPTS+1):
        print(f"\n{'═'*54}")
        print(f"  ATTEMPT {_attempt}/{MAX_ATTEMPTS}")
        print(f"{'═'*54}")

        _prog(f"Qwen finding text zone (attempt {_attempt})…")
        _qwen_zone=qwen_find_placement(_img,_product_mask,
                                       exclude_zones=_failed_zones if _failed_zones else None)

        _prog("Refining placement…")
        _tx,_ty,_tw,_th=refine_placement(_img,_product_mask,_qwen_zone)

        _overlap=compute_overlap_ratio(_tx,_ty,_tw,_th,_product_mask)
        _patch=np.array(_img.convert("RGB"))[_ty:_ty+_th,_tx:_tx+_tw]
        _bg_std=float(_patch.std()) if _patch.size>0 else 50.0
        _clean=_bg_std<32.0
        print(f"   Overlap Ratio: {_overlap:.3f} | bg_std: {_bg_std:.1f}")

        _mask_unreliable = (_product_mask.mean() > 0.75)
        if _mask_unreliable:
            _overlap = 0.0
            print(f"   ⚠ Mask coverage > 75% — using bg_std only for placement")

        _threshold=0.50 if _bg_std<32.0 else 0.18
        if not _mask_unreliable and _overlap>_threshold and not _clean and _attempt<MAX_ATTEMPTS:
            print(f"   ✗ Overlap={_overlap:.2f} too high — trying different zone")
            _failed_zones.append(_qwen_zone.get("zone","top")); continue
        elif not _mask_unreliable and _overlap>_threshold and _clean:
            print(f"   ⚡ Overlap={_overlap:.2f} but bg clean — continuing")

        _prog("Qwen designing typography…")
        _style=qwen_design_decision(_img,_theme,
            f"zone={_qwen_zone.get('zone')} y={_qwen_zone['y_start_pct']:.2f}→{_qwen_zone['y_end_pct']:.2f} attempt={_attempt}",
            _tx,_ty,_tw,_th)

        if _logo_img:
            _prog("Qwen positioning logo…")
            _lx,_ly,_qwen_lw,_qwen_lh=qwen_logo_position(_img,_tx,_ty,_tw,_th)
            _orig_ratio=_logo_img.height/_logo_img.width
            _final_lw=_qwen_lw
            _final_lh=int(_final_lw*_orig_ratio)
            if _final_lh>H*0.18: _final_lh=int(H*0.18); _final_lw=int(_final_lh/_orig_ratio)
            _logo_size=(_final_lw,_final_lh)
            _logo_pos=(_lx,_ly)

        _prog("Rendering poster…")
        _poster,_render_info=render_poster(_img,_tx,_ty,_tw,_th,_style,_texts,_theme,
                              _product_mask,_logo_img,_logo_pos,_logo_size)

        _score=clip_score(_poster.resize((336,336),Image.LANCZOS))
        print(f"\n   CLIP score: {_score:+.3f} {'✓ GOOD' if _score>=GOOD_SCORE else '✗ LOW'}")

        if _score>_best_score:
            _best_score=_score; _best_poster=_poster.copy()
            _best_tx,_best_ty,_best_tw,_best_th=_tx,_ty,_tw,_th
            _best_render_info=dict(_render_info)

        _bx_c=int(np.clip(_tx+_tw//2-int(W*0.15),_tx,_tx+_tw))
        _bh_c=int(H*0.068); _yc=min(_ty+_th-_bh_c-int(H*0.01),_ty+_th-_bh_c)
        _cf=_product_mask[_yc:_yc+_bh_c,_bx_c:_bx_c+int(W*0.30)]
        _cta_furn=float(_cf.mean()) if _cf.size>0 else 0.0
        _comp=compute_composite_score(_score,_overlap,_bg_std,_cta_furn)
        print(f"   Composite: {_comp:.4f}")

        if _score>=GOOD_SCORE:
            _all_candidates.append((_poster.copy(),_attempt,_score,_overlap,_comp,
                                    _tx,_ty,_tw,_th,dict(_render_info)))
            _prog("Claude evaluating poster…")
            _accept,_claude_result=claude_evaluate_poster(_poster,_score,_overlap)
            if _accept:
                print(f"   ✓ Accepted at attempt {_attempt}")
                break
            else:
                print(f"   ✗ Claude rejected — retrying")
                _failed_zones.append(_qwen_zone.get("zone","top"))

        if _attempt<MAX_ATTEMPTS:
            _prog("Qwen analyzing failure…")
            _fb=qwen_analyze_failure(_poster,_score,_attempt)
            fix=_fb.get("fix","try_different_zone")
            if fix=="try_different_zone" or _fb.get("problem")=="overlap":
                _failed_zones.append(_qwen_zone.get("zone","top"))
                print(f"   → Trying different zone (failed: {_failed_zones})")
            elif fix in ["move_text_down","move_text_up"]:
                delta=0.12 if fix=="move_text_down" else -0.12
                _qwen_zone["y_start_pct"]=float(np.clip(_qwen_zone["y_start_pct"]+delta,0,0.9))
                _qwen_zone["y_end_pct"]  =float(np.clip(_qwen_zone["y_end_pct"]+delta,0.1,1.0))
                print(f"   → Shifting zone {fix}")

    # Final selection — also restore the coords that match the chosen poster
    if len(_all_candidates)>1:
        _all_candidates.sort(key=lambda x:x[4],reverse=True)
        _gap=_all_candidates[0][4]-_all_candidates[1][4]
        if _gap>0.15:
            _best_poster=_all_candidates[0][0]; _best_score=_all_candidates[0][2]
            _tx,_ty,_tw,_th,_render_info=_all_candidates[0][5],_all_candidates[0][6],_all_candidates[0][7],_all_candidates[0][8],_all_candidates[0][9]
        else:
            _bidx=claude_pick_best(_all_candidates)
            _best_poster=_all_candidates[_bidx][0]; _best_score=_all_candidates[_bidx][2]
            _tx,_ty,_tw,_th,_render_info=_all_candidates[_bidx][5],_all_candidates[_bidx][6],_all_candidates[_bidx][7],_all_candidates[_bidx][8],_all_candidates[_bidx][9]
    elif len(_all_candidates)==1:
        _best_poster=_all_candidates[0][0]; _best_score=_all_candidates[0][2]
        _tx,_ty,_tw,_th,_render_info=_all_candidates[0][5],_all_candidates[0][6],_all_candidates[0][7],_all_candidates[0][8],_all_candidates[0][9]
    else:
        # No candidate reached GOOD_SCORE — use coords from the overall best-scored attempt
        _tx,_ty,_tw,_th,_render_info=_best_tx,_best_ty,_best_tw,_best_th,_best_render_info

    # Save final poster
    _POSTER_PATH=os.path.join(workspace,"final_poster.png")
    _best_poster.save(_POSTER_PATH,"PNG")
    print(f"\n   ✅ Poster saved → {_POSTER_PATH}")

    # ── Build poster_config — exact format the customize page expects ──
    _font_map = {
        "playfair":     "playfair",
        "cormorant":    "cormorant",
        "libre_caslon": "caslon",
        "dm_serif":     "dmserif",
        "raleway":      "raleway",
        "montserrat":   "montserrat",
        "lato_bold":    "lato",
        "lato_black":   "lato",
        "nunito":       "nunito",
        "josefin":      "josefin",
    }

    _poster_config = {
        "headline":      _texts["headline"],
        "sub":           _texts["description"],
        "cta":           _texts["cta"],
        "headlineFont":  _font_map.get(_style.get("headline_font","playfair"), "display"),
        "headlineAlign": "center",
        "color":         _render_info.get("headline_color_hex","#ffffff"),
        "size":          _render_info.get("headline_size_px",44),
        "subFont":       _font_map.get(_style.get("description_font","lato_bold"), "sans"),
        "subAlign":      "center",
        "subColor":      _render_info.get("description_color_hex","#ffffffb3"),
        "subSize":       _render_info.get("description_size_px",18),
        "ctaFont":       "sans",
        "ctaAlign":      "center",
        "ctaColor":      _render_info.get("cta_bg_hex","#F76C6C"),
        "ctaTextColor":  _render_info.get("cta_fg_hex","#ffffff"),
        "ctaSize":       _render_info.get("cta_size_px",13),
    }

    # ── Encode images as base64 ────────────────────────────────────
    def _to_b64(img):
        buf = BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=88)
        return base64.b64encode(buf.getvalue()).decode()

    poster_b64 = _to_b64(_best_poster)
    bg_b64     = _to_b64(Image.open(approved_path).convert("RGB"))

    # ── Text coordinates as percentages (for frontend customize screen) ──
    text_coords = {
        "tx_pct":     round(_tx / W, 4),
        "ty_pct":     round(_ty / H, 4),
        "tw_pct":     round(_tw / W, 4),
        "th_pct":     round(_th / H, 4),
        "headline_y": round(_render_info.get("headline_y_px", _ty) / H, 4),
        "sub_y":      round(_render_info.get("sub_y_px", _ty + _th * 0.38) / H, 4),
        "cta_y":      round(_render_info.get("cta_y_px", _ty + _th * 0.60) / H, 4),
        "cta_x":      round(_render_info.get("cta_x_px", _tx + _tw // 2) / W, 4),
    }

    return {
        "poster_b64":    poster_b64,
        "bg_b64":        bg_b64,
        "text_coords":   text_coords,
        "poster_config": _poster_config,
    }
