/* ═══════════════════════════════════════════════════════════
   POSTTIVA — App controller (v2 · matches real UI flow)
   Flow: landing → auth → home → upload (product + logo)
         → sam → textgen (Ad Text) → loading → result
         → customize → profile
   ═══════════════════════════════════════════════════════════ */

const API = window.PosttivaAPI;

// ─── State ─────────────────────────────────────────────
const state = {
  screen: 'landing',
  user:   null,
  session: {
    image_id:    null,
    file:        null,
    preview:     null,
    logo_file:   null,
    logo_data:   null,   // base64 data-url for rendering in poster
    sam_point:   null,
    session_id:  null,
    prompt:      '',
    text_options: [],
    text:        null,
    poster:      null,
    report:      null,
    customize: {
      headline:        'New\ncollection',
      sub:             'has now arrived',
      cta:             'Shop now',
      tag:             'Living Room · Product Ad',
      palette:         'plum',
      // per-element font & align (old global 'font'/'align' kept for compat)
      font:            'display',
      align:           'left',
      headlineFont:    'display',
      headlineAlign:   'left',
      subFont:         'display',
      subAlign:        'left',
      ctaFont:         'sans',
      ctaAlign:        'left',
      color:           '#ffffff',
      size:            44,
      subColor:        '#ffffffb3',
      subSize:         18,
      ctaColor:        '#F76C6C',
      ctaTextColor:    '#ffffff',
      ctaSize:         13,
      // Normalized CTA top-left (0–1) relative to poster box; set when user drags
      ctaNl:           null,
      ctaNt:           null,
      _ctaMoved:       false,
    },
  },
};

// ─── Router ─────────────────────────────────────────────
const screens = ['landing', 'signup', 'login', 'forgot', 'reset', 'home', 'upload', 'sam', 'brief', 'textgen', 'loading', 'result', 'customize', 'profile'];

function go(name) {
  state.screen = name;
  screens.forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.toggle('active', s === name);
  });
  window.scrollTo(0, 0);
  localStorage.setItem('posttiva_screen', name);
  const fn = onEnter[name];
  if (fn) fn();
}
window.go = go;

function showToast(msg) {
  const existing = document.getElementById('posttiva-toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'posttiva-toast';
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
    background: '#4B1D3F', color: '#fff', padding: '12px 24px', borderRadius: '50px',
    fontFamily: 'Outfit, sans-serif', fontSize: '14px', fontWeight: '500',
    boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: '9999',
    opacity: '0', transition: 'opacity .25s',
  });
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

window.goUpload = () => {
  if (!state.user) {
    showToast('Please sign in or create an account to make a poster.');
    go('login');
    return;
  }
  // Full session reset — wipe all previous poster data
  state.session = {
    image_id: null, file: null, preview: null,
    logo_file: null, logo_data: null,
    sam_point: null, session_id: null,
    prompt: '', text_options: [], text_option: null,
    text: null, poster: null, report: null,
    project_id: null, _fromHome: false,
    brief: {}, survey: {},
    _undoStack: [], _redoStack: [],
    customize: {
      headline: 'New\ncollection', sub: 'has now arrived',
      cta: 'Shop now', tag: 'Living Room · Product Ad',
      palette: 'plum', font: 'display', align: 'left',
      headlineFont: 'display', headlineAlign: 'left',
      subFont: 'display', subAlign: 'left',
      ctaFont: 'sans', ctaAlign: 'left',
      color: '#ffffff', size: 44,
      subColor: '#ffffffb3', subSize: 18,
      ctaColor: '#F76C6C', ctaTextColor: '#ffffff', ctaSize: 13,
      ctaNl: null, ctaNt: null, _ctaMoved: false,
    },
  };
  // Also clear api.js globals so old payload/survey don't bleed into new session
  window._posttiva_survey  = {};
  window._posttiva_payload = null;
  window._posttiva_text    = null;
  state.session._textGenRunning = false;
  go('upload');
};

window.navGo = (screen) => { if (screen === 'upload') { goUpload(); } else { go(screen); } };

const onEnter = {};

// ─── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const builders = [
    buildLanding, () => buildAuth('signup'), () => buildAuth('login'),
    buildForgot, buildReset, buildHome, buildUpload, buildSam,
    buildBrief, buildTextgen, buildLoading, buildResult, buildCustomize, buildProfile,
  ];
  builders.forEach(fn => { try { fn(); } catch(e) { console.error('Screen build error:', fn.name || '?', e); } });

  // Restore last screen — skip transient screens or auth-required screens when not logged in
  const TRANSIENT     = ['loading', 'sam', 'brief', 'textgen', 'result', 'customize'];
  const AUTH_REQUIRED = ['home', 'upload', 'profile'];
  const saved = localStorage.getItem('posttiva_screen');
  const validScreen = screens.includes(saved) && !TRANSIENT.includes(saved);
  const startScreen = 'landing';
  go(startScreen);
});

// ─── Shared helpers ─────────────────────────────────────
function furnitureBg(variant = '') {
  return `
    <div class="furn-bg ${variant}"></div>
    <div class="bg-blob bg-blob--rose"  style="top:-120px;right:-80px"></div>
    <div class="bg-blob bg-blob--coral" style="bottom:-100px;left:-120px"></div>
    <div class="bg-blob bg-blob--plum"  style="top:40%;left:45%"></div>
  `;
}

function navBar({ dark = false, ctx = 'guest', active = '' } = {}) {
  const cls = 'nav' + (dark ? ' nav--dark' : '');
  const right = ctx === 'user'
    ? `<div class="nav__avatar" onclick="go('profile')">${(state.user?.name || 'L')[0].toUpperCase()}</div>`
    : `<button class="btn btn--sm btn--ghost" onclick="go('login')">Sign in</button>
       <button class="btn btn--sm btn--primary" onclick="go('signup')">Get started</button>`;
  const links = ctx === 'user'
    ? [['home','Home'],['upload','New'],['profile','Profile']]
    : [['landing','Home']];
  return `
    <nav class="${cls}">
      <div class="nav__logo" onclick="go('${ctx==='user'?'home':'landing'}')">
        <img src="posttiva-logo.png" alt="Posttiva">
      </div>
      <div class="nav__center">
        ${links.map(([k,l])=>`<a class="nav__link ${active===k?'is-active':''}" onclick="navGo('${k}')">${l}</a>`).join('')}
      </div>
      <div class="nav__right">${right}</div>
    </nav>
  `;
}

