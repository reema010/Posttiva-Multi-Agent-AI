# ═══════════════════════════════════════════════════════════════════
#  POSTTIVA — FastAPI Backend
#  Wraps the 3-agent pipeline so the frontend can call it via HTTP.
#
#  Routes (match api.js exactly):
#    POST /upload          — upload product image → SAM loads it
#    POST /preview         — SAM hover            → overlay base64
#    POST /save_mask       — SAM click confirm    → saves product+mask
#    POST /run_text        — Text Agent job
#    POST /run_image       — Image Agent job
#    POST /run_layout      — Layout Agent job
#    GET  /job/{job_id}    — poll job status
#    GET  /job/{job_id}/result — get final result
# ═══════════════════════════════════════════════════════════════════

import os, uuid, time, threading, base64, io, traceback
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, Any, Dict
from PIL import Image

# ── Load environment variables ────────────────────────────────────
from dotenv import load_dotenv
load_dotenv()

# ── App ───────────────────────────────────────────────────────────
app = FastAPI(title="POSTTIVA API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Paths (RunPod uses /workspace) ────────────────────────────────
WORKSPACE       = os.environ.get("WORKSPACE", "/workspace")
SAM_PRODUCT_PATH = os.path.join(WORKSPACE, "sam_product.png")
SAM_MASK_PATH    = os.path.join(WORKSPACE, "sam_mask.png")
CHECKPOINTS_DIR  = os.path.join(WORKSPACE, "checkpoints")
SAVE_FOLDER      = os.path.join(WORKSPACE, "sam_results")
os.makedirs(CHECKPOINTS_DIR, exist_ok=True)
os.makedirs(SAVE_FOLDER,     exist_ok=True)

# ── In-memory job store ───────────────────────────────────────────
# { job_id: { status, progress, result, error } }
_jobs: Dict[str, dict] = {}

def _new_job() -> str:
    jid = str(uuid.uuid4())
    _jobs[jid] = {"status": "running", "progress": "Starting…", "result": None, "error": None}
    return jid

def _job_done(jid: str, result: dict):
    _jobs[jid]["status"]   = "done"
    _jobs[jid]["progress"] = "Done"
    _jobs[jid]["result"]   = result

def _job_error(jid: str, msg: str):
    _jobs[jid]["status"] = "error"
    _jobs[jid]["error"]  = msg

def _job_progress(jid: str, msg: str):
    if jid in _jobs:
        _jobs[jid]["progress"] = msg

# ── Shared state (one user at a time — matches Colab notebook flow) ─
_state: Dict[str, Any] = {
    "engine":    None,   # SAMEngineHQ instance
    "image_pil": None,   # current PIL image
    "mask":      None,   # last SAM mask numpy array
    "settings":  {},     # campaign preferences from /run_text payload
    "text":      None,   # { headline, description, cta }
    "approved_path": None,  # approved background image path
}

# ── Helpers ───────────────────────────────────────────────────────
def _pil_to_b64(img: Image.Image, fmt="JPEG", quality=85) -> str:
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    return base64.b64encode(buf.getvalue()).decode()

def _b64_to_pil(b64: str) -> Image.Image:
    data = base64.b64decode(b64)
    return Image.open(io.BytesIO(data))

# ═══════════════════════════════════════════════════════════════════
# ROUTE 1 — POST /upload
# Frontend: apiUploadImage(file)
# Returns:  { preview: base64, width, height }
# ═══════════════════════════════════════════════════════════════════
@app.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")

        # Import here so models load once at startup (models/loader.py handles that)
        from models.loader import get_sam_engine
        engine = get_sam_engine()
        engine.load_image(image)
        _state["engine"]    = engine
        _state["image_pil"] = image
        _state["mask"]      = None

        preview_b64 = _pil_to_b64(image, quality=82)
        return {"preview": preview_b64, "width": image.width, "height": image.height}

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════
# ROUTE 2 — POST /preview
# Frontend: apiSamHover(image_id, px, py)
# Body:     { x: px, y: py, scale: "refined" }
# Returns:  { overlay: base64, score, area_pct, x, y }
# ═══════════════════════════════════════════════════════════════════
class PreviewBody(BaseModel):
    x:     int
    y:     int
    scale: str = "refined"

@app.post("/preview")
async def sam_preview(body: PreviewBody):
    try:
        engine = _state.get("engine")
        if engine is None:
            raise HTTPException(status_code=400, detail="No image loaded. Call /upload first.")

        import numpy as np
        from scipy import ndimage

        mask, score = engine.get_mask(body.x, body.y, scale=body.scale)
        _state["mask"] = mask

        # Build blue/red overlay — identical to Colab widget
        overlay = engine.image_np.copy()
        color   = np.array([30, 144, 255], dtype=np.uint8)
        mb      = mask.astype(bool)
        overlay[mb] = (overlay[mb] * 0.55 + color * 0.45).astype(np.uint8)
        dilated = ndimage.binary_dilation(mb, iterations=3)
        overlay[dilated ^ mb] = [255, 0, 0]

        area_pct = float(mask.sum() / (engine.h * engine.w)) * 100
        overlay_pil = Image.fromarray(overlay.astype("uint8"), "RGB")
        overlay_b64 = _pil_to_b64(overlay_pil, quality=82)

        return {
            "overlay":  overlay_b64,
            "score":    float(score),
            "area_pct": round(area_pct, 2),
            "x":        body.x,
            "y":        body.y,
        }

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════
# ROUTE 3 — POST /save_mask
# Frontend: apiSamSelect(image_id, nx, ny)
# Returns:  { thumbnail: base64 }
# ═══════════════════════════════════════════════════════════════════
@app.post("/save_mask")
async def save_mask():
    try:
        engine = _state.get("engine")
        mask   = _state.get("mask")

        if engine is None or mask is None:
            raise HTTPException(status_code=400, detail="No mask available. Hover first.")

        import numpy as np

        # ── Save product cutout + mask — identical to on_click_save() in Colab ──
        out, path = engine.extract_and_save(mask)
        out.save(SAM_PRODUCT_PATH, "PNG")

        pad = 10
        rows_m = np.any(mask, axis=1)
        cols_m = np.any(mask, axis=0)
        y_min_m, y_max_m = np.where(rows_m)[0][[0, -1]]
        x_min_m, x_max_m = np.where(cols_m)[0][[0, -1]]
        h_img, w_img = engine.image_np.shape[:2]
        y_min_m = max(0, y_min_m - pad)
        y_max_m = min(h_img - 1, y_max_m + pad)
        x_min_m = max(0, x_min_m - pad)
        x_max_m = min(w_img - 1, x_max_m + pad)
        mask_cropped = mask[y_min_m:y_max_m+1, x_min_m:x_max_m+1]
        mask_img = Image.fromarray(((1 - mask_cropped) * 255).astype(np.uint8), "L")
        mask_img.save(SAM_MASK_PATH, "PNG")

        # Thumbnail for frontend preview
        thumb = out.convert("RGB").copy()
        thumb.thumbnail((200, 200))
        thumbnail_b64 = _pil_to_b64(thumb, quality=82)

        return {"thumbnail": thumbnail_b64}

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════
# ROUTE 4 — POST /run_text
# Frontend: apiGenerateText(payload)
# Body:     { ad_type, product_focus, discount, room, room_style,
#             lighting, urgency, frame }
# Returns:  { job_id }
# ═══════════════════════════════════════════════════════════════════
class PipelinePayload(BaseModel):
    ad_type:       str = "Product ad"
    product_focus: str = "Aesthetic"
    discount:      int = 0
    room:          str = "Living Room"
    room_style:    str = "Modern"
    lighting:      str = "Sunlight"
    urgency:       str = "Non-urgent"
    frame:         str = "square"
    text:          Optional[dict] = None   # used by /run_layout
    seed:          Optional[int] = None

@app.post("/run_text")
async def run_text(payload: PipelinePayload):
    jid = _new_job()
    _state["settings"] = payload.dict()

    def _worker():
        try:
            from agents.text_agent import run_text_agent
            _job_progress(jid, "Reading your product…")
            result = run_text_agent(
                image_path    = SAM_PRODUCT_PATH,
                settings      = _state["settings"],
                on_progress   = lambda msg: _job_progress(jid, msg),
            )
            _state["text"] = result
            _job_done(jid, {"text": result})
        except Exception as e:
            traceback.print_exc()
            _job_error(jid, str(e))

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": jid}


# ═══════════════════════════════════════════════════════════════════
# ROUTE 5 — POST /run_image
# Frontend: apiGeneratePoster(payload)
# Returns:  { job_id }
# ═══════════════════════════════════════════════════════════════════
@app.post("/run_image")
async def run_image(payload: PipelinePayload):
    jid = _new_job()
    # Merge new payload into stored settings (keep text settings)
    _state["settings"].update(payload.dict())

    def _worker():
        try:
            from agents.image_agent import run_image_agent
            _job_progress(jid, "Loading Stable Diffusion…")
            approved_path = run_image_agent(
                product_path  = SAM_PRODUCT_PATH,
                mask_path     = SAM_MASK_PATH,
                settings      = _state["settings"],
                workspace     = WORKSPACE,
                on_progress   = lambda msg: _job_progress(jid, msg),
            )
            _state["approved_path"] = approved_path

            # Return poster as base64
            img     = Image.open(approved_path).convert("RGB")
            b64     = _pil_to_b64(img, quality=88)
            _job_done(jid, {"poster_b64": b64, "clip_score": 0.0, "overlap": 0.0})
        except Exception as e:
            traceback.print_exc()
            _job_error(jid, str(e))

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": jid}


# ═══════════════════════════════════════════════════════════════════
# ROUTE 6 — POST /run_layout
# Frontend: apiLayout({ session_id, text })
# Body:     { ...pipeline_payload, text: { headline, description, cta } }
# Returns:  { job_id }
# ═══════════════════════════════════════════════════════════════════
@app.post("/run_layout")
async def run_layout(payload: PipelinePayload):
    jid = _new_job()
    # text can come from payload (user-edited) or from stored text agent result
    text_to_use = payload.text or _state.get("text")

    def _worker():
        try:
            from agents.layout_agent import run_layout_agent
            _job_progress(jid, "Qwen finding text zone…")
            result = run_layout_agent(
                approved_path = _state.get("approved_path"),
                product_path  = SAM_PRODUCT_PATH,
                mask_path     = SAM_MASK_PATH,
                texts         = text_to_use,
                settings      = _state["settings"],
                workspace     = WORKSPACE,
                on_progress   = lambda msg: _job_progress(jid, msg),
            )
            _job_done(jid, result)
        except Exception as e:
            traceback.print_exc()
            _job_error(jid, str(e))

    threading.Thread(target=_worker, daemon=True).start()
    return {"job_id": jid}


# ═══════════════════════════════════════════════════════════════════
# ROUTE 7 — GET /job/{job_id}
# Frontend: _pollJob(job_id)
# Returns:  { status, progress }  or  { status:"done", text/poster_b64/… }
# ═══════════════════════════════════════════════════════════════════
@app.get("/job/{job_id}")
async def get_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    resp = {"status": job["status"], "progress": job["progress"]}
    if job["status"] == "done" and job["result"]:
        resp.update(job["result"])
    if job["status"] == "error":
        resp["error"] = job["error"]
    return resp


# ═══════════════════════════════════════════════════════════════════
# ROUTE 8 — GET /job/{job_id}/result
# Frontend: _aiFetch('/job/' + job_id + '/result')
# Returns full result payload
# ═══════════════════════════════════════════════════════════════════
@app.get("/job/{job_id}/result")
async def get_job_result(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=202, detail="Job not done yet")
    return job["result"] or {}


# ═══════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ═══════════════════════════════════════════════════════════════════
@app.get("/health")
async def health():
    return {"status": "ok", "workspace": WORKSPACE}
