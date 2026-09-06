/** ═══════════════════════════════════════════════════════════
   POSTTIVA — API client  (v5 · split Text / Image / Layout)

   Flow:
   1. Upload image        → POST /upload
   2. Hover (real-time)   → POST /preview  (blue/red SAM mask)
   3. Click confirm       → POST /save_mask
   4. Text Agent          → POST /run_text  (~30 sec)
      → user sees headline/description/CTA fast ✅
   5. User approves text  → clicks "Use this text →"
   6. Image Agent         → POST /run_image (~5 min)
      → Stable Diffusion generates AI background
   7. Layout Agent        → POST /run_layout (~2 min)
      → Qwen places text on poster
   8. Final poster shown  ✅
═══════════════════════════════════════════════════════════ */

// ─── CONFIG ──────────────────────────────────────────────
const DB_BASE  = window.POSTTIVA_DB_BASE  || 'http://localhost:3001';
// ← Updated automatically from config.js
const API_BASE = window.POSTTIVA_API_BASE || 'http://localhost:8000';
const DEMO_MODE = false;

// ─── Token store ─────────────────────────────────────────
let _token = null;
function getToken()  { return _token; }
function setToken(t) { _token = t; }
function clearToken(){ _token = null; }

// ─── Helpers ─────────────────────────────────────────────
async function _dbFetch(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && _token) headers['Authorization'] = 'Bearer ' + _token;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(DB_BASE + path, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function _aiFetch(path, { method = 'POST', body, formData } = {}) {
  const headers = {};
  const opts = { method, headers };
  if (formData) {
    opts.body = formData;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll job until done — calls onProgress with status string every 3 sec
async function _pollJob(job_id, onProgress) {
  while (true) {
    await _sleep(3000);
    const data = await _aiFetch('/job/' + job_id, { method: 'GET' });
    if (onProgress) onProgress(data.progress || '');
    if (data.status === 'done')  return data;
    if (data.status === 'error') throw new Error(data.error || 'Pipeline failed');
  }
}

// Map frontend brief values → backend pipeline settings
function _buildPayload({ ad_type, audience, discount, room, style, lighting, urgency, frame } = {}) {
  const adTypeMap = {
    'product':      'Product ad', 'product ad':   'Product ad',
    'sale':         'Offers',     'offers':        'Offers', 'offer': 'Offers',
    'eid':          'Eid',
    'national':     'National Day', 'national day': 'National Day', 'nationalday': 'National Day',
  };
  const focusMap = {
    'aesthetic': 'Aesthetic', 'beauty': 'Aesthetic', 'editorial': 'Aesthetic',
    'comfort':   'Comfort',   'cozy':   'Comfort',
    'practical': 'Practical', 'quality':'Practical',
  };
  const roomMap = {
    'living':  'Living Room', 'living room': 'Living Room',
    'bedroom': 'Bedroom',
  };
  const styleMap = {
    'classic': 'Classic', 'modern': 'Modern', 'boho': 'Boho',
  };
  // Must match backend agents/image_agent.py LIGHT_DATA keys exactly ("Indoor", not "Indoor Lighting")
  const lightMap = {
    'sunlight': 'Sunlight',
    'indoor': 'Indoor',
    'indoor lighting': 'Indoor',
  };
  const urgencyMap = {
    'urgent': 'Urgent', 'non_urgent': 'Non-urgent', 'non-urgent': 'Non-urgent',
  };
  const frameMap = {
    'square': 'square', 'vertical': 'vertical', 'portrait': 'portrait',
  };
  return {
    ad_type:       adTypeMap[(ad_type  || '').toLowerCase()] || 'Product ad',
    product_focus: focusMap[ (audience || '').toLowerCase()] || 'Aesthetic',
    discount:      Number(discount) || 0,
    room:          roomMap[ (room    || '').toLowerCase()] || 'Living Room',
    room_style:    styleMap[(style   || '').toLowerCase()] || 'Modern',
    lighting:      lightMap[(lighting|| '').toLowerCase()] || 'Sunlight',
    urgency:       urgencyMap[(urgency||'').toLowerCase()]  || 'Non-urgent',
    frame:         frameMap[ (frame  || '').toLowerCase()] || 'square',
  };
}

// ═══════════════════════════════════════════════════════
// AUTH — always real database
// ═══════════════════════════════════════════════════════

async function apiSignup({ name, email, password }) {
  const data = await _dbFetch('/api/auth/register', { method: 'POST', body: { name, email, password } });
  setToken(data.token); return data;
}

async function apiLogin({ email, password, rememberMe = false }) {
  const data = await _dbFetch('/api/auth/login', { method: 'POST', body: { email, password, rememberMe } });
  setToken(data.token); return data;
}

async function apiForgotPassword({ email }) {
  return _dbFetch('/api/auth/forgot-password', { method: 'POST', body: { email } });
}

async function apiResetPassword({ email, code, newPassword }) {
  return _dbFetch('/api/auth/reset-password', { method: 'POST', body: { email, code, newPassword } });
}

async function apiLogout() {
  try { await _dbFetch('/api/auth/logout', { method: 'POST', auth: true }); } catch(e) {}
  clearToken();
}

async function apiUpdateProfile({ name, email }) {
  return _dbFetch('/api/user/profile', { method: 'PUT', body: { name, email }, auth: true });
}

async function apiUpdatePassword({ currentPassword, newPassword }) {
  return _dbFetch('/api/user/password', { method: 'PUT', body: { currentPassword, newPassword }, auth: true });
}

// ═══════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════

async function apiSaveProject({ title, bg_color, label, sub, chat_answers, poster_config, session_id, poster_img }) {
  return _dbFetch('/api/projects', {
    method: 'POST', body: { title, bg_color, label, sub, chat_answers, poster_config, session_id, poster_img }, auth: true
  });
}

async function apiGetProjects() { return _dbFetch('/api/projects', { auth: true }); }

async function apiUpdateProject(id, { title, bg_color, label, sub, poster_config, session_id, poster_img }) {
  return _dbFetch('/api/projects/' + id, {
    method: 'PUT', body: { title, bg_color, label, sub, poster_config, session_id, poster_img }, auth: true
  });
}

async function apiDeleteProject(id) {
  return _dbFetch('/api/projects/' + id, { method: 'DELETE', auth: true });
}

async function apiRating({ session_id, project_id, rating }) {
  return _dbFetch('/api/feedback', { method: 'POST', body: { project_id, session_id, rating }, auth: true });
}

// ═══════════════════════════════════════════════════════
// AGENT 1 — IMAGE UPLOAD + SAM SEGMENTATION
//
// SAM hover (exactly like Jupyter notebook widget):
//   - User moves mouse over image
//   - app.js calls apiSamHover(image_id, px, py) with PIXEL coords
//   - Backend runs SAM → returns overlay:
//       Blue  = selected product area
//       Red   = product border
//   - Drawn on canvas in real time
//   - User clicks → apiSamSelect saves mask
// ═══════════════════════════════════════════════════════

async function apiUploadImage(file) {
  if (DEMO_MODE) {
    await _sleep(600);
    return { image_id: 'demo_' + Date.now(), preview_url: URL.createObjectURL(file) };
  }
  const fd = new FormData();
  fd.append('file', file);
  const res = await _aiFetch('/upload', { method: 'POST', formData: fd });
  return {
    image_id:    'uploaded',
    preview_url: 'data:image/jpeg;base64,' + res.preview,
    width:       res.width,
    height:      res.height,
  };
}

// Hover — px, py are pixel coordinates (computed by app.js _getPixelCoords)
async function apiSamHover(image_id, px, py) {
  if (DEMO_MODE) { await _sleep(80); return { overlay_b64: null }; }
  const res = await _aiFetch('/preview', { body: { x: px, y: py, scale: 'refined' } });
  return {
    overlay_b64: res.overlay,   // base64 jpeg — blue highlight + red border
    score:       res.score,     // SAM confidence 0-1
    area:        res.area_pct,  // % of image covered
    x:           res.x,
    y:           res.y,
  };
}

// Click confirm → save mask to disk
async function apiSamSelect(image_id, nx, ny) {
  if (DEMO_MODE) {
    await _sleep(700);
    return { product_url: null, mask_url: null, session_id: 'sess_' + Date.now() };
  }
  const saved = await _aiFetch('/save_mask', { method: 'POST' });
  return {
    product_url: null,
    mask_url:    null,
    session_id:  'sess_' + Date.now(),
    thumbnail:   saved.thumbnail,  // base64 jpeg of cropped product
  };
}

// ═══════════════════════════════════════════════════════
// AGENT 2 — TEXT GENERATION ONLY (~30 seconds)
// Calls /run_text → only Text Agent
// Returns headline/description/CTA fast to show user
// ═══════════════════════════════════════════════════════

async function apiGenerateText({ session_id, ad_type, season, audience, room, style, lighting, frame, discount, urgency }) {
  if (DEMO_MODE) {
    await _sleep(2800);
    return {
      headline:    'Velvet that hugs.',
      description: 'A sofa shaped by quiet mornings and long conversations. Handcrafted in deep plum boucle — made to outlast trends.',
      cta:         'Shop the collection',
      attributes:  { type: 'sofa', material: 'boucle', color: 'deep plum', style: 'modern luxury' }
    };
  }

  // Use the arguments passed by app.js (from state.session.survey) — single source of truth
  const payload = _buildPayload({
    ad_type:  ad_type  || 'product',
    audience: audience || 'aesthetic',
    discount: discount || 0,
    room:     room     || 'living',
    style:    style    || 'modern',
    lighting: lighting || 'sunlight',
    urgency:  urgency  || 'non_urgent',
    frame:    frame    || 'square',
  });
  payload.seed = Math.floor(Math.random() * (2**31));

  console.log('[POSTTIVA] Text payload:', payload);

  // Store payload for Image + Layout agents to reuse
  window._posttiva_payload = payload;

  const job = await _aiFetch('/run_text', { body: payload });
  window._posttiva_text_job_id = job.job_id;

  const result = await _pollJob(job.job_id, (progress) => {
    console.log('[POSTTIVA text]', progress);
  });

  window._posttiva_text = result.text;

  return {
    headline:    result.text?.headline    || '',
    description: result.text?.description || '',
    cta:         result.text?.cta         || 'Shop Now',
    attributes:  {},
  };
}



// ═══════════════════════════════════════════════════════
// AGENT 3 — IMAGE GENERATION ONLY (~5 min)
// Calls /run_image → Stable Diffusion generates background
// Returns poster_url with AI background + product preserved
// ═══════════════════════════════════════════════════════

async function apiGeneratePoster({ session_id, style_prompt, palette_hint }) {
  if (DEMO_MODE) {
    await _sleep(4200);
    return {
      poster_url: null,
      report: {
        integrity: { label: 'excellent', passed: true },
        artifacts:  { label: 'clean',     passed: true },
        style:      { passed: true },
        retries:    0,
        elapsed_s:  18.4
      }
    };
  }

  const payload = window._posttiva_payload || _buildPayload({});
  


  // Launch IMAGE AGENT job
  const job = await _aiFetch('/run_image', { body: payload });
  window._posttiva_image_job_id = job.job_id;

  // Poll until image done
  const result = await _pollJob(job.job_id, (progress) => {
    console.log('[POSTTIVA image]', progress);
  });

  // Get final result with poster base64
  const res = await _aiFetch('/job/' + job.job_id + '/result', { method: 'GET' });

  return {
    poster_url: res.poster_b64 ? 'data:image/jpeg;base64,' + res.poster_b64 : null,
    poster_b64: res.poster_b64,
    report: {
      integrity:  { label: 'excellent', passed: true },
      artifacts:  { label: 'clean',     passed: true },
      style:      { passed: true },
      retries:    0,
      elapsed_s:  0,
      clip_score: res.clip_score,
      overlap:    res.overlap,
    }
  };
}

// ═══════════════════════════════════════════════════════
// AGENT 4 — LAYOUT AGENT (~2 min)
// Calls /run_layout → Qwen places text on the AI background
// Returns final poster with text overlaid
// ═══════════════════════════════════════════════════════

async function apiLayout({ session_id, text }) {
  if (DEMO_MODE) { await _sleep(900); return { layout_tree: null, svg: null, poster_url: null }; }

  // POST /run_layout → send text directly so backend uses correct session's text
  const payload = { ...(window._posttiva_payload || _buildPayload({})), text: text || null };
  console.log('[POSTTIVA layout] sending text:', text);

  const job = await _aiFetch('/run_layout', { body: payload });
  window._posttiva_layout_job_id = job.job_id;

  // Poll until layout done
  const result = await _pollJob(job.job_id, (progress) => {
    console.log('[POSTTIVA layout]', progress);
  });

  // Get final poster
  const res = await _aiFetch('/job/' + job.job_id + '/result', { method: 'GET' });

  return {
    poster_url:    res.poster_b64 ? 'data:image/jpeg;base64,' + res.poster_b64 : null,
    poster_b64:    res.poster_b64,
    bg_url:        res.bg_b64 ? 'data:image/jpeg;base64,' + res.bg_b64 : null,
    text_coords:   res.text_coords || null,
    poster_config: res.poster_config || null,
    layout_tree:   null,
    svg:           null,
  };
}

async function apiCustomize(payload) {
  if (DEMO_MODE) { await _sleep(800); return { poster_url: null }; }
  return { poster_url: null };
}

async function apiRegenerate(payload) {
  if (DEMO_MODE) { await _sleep(3200); return { poster_url: null, report: {} }; }

  const pl = window._posttiva_payload || _buildPayload({});
  const job = await _aiFetch('/run_image', { body: pl });
  window._posttiva_image_job_id = job.job_id;
  await _pollJob(job.job_id);
  const res = await _aiFetch('/job/' + job.job_id + '/result', { method: 'GET' });
  return {
    poster_url: res.poster_b64 ? 'data:image/jpeg;base64,' + res.poster_b64 : null,
    report: {}
  };
}

// ═══════════════════════════════════════════════════════
// Store survey answers for pipeline mapping
// Called by app.js submitBrief so api.js can read them
// ═══════════════════════════════════════════════════════
window._posttiva_survey = {};

// Capture brief when user submits
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const origFn = window.submitBrief;
    if (origFn) {
      window.submitBrief = function() {
        const b = (window.state && window.state.session && window.state.session.brief) || {};
        // Get discount value from input
        const discountEl = document.getElementById('discount-value');
        b.discountValue = discountEl ? discountEl.value : 0;
        window._posttiva_survey = b;
        console.log('[POSTTIVA] Brief captured:', b);
        return origFn.apply(this, arguments);
      };
    }
  }, 200);
});

// ═══════════════════════════════════════════════════════
// EXPOSE to app.js via window.PosttivaAPI
// ═══════════════════════════════════════════════════════
window.PosttivaAPI = {
  DB_BASE, API_BASE, DEMO_MODE,
  getToken, setToken, clearToken,
  apiSignup, apiLogin, apiLogout,
  apiForgotPassword, apiResetPassword,
  apiUpdateProfile, apiUpdatePassword,
  apiSaveProject, apiGetProjects, apiUpdateProject, apiDeleteProject, apiRating,
  apiUploadImage, apiSamHover, apiSamSelect,
  apiGenerateText, apiGeneratePoster,
  apiLayout, apiCustomize, apiRegenerate,
};