// Render the editable poster canvas (shared between result + customize)
function posterCanvas(id = 'poster-main', clickable = false) {
  // AFTER — add aspect-ratio:auto to override the CSS 4/5 constraint:
if (state.session.poster && clickable) {
    return `<div class="poster-canvas" id="${id}" style="position:relative;overflow:visible;border-radius:inherit;cursor:pointer;aspect-ratio:auto;padding:0;" onclick="go('customize')">
      <img src="${state.session.poster}" style="width:100%;height:auto;display:block;border-radius:inherit;box-shadow:var(--shadow-lg);">
    </div>`;
}

  const c = state.session.customize;
  const bgs = {
    plum:   'linear-gradient(160deg,#4B1D3F 0%,#31122A 100%)',
    rose:   'linear-gradient(160deg,#A64D79 0%,#4B1D3F 100%)',
    coral:  'linear-gradient(160deg,#F76C6C 0%,#A64D79 100%)',
    ink:    'linear-gradient(160deg,#1A1A1A 0%,#31122A 100%)',
    bright: 'linear-gradient(160deg,#A64D79 0%,#F76C6C 100%)',
    warm:   'linear-gradient(160deg,#C06A93 0%,#F76C6C 100%)',
    deep:   'linear-gradient(160deg,#6B2E5A 0%,#1A1A1A 100%)',
  };
  const logo = state.session.logo_data
    ? `<img class="poster-canvas__logo" src="${state.session.logo_data}" alt="logo">`
    : '';
  const fontMap = {
    display: { family: "'Cormorant Garamond', Georgia, serif",      style: 'italic', weight: 500 },
    sans:    { family: "'Outfit', system-ui, sans-serif",            style: 'normal', weight: 700 },
    mono:    { family: "'JetBrains Mono', ui-monospace, monospace",  style: 'normal', weight: 600 },
    dmserif: { family: '"DM Serif Display", Georgia, serif',         style: 'normal', weight: 400 },
  };
  const fH = fontMap[c.headlineFont || c.font] || fontMap.display;
  const fS = fontMap[c.subFont      || c.font] || fontMap.display;
  const fC = fontMap[c.ctaFont      || 'sans'] || fontMap.sans;
  const ctaColor     = c.ctaColor     || '#F76C6C';
  const ctaTextColor = c.ctaTextColor || '#ffffff';
  const subColor     = c.subColor     || 'rgba(255,255,255,0.7)';
  const subSize      = Number(c.subSize)  || 18;
  const ctaSize      = Number(c.ctaSize)  || 13;
  const headlineAlign = c.headlineAlign || c.align || 'left';
  const subAlign      = c.subAlign      || c.align || 'left';
  const ctaPos = (c._ctaMoved && Number.isFinite(c.ctaNl) && Number.isFinite(c.ctaNt))
    ? `left:${(c.ctaNl * 100)}%;top:${(c.ctaNt * 100)}%;transform:translate(0,0);`
    : `left:${Number(c.ctaX) || 0}px;top:${Number(c.ctaY) || 0}px;`;
  return `
    <div class="poster-canvas" id="${id}"
         style="background:${bgs[c.palette] || bgs.plum};display:flex;flex-direction:column;position:relative;
                ${clickable?'cursor:pointer':''}"
         ${clickable?`onclick="go('customize')"`:''}>
      ${logo}
      <div class="poster-canvas__tag" id="${id}-tag">${escape(c.tag)}</div>
      <div class="poster-canvas__product">🛋️</div>
      <div class="poster-canvas__title"
           id="${id}-title"
           style="font-family:${fH.family};font-style:${fH.style};font-weight:${fH.weight};font-size:${Number(c.size)}px;color:${c.color};text-align:${headlineAlign}">${escape(c.headline).replace(/\n/g,'<br>')}</div>
      <div class="poster-canvas__sub" id="${id}-sub"
           style="font-family:${fS.family};font-style:${fS.style};font-size:${subSize}px;color:${subColor};text-align:${subAlign}">${escape(c.sub)}</div>
      <div class="poster-canvas__cta" id="${id}-cta"
           style="position:absolute;${ctaPos}background:${ctaColor};color:${ctaTextColor};border-color:${ctaColor};font-size:${ctaSize}px;font-family:${fC.family};width:fit-content;flex-shrink:0;cursor:grab;user-select:none">${escape(c.cta)}</div>
    </div>
  `;
}
function escape(s) { return String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

// ═══════════════════════════════════════════════════════
// LANDING
// ═══════════════════════════════════════════════════════
function buildLanding() {
  const root = document.getElementById('screen-landing');
  root.innerHTML = `
    ${navBar({ ctx: 'guest' })}
    <section class="landing">
      ${furnitureBg()}
      <div class="landing__hero">
        <div class="landing__left">
          <span class="eyebrow">Live · Multi-agent AI studio for furniture</span>
          <h1 class="display display--xl">Your product,<br><em class="italic">their</em> obsession.</h1>
          <p class="landing__tagline"><em>Snap. Generate. Sell.</em> — your furniture, dressed for the spotlight in under 30 seconds.</p>
          <p>Posttiva is a coordinated system of three AI agents that turn a plain furniture photo into a market-ready poster — your product stays <em>exactly</em> as it is, and everything around it is designed for you.</p>
          <div class="landing__ctas">
            <button class="btn btn--primary btn--lg" onclick="go('signup')">Get started — it's free →</button>
            <button class="btn btn--ghost btn--lg" onclick="go('login')">Sign in</button>
          </div>
          <div class="landing__stats">
            <div><div class="landing__stat__num">3</div><div class="landing__stat__label">AI agents</div></div>
            <div><div class="landing__stat__num">~3<span style="font-size:18px">m</span></div><div class="landing__stat__label">Per poster</div></div>
            <div><div class="landing__stat__num">100<span style="font-size:22px">%</span></div><div class="landing__stat__label">Product preserved</div></div>
          </div>
        </div>
        <div class="landing__visual">
          ${heroPoster(1, 'sofa', 'Velvet·', 'F/W 26')}
          ${heroPoster(2, 'chair', 'Boucle.', 'New drop')}
          ${heroPoster(3, 'lamp',  'Warm.',  '·studio')}
        </div>
      </div>

      <section class="landing__features">
        <div class="landing__features__inner">
          <div>
            <span class="eyebrow" style="color:var(--coral)">Under the hood</span>
            <h2 class="display display--lg">Three agents,<br><em class="italic">one</em> studio.</h2>
            <p class="landing__features__intro">Each agent has a single job. Together they produce posters that preserve your product, read like good copy, and land like real design.</p>
          </div>
          <div class="landing__feat-grid">
            <div class="feat-card">
              <div class="feat-card__num">01</div>
              <h3>Image Agent</h3>
              <p>SAM-HQ segments your product with pixel precision. Stable Diffusion inpaints a coherent background. QA checks integrity, artifacts, style.</p>
            </div>
            <div class="feat-card">
              <div class="feat-card__num">02</div>
              <h3>Text Agent</h3>
              <p>Reads your product with vision AI — type, material, color, style — then writes a headline, description, and CTA in the tone you choose.</p>
            </div>
            <div class="feat-card">
              <div class="feat-card__num">03</div>
              <h3>Layout Agent</h3>
              <p>Assembles the final poster with a PosterO-style layout tree — balancing type, product, and negative space for different platforms.</p>
            </div>
            <div class="feat-card" style="background:var(--coral);border-color:var(--coral)">
              <div class="feat-card__num" style="color:#fff">✦</div>
              <h3>Product preservation</h3>
              <p style="color:rgba(255,255,255,0.85)">The core promise: the system builds around your real product — never replaces or warps it.</p>
            </div>
          </div>
        </div>
      </section>

      <footer class="landing__foot">
        <span>Riyadh</span><span class="star">✦</span>
        <span>CCIS · PNU</span><span class="star">✦</span>
        <span>GP · 2026</span><span class="star">✦</span>
        <span>Posttiva</span>
      </footer>
    </section>
  `;
}
function heroPoster(n, type, title, sub) {
  const icons = { sofa: '🛋️', chair: '🪑', lamp: '💡' };
  return `
    <div class="hero-poster hero-poster--${n}">
      <div class="hero-poster__inner">
        <div class="hero-poster__tag">Poster · 0${n}</div>
        <div class="hero-poster__product">${icons[type]}</div>
        <div class="hero-poster__title">${title}</div>
        <div class="hero-poster__sub">${sub}</div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════
// AUTH (signup + login)
// ═══════════════════════════════════════════════════════
function buildAuth(kind) {
  const root = document.getElementById('screen-' + kind);
  const isSignup = kind === 'signup';
  root.innerHTML = `
    <div class="auth">
      <div class="auth__brand">
        <div class="auth__brand__top">
          <img class="auth__brand__logo" src="posttiva-logo.png" alt="Posttiva">
          <h2>${isSignup ? 'Design posters<br>in <em>minutes,</em><br>not hours.' : 'Welcome<br><em>back.</em>'}</h2>
          <p>${isSignup ? 'Join designers, small business owners, and furniture brands using Posttiva\'s 3-agent system to ship on-brand posters every day.' : 'Pick up where you left off. Your session, drafts, and approved posters are waiting.'}</p>
        </div>
        <div class="auth__testimonial">
          <div class="auth__testimonial__quote">"The product came out exactly as shot. The background looked like a real photoshoot."</div>
        </div>
      </div>
      <div class="auth__form-wrap">
        <form class="auth__form" id="form-${kind}">
          <h3>${isSignup ? 'Create your account' : 'Sign in'}</h3>
          <p class="auth__form__sub">${isSignup ? 'Free to start · no card required' : 'Enter your credentials to continue'}</p>

          ${isSignup ? `
            <div class="field">
              <label class="field__label">Full name</label>
              <input class="field__input" name="name" type="text" placeholder="Enter your name" required autocomplete="name">
            </div>` : ''}
          <div class="field">
            <label class="field__label">Email</label>
            <input class="field__input" name="email" type="email" placeholder="example@email.com" required autocomplete="email">
          </div>
          <div class="field">
            <label class="field__label">Password</label>
            <input class="field__input" name="password" type="password" placeholder="${isSignup ? 'At least 8 characters' : 'Password'}" minlength="8" required autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          </div>
          ${!isSignup ? `<div style="text-align:right;margin-top:-8px;margin-bottom:18px"><a style="font-size:12px;color:var(--rose);font-weight:600;cursor:pointer" onclick="go('forgot')">Forgot password?</a></div>` : ''}

          <button class="btn btn--primary btn--full btn--lg" type="submit">
            ${isSignup ? 'Create account' : 'Sign in'} →
          </button>

          <div class="auth__form__alt">
            ${isSignup
              ? `Already have an account? <a onclick="go('login')">Sign in</a>`
              : `New here? <a onclick="go('signup')">Create account</a>`}
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('form-' + kind).addEventListener('submit', async (e) => {
    e.preventDefault();

    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);

    if (data.password.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }

    try {
      const res = isSignup ? await API.apiSignup(data) : await API.apiLogin(data);
      state.user = res.user;
      go('home');
    } catch (err) {
      alert('Auth failed: ' + err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════════
function buildForgot() {
  const root = document.getElementById('screen-forgot');
  root.innerHTML = `
    <div class="auth">
      <div class="auth__brand">
        <div class="auth__brand__top">
          <img class="auth__brand__logo" src="posttiva-logo.png" alt="Posttiva">
          <h2>Reset your<br><em>password.</em></h2>
          <p>Enter the email address for your account and we'll send you a verification code.</p>
        </div>
      </div>
      <div class="auth__form-wrap">
        <form class="auth__form" id="form-forgot">
          <h3>Forgot password</h3>
          <p class="auth__form__sub">We'll email you a code to reset it</p>
          <div class="field">
            <label class="field__label">Email</label>
            <input class="field__input" id="forgot-email" type="email" placeholder="example@email.com" required autocomplete="email">
          </div>
          <button class="btn btn--primary btn--full btn--lg" type="submit">Send code →</button>
          <div class="auth__form__alt">
            <a onclick="go('login')">← Back to sign in</a>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    try {
      await API.apiForgotPassword({ email });
      state._resetEmail = email;
      go('reset');
    } catch (err) {
      alert('Could not send code: ' + err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════
// RESET PASSWORD
// ═══════════════════════════════════════════════════════
function buildReset() {
  const root = document.getElementById('screen-reset');
  root.innerHTML = `
    <div class="auth">
      <div class="auth__brand">
        <div class="auth__brand__top">
          <img class="auth__brand__logo" src="posttiva-logo.png" alt="Posttiva">
          <h2>Enter your<br><em>new password.</em></h2>
          <p>Check your inbox for the verification code we sent you.</p>
        </div>
      </div>
      <div class="auth__form-wrap">
        <form class="auth__form" id="form-reset">
          <h3>Create new password</h3>
          <p class="auth__form__sub">Enter the code from your email</p>
          <div class="field">
            <label class="field__label">Verification code</label>
            <input class="field__input" id="reset-code" type="text" placeholder="6-digit code" required autocomplete="one-time-code">
          </div>
          <div class="field">
            <label class="field__label">New password</label>
            <input class="field__input" id="reset-password" type="password" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">
          </div>
          <button class="btn btn--primary btn--full btn--lg" type="submit">Reset password →</button>
          <div class="auth__form__alt">
            <a onclick="go('forgot')">← Resend code</a>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code        = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-password').value;
    if (newPassword.length < 8) { alert('Password must be at least 8 characters.'); return; }
    try {
      await API.apiResetPassword({ email: state._resetEmail, code, newPassword });
      state._resetEmail = null;
      alert('✓ Password reset! Please sign in.');
      go('login');
    } catch (err) {
      alert('Reset failed: ' + err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════
function buildHome() {
  const root = document.getElementById('screen-home');
  root.innerHTML = `
    ${navBar({ ctx: 'user', active: 'home' })}
    <section class="home">
      ${furnitureBg('furn-bg--subtle')}
      <div class="home__inner">
        <div class="home__head">
          <div class="home__greet">
            <span class="eyebrow">My Projects</span>
            <h1>Welcome, <em id="home-name"></em></h1>
          </div>
          <div class="home__stats">
            <div class="home__stat">
              <div class="home__stat__label">Saved drafts</div>
              <div class="home__stat__val"><span id="draft-count">0</span></div>
            </div>
          </div>
        </div>

        <div class="home__cta">
          <div class="home__cta__left">
            <span class="eyebrow eyebrow--coral">◆ Start here</span>
            <h2 style="margin-top:10px">A poster<br>in <em>four</em> steps.</h2>
            <p>Upload your product · optionally add your brand logo · pick a headline the AI writes for you · download.</p>
            <button class="btn btn--primary btn--lg" onclick="goUpload()">New poster →</button>
          </div>
          <div class="home__cta__visual">
            <div class="mini-poster mini-poster--a"><div class="mini-poster__tag">№ 01</div><div class="mini-poster__t">velvet.</div></div>
            <div class="mini-poster mini-poster--b"><div class="mini-poster__tag">№ 02</div><div class="mini-poster__t">warm.</div></div>
            <div class="mini-poster mini-poster--c"><div class="mini-poster__tag">№ 03</div><div class="mini-poster__t">bloom.</div></div>
          </div>
        </div>

        <div class="home__section-head">
          <h3>Recent <em>work.</em></h3>
        </div>

        <div class="home__grid" id="home-grid"></div>
      </div>
    </section>
  `;

  // event delegation — handles all card buttons (Open / Download / Delete / New)
  document.getElementById('home-grid').addEventListener('click', (e) => {
    // Match only buttons with data-action — avoids landing on project-new div or card wrappers
    const btn = e.target.closest('button[data-action]') || e.target.closest('.project-new[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id;            // keep as string — works for numeric AND mongo-style ids
    if (action === 'new')           { goUpload(); return; }
    if (!id || id === 'undefined')  return;   // safety guard — skip if no valid id
    if (action === 'open')          window.openProject(id);
    if (action === 'download')      window.downloadProject(id);
    if (action === 'delete')        window.deleteProject(id);
  });
}
const PAL_BG = {
  plum:   'linear-gradient(160deg,#4B1D3F,#31122A)',
  rose:   'linear-gradient(160deg,#A64D79,#4B1D3F)',
  coral:  'linear-gradient(160deg,#F76C6C,#A64D79)',
  bright: 'linear-gradient(160deg,#A64D79,#F76C6C)',
  warm:   'linear-gradient(160deg,#C06A93,#F76C6C)',
  ink:    'linear-gradient(160deg,#1A1A1A,#31122A)',
  deep:   'linear-gradient(160deg,#6B2E5A,#1A1A1A)',
};
function timeAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (d < 1) return 'Today';
  if (d < 7) return d + 'd';
  return Math.floor(d / 7) + 'w';
}
function renderProjectGrid(projects) {
  const grid = document.getElementById('home-grid');
  if (!grid) return;
  const fontFamilies = {
    display: "'Cormorant Garamond', Georgia, serif",
    sans:    "'Outfit', system-ui, sans-serif",
    mono:    "'JetBrains Mono', ui-monospace, monospace",
    dmserif: '"DM Serif Display", Georgia, serif',
  };
  const cards = projects.map(p => {
    // Normalise the project id — backends may return 'id', 'project_id', or '_id'
    const pid = p.id || p.project_id || p._id || '';
    let c = p.poster_config;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch(e) { c = {}; } }
    c = c || {};
    const bg       = PAL_BG[c.palette] || PAL_BG[p.bg_color] || PAL_BG.plum;
    const ff       = fontFamilies[c.font] || fontFamilies.display;
    const headline = escape(c.headline || p.label || p.title || 'Untitled').replace(/\n/g,'<br>');
    const sub      = escape(c.sub || p.sub || '');
    const cta      = escape(c.cta || 'Shop now');
    const ctaColor = c.ctaColor || '#F76C6C';
    const color    = c.color    || '#ffffff';
    const tag      = escape(c.tag || '');
    const sz       = Math.min(c.size || 44, 22); // scale headline size down for preview
    const posterImg = p.poster_img || null;
    return `
      <div style="border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(75,29,63,0.13);background:#fff;display:flex;flex-direction:column">
        <div style="aspect-ratio:3/4;background:${bg};display:flex;flex-direction:column;padding:${posterImg?'0':'14px 12px 12px'};overflow:hidden">
          ${posterImg
            ? `<img src="${posterImg}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="poster">`
            : `<div style="font-family:'JetBrains Mono',monospace;font-size:7px;color:rgba(255,255,255,0.5);letter-spacing:.12em;text-transform:uppercase;flex-shrink:0">${tag}</div>
          <div style="margin-top:auto">
            <div style="font-family:${ff};font-style:italic;font-size:${sz}px;color:${color};line-height:1.15;margin-bottom:4px">${headline}</div>
            <div style="font-family:Outfit,sans-serif;font-size:9px;color:rgba(255,255,255,0.7);margin-bottom:10px">${sub}</div>
            <div style="display:inline-block;background:${ctaColor};color:#fff;font-family:Outfit,sans-serif;font-size:8px;font-weight:700;padding:4px 10px;border-radius:50px;letter-spacing:.04em">${cta}</div>
          </div>`}
        </div>
        <div style="display:flex;border-top:1px solid #f0dde8">
          <button data-action="open"     data-id="${pid}"
                  style="flex:1;padding:11px 0;background:#4B1D3F;color:#fff;border:none;font-family:Outfit,sans-serif;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.04em">
            Open
          </button>
          <button data-action="download" data-id="${pid}"
                  style="flex:1;padding:11px 0;background:#31122A;color:#fff;border:none;border-left:1px solid rgba(255,255,255,0.12);font-family:Outfit,sans-serif;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.04em">
            Download
          </button>
          <button data-action="delete"   data-id="${pid}"
                  style="flex:1;padding:11px 0;background:#7B1D3A;color:#fff;border:none;border-left:1px solid rgba(255,255,255,0.12);font-family:Outfit,sans-serif;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.04em">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join('');
  grid.innerHTML = `
    <div class="project-new" data-action="new">
      <div class="project-new__plus">+</div>
      <div class="project-new__label">New poster</div>
    </div>
    ${cards}
  `;
  const el = document.getElementById('draft-count');
  if (el) el.textContent = projects.length;
}
window.openProject = (id) => {
  const p = (state._projects || []).find(x => String(x.id || x.project_id || x._id) === String(id));
  if (!p) { showToast('Project not found — try refreshing the page.'); return; }
  let config = p.poster_config;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch(e) { config = {}; } }
  // replace (not merge) so each project opens with its own clean settings
  const defaults = { headline:'New\ncollection', sub:'has now arrived', cta:'Shop now',
    tag:'Living Room · Product Ad', palette:'plum', font:'display',
    align:'left', color:'#ffffff', size:44,
    subColor:'#ffffffb3', subSize:18,
    ctaColor:'#F76C6C', ctaTextColor:'#ffffff', ctaSize:13 };
  state.session.customize  = { ...defaults, ...(config || {}) };
  state.session.session_id = p.session_id || null;
  state.session.project_id = p.id || p.project_id || p._id;
  state.session._fromHome  = true;
  if (p.poster_img) state.session.poster = p.poster_img;
  // Avoid showing another session's background in Customize (bg not persisted on project yet)
  state.session.bgPoster = null;
  state.session.textCoords = null;
  go('result');
};
window.deleteProject = async (id) => {
  if (!confirm('Delete this project?')) return;
  try {
    await API.apiDeleteProject(id);
    state._projects = (state._projects || []).filter(p => String(p.id || p.project_id || p._id) !== String(id));
    renderProjectGrid(state._projects);
    showToast('Project deleted.');
  } catch (e) { showToast('Delete failed: ' + e.message); }
};

window.downloadProject = async (id) => {
  const p = (state._projects || []).find(x => String(x.id || x.project_id || x._id) === String(id));
  if (!p) { showToast('Project not found.'); return; }
  let config = p.poster_config;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch(e) { config = {}; } }
  const titleRaw = (config && config.headline) || p.title || 'poster';
  const safeName = String(titleRaw).replace(/\n/g, '-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'poster';

  if (p.poster_img && String(p.poster_img).startsWith('data:')) {
    showToast('Preparing download…');
    const a = document.createElement('a');
    a.href = p.poster_img;
    a.download = safeName + '.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Poster downloaded!');
    return;
  }

  const merged = { ...(state.session.customize || {}), ...(config || {}) };
  showToast('Preparing download…');
  try {
    const cv = await posterToCanvas(merged);
    triggerCanvasDownload(cv, titleRaw);
    showToast('Poster downloaded!');
  } catch (err) {
    showToast('Download failed — try again.');
    console.error('downloadProject error:', err);
  }
};
onEnter.home = async () => {
  // update greeting and nav avatar with current user info
  const nameEl   = document.getElementById('home-name');
  const avatarEl = document.querySelector('#screen-home .nav__avatar');
  if (state.user) {
    if (nameEl)   nameEl.textContent   = state.user.name + '.';
    if (avatarEl) avatarEl.textContent = state.user.name[0].toUpperCase();
  }

  if (!state.user) { renderProjectGrid([]); return; }
  try {
    const projects = await API.apiGetProjects();
    state._projects = Array.isArray(projects) ? projects : (projects.projects || []);
    renderProjectGrid(state._projects);
  } catch (e) {
    renderProjectGrid([]);
    showToast('Could not load projects — check that the server is running.');
  }
};

// ═══════════════════════════════════════════════════════
// UPLOAD (product + optional logo)
// ═══════════════════════════════════════════════════════
function buildUpload() {
  const root = document.getElementById('screen-upload');
  root.innerHTML = `
    ${navBar({ ctx: 'user', active: 'upload' })}
    <section class="upload">
      ${furnitureBg()}
      <div class="upload__inner">
        <div class="upload__head">
          <span class="eyebrow">Step 01 · Upload</span>
          <h1>Generate your <em>poster.</em></h1>
          <p>Upload a product image and (optionally) your brand logo — let AI do the rest.</p>
        </div>

        <div class="upload-card">
          <!-- Step 1: product image -->
          <div class="upload-step">
            <div class="upload-step__label">
              <span>Step 1 · <span class="req">*</span> Upload your furniture image</span>
            </div>
            <div class="drop-zone" id="dz-product" onclick="document.getElementById('product-input').click()">
              <input type="file" id="product-input" accept="image/*" style="display:none">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <p id="product-label">Drag & drop your furniture image here, or <span class="browse-link">browse</span></p>
              <img id="product-preview" class="drop-preview" alt="" style="display:none">
            </div>
          </div>

          <!-- Step 2: logo (optional) -->
          <div class="upload-step">
            <div class="upload-step__label">
              <span>Step 2 · Upload your logo</span>
              <span class="opt">(optional — it will appear on the poster)</span>
            </div>
            <div class="drop-zone" id="dz-logo" onclick="document.getElementById('logo-input').click()">
              <input type="file" id="logo-input" accept="image/*" style="display:none">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <p id="logo-label">Drop your logo here (PNG with transparent background works best)</p>
              <img id="logo-preview" class="drop-preview drop-preview--logo" alt="" style="display:none">
            </div>
          </div>

          <div style="text-align:center;margin-top:24px">
            <button class="btn btn--primary btn--lg" id="btn-generate" onclick="continueFromUpload()">
              ✦ Continue →
            </button>
            <p id="upload-err" style="color:var(--danger);font-size:13px;margin-top:10px;display:none">Please upload a furniture image first.</p>
          </div>
        </div>

        <div class="upload__steps">
          <div class="step-pill is-active"><div class="step-pill__num">1</div>Upload</div>
          <div class="step-pill"><div class="step-pill__num">2</div>Select product</div>
          <div class="step-pill"><div class="step-pill__num">3</div>Pick copy</div>
          <div class="step-pill"><div class="step-pill__num">4</div>Get poster</div>
        </div>
      </div>
    </section>
  `;

  // wire both dropzones
  wireDropzone('dz-product',  'product-input', 'product-preview', 'product-label', (file, dataUrl) => {
    state.session.file    = file;
    state.session.preview = dataUrl;
  });
  wireDropzone('dz-logo', 'logo-input', 'logo-preview', 'logo-label', (file, dataUrl) => {
    state.session.logo_file = file;
    state.session.logo_data = dataUrl;
  });
}

function wireDropzone(zoneId, inputId, previewId, labelId, onFile) {
  const dz = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const label = document.getElementById(labelId);

  const handle = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.src = e.target.result;
      preview.style.display = 'block';
      label.style.display = 'none';
      dz.classList.add('has-file');
      onFile(file, e.target.result);
    };
    reader.readAsDataURL(file);
  };

  input.addEventListener('change', e => handle(e.target.files[0]));
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handle(f); });
}

window.continueFromUpload = async () => {
  if (!state.session.file) {
    document.getElementById('upload-err').style.display = 'block';
    return;
  }
  try {
    // Clear previous session data when starting new poster
    state.session.poster = null;
    state.session.thumbnail = null;
    state.session.text_option = null;
    state.session.report = null;
    const res = await API.apiUploadImage(state.session.file);
    state.session.image_id    = res.image_id;
    state.session.preview     = res.preview_url || state.session.preview;
    go('sam');
  } catch (e) { alert('Upload failed: ' + e.message); }
};

// ═══════════════════════════════════════════════════════
// SAM
// ═══════════════════════════════════════════════════════
function buildSam() {
  const root = document.getElementById('screen-sam');
  root.innerHTML = `
    ${navBar({ dark: true, ctx: 'user' })}
    <section class="sam">
      <div class="sam__inner">
        <div class="sam__head">
          <h2>Step 02 · Click your <em>product.</em></h2>
          <div class="sam__head__tools">
            <button class="tool-btn is-active">Click</button>
            <button class="tool-btn" onclick="go('upload')">↶ Re-upload</button>
          </div>
        </div>

        <div class="sam__canvas" id="sam-canvas" style="position:relative;cursor:crosshair;overflow:hidden">
          <img class="sam__canvas__image" id="sam-image" alt="" style="display:block;width:100%;height:100%;object-fit:contain">
          <canvas id="sam-overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;display:none"></canvas>
          <div id="sam-cursor" style="position:absolute;width:14px;height:14px;border-radius:50%;background:rgba(255,220,0,0.9);border:2px solid white;pointer-events:none;transform:translate(-50%,-50%);display:none;z-index:10"></div>
          <div class="sam__canvas__hint" id="sam-hint">Hover to preview · click to confirm</div>
        </div>

        <div class="sam__foot">
          <div class="sam__foot__info">
            <strong style="color:#fff">SAM-HQ ViT-L</strong> — segments your product with pixel precision so the background never touches it
          </div>
          <div class="sam__foot__actions">
            <button class="btn btn--light" onclick="go('upload')">Back</button>
            <button class="btn btn--primary" id="sam-confirm" disabled style="opacity:0.5">Confirm selection →</button>
          </div>
        </div>
      </div>
    </section>
  `;

  const _sam = { lastPx: -1, lastPy: -1, busy: false };

  function _drawOverlay(b64) {
    const overlayCanvas = document.getElementById('sam-overlay');
    const img = document.getElementById('sam-image');
    if (!overlayCanvas || !img) return;
    overlayCanvas.width  = img.naturalWidth  || img.clientWidth;
    overlayCanvas.height = img.naturalHeight || img.clientHeight;
    overlayCanvas.style.display = 'block';
    const ctx = overlayCanvas.getContext('2d');
    const oi = new Image();
    oi.onload = () => {
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      ctx.drawImage(oi, 0, 0, overlayCanvas.width, overlayCanvas.height);
    };
    oi.src = 'data:image/jpeg;base64,' + b64;
  }

  function _getPixelCoords(e) {
    const img = document.getElementById('sam-image');
    const rect = img.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const scaleX = img.naturalWidth  / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return { px: Math.round(dx * scaleX), py: Math.round(dy * scaleY), dx, dy };
  }

  const canvas  = document.getElementById('sam-canvas');
  const cursor  = document.getElementById('sam-cursor');
  const confirm = document.getElementById('sam-confirm');

  let _hoverTimer = null;

  canvas.addEventListener('mousemove', (e) => {
    const img     = document.getElementById('sam-image');
    const imgRect = img.getBoundingClientRect();
    const canRect = canvas.getBoundingClientRect();
    const dx = e.clientX - canRect.left;
    const dy = e.clientY - canRect.top;

    // Show yellow dot cursor
    cursor.style.left    = dx + 'px';
    cursor.style.top     = dy + 'px';
    cursor.style.display = 'block';

    // Only call API if over the image
    if (e.clientX < imgRect.left || e.clientX > imgRect.right ||
        e.clientY < imgRect.top  || e.clientY > imgRect.bottom) return;

    const { px, py } = _getPixelCoords(e);
    if (_sam.busy || (px === _sam.lastPx && py === _sam.lastPy)) return;

    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(async () => {
      if (_sam.busy) return;
      _sam.busy = true;
      _sam.lastPx = px; _sam.lastPy = py;
      try {
        const res = await API.apiSamHover(state.session.image_id, px, py);
        if (res && res.overlay_b64) {
          _drawOverlay(res.overlay_b64);
          const hint = document.getElementById('sam-hint');
          if (hint) hint.textContent = `x=${px}, y=${py} · Score: ${(res.score||0).toFixed(2)} · Area: ${(res.area||0).toFixed(1)}% · click to confirm`;
        }
      } catch (err) { /* silent */ }
      _sam.busy = false;
    }, 120);
  });

  canvas.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
    clearTimeout(_hoverTimer);
    _sam.busy = false;
  });

  canvas.addEventListener('click', async (e) => {
    const img     = document.getElementById('sam-image');
    const imgRect = img.getBoundingClientRect();
    if (e.clientX < imgRect.left || e.clientX > imgRect.right ||
        e.clientY < imgRect.top  || e.clientY > imgRect.bottom) return;

    const { px, py } = _getPixelCoords(e);
    const nx = (e.clientX - imgRect.left) / imgRect.width;
    const ny = (e.clientY - imgRect.top)  / imgRect.height;
    state.session.sam_point = { x: nx, y: ny, px, py };

    try {
      const res = await API.apiSamSelect(state.session.image_id, nx, ny);
      state.session.session_id = res.session_id;
      if (res.thumbnail) state.session.thumbnail = res.thumbnail;
      confirm.disabled = false;
      confirm.style.opacity = '1';
      const hint = document.getElementById('sam-hint');
      if (hint) hint.textContent = '✅ Product selected — click Confirm to continue';
    } catch (err) { /* silent */ }
  });

  confirm.onclick = async () => {
    const p = state.session.sam_point || { x: 0.5, y: 0.5 };
    try {
      const res = await API.apiSamSelect(state.session.image_id, p.x, p.y);
      state.session.session_id = res.session_id;
      if (res.thumbnail) state.session.thumbnail = res.thumbnail;
    } catch (err) { /* silent */ }
    go('brief');
  };
}
onEnter.sam = () => {
  const img = document.getElementById('sam-image');
  if (state.session.preview) img.src = state.session.preview;
};

// ═══════════════════════════════════════════════════════
// BRIEF — 6 quick questions before text generation
// ═══════════════════════════════════════════════════════
const BRIEF_QUESTIONS = [
  {
    id: 'frame', label: 'What frame size would you prefer for your poster?',
    options: [
      { v: 'square',   label: 'Square',    sub: '1:1' },
      { v: 'vertical', label: 'Vertical',  sub: '4:5' },
      { v: 'portrait', label: 'Portrait',  sub: '9:16' },
    ],
  },
  {
    id: 'ad_type', label: 'What type of advertisement are you creating today?',
    options: [
      { v: 'product',  label: 'Product Ad' },
      { v: 'sale',     label: 'Offers / Sale' },
      { v: 'eid',      label: 'Eid Campaign' },
      { v: 'national', label: 'National Day' },
    ],
  },
  {
    id: 'product_appeal',
    label: 'What best describes your product appeal?',
    conditional: { qid: 'ad_type', v: 'product' },
    options: [
      { v: 'aesthetic', label: 'Aesthetic', sub: 'beauty, elegance' },
      { v: 'comfort',   label: 'Comfort',   sub: 'coziness, relaxation' },
      { v: 'practical', label: 'Practical', sub: 'quality, durability' },
    ],
  },
  {
    id: 'sale_urgency',
    label: 'Is your offer time-sensitive?',
    conditional: { qid: 'ad_type', v: 'sale' },
    options: [
      { v: 'non_urgent', label: 'Non-urgent' },
      { v: 'urgent',     label: 'Urgent',    sub: 'limited time' },
    ],
  },
  {
    id: 'room', label: 'Which room setting fits your product best?',
    options: [
      { v: 'living',  label: 'Living Room' },
      { v: 'bedroom', label: 'Bedroom' },
    ],
  },
  {
    id: 'style', label: 'What styling fits your brand?',
    options: [
      { v: 'classic', label: 'Classic' },
      { v: 'modern',  label: 'Modern' },
      { v: 'boho',    label: 'Boho' },
    ],
  },
  {
    id: 'lighting', label: 'What kind of lighting do you prefer for the scene?',
    options: [
      { v: 'sunlight', label: 'Sunlight' },
      { v: 'indoor',   label: 'Indoor Light' },
    ],
  },
  {
    id: 'discount',
    label: 'Last question — would you like to add a discount badge?',
    options: [
      { v: 'yes', label: 'Yes' },
      { v: 'no',  label: 'No' },
    ],
  },
];

window.toggleDiscount = (show) => {
  const el = document.getElementById('discount-input');
  if (el) el.style.display = show ? 'block' : 'none';
};

function buildBrief() {
  const root = document.getElementById('screen-brief');
  root.innerHTML = `
    ${navBar({ ctx: 'user' })}
    <section class="brief">
      ${furnitureBg('furn-bg--subtle')}
      <div class="brief__inner">
        <div class="brief__head">
          <span class="eyebrow">Step 03 · Brief</span>
          <h1>A few quick <em>questions.</em></h1>
          <p>The more we know, the sharper your poster turns out. Takes ~30 seconds.</p>
        </div>

        <div class="brief__progress">
          <div class="brief__progress__track"><div class="brief__progress__fill" id="brief-fill" style="width:0%"></div></div>
          <span id="brief-count">0 / ${BRIEF_QUESTIONS.length}</span>
        </div>

        <div class="brief__questions" id="brief-questions"></div>

        <div class="brief__actions">
          <button class="btn btn--ghost" onclick="go('sam')">← Back</button>
          <button class="btn btn--primary" id="brief-go" onclick="submitBrief()" disabled style="opacity:.5">Generate →</button>
        </div>
      </div>
    </section>
  `;
}

onEnter.brief = () => {
  state.session.brief = {};
  const wrap = document.getElementById('brief-questions');

  let mainNum = 0;
  wrap.innerHTML = BRIEF_QUESTIONS.map(q => {
    if (!q.conditional) mainNum++;
    const numLabel = q.conditional ? '↳' : String(mainNum).padStart(2, '0');

    const inner = `
      <div class="brief-q" data-qid="${q.id}">
        <div class="brief-q__label">
          <span class="brief-q__num">${numLabel}</span>
          ${q.label}
        </div>
        <div class="brief-q__options">
          ${q.options.map((o, oi) => `
            <button
              class="brief-opt"
              onclick="
                pickBrief('${q.id}','${o.v}', this);
                if('${q.id}' === 'discount'){ window.toggleDiscount('${o.v}' === 'yes'); }
              "
            >
              <span class="brief-opt__label">${oi + 1}) ${o.label}</span>
              ${o.sub ? `<span class="brief-opt__sub">${o.sub}</span>` : ''}
            </button>
          `).join('')}
        </div>
        ${q.id === 'discount' ? `
          <div id="discount-input" style="display:none;margin-top:10px;">
            <input type="number" id="discount-value" placeholder="Enter discount" min="1" max="100" style="width:120px;">
            <span>%</span>
          </div>
        ` : ''}
      </div>`;

    return q.conditional
      ? `<div id="brief-cond-${q.id}" style="display:none">${inner}</div>`
      : inner;
  }).join('');

  updateBriefProgress();
};

window.pickBrief = (qid, v, btn) => {
  state.session.brief[qid] = v;
  const group = btn.closest('.brief-q');
  group.querySelectorAll('.brief-opt').forEach(b => b.classList.remove('is-selected'));
  btn.classList.add('is-selected');

  if (qid === 'ad_type') {
    BRIEF_QUESTIONS.filter(q => q.conditional && q.conditional.qid === 'ad_type').forEach(q => {
      const el = document.getElementById('brief-cond-' + q.id);
      const show = q.conditional.v === v;
      if (el) el.style.display = show ? 'block' : 'none';
      if (!show) delete state.session.brief[q.id];
    });
  }

  updateBriefProgress();
};

function updateBriefProgress() {
  const adType = state.session.brief.ad_type;
  const active = BRIEF_QUESTIONS.filter(q =>
    !q.conditional || q.conditional.v === adType
  );
  const total = active.length;
  const done  = active.filter(q => state.session.brief[q.id] !== undefined).length;
  document.getElementById('brief-fill').style.width = `${(done / total) * 100}%`;
  document.getElementById('brief-count').textContent = `${done} / ${total}`;
  const btn = document.getElementById('brief-go');
  const ready = done === total;
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '.5';
}

window.skipBrief = () => {
  // sensible defaults so generation still works
  state.session.brief = {
    frame: 'square', ad_type: 'product', room: 'living',
    style: 'modern', lighting: 'indoor', discount: 'no',
  };
  submitBrief();
};

window.submitBrief = () => {
  const b = state.session.brief || {};
  // Map brief into the survey shape that generateTextCopy already reads
  // Store survey for api.js to read
  window._posttiva_survey = Object.assign({}, state.session.brief || {});
  state.session.survey = {
    ad_type:       b.ad_type || 'product',
    season:        b.ad_type === 'eid' ? 'eid' : b.ad_type === 'national' ? 'national-day' : 'anytime',
    audience:      b.product_appeal || '',
    product_focus: b.product_appeal || 'aesthetic',
    room:          b.room,
    style:         b.style,
    lighting:      b.lighting,
    frame:         b.frame,
    discount:      b.discount === 'yes',
    discountValue: b.discount === 'yes' ? document.getElementById('discount-value')?.value : 0,
    urgency:       b.sale_urgency || 'non_urgent',
  };
  // Update the customize defaults so the Result screen reflects user's brief
  const labelMap = { living: 'Living Room', bedroom: 'Bedroom' };
  const adMap    = { product: 'Product Ad', sale: 'Offers / Sale', eid: 'Eid Campaign', national: 'National Day' };
  state.session.customize.tag = `${labelMap[b.room] || 'Living Room'} · ${adMap[b.ad_type] || 'Product Ad'}`;
  state.session._textGenRunning = false; // allow textgen to run fresh on next screen
  go('textgen');
};

// ═══════════════════════════════════════════════════════
// TEXTGEN — AI generates 3 copy options, user picks or regenerates
// (replaces the old multi-step survey to match the real UI flow)
// ═══════════════════════════════════════════════════════
function buildTextgen() {
  const root = document.getElementById('screen-textgen');
  root.innerHTML = `
    ${navBar({ ctx: 'user' })}
    <section class="textgen">
      ${furnitureBg('furn-bg--subtle')}
      <div class="textgen__inner">
        <div class="textgen__card">
          <div class="textgen__head">
            <span class="eyebrow">Step 04 · Ad Text</span>
            <h2>Your AI <em>copy.</em></h2>
            <p>The Text Agent read your product and the answers from the brief. Here's what it wrote — keep it, or regenerate.</p>
          </div>

          <div class="textgen__loading" id="tg-loading">
            <div class="dots"><span></span><span></span><span></span></div>
            <div class="textgen__loading__label" id="tg-loading-msg">Reading your product…</div>
          </div>

          <div class="tg-single" id="tg-single" style="display:none"></div>

          <div class="textgen__actions">
            <button class="btn btn--ghost" onclick="go('brief')">← Back</button>
            <button class="btn btn--ghost" id="btn-tg-regen" onclick="regenerateText()">↻ Regenerate</button>
            <button class="btn btn--primary" id="btn-tg-use" onclick="useSelectedText()" disabled style="opacity:.5">Use this text →</button>
          </div>
        </div>
      </div>
    </section>
  `;
}
onEnter.textgen = () => {
  // Always reset flag when entering textgen so re-pick text always works
  state.session._textGenRunning = false;
  state.session.text_option = null;
  document.getElementById('tg-single').innerHTML = '';
  generateTextCopy();
};

async function generateTextCopy() {
  if (state.session._textGenRunning) return; // prevent double-call
  state.session._textGenRunning = true;
  const loading = document.getElementById('tg-loading');
  const single  = document.getElementById('tg-single');
  const msg     = document.getElementById('tg-loading-msg');
  const useBtn  = document.getElementById('btn-tg-use');
  loading.style.display = 'block';
  single.style.display = 'none';
  useBtn.disabled = true;
  useBtn.style.opacity = '.5';

  const msgs = ['Reading your product…', 'Finding the right tone…', 'Writing the headline…', 'Polishing the CTA…'];
  let mi = 0;
  const interval = setInterval(() => { msg.textContent = msgs[mi++ % msgs.length]; }, 1300);

  try {
    const survey = state.session.survey || {};
    const r = await API.apiGenerateText({
      session_id:    state.session.session_id,
      ad_type:       survey.ad_type       || 'product',
      season:        survey.season        || 'anytime',
      audience:      survey.product_focus || survey.audience || 'aesthetic',
      room:          survey.room          || 'living',
      style:         survey.style         || 'modern',
      lighting:      survey.lighting      || 'sunlight',
      frame:         survey.frame         || 'square',
      discount:      survey.discountValue || 0,
      urgency:       survey.urgency       || 'non_urgent',
    });

    // Pick a tone label from the survey for nicer display
    const toneLabel = survey.tone || (survey.ad_type? (survey.ad_type === 'sale' ? 'Bold & energetic' : 'Editorial & elevated')
      : 'Editorial & elevated');

    state.session.text_option = { tone: toneLabel, ...r };

    clearInterval(interval);
    loading.style.display = 'none';
    single.style.display = 'block';
    state.session._textGenRunning = false;
    renderTextSingle();
  } catch (e) {
    clearInterval(interval);
    state.session._textGenRunning = false;
    msg.textContent = 'Error: ' + e.message;
  }
}

function renderTextSingle() {
  const t = state.session.text_option;
  if (!t) return;
  const single = document.getElementById('tg-single');
  single.innerHTML = `
    <div class="tg-single__card">
      <div class="tg-single__row tg-single__row--meta">
        <span class="tg-single__tag">Tone · ${escape(t.tone)}</span>
        <span class="tg-single__hint">Tap fields to edit · or hit ↻ Regenerate above</span>
      </div>

      <div class="tg-single__field">
        <label>Headline</label>
        <input type="text" id="tg-headline" value="${escape(t.headline)}">
      </div>
      <div class="tg-single__field">
        <label>Description</label>
        <textarea id="tg-desc" rows="3">${escape(t.description)}</textarea>
      </div>
      <div class="tg-single__field tg-single__field--cta">
        <label>Call to action</label>
        <input type="text" id="tg-cta" value="${escape(t.cta)}">
      </div>
    </div>
  `;

  // wire edits back to state
  document.getElementById('tg-headline').oninput = (e) => { state.session.text_option.headline = e.target.value; };
  document.getElementById('tg-desc').oninput     = (e) => { state.session.text_option.description = e.target.value; };
  document.getElementById('tg-cta').oninput      = (e) => { state.session.text_option.cta = e.target.value; };

  const btn = document.getElementById('btn-tg-use');
  btn.disabled = false;
  btn.style.opacity = '1';
}

window.regenerateText = () => { state.session._textGenRunning = false; generateTextCopy(); };

window.useSelectedText = () => {
  const t = state.session.text_option;
  if (!t) return;
  const c = state.session.customize;
  // Break long headlines into two lines on a sensible word boundary
  const h = (t.headline || '').trim().replace(/\.$/, '');
  const words = h.split(' ');
  c.headline = words.length > 3
    ? words.slice(0, Math.ceil(words.length/2)).join(' ') + '\n' + words.slice(Math.ceil(words.length/2)).join(' ')
    : h;
  c.sub  = t.description?.split(/[.—]/)[0]?.trim() || '';
  c.cta  = t.cta || 'Shop now';
  c.tag  = t.tone || 'Product Ad';
  runImageThenLayout();
};
// ═══════════════════════════════════════════════════════
// LOADING — runs the Image + Layout agents
// ═══════════════════════════════════════════════════════
function buildLoading() {
  const root = document.getElementById('screen-loading');
  root.innerHTML = `
    <section class="loading">
      <div class="loading__content">
        <img class="loading__logo" src="posttiva-logo.png" alt="Posttiva">
        <div class="loading__title">Your poster is <em>in the making.</em></div>
        <div class="loading__msg" id="loading-msg">Waking up the agents…</div>
        <div class="agent-steps" id="agent-steps"></div>
        <div class="loading__progress"><div class="loading__progress__fill" id="loading-fill" style="width:0%"></div></div>
      </div>
    </section>
  `;
}
const PIPELINE_STEPS = [
  { id:'brief',  name:'Brief',       desc:'Locked in — your answers are ready', icon:'?' },
  { id:'image',  name:'Image Agent', desc:'Generating background · SD2 inpainting with product preservation', icon:'▣' },
  { id:'text',   name:'Text Agent',  desc:'Writing and polishing your ad copy', icon:'✎' },
  { id:'layout', name:'Layout Agent',desc:'Composing final poster · type & product placement', icon:'◫' },
];

async function runPipeline() {
  go('loading');

  const steps = document.getElementById('agent-steps');
  steps.innerHTML = PIPELINE_STEPS.map(s => `
    <div class="agent-step" data-id="${s.id}">
      <div class="agent-step__icon">${s.icon}</div>
      <div class="agent-step__info">
        <div class="agent-step__name">${s.name}</div>
        <div class="agent-step__desc">${s.desc}</div>
      </div>
      <div class="agent-step__status">Queued</div>
    </div>
  `).join('');

  const setStep = (id, status) => {
    const el = steps.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove('is-active', 'is-done');
    if (status === 'active') el.classList.add('is-active');
    if (status === 'done') el.classList.add('is-done');
    el.querySelector('.agent-step__status').textContent =
      status === 'active' ? 'Running...' : status === 'done' ? 'Done' : 'Queued';
  };
  const setMsg = (m) => { document.getElementById('loading-msg').textContent = m; };
  const setFill = (p) => { document.getElementById('loading-fill').style.width = p + '%'; };

  try {
    setStep('brief', 'done'); setFill(10);

    // STEP 1: IMAGE AGENT
    setStep('image', 'active');
    setMsg('Image Agent - Stable Diffusion generating background...');
    setFill(20);

    const b = state.session.brief || {};
    const poster = await API.apiGeneratePoster({
      session_id:   state.session.session_id,
      style_prompt: state.session.prompt || 'modern interior',
      brief: {
        room:     b.room     || 'living',
        style:    b.style    || 'modern',
        lighting: b.lighting || 'sunlight',
        ad_type:  b.ad_type  || 'product',
        frame:    b.frame    || 'square',
        discount: b.discount === 'yes' ? (document.getElementById('discount-value')?.value || 0) : 0,
        urgency:  b.sale_urgency || 'non_urgent',
      },
    });

    state.session.poster = poster.poster_url || (poster.poster_b64 ? 'data:image/jpeg;base64,' + poster.poster_b64 : null);
    state.session.report = poster.report;
    setStep('image', 'done'); setFill(33);
    setMsg('Image Agent done - Now starting Text Agent...');
    await new Promise(r => setTimeout(r, 800));

    // STEP 2: TEXT AGENT - go to textgen screen
    setStep('text', 'active');
    setMsg('Text Agent - reading your product and writing copy...');
    setFill(40);
    await new Promise(r => setTimeout(r, 500));
    go('textgen');

  } catch (err) {
    setMsg('Something went wrong: ' + err.message);
  }
}


// Run Image Agent first, then Layout Agent with approved text
async function runImageThenLayout() {
  go('loading');
  const steps = document.getElementById('agent-steps');
  steps.innerHTML = PIPELINE_STEPS.map(s => `
    <div class="agent-step" data-id="${s.id}">
      <div class="agent-step__icon">${s.icon}</div>
      <div class="agent-step__info">
        <div class="agent-step__name">${s.name}</div>
        <div class="agent-step__desc">${s.desc}</div>
      </div>
      <div class="agent-step__status">Queued</div>
    </div>
  `).join('');

  const setStep = (id, status) => {
    const el = steps.querySelector('[data-id="' + id + '"]');
    if (!el) return;
    el.classList.remove('is-active','is-done');
    if (status === 'active') el.classList.add('is-active');
    if (status === 'done')   el.classList.add('is-done');
    el.querySelector('.agent-step__status').textContent =
      status === 'active' ? 'Running...' : status === 'done' ? 'Done' : 'Queued';
  };
  const setMsg  = (m) => { const el = document.getElementById('loading-msg');  if(el) el.textContent = m; };
  const setFill = (p) => { const el = document.getElementById('loading-fill'); if(el) el.style.width = p+'%'; };

  try {
    setStep('brief','done'); setFill(10);

    // IMAGE AGENT
    setStep('image','active');
    setMsg('Image Agent — Stable Diffusion generating background…');
    setFill(20);

    const poster = await API.apiGeneratePoster({ session_id: state.session.session_id });
    const _bgUrl = poster.poster_url || (poster.poster_b64 ? 'data:image/jpeg;base64,' + poster.poster_b64 : null);
    state.session.bgPoster = _bgUrl;
    state.session.poster   = _bgUrl;
    state.session.report   = poster.report;
    setStep('image','done'); setFill(50);
    setMsg('Image Agent done — starting Layout Agent…');
    await new Promise(r => setTimeout(r, 600));

    // TEXT done
    setStep('text','done'); setFill(60);

    // LAYOUT AGENT
    setStep('layout','active');
    setMsg('Layout Agent — placing text on your poster…');
    setFill(70);

    const layout = await API.apiLayout({
      session_id: state.session.session_id,
      text: state.session.text_option || state.session.text,
    });

    if (layout && layout.poster_url) state.session.poster = layout.poster_url;
    else if (layout && layout.poster_b64) state.session.poster = 'data:image/jpeg;base64,' + layout.poster_b64;
    // Store background-only image for customize screen
    if (layout && layout.bg_b64) state.session.bgPoster = 'data:image/jpeg;base64,' + layout.bg_b64;
    else if (layout && layout.bg_url) state.session.bgPoster = layout.bg_url;
    if (layout && layout.text_coords) state.session.textCoords = layout.text_coords;
    if (layout && layout.poster_config) Object.assign(state.session.customize, layout.poster_config);
    // New layout → CTA position comes from layout until user drags again
    state.session.customize._ctaMoved = false;
    state.session.customize.ctaNl = null;
    state.session.customize.ctaNt = null;

    setStep('layout','done'); setFill(100);
    setMsg('All agents done — your poster is ready!');
    await new Promise(r => setTimeout(r, 600));
    state.session._fromHome  = false;
    state.session.project_id = null;
    go('result');
    autoSaveProject();

  } catch (err) {
    const el = document.getElementById('loading-msg');
    if (el) el.textContent = 'Something went wrong: ' + err.message;
  }
}

async function runLayoutAgent() {
  go('loading');
  const steps = document.getElementById('agent-steps');
  if (steps) {
    steps.innerHTML = PIPELINE_STEPS.map(s => `
      <div class="agent-step" data-id="${s.id}">
        <div class="agent-step__icon">${s.icon}</div>
        <div class="agent-step__info">
          <div class="agent-step__name">${s.name}</div>
          <div class="agent-step__desc">${s.desc}</div>
        </div>
        <div class="agent-step__status">Queued</div>
      </div>
    `).join('');
    ['brief','image','text'].forEach(id => {
      const el = steps.querySelector('[data-id="' + id + '"]');
      if (el) { el.classList.add('is-done'); el.querySelector('.agent-step__status').textContent = 'Done'; }
    });
    const layoutEl = steps.querySelector('[data-id="layout"]');
    if (layoutEl) { layoutEl.classList.add('is-active'); layoutEl.querySelector('.agent-step__status').textContent = 'Running...'; }
  }
  const setMsg = (m) => { document.getElementById('loading-msg').textContent = m; };
  const setFill = (p) => { document.getElementById('loading-fill').style.width = p + '%'; };

  try {
    setMsg('Layout Agent - Qwen placing text on your poster...');
    setFill(75);

    const layout = await API.apiLayout({
      session_id: state.session.session_id,
      text:       state.session.text_option || state.session.text,
    });

    if (layout && layout.poster_url) {
      state.session.poster = layout.poster_url;
    } else if (layout && layout.poster_b64) {
      state.session.poster = 'data:image/jpeg;base64,' + layout.poster_b64;
    }
    if (layout && layout.bg_b64) state.session.bgPoster = 'data:image/jpeg;base64,' + layout.bg_b64;
    else if (layout && layout.bg_url) state.session.bgPoster = layout.bg_url;
    if (layout && layout.text_coords) state.session.textCoords = layout.text_coords;
    if (layout && layout.poster_config) Object.assign(state.session.customize, layout.poster_config);
    state.session.customize._ctaMoved = false;
    state.session.customize.ctaNl = null;
    state.session.customize.ctaNt = null;

    const layoutEl = document.querySelector('[data-id="layout"]');
    setFill(100);
    setMsg('All agents done - Your poster is ready!');
    await new Promise(r => setTimeout(r, 600));
    state.session._fromHome  = false;
    state.session.project_id = null;
    go('result');
    autoSaveProject();
  } catch (err) {
    setMsg('Something went wrong: ' + err.message);
  }
}


// ═══════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════
function buildResult() {
  const root = document.getElementById('screen-result');
  root.innerHTML = `
    ${navBar({ ctx: 'user' })}
    <section class="result">
      ${furnitureBg('furn-bg--subtle')}
      <div class="result__inner">
        <div class="result__hero">
          <h1 class="display display--lg" style="margin-top:8px">Your creation is <em class="italic">ready.</em></h1>
          <p class="result__hero__sub">Built in 4 steps by 3 AI agents. Tweak it, save it, or share it with the world.</p>
        </div>

        <div class="result__layout">
          <div class="result__poster" id="result-poster-wrap">
            <!-- poster injected on enter -->
          </div>

          <div class="result__side">
            <!-- Actions card (primary) -->
            <div class="actions-card">
              <h4 class="actions-card__title">What's <em class="italic">next?</em></h4>
              <div class="actions-card__grid">
                <button class="action-btn action-btn--primary" onclick="downloadPoster()">
                  <span class="action-btn__icon">⬇</span>
                  <span class="action-btn__label">Download</span>
                  <span class="action-btn__sub">PNG · high-res</span>
                </button>
                <button class="action-btn" onclick="go('customize')">
                  <span class="action-btn__icon">✎</span>
                  <span class="action-btn__label">Customize</span>
                  <span class="action-btn__sub">Text · color · font</span>
                </button>
                <button class="action-btn" onclick="showRegenModal()">
                  <span class="action-btn__icon">↺</span>
                  <span class="action-btn__label">Regenerate</span>
                  <span class="action-btn__sub">New background</span>
                </button>
                <button class="action-btn" onclick="state.session._textGenRunning=false;go('textgen')">
                  <span class="action-btn__icon">✦</span>
                  <span class="action-btn__label">Re-pick text</span>
                  <span class="action-btn__sub">Try a new headline</span>
                </button>
              </div>
              <button id="btn-delete-project"
                style="display:none;margin-top:16px;width:100%;padding:10px 0;background:none;border:1.5px solid #e8c0cc;border-radius:50px;color:#A64D79;font-family:Outfit,sans-serif;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:.04em"
                onclick="deleteCurrentProject()">
                ✕ Delete this project
              </button>
            </div>

            <!-- Rating -->
            <div class="rating-card">
              <h4>How did we do?</h4>
              <p>Your rating helps the agents learn what works.</p>
              <div class="rating-stars" id="rating-stars" role="radiogroup" aria-label="Rate this poster">
                ${[1,2,3,4,5].map(n => `<button class="rating-star" data-val="${n}" aria-label="${n} star${n>1?'s':''}" onclick="setRating(${n})">★</button>`).join('')}
              </div>
              <div class="rating-card__feedback" id="rating-feedback"></div>
            </div>
          </div>
        </div>

        <button class="btn btn--ghost" style="margin-top:32px" onclick="go('home')">← Back to home</button>
      </div>
    </section>
  `;
}
onEnter.result = () => {
  document.getElementById('result-poster-wrap').innerHTML = posterCanvas('res-poster', true);
  const r = state.session.report;
  if (r) {
    if (r.integrity) document.getElementById('rep-integrity').textContent = '✓ ' + r.integrity.label;
    if (r.artifacts) document.getElementById('rep-artifacts').textContent = '✓ ' + r.artifacts.label;
    const retEl  = document.getElementById('rep-retries');
    const timeEl = document.getElementById('rep-time');
    if (retEl)  retEl.textContent  = r.retries ?? 0;
    if (timeEl) timeEl.textContent = (r.elapsed_s ?? 0).toFixed(1) + 's';
  }
  const delBtn = document.getElementById('btn-delete-project');
  if (delBtn) delBtn.style.display = state.session.project_id ? 'block' : 'none';
};
window.deleteCurrentProject = async () => {
  if (!state.session.project_id) return;
  if (!confirm('Delete this project? This cannot be undone.')) return;
  try {
    await API.apiDeleteProject(state.session.project_id);
    state._projects = (state._projects || []).filter(p => Number(p.id) !== Number(state.session.project_id));
    state.session.project_id = null;
    state.session._fromHome  = false;
    showToast('Project deleted.');
    go('home');
  } catch (e) {
    showToast('Delete failed: ' + e.message);
  }
};

// Background-only brief — shown when user clicks "New selection" on regenerate
window.showBgBrief = () => {
  const existing = document.getElementById('bg-brief-modal');
  if (existing) existing.remove();

  const b = state.session.brief || {};
  const modal = document.createElement('div');
  modal.id = 'bg-brief-modal';
  Object.assign(modal.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '9999', fontFamily: 'Outfit, sans-serif',
  });

  const opts = (qid, options, current) => options.map(o => `
    <button onclick="bgBriefPick('${qid}','${o.v}',this)"
      style="padding:10px 18px;border-radius:50px;border:1.5px solid #c8a8c0;background:${current===o.v?'#4B1D3F':'#fff'};
      color:${current===o.v?'#fff':'#4B1D3F'};font-family:Outfit,sans-serif;font-size:13px;font-weight:600;cursor:pointer;margin:4px">
      ${o.label}
    </button>`).join('');

  modal.innerHTML = `
    <div style="background:#fff;border-radius:24px;padding:36px;max-width:440px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto">
      <h3 style="font-size:20px;margin:0 0 6px;font-family:inherit">New background selection</h3>
      <p style="color:#888;font-size:13px;margin:0 0 24px">Choose new room, style and lighting for your poster.</p>

      <div style="margin-bottom:18px">
        <div style="font-size:13px;font-weight:600;color:#4B1D3F;margin-bottom:8px">Frame</div>
        <div id="bg-brief-frame">${opts('frame',[{v:'square',label:'Square 1:1'},{v:'vertical',label:'Vertical 4:5'},{v:'portrait',label:'Portrait 9:16'}],b.frame||'square')}</div>
      </div>
      <div style="margin-bottom:18px">
        <div style="font-size:13px;font-weight:600;color:#4B1D3F;margin-bottom:8px">Room</div>
        <div id="bg-brief-room">${opts('room',[{v:'living',label:'Living Room'},{v:'bedroom',label:'Bedroom'}],b.room||'living')}</div>
      </div>
      <div style="margin-bottom:18px">
        <div style="font-size:13px;font-weight:600;color:#4B1D3F;margin-bottom:8px">Style</div>
        <div id="bg-brief-style">${opts('style',[{v:'classic',label:'Classic'},{v:'modern',label:'Modern'},{v:'boho',label:'Boho'}],b.style||'modern')}</div>
      </div>
      <div style="margin-bottom:24px">
        <div style="font-size:13px;font-weight:600;color:#4B1D3F;margin-bottom:8px">Lighting</div>
        <div id="bg-brief-lighting">${opts('lighting',[{v:'sunlight',label:'Sunlight'},{v:'indoor',label:'Indoor Light'}],b.lighting||'sunlight')}</div>
      </div>

      <div style="display:flex;gap:12px">
        <button onclick="document.getElementById('bg-brief-modal').remove()"
          style="flex:1;padding:14px;border-radius:50px;border:2px solid #4B1D3F;background:transparent;color:#4B1D3F;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer">
          Cancel
        </button>
        <button onclick="submitBgBrief()"
          style="flex:1;padding:14px;border-radius:50px;border:none;background:#4B1D3F;color:#fff;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer">
          Generate →
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
};

window.bgBriefPick = (qid, v, btn) => {
  state.session.brief = state.session.brief || {};
  state.session.brief[qid] = v;
  const container = btn.closest('[id^="bg-brief-"]');
  if (container) container.querySelectorAll('button').forEach(b => {
    b.style.background = '#fff';
    b.style.color = '#4B1D3F';
  });
  btn.style.background = '#4B1D3F';
  btn.style.color = '#fff';
};

window.submitBgBrief = () => {
  document.getElementById('bg-brief-modal')?.remove();
  // Rebuild payload with new background selections but keep text selections
  const b = state.session.brief || {};
  window._posttiva_payload = {
    ...(window._posttiva_payload || {}),
    room:       b.room === 'living' ? 'Living Room' : 'Bedroom',
    room_style: b.style === 'classic' ? 'Classic' : b.style === 'boho' ? 'Boho' : 'Modern',
    lighting:   b.lighting === 'indoor' ? 'Indoor' : 'Sunlight',
    frame:      b.frame || 'square',
  };
  runImageThenLayout();
};

window.showRegenModal = () => {
  const existing = document.getElementById('regen-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'regen-modal';
  Object.assign(modal.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '9999', fontFamily: 'Outfit, sans-serif',
  });
  modal.innerHTML = `
    <div style="background:#fff;border-radius:24px;padding:40px 36px;max-width:380px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.2)">
      <h3 style="font-size:22px;margin:0 0 10px;font-family:inherit">Regenerate background</h3>
      <p style="color:#888;font-size:14px;margin:0 0 28px">Use the same brief answers, or start fresh with new ones?</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button onclick="closeRegenModal();regenBg();"
          style="flex:1;padding:14px 18px;background:#4B1D3F;color:#fff;border:none;border-radius:50px;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer">
          Same selection
        </button>
        <button onclick="closeRegenModal();showBgBrief();"
          style="flex:1;padding:14px 18px;background:transparent;color:#4B1D3F;border:2px solid #4B1D3F;border-radius:50px;font-family:Outfit,sans-serif;font-size:14px;font-weight:600;cursor:pointer">
          New selection
        </button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) closeRegenModal(); });
  document.body.appendChild(modal);
};
window.closeRegenModal = () => { const m = document.getElementById('regen-modal'); if (m) m.remove(); };
window.regenBg = async () => {
  state.session._fromHome = false;
  // Rebuild payload from current brief to ensure fresh generation
  const b = state.session.brief || {};
  const roomMap    = { living: 'Living Room', bedroom: 'Bedroom' };
  const styleMap   = { classic: 'Classic', modern: 'Modern', boho: 'Boho' };
  const lightMap   = { sunlight: 'Sunlight', indoor: 'Indoor' };
  window._posttiva_payload = {
    ...(window._posttiva_payload || {}),
    room:       roomMap[b.room]    || 'Living Room',
    room_style: styleMap[b.style]  || 'Modern',
    lighting:   lightMap[b.lighting] || 'Sunlight',
    frame:      b.frame || 'square',
    seed: Math.floor(Math.random() * (2**31)),
  };
  runImageThenLayout();
};

// 5-star rating (sent to backend as feedback signal)
window.setRating = async (val) => {
  state.session.rating = val;
  document.querySelectorAll('.rating-star').forEach((s, i) => {
    s.classList.toggle('is-on', i < val);
  });
  const messages = [
    '',
    'Sorry to hear that — we\'ll dig into what went wrong.',
    'Thanks — we\'ll keep refining.',
    'Good — appreciate the feedback.',
    'Great — glad it worked!',
    'Loved it? Tell a friend.',
  ];
  const fb = document.getElementById('rating-feedback');
  if (fb) fb.textContent = messages[val] || '';
  try {
    await API.apiRating({
      session_id: state.session.session_id || null,
      project_id: state.session.project_id || null,
      rating: val,
    });
  } catch (e) { console.warn('Rating save failed:', e.message); }
};

// ═══════════════════════════════════════════════════════
// CUSTOMIZE (text editor with font/color/size/align)
// ═══════════════════════════════════════════════════════
function buildCustomize() {
  const root = document.getElementById('screen-customize');
  root.innerHTML = `
    ${navBar({ ctx: 'user' })}
    <section class="customize">
      ${furnitureBg('furn-bg--subtle')}
      <div class="customize__inner">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px;flex-wrap:wrap;gap:16px">
          <div>
            <span class="eyebrow">Step 04b · Customize</span>
            <h1 class="display display--lg" style="margin-top:8px">Make it <em class="italic">yours.</em></h1>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn--ghost" onclick="go('result')">← Back</button>
            <button class="btn btn--primary" onclick="saveCustomize()">✓ Save changes</button>
          </div>
        </div>

        <div class="customize__layout--3col">
          <div class="customize__stage">
            <div class="customize__toolbar">
              <button class="toolbar-btn" onclick="custUndo()">↶ Undo</button>
              <button class="toolbar-btn" onclick="custRedo()">↷ Redo</button>
              <button class="toolbar-btn" onclick="custReset()">↻ Reset</button>
              <button class="toolbar-btn toolbar-btn--danger" onclick="custClearLogo()">✕ Remove logo</button>
            </div>

            <div id="customize-poster-wrap" style="width:100%;max-width:440px"></div>

            <div class="customize__bottom-bar">
              <button class="btn btn--ghost" onclick="downloadPoster()">⬇ Download</button>
              <button class="btn btn--plum"  onclick="saveProject()">★ Save project</button>
              <button class="btn btn--primary" onclick="saveCustomize()">✓ Save changes</button>
            </div>
          </div>

          <aside class="customize__panel">
            <h3>Edit</h3>

            <div class="customize__section">
              <div class="customize__section__title">Headline</div>
              <textarea class="editor-field__textarea" id="c-headline">${state.session.customize.headline}</textarea>
              <div class="editor-row" style="margin-top:10px;gap:12px;align-items:center">
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft);cursor:pointer">
                  <input type="color" id="c-color" value="${state.session.customize.color}"
                    style="width:32px;height:32px;border-radius:8px;border:2px solid #e8d5e4;cursor:pointer;padding:2px;background:none">
                  Text color
                </label>
                <div class="size-stepper" style="margin-left:auto">
                  <button onclick="changeSize('headline',-2)">−</button>
                  <span id="c-size-disp">${Number(state.session.customize.size)}</span>
                  <button onclick="changeSize('headline',2)">+</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Font</div>
                <div class="font-row" id="c-headline-font-row">
                  <button class="font-btn ${(state.session.customize.headlineFont||'display')==='display'?'is-active':''}" data-font="display" style="font-family:var(--font-display);font-style:italic">Cormorant</button>
                  <button class="font-btn ${(state.session.customize.headlineFont||'display')==='sans'?'is-active':''}"    data-font="sans"    style="font-family:var(--font-ui);font-weight:700">Outfit</button>
                  <button class="font-btn ${(state.session.customize.headlineFont||'display')==='mono'?'is-active':''}"    data-font="mono"    style="font-family:var(--font-mono)">JetBrains</button>
                  <button class="font-btn ${(state.session.customize.headlineFont||'display')==='dmserif'?'is-active':''}" data-font="dmserif" style="font-family:'DM Serif Display',serif">DM Serif</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Alignment</div>
                <div class="align-row" id="c-headline-align-row">
                  <button class="${(state.session.customize.headlineAlign||'left')==='left'?'is-active':''}"   data-align="left"   title="Left">&#8676;</button>
                  <button class="${(state.session.customize.headlineAlign||'left')==='center'?'is-active':''}" data-align="center" title="Center">&#8596;</button>
                  <button class="${(state.session.customize.headlineAlign||'left')==='right'?'is-active':''}"  data-align="right"  title="Right">&#8677;</button>
                </div>
              </div>
            </div>

            <div class="customize__section">
              <div class="customize__section__title">Sub-line</div>
              <input class="editor-field__input" id="c-sub" value="${state.session.customize.sub}">
              <div class="editor-row" style="margin-top:10px;gap:12px;align-items:center">
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft);cursor:pointer">
                  <input type="color" id="c-subcolor" value="${(state.session.customize.subColor||'#ffffff').slice(0,7)}"
                    style="width:32px;height:32px;border-radius:8px;border:2px solid #e8d5e4;cursor:pointer;padding:2px;background:none">
                  Text color
                </label>
                <div class="size-stepper" style="margin-left:auto">
                  <button onclick="changeSize('sub',-2)">−</button>
                  <span id="c-subsize-disp">${Number(state.session.customize.subSize)||18}</span>
                  <button onclick="changeSize('sub',2)">+</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Font</div>
                <div class="font-row" id="c-sub-font-row">
                  <button class="font-btn ${(state.session.customize.subFont||'display')==='display'?'is-active':''}" data-font="display" style="font-family:var(--font-display);font-style:italic">Cormorant</button>
                  <button class="font-btn ${(state.session.customize.subFont||'display')==='sans'?'is-active':''}"    data-font="sans"    style="font-family:var(--font-ui);font-weight:700">Outfit</button>
                  <button class="font-btn ${(state.session.customize.subFont||'display')==='mono'?'is-active':''}"    data-font="mono"    style="font-family:var(--font-mono)">JetBrains</button>
                  <button class="font-btn ${(state.session.customize.subFont||'display')==='dmserif'?'is-active':''}" data-font="dmserif" style="font-family:'DM Serif Display',serif">DM Serif</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Alignment</div>
                <div class="align-row" id="c-sub-align-row">
                  <button class="${(state.session.customize.subAlign||'left')==='left'?'is-active':''}"   data-align="left"   title="Left">&#8676;</button>
                  <button class="${(state.session.customize.subAlign||'left')==='center'?'is-active':''}" data-align="center" title="Center">&#8596;</button>
                  <button class="${(state.session.customize.subAlign||'left')==='right'?'is-active':''}"  data-align="right"  title="Right">&#8677;</button>
                </div>
              </div>
            </div>

            <div class="customize__section">
              <div class="customize__section__title">Call to action</div>
              <input class="editor-field__input" id="c-cta" value="${state.session.customize.cta}">
              <div class="editor-row" style="margin-top:10px;gap:12px;align-items:center;flex-wrap:wrap">
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft);cursor:pointer">
                  <input type="color" id="c-ctacolor" value="${state.session.customize.ctaColor}"
                    style="width:32px;height:32px;border-radius:8px;border:2px solid #e8d5e4;cursor:pointer;padding:2px;background:none">
                  Button color
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-soft);cursor:pointer">
                  <input type="color" id="c-ctatextcolor" value="${state.session.customize.ctaTextColor||'#ffffff'}"
                    style="width:32px;height:32px;border-radius:8px;border:2px solid #e8d5e4;cursor:pointer;padding:2px;background:none">
                  Text color
                </label>
                <div class="size-stepper" style="margin-left:auto">
                  <button onclick="changeSize('cta',-1)">−</button>
                  <span id="c-ctasize-disp">${Number(state.session.customize.ctaSize)||13}</span>
                  <button onclick="changeSize('cta',1)">+</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Font</div>
                <div class="font-row" id="c-cta-font-row">
                  <button class="font-btn ${(state.session.customize.ctaFont||'sans')==='display'?'is-active':''}" data-font="display" style="font-family:var(--font-display);font-style:italic">Cormorant</button>
                  <button class="font-btn ${(state.session.customize.ctaFont||'sans')==='sans'?'is-active':''}"    data-font="sans"    style="font-family:var(--font-ui);font-weight:700">Outfit</button>
                  <button class="font-btn ${(state.session.customize.ctaFont||'sans')==='mono'?'is-active':''}"    data-font="mono"    style="font-family:var(--font-mono)">JetBrains</button>
                  <button class="font-btn ${(state.session.customize.ctaFont||'sans')==='dmserif'?'is-active':''}" data-font="dmserif" style="font-family:'DM Serif Display',serif">DM Serif</button>
                </div>
              </div>
              <div style="margin-top:10px">
                <div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Alignment</div>
                <div class="align-row" id="c-cta-align-row">
                  <button class="${(state.session.customize.ctaAlign||'left')==='left'?'is-active':''}"   data-align="left"   title="Left">&#8676;</button>
                  <button class="${(state.session.customize.ctaAlign||'left')==='center'?'is-active':''}" data-align="center" title="Center">&#8596;</button>
                  <button class="${(state.session.customize.ctaAlign||'left')==='right'?'is-active':''}"  data-align="right"  title="Right">&#8677;</button>
                </div>
              </div>
            </div>

          </aside>
        </div>
      </div>
    </section>
  `;

  // Wire all controls — use event delegation so re-renders never break wiring
  const c = state.session.customize;

  const pushUndo = () => {
    state.session._undoStack = state.session._undoStack || [];
    state.session._redoStack = [];
    state.session._undoStack.push(JSON.stringify(state.session.customize));
    if (state.session._undoStack.length > 50) state.session._undoStack.shift();
  };
  window._custPushUndo = pushUndo;

  // Flush live text inputs → state
  const flushInputs = () => {
    const hl = document.getElementById('c-headline');
    const sb = document.getElementById('c-sub');
    const ct = document.getElementById('c-cta');
    if (hl) c.headline = hl.value;
    if (sb) c.sub      = sb.value;
    if (ct) c.cta      = ct.value;
  };

  // Rebuild poster only (panel stays untouched)
  const rerender = () => { flushInputs(); rerenderPoster(); };

  // ── Text inputs (live-patch poster, no full rebuild) ──
  document.getElementById('c-headline').oninput = (e) => {
    c.headline = e.target.value;
    const el = document.getElementById('cust-poster-title');
    if (el) el.innerHTML = c.headline.replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch])).replace(/\n/g,'<br>');
  };
  document.getElementById('c-sub').oninput = (e) => {
    c.sub = e.target.value;
    const el = document.getElementById('cust-poster-sub');
    if (el) el.textContent = c.sub;
  };
  document.getElementById('c-cta').oninput = (e) => {
    c.cta = e.target.value;
    const el = document.getElementById('cust-poster-cta');
    if (el) el.textContent = c.cta;
  };
  document.getElementById('c-headline').onblur = () => pushUndo();
  document.getElementById('c-sub').onblur      = () => pushUndo();
  document.getElementById('c-cta').onblur      = () => pushUndo();

  // ── Color pickers (live-patch) ──
  document.getElementById('c-color').oninput = (e) => {
    pushUndo(); c.color = e.target.value;
    const el = document.getElementById('cust-poster-title');
    if (el) el.style.color = c.color;
  };
  document.getElementById('c-subcolor').oninput = (e) => {
    pushUndo(); c.subColor = e.target.value;
    const el = document.getElementById('cust-poster-sub');
    if (el) el.style.color = c.subColor;
  };
  document.getElementById('c-ctacolor').oninput = (e) => {
    pushUndo(); c.ctaColor = e.target.value;
    const el = document.getElementById('cust-poster-cta');
    if (el) { el.style.background = c.ctaColor; el.style.borderColor = c.ctaColor; }
  };
  document.getElementById('c-ctatextcolor').oninput = (e) => {
    pushUndo(); c.ctaTextColor = e.target.value;
    const el = document.getElementById('cust-poster-cta');
    if (el) el.style.color = c.ctaTextColor;
  };

  // ── Font buttons — event delegation on the panel (survives any re-render) ──
  const panel = document.querySelector('#screen-customize .customize__panel');

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-font]');
    if (!btn) return;
    const row = btn.closest('.font-row');
    if (!row) return;
    pushUndo();
    row.querySelectorAll('[data-font]').forEach(x => x.classList.remove('is-active'));
    btn.classList.add('is-active');
    const font = btn.dataset.font;
    const rowId = row.id;
    if (rowId === 'c-headline-font-row') { c.headlineFont = font; c.font = font; }
    else if (rowId === 'c-sub-font-row')  { c.subFont = font; }
    else if (rowId === 'c-cta-font-row')  { c.ctaFont = font; }
    rerender();
  });

  // ── Align buttons — event delegation ──
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-align]');
    if (!btn) return;
    const row = btn.closest('.align-row');
    if (!row) return;
    pushUndo();
    row.querySelectorAll('[data-align]').forEach(x => x.classList.remove('is-active'));
    btn.classList.add('is-active');
    const align = btn.dataset.align;
    const rowId = row.id;
    if (rowId === 'c-headline-align-row') { c.headlineAlign = align; c.align = align; }
    else if (rowId === 'c-sub-align-row')  { c.subAlign = align; }
    else if (rowId === 'c-cta-align-row')  { c.ctaAlign = align; }
    rerender();
  });
}

function rerenderPoster() {
  // Load fonts dynamically — only for customize page
  if (!document.getElementById('posttiva-customize-fonts')) {
    const link = document.createElement('link');
    link.id = 'posttiva-customize-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Lato:wght@700;900&family=Josefin+Sans:wght@400;600;700&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&family=Libre+Caslon+Text:wght@400;700&family=Nunito:wght@600;700;800&family=Raleway:wght@600;700&family=Montserrat:wght@600;700&display=swap';
    document.head.appendChild(link);
  }
  const wrap = document.getElementById('customize-poster-wrap');
  if (!wrap) return;

  const bgSrc = state.session.bgPoster || null;
  const c = state.session.customize;

  // Scale factor: layout agent renders at SD resolution, browser displays at 440px
  const frame = (state.session.brief || {}).frame || 'square';
  const sdW = (frame === 'portrait') ? 1024 : 768;
  const scale = 440 / sdW;

  // Use exact same fonts as layout agent
  const fontMap = {
    playfair:   { family: "'Playfair Display', Georgia, serif",       style: 'normal', weight: 700 },
    cormorant:  { family: "'Cormorant Garamond', Georgia, serif",      style: 'italic', weight: 600 },
    caslon:     { family: "'Libre Caslon Text', Georgia, serif",       style: 'normal', weight: 700 },
    dmserif:    { family: '"DM Serif Display", Georgia, serif',        style: 'normal', weight: 400 },
    raleway:    { family: "'Raleway', system-ui, sans-serif",          style: 'normal', weight: 700 },
    montserrat: { family: "'Montserrat', system-ui, sans-serif",       style: 'normal', weight: 700 },
    lato:       { family: "'Lato', system-ui, sans-serif",             style: 'normal', weight: 700 },
    nunito:     { family: "'Nunito', system-ui, sans-serif",           style: 'normal', weight: 700 },
    josefin:    { family: "'Josefin Sans', system-ui, sans-serif",     style: 'normal', weight: 600 },
    display:    { family: "'Playfair Display', Georgia, serif",        style: 'normal', weight: 700 },
    sans:       { family: "'Lato', system-ui, sans-serif",             style: 'normal', weight: 700 },
    mono:       { family: "'Josefin Sans', system-ui, sans-serif",     style: 'normal', weight: 600 },
  };
  const fH = fontMap[c.headlineFont || c.font] || fontMap.playfair;
  const fS = fontMap[c.subFont      || c.font] || fontMap.lato;
  const fC = fontMap[c.ctaFont      || 'lato'] || fontMap.lato;

  const tc = state.session.textCoords || {};
  const txPct = tc.tx_pct     != null ? (tc.tx_pct     * 100) + '%' : '4%';
  const tyPct = tc.ty_pct     != null ? (tc.ty_pct     * 100) + '%' : '5%';
  const hlTopPct = tc.headline_y != null ? (tc.headline_y * 100) + '%' : tyPct;
  const twPct = tc.tw_pct != null ? (tc.tw_pct * 100) + '%' : '58%';
  const subTopPct    = tc.sub_y != null ? (tc.sub_y * 100) + '%' : '28%';
  const ctaTopPct    = tc.cta_y != null ? (tc.cta_y * 100) + '%' : '38%';
  const ctaCenterPct = tc.cta_x != null ? (tc.cta_x * 100) + '%' : '50%';

  const div = document.createElement('div');
  div.id = 'cust-poster';
  div.style.cssText = 'position:relative;overflow:hidden;border-radius:12px;display:block;';

  if (bgSrc) {
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:auto;display:block;border-radius:12px;';
    img.onerror = () => { div.style.background = '#f5f0f3'; div.style.minHeight = '400px'; };
    img.src = bgSrc;
    img.onload = () => { _attachCtaDrag(); };
    div.appendChild(img);
  } else {
    div.style.cssText += 'background:#f5f0f3;min-height:400px;';
  }

  const hl = document.createElement('div');
  hl.id = 'cust-poster-title';
  hl.style.cssText = 'position:absolute;top:' + hlTopPct + ';left:' + txPct + ';width:' + twPct + ';font-family:' + fH.family + ';font-style:' + fH.style + ';font-weight:' + fH.weight + ';font-size:' + Math.round((Number(c.size)||44) * scale) + 'px;color:' + (c.color||'#ffffff') + ';text-align:' + (c.headlineAlign||'center') + ';line-height:1.15;text-shadow:1px 1px 4px rgba(0,0,0,0.4);pointer-events:none;';
  hl.innerHTML = (c.headline||'').replace(/[<>&]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch])).replace(/\n/g,'<br>');

  const sub = document.createElement('div');
  sub.id = 'cust-poster-sub';
  sub.style.cssText = 'position:absolute;top:' + subTopPct + ';left:' + txPct + ';width:' + twPct + ';font-family:' + fS.family + ';font-style:' + fS.style + ';font-size:' + Math.round((Number(c.subSize)||18) * scale) + 'px;color:' + (c.subColor||'rgba(255,255,255,0.85)') + ';text-align:' + (c.subAlign||'center') + ';text-shadow:1px 1px 3px rgba(0,0,0,0.3);pointer-events:none;';
  sub.textContent = c.sub || '';

  // CTA position: use dragged position if moved, otherwise center in text zone
  let ctaLeft = ctaCenterPct, ctaTop = ctaTopPct;
  if (c._ctaMoved && Number.isFinite(c.ctaNl) && Number.isFinite(c.ctaNt)) {
    ctaLeft = (c.ctaNl * 100) + '%';
    ctaTop  = (c.ctaNt * 100) + '%';
  }
  const cta = document.createElement('div');
  cta.id = 'cust-poster-cta';
  cta.style.cssText = 'position:absolute;left:' + ctaLeft + ';top:' + ctaTop + ';transform:translateX(-50%);background:' + (c.ctaColor||'#F76C6C') + ';color:' + (c.ctaTextColor||'#ffffff') + ';font-family:' + fC.family + ';font-size:' + Math.round((Number(c.ctaSize)||13) * scale) + 'px;font-weight:700;padding:8px 20px;border-radius:50px;cursor:grab;user-select:none;white-space:nowrap;border:none;pointer-events:all;';
  cta.textContent = c.cta || 'Shop Now';

  div.appendChild(hl);
  div.appendChild(sub);
  div.appendChild(cta);
  wrap.innerHTML = '';
  wrap.appendChild(div);

  if (!bgSrc) _attachCtaDrag();
}

// Drag handler — always grabs the fresh #cust-poster-cta after each render
function _attachCtaDrag() {
  const cta    = document.getElementById('cust-poster-cta');
  const canvas = document.getElementById('cust-poster');
  if (!cta || !canvas) return;

  if (window._ctaDragMove) document.removeEventListener('mousemove', window._ctaDragMove);
  if (window._ctaDragUp)   document.removeEventListener('mouseup',   window._ctaDragUp);

  const c = state.session.customize;
  let dragging = false, startX, startY, origNl, origNt, cw, ch;

  const onDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    cta.style.cursor = 'grabbing';
    startX = e.clientX;
    startY = e.clientY;
    cw = Math.max(1, canvas.clientWidth);
    ch = Math.max(1, canvas.clientHeight);
    origNl = Number.isFinite(c.ctaNl) ? c.ctaNl : (cta.offsetLeft / cw);
    origNt = Number.isFinite(c.ctaNt) ? c.ctaNt : (cta.offsetTop / ch);
    e.preventDefault();
    e.stopPropagation();
  };

  window._ctaDragMove = (e) => {
    if (!dragging) return;
    const dxN = (e.clientX - startX) / cw;
    const dyN = (e.clientY - startY) / ch;
    const wN = cta.offsetWidth / cw;
    const hN = cta.offsetHeight / ch;
    let nl = origNl + dxN;
    let nt = origNt + dyN;
    nl = Math.max(0, Math.min(1 - wN, nl));
    nt = Math.max(0, Math.min(1 - hN, nt));
    cta.style.left = (nl * 100) + '%';
    cta.style.top  = (nt * 100) + '%';
    c.ctaNl = nl;
    c.ctaNt = nt;
  };

  window._ctaDragUp = () => {
    if (!dragging) return;
    dragging = false;
    cta.style.cursor = 'grab';
    c._ctaMoved = true;
    if (window._custPushUndo) window._custPushUndo();
  };

  cta.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', window._ctaDragMove);
  document.addEventListener('mouseup',   window._ctaDragUp);
}

onEnter.customize = () => {
  state.session._undoStack = [];
  state.session._redoStack = [];
  buildCustomize();
  rerenderPoster();
};
window.changeSize = (target, d) => {
  state.session._undoStack = state.session._undoStack || [];
  state.session._redoStack = [];
  state.session._undoStack.push(JSON.stringify(state.session.customize));
  const c = state.session.customize;
  const hl = document.getElementById('c-headline');
  const sb = document.getElementById('c-sub');
  const ct = document.getElementById('c-cta');
  if (hl) c.headline = hl.value;
  if (sb) c.sub      = sb.value;
  if (ct) c.cta      = ct.value;

  // Shared scale — same formula used by rerenderPoster() so preview matches save/download
  const _fr  = (state.session.brief || {}).frame || 'square';
  const _sc  = 440 / ((_fr === 'portrait') ? 1024 : 768);

  if (target === 'headline') {
    c.size = Math.max(14, Math.min(96, Number(c.size) + d));
    const el = document.getElementById('c-size-disp');
    if (el) el.textContent = c.size;
    // headline falls through to rerenderPoster() below — correctly scaled
  } else if (target === 'sub') {
    c.subSize = Math.max(10, Math.min(48, Number(c.subSize || 18) + d));
    const el  = document.getElementById('c-subsize-disp');
    if (el) el.textContent = c.subSize;
    const subEl = document.getElementById('cust-poster-sub');
    if (subEl) subEl.style.fontSize = Math.round(c.subSize * _sc) + 'px';
    return;
  } else if (target === 'cta') {
    c.ctaSize = Math.max(8, Math.min(32, Number(c.ctaSize || 13) + d));
    const el  = document.getElementById('c-ctasize-disp');
    if (el) el.textContent = c.ctaSize;
    const ctaEl = document.getElementById('cust-poster-cta');
    if (ctaEl) ctaEl.style.fontSize = Math.round(c.ctaSize * _sc) + 'px';
    return;
  }
  rerenderPoster();
};
window.custUndo = () => {
  const stack = state.session._undoStack;
  if (!stack?.length) return;
  state.session._redoStack = state.session._redoStack || [];
  state.session._redoStack.push(JSON.stringify(state.session.customize));
  state.session.customize = JSON.parse(stack.pop());
  buildCustomize();
  rerenderPoster();
};
window.custRedo = () => {
  const stack = state.session._redoStack;
  if (!stack?.length) return;
  state.session._undoStack = state.session._undoStack || [];
  state.session._undoStack.push(JSON.stringify(state.session.customize));
  state.session.customize = JSON.parse(stack.pop());
  buildCustomize();
  rerenderPoster();
};
window.custReset = () => {
  state.session.customize = {
    headline: 'New\ncollection', sub: 'has now arrived', cta: 'Shop now',
    tag: 'Living Room · Product Ad',
    palette: 'plum', font: 'display', align: 'left',
    headlineFont: 'display', headlineAlign: 'left',
    subFont: 'display', subAlign: 'left',
    ctaFont: 'sans', ctaAlign: 'left',
    color: '#ffffff', size: 44,
    subColor: '#ffffffb3', subSize: 18,
    ctaColor: '#F76C6C', ctaTextColor: '#ffffff', ctaSize: 13,
    ctaNl: null, ctaNt: null, _ctaMoved: false,
  };
  buildCustomize();
  rerenderPoster();
};
window.custClearLogo = () => { state.session.logo_data = null; state.session.logo_file = null;
  rerenderPoster(); };

window.saveCustomize = async () => {
  showToast('Saving…');
  try {
    const hl = document.getElementById('c-headline');
    const sb = document.getElementById('c-sub');
    const ct = document.getElementById('c-cta');
        const c = state.session.customize;
        if (hl) c.headline = hl.value;
        if (sb) c.sub      = sb.value;
        if (ct) c.cta      = ct.value;
    // Flush all color pickers so canvas render matches exactly what user sees
        const colorEl        = document.getElementById('c-color');
        const subColorEl     = document.getElementById('c-subcolor');
        const ctaColorEl     = document.getElementById('c-ctacolor');
        const ctaTextColorEl = document.getElementById('c-ctatextcolor');

        if (colorEl)        c.color        = colorEl.value;
        if (subColorEl)     c.subColor     = subColorEl.value;
        if (ctaColorEl)     c.ctaColor     = ctaColorEl.value;
        if (ctaTextColorEl) c.ctaTextColor = ctaTextColorEl.value;

    let posterImg = state.session.poster || null;
    try {
      const cv = await posterToCanvas();
      posterImg = cv.toDataURL('image/jpeg', 0.92);
      state.session.poster = posterImg;
    } catch (_e) { /* keep previous poster if raster export fails */ }

    const projectData = {
      title:        (c.headline || 'Untitled Poster').replace(/\n/g,' ').trim(),
      bg_color:     c.palette   || 'plum',
      label:        c.headline  || '',
      sub:          c.sub       || '',
      chat_answers: state.session.brief || {},
      poster_config: c,
      session_id:   state.session.session_id || null,
      poster_img:   posterImg,
    };
    if (state.session.project_id) {
      await API.apiUpdateProject(state.session.project_id, projectData);
      if (state._projects) {
        state._projects = state._projects.map(p =>
          String(p.id||p.project_id||p._id) === String(state.session.project_id)
            ? { ...p, poster_config: c, poster_img: posterImg, title: projectData.title }
            : p
        );
      }
    } else {
      const saved = await API.apiSaveProject(projectData);
      const newId = saved?.project_id || saved?.id || saved?._id || null;
      state.session.project_id = newId;
      if (newId && state._projects) {
        state._projects = [{ id: newId, ...projectData }, ...(state._projects||[])];
      }
    }
    showToast('Saved!');
    go('result');
  } catch (e) {
    showToast('Save failed: ' + e.message);
    console.error('[POSTTIVA] save error:', e);
  }
};
// ── Default CTA pill top-left in the same 440×550 space as posterToCanvas ───
function defaultCtaCanvasPos(c, W, H, tc) {
  const txPx = tc && tc.tx_pct != null ? Math.round(tc.tx_pct * W) : Math.round(W * 0.04);
  const tyPx = tc && tc.ty_pct != null ? Math.round(tc.ty_pct * H) : Math.round(H * 0.05);
  const lines = (c.headline || '').split('\n').filter(l => l.trim());
  const headlineSize = Number(c.size) || 44;
  const lineH = headlineSize * 1.15;
  const headY = tyPx;
  const subY = headY + lines.length * lineH + 10;
  const subSize = Number(c.subSize) || 18;
  const ctaYPos = subY + subSize + 14;
  return { x: txPx, y: ctaYPos };
}

// ── Canvas 2D poster renderer (no CORS / html2canvas issues) ──────────────
async function posterToCanvas(customizeOverride) {
  await document.fonts.ready;
  const c = customizeOverride || state.session.customize;

  // ── Step 1: Load background image to get actual PIL dimensions ──
  const bgSrc = customizeOverride ? null : (state.session.bgPoster || null);
  let bgImg = null;
  if (bgSrc) {
    bgImg = await new Promise((resolve) => {
      const tryLoad = (withCORS) => {
        const img = new Image();
        if (withCORS) img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => withCORS ? tryLoad(false) : resolve(null);
        img.src = bgSrc + (withCORS && bgSrc.startsWith('http') ? (bgSrc.includes('?') ? '&_cb=' : '?_cb=') + Date.now() : '');
      };
      tryLoad(true);
    });
  }

  // ── Step 2: Canvas = PIL image dimensions (no rounding, no 2× scale) ──
  // Font sizes & text_coords in poster_config are already in PIL pixels,
  // so drawing at PIL resolution means PIX = 1.0 — no scaling needed.
  const W = bgImg ? bgImg.naturalWidth  : 880;
  const H = bgImg ? bgImg.naturalHeight : 1100;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // ── Step 3: Draw background — no rounded clip so download has sharp corners ──
  if (bgImg) {
    ctx.drawImage(bgImg, 0, 0, W, H);
  } else {
    const stops = {
      plum:['#4B1D3F','#31122A'],rose:['#A64D79','#4B1D3F'],
      coral:['#F76C6C','#A64D79'],ink:['#1A1A1A','#31122A'],
      bright:['#A64D79','#F76C6C'],warm:['#C06A93','#F76C6C'],deep:['#6B2E5A','#1A1A1A'],
    };
    const [c1,c2] = stops[c.palette]||stops.plum;
    const grd = ctx.createLinearGradient(W,0,0,H);
    grd.addColorStop(0,c1); grd.addColorStop(1,c2);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Step 4: PIX = 1.0 — font sizes from poster_config are PIL pixels ──
  const PIX = 1.0;

  // ── Font map ────────────────────────────────────────────────────
  const ff = {
    playfair:   '"Playfair Display"',
    cormorant:  '"Cormorant Garamond"',
    caslon:     '"Libre Caslon Text"',
    dmserif:    '"DM Serif Display"',
    raleway:    '"Raleway"',
    montserrat: '"Montserrat"',
    lato:       '"Lato"',
    nunito:     '"Nunito"',
    josefin:    '"Josefin Sans"',
    display:    '"Playfair Display"',
    sans:       '"Lato"',
    mono:       '"Josefin Sans"',
  };
  const hFontName = ff[c.headlineFont || c.font] || ff.playfair;
  const sFontName = ff[c.subFont      || c.font] || ff.lato;
  const cFontName = ff[c.ctaFont      || 'lato'] || ff.lato;

  const hFont = hFontName + ', Georgia, serif';
  const sFont = sFontName + ', Georgia, serif';
  const cFont = cFontName + ', sans-serif';

  // Font sizes are PIL pixel values — use as-is (PIX = 1.0)
  const headlineSize = Number(c.size)    || 44;
  const subSize      = Number(c.subSize) || 18;
  const ctaSize      = Number(c.ctaSize) || 13;

  // ── Text positions — Layout Agent coords are fractions of PIL dimensions ──
  const tc = customizeOverride ? null : (state.session.textCoords || null);
  const txPx = tc?.tx_pct != null ? Math.round(tc.tx_pct * W) : Math.round(W * 0.04);
  const tyPx = tc?.ty_pct != null ? Math.round(tc.ty_pct * H) : Math.round(H * 0.05);
  const twPx = tc?.tw_pct != null ? Math.round(tc.tw_pct * W) : Math.round(W * 0.58);

  // Alignment — always respect the user's choice
  const hAlign = c.headlineAlign || 'center';
  const sAlign = c.subAlign      || 'center';

  // X anchor for canvas textAlign
  const hX = hAlign === 'right'  ? txPx + twPx
            : hAlign === 'center' ? txPx + twPx / 2
            : txPx;
  const sX = sAlign === 'right'  ? txPx + twPx
            : sAlign === 'center' ? txPx + twPx / 2
            : txPx;

  const lines = (c.headline || '').split('\n').filter(l => l.trim());
  const lineH = headlineSize * 1.15;

  const headY = tc?.headline_y != null ? Math.round(tc.headline_y * H) : tyPx;
  const subY  = tc?.sub_y      != null ? Math.round(tc.sub_y      * H) : headY + lines.length * lineH + 10;

  // ── Headline ─────────────────────────────────────────────────
  ctx.font = headlineSize + 'px ' + hFont;
  ctx.fillStyle = c.color || '#ffffff';
  ctx.textAlign = hAlign; ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4;
  lines.forEach((ln, i) => ctx.fillText(ln, hX, headY + i * lineH, twPx));

  // ── Sub-line ──────────────────────────────────────────────────
  ctx.font = subSize + 'px ' + sFont;
  ctx.fillStyle = c.subColor || 'rgba(255,255,255,0.85)';
  ctx.textAlign = sAlign;
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 3;
  ctx.fillText(c.sub || '', sX, subY, twPx);

  // ── CTA pill ──────────────────────────────────────────────────
  ctx.shadowBlur = 0;
  ctx.font = '700 ' + ctaSize + 'px ' + cFont;
  const ctaLabel = c.cta || 'Shop Now';
  const ctaBtnW  = ctx.measureText(ctaLabel).width + 40;
  const ctaBtnH  = Math.max(32, ctaSize * 2.8);

  // ctaNl / ctaNt are fractions of the display container (same proportion as PIL)
  let ctaX, ctaYPos;
  if (c._ctaMoved && Number.isFinite(c.ctaNl) && Number.isFinite(c.ctaNt)) {
    ctaX    = Math.round(c.ctaNl * W);
    ctaYPos = Math.round(c.ctaNt * H);
  } else if (tc?.cta_y != null) {
    ctaYPos = Math.round(tc.cta_y * H);
    const centerX = tc?.cta_x != null ? Math.round(tc.cta_x * W) : W / 2;
    ctaX = centerX - ctaBtnW / 2;
  } else {
    const defCta = defaultCtaCanvasPos(c, W, H, tc);
    ctaX    = defCta.x;
    ctaYPos = defCta.y;
  }

  // Draw rounded pill
  const rr = ctaBtnH / 2;
  ctx.beginPath();
  ctx.moveTo(ctaX + rr, ctaYPos);
  ctx.lineTo(ctaX + ctaBtnW - rr, ctaYPos);
  ctx.arcTo(ctaX + ctaBtnW, ctaYPos,     ctaX + ctaBtnW, ctaYPos + rr,     rr);
  ctx.lineTo(ctaX + ctaBtnW, ctaYPos + ctaBtnH - rr);
  ctx.arcTo(ctaX + ctaBtnW, ctaYPos + ctaBtnH, ctaX + ctaBtnW - rr, ctaYPos + ctaBtnH, rr);
  ctx.lineTo(ctaX + rr,     ctaYPos + ctaBtnH);
  ctx.arcTo(ctaX, ctaYPos + ctaBtnH, ctaX, ctaYPos + ctaBtnH - rr, rr);
  ctx.lineTo(ctaX, ctaYPos + rr);
  ctx.arcTo(ctaX, ctaYPos, ctaX + rr, ctaYPos, rr);
  ctx.closePath();
  ctx.fillStyle = c.ctaColor || '#F76C6C';
  ctx.fill();
  ctx.fillStyle = c.ctaTextColor || '#ffffff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ctaLabel, ctaX + ctaBtnW / 2, ctaYPos + ctaBtnH / 2);

  return cv;
}

function triggerCanvasDownload(canvas, headline) {
  const title = (headline || 'poster').replace(/\n/g,'-').replace(/\s+/g,'-').replace(/[^a-z0-9-]/gi,'').toLowerCase() || 'poster';
  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = title + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title + '.png';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  } catch(e) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = title + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
}

window.downloadPoster = async () => {
  showToast('Preparing download…');
  try {
    const hl   = document.getElementById('c-headline');
    const sb   = document.getElementById('c-sub');
    const ct   = document.getElementById('c-cta');
    const cust = state.session.customize;
    if (hl && cust) cust.headline = hl.value;
    if (sb && cust) cust.sub      = sb.value;
    if (ct && cust) cust.cta      = ct.value;

    const title = (cust?.headline || 'poster')
      .replace(/\n/g,'-').replace(/\s+/g,'-')
      .replace(/[^a-z0-9-]/gi,'').toLowerCase() || 'poster';

    // If we have a background image, render a fresh high-res canvas with text overlay
    if (state.session.bgPoster) {
      const cv = await posterToCanvas();
      if (cv) { triggerCanvasDownload(cv, cust?.headline); showToast('Poster downloaded!'); return; }
    }

    // Otherwise use the already-saved poster (e.g. after saveCustomize set state.session.poster)
    const posterSrc = state.session.poster;
    if (!posterSrc) { showToast('No poster available.'); return; }
    const a = document.createElement('a');
    a.href = posterSrc;
    a.download = title + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast('Poster downloaded!');
  } catch (err) {
    showToast('Download failed — try again.');
    console.error('[POSTTIVA] download error:', err);
  }
};

async function autoSaveProject() {
  if (!state.user) return;
  if (state.session.project_id) return; // already saved
  const c = state.session.customize;
  try {
    let posterImg = state.session.poster || null;
    try { const cv = await posterToCanvas(); posterImg = cv.toDataURL('image/jpeg', 0.85); } catch(e) {}
    const saved = await API.apiSaveProject({
      title:        (c.headline || 'Untitled Poster').replace(/\n/g,' ').trim(),
      bg_color:     c.palette   || 'plum',
      label:        c.headline  || '',
      sub:          c.sub       || '',
      chat_answers: state.session.brief    || {},
      poster_config: c,
      session_id:   state.session.session_id || null,
      poster_img:   posterImg,
    });
    const newId = saved?.project_id || saved?.id || saved?._id || null;
    state.session.project_id = newId;
    if (newId) {
      const newProject = {
        id: newId,
        title:     (c.headline || 'Untitled Poster').replace(/\n/g,' ').trim(),
        bg_color:  c.palette  || 'plum',
        label:     c.headline || '',
        sub:       c.sub      || '',
        poster_config: c,
        poster_img: posterImg,
        session_id: state.session.session_id,
        created_at: new Date().toISOString(),
      };
      state._projects = [newProject, ...(state._projects || [])];
      // reveal delete button now that we have a project_id
      const delBtn = document.getElementById('btn-delete-project');
      if (delBtn) delBtn.style.display = 'block';
    }
  } catch (_e) { /* silent — poster still usable without save */ }
}

window.saveProject = async () => {
  // Flush live inputs and render latest canvas first
  const c = state.session.customize;
  const hl = document.getElementById('c-headline');
  const sb = document.getElementById('c-sub');
  const ct = document.getElementById('c-cta');
  if (hl) c.headline = hl.value;
  if (sb) c.sub = sb.value;
  if (ct) c.cta = ct.value;
  let posterImg = state.session.poster || null;
  try { const cv = await posterToCanvas(); posterImg = cv.toDataURL('image/jpeg', 0.92); state.session.poster = posterImg; } catch(_e) {}

  // If already saved, update the existing record instead of inserting a new one
  if (state.session.project_id) {
    try {
      await API.apiUpdateProject(state.session.project_id, {
        title:        c.headline || 'Untitled Poster',
        bg_color:     c.palette  || 'plum',
        label:        c.headline || '',
        sub:          c.sub      || '',
        poster_config: c,
        session_id:   state.session.session_id || null,
        poster_img:   posterImg,
      });
      state._projects = (state._projects || []).map(p =>
        String(p.id || p.project_id || p._id) === String(state.session.project_id)
          ? { ...p, poster_config: c, title: c.headline || p.title, poster_img: posterImg }
          : p
      );
      showToast('✓ Project updated!');
    } catch (e) {
      showToast('Save failed: ' + e.message);
    }
    return;
  }
  // First time — insert new record
  try {
    const saved = await API.apiSaveProject({
      title:        c.headline || 'Untitled Poster',
      bg_color:     c.palette  || 'plum',
      label:        c.headline || '',
      sub:          c.sub      || '',
      chat_answers: state.session.brief    || {},
      poster_config: c,
      session_id:   state.session.session_id || null,
      poster_img:   posterImg,
    });
    const newId = saved?.project_id || saved?.id || saved?._id || null;
    state.session.project_id = newId;
    if (newId) {
      state._projects = [{ id: newId, title: c.headline || 'Untitled Poster',
        bg_color: c.palette || 'plum', label: c.headline || '', sub: c.sub || '',
        poster_config: c, poster_img: posterImg, session_id: state.session.session_id,
        created_at: new Date().toISOString() }, ...(state._projects || [])];
    }
    showToast('✓ Saved to My Projects!');
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
};

// ═══════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════
function buildProfile() {
  const root = document.getElementById('screen-profile');
  root.innerHTML = `
    ${navBar({ ctx: 'user', active: 'profile' })}
    <section class="profile">
      ${furnitureBg('furn-bg--subtle')}
      <div class="profile__inner">
        <div class="profile__head">
          <div class="profile__head__avatar" id="profile-init">L</div>
          <div class="profile__head__info">
            <h2 id="profile-name"></h2>
            <p id="profile-email"></p>
          </div>
        </div>

        <div class="card">
          <h3 class="display display--md" style="margin-bottom:8px">Account settings</h3>
          <p style="color:var(--ink-soft);margin-bottom:24px">Update your details · keep your account in sync.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
            <div class="field">
              <label class="field__label">Full name</label>
              <input class="field__input" id="edit-name" value="">
            </div>
            <div class="field">
              <label class="field__label">Email</label>
              <input class="field__input" id="edit-email" value="">
            </div>
          </div>
          <div style="display:flex;gap:10px;margin-top:8px">
            <button class="btn btn--primary" onclick="saveProfileChanges()">Save changes</button>
            <button class="btn btn--ghost" onclick="logout()">Log out</button>
          </div>
        </div>
      </div>
    </section>
  `;
}
window.saveProfileChanges = async () => {
  const name  = document.getElementById('edit-name')?.value?.trim();
  const email = document.getElementById('edit-email')?.value?.trim();
  if (!name || !email) { alert('Name and email are required.'); return; }
  try {
    await API.apiUpdateProfile({ name, email });
    state.user = { ...state.user, name, email };
    alert('✓ Profile saved!');
  } catch(e) { alert('Could not save: ' + e.message); }
};

onEnter.profile = () => {
  if (state.user) {
    document.getElementById('profile-name').textContent  = state.user.name;
    document.getElementById('profile-email').textContent = state.user.email;
    document.getElementById('profile-init').textContent  = state.user.name[0].toUpperCase();
    document.getElementById('edit-name').value  = state.user.name;
    document.getElementById('edit-email').value = state.user.email;
  }
};
window.logout = async () => {
  try { await API.apiLogout(); } catch(e) {}
  state.user     = null;
  state._projects = [];
  // reset session so stale poster data doesn't bleed into next login
  state.session = {
    image_id: null, file: null, preview: null,
    logo_file: null, logo_data: null, sam_point: null,
    session_id: null, prompt: '', text_options: [], text: null,
    poster: null, report: null, project_id: null, _fromHome: false,
    brief: {},
    customize: {
      headline: 'New\ncollection', sub: 'has now arrived',
      cta: 'Shop now', tag: 'Living Room · Product Ad',
      palette: 'plum', font: 'display', align: 'left',
      headlineFont: 'display', headlineAlign: 'left',
      subFont: 'display', subAlign: 'left',
      ctaFont: 'sans', ctaAlign: 'left',
      color: '#ffffff', size: 44,
      subColor: '#ffffffb3', subSize: 18,
      ctaColor: '#F76C6C', ctaTextColor: '#ffffff', ctaSize: 13,
    },
  };
  localStorage.removeItem('posttiva_screen');
  go('landing');
};