require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');
const db       = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────────────────────
// EMAIL — sends from posttivaweb@gmail.com
// ─────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ─────────────────────────────────────────────
// MIDDLEWARE — checks Bearer token on every
// protected route
// ─────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not logged in' });
  }
  const token = auth.split(' ')[1];
  const result = await db.query(
    'SELECT user_id FROM sessions WHERE token=$1 AND expires_at > now()',
    [token]
  );
  if (!result.rows[0]) {
    return res.status(401).json({ message: 'Session expired — please log in again' });
  }
  req.userId = result.rows[0].user_id;
  next();
}

// ─────────────────────────────────────────────
// SIGN UP
// • Checks email already exists → clear message
// • Hashes password with bcrypt
// • Saves to users table
// • Creates session token
// ─────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    // Check duplicate email
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows[0]) {
      return res.status(400).json({ message: 'This email already has an account. Please sign in instead.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES($1,$2,$3) RETURNING id, username, email',
      [name, email, hash]
    );
    const token = crypto.randomUUID();
    await db.query(
      "INSERT INTO sessions (user_id, token, expires_at) VALUES($1,$2, now()+interval'1 day')",
      [user.rows[0].id, token]
    );
    console.log('✓ Signed up:', email);
    res.json({ user: { name: user.rows[0].username, email: user.rows[0].email }, token });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ message: 'Server error — please try again.' });
  }
});

// ─────────────────────────────────────────────
// LOGIN
// • Checks email exists in database
// • Checks password matches bcrypt hash
// • Both wrong  → same message (security)
// • Correct → returns token + user info
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }
    const result = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!result.rows[0]) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    const match = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    const token  = crypto.randomUUID();
    const expiry = rememberMe ? '30 days' : '1 day';
    await db.query(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES($1,$2, now()+interval'${expiry}')`,
      [result.rows[0].id, token]
    );
    console.log('✓ Logged in:', email);
    res.json({ user: { name: result.rows[0].username, email: result.rows[0].email }, token });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: 'Server error — please try again.' });
  }
});

// ─────────────────────────────────────────────
// FORGOT PASSWORD — Step 1
// • Checks email exists
// • Generates 6-digit code
// • Saves code in password_resets table (15 min)
// • Sends code to user's email
// ─────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await db.query('SELECT id, username FROM users WHERE email=$1', [email]);
    if (!user.rows[0]) {
      return res.status(404).json({ message: 'No account found with this email address.' });
    }

    // Delete any old codes for this user
    await db.query('DELETE FROM password_resets WHERE user_id=$1', [user.rows[0].id]);

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      "INSERT INTO password_resets (user_id, token, expires_at) VALUES($1,$2, now()+interval'15 minutes')",
      [user.rows[0].id, code]
    );

    // Send email
    await mailer.sendMail({
      from: `"Posttiva" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Posttiva password reset code',
      html: `
        <div style="font-family:Outfit,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:28px;font-weight:700;color:#4B1D3F;letter-spacing:-1px">Posttiva</div>
          </div>
          <h2 style="font-size:20px;color:#1a1a1a;margin-bottom:8px">Reset your password</h2>
          <p style="color:#555;font-size:15px;margin-bottom:24px">Hi ${user.rows[0].username}, use the code below to reset your Posttiva password.</p>
          <div style="background:#F9F5F7;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
            <div style="font-size:42px;font-weight:700;letter-spacing:12px;color:#4B1D3F">${code}</div>
          </div>
          <p style="color:#888;font-size:13px">This code expires in <strong>15 minutes</strong>. If you did not request this, ignore this email.</p>
          <hr style="border:none;border-top:1px solid #f0e8f0;margin:24px 0">
          <p style="color:#bbb;font-size:12px;text-align:center">Posttiva · AI Poster Studio · PNU · Riyadh</p>
        </div>
      `
    });

    console.log('✓ Reset code sent to:', email);
    res.json({ ok: true, message: 'Verification code sent to your email.' });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ message: 'Could not send email — please try again.' });
  }
});

// ─────────────────────────────────────────────
// RESET PASSWORD — Step 2
// • Checks code matches + not expired
// • Updates password hash in users table
// • Marks code as used
// ─────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, code and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    const user = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!user.rows[0]) {
      return res.status(404).json({ message: 'No account found with this email.' });
    }
    const reset = await db.query(
      'SELECT * FROM password_resets WHERE user_id=$1 AND token=$2 AND expires_at>now() AND used=false',
      [user.rows[0].id, code]
    );
    if (!reset.rows[0]) {
      return res.status(400).json({ message: 'Invalid or expired code. Please request a new one.' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [hash, user.rows[0].id]);
    await db.query('UPDATE password_resets SET used=true WHERE user_id=$1', [user.rows[0].id]);
    console.log('✓ Password reset for:', email);
    res.json({ ok: true, message: 'Password updated successfully.' });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ message: 'Server error — please try again.' });
  }
});

// ─────────────────────────────────────────────
// UPDATE PROFILE — username and email
// ─────────────────────────────────────────────
app.put('/api/user/profile', requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (email) {
      const taken = await db.query('SELECT id FROM users WHERE email=$1 AND id!=$2', [email, req.userId]);
      if (taken.rows[0]) return res.status(400).json({ message: 'This email is already used by another account.' });
    }
    await db.query(
      'UPDATE users SET username=$1, email=$2, updated_at=now() WHERE id=$3',
      [name, email, req.userId]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// UPDATE PASSWORD — from profile settings
// ─────────────────────────────────────────────
app.put('/api/user/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    const ok   = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
    if (!ok) return res.status(400).json({ message: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [hash, req.userId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// SAVE PROJECT — full poster config to database
// ─────────────────────────────────────────────
app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const { title, bg_color, label, sub, chat_answers, poster_config, session_id, poster_img } = req.body;
    const result = await db.query(
      `INSERT INTO projects (user_id, title, bg_color, label, sub, chat_answers, poster_config, session_id, poster_img)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.userId, title || 'Untitled Poster', bg_color, label, sub,
       JSON.stringify(chat_answers || {}), JSON.stringify(poster_config || {}), session_id || null, poster_img || null]
    );
    console.log('✓ Project saved:', result.rows[0].id);
    res.json(result.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// GET ALL PROJECTS — for the home and profile screens
// ─────────────────────────────────────────────
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// UPDATE PROJECT — saves changes to existing project
// Always checks user_id for security
// ─────────────────────────────────────────────
app.put('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const { title, bg_color, label, sub, poster_config, session_id, poster_img } = req.body;
    const result = await db.query(
      `UPDATE projects SET title=$1, bg_color=$2, label=$3, sub=$4,
       poster_config=$5, session_id=$6, poster_img=$7
       WHERE id=$8 AND user_id=$9 RETURNING id`,
      [title || 'Untitled Poster', bg_color, label, sub,
       JSON.stringify(poster_config || {}), session_id || null, poster_img || null,
       req.params.id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ message: 'Project not found.' });
    console.log('✓ Project updated:', req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// DELETE PROJECT — removes from database
// Always checks user_id for security
// ─────────────────────────────────────────────
app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM projects WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    console.log('✓ Project deleted:', req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// SAVE RATING — 5-star feedback
// ON CONFLICT updates existing rating
// ─────────────────────────────────────────────
app.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    const { project_id, rating, session_id } = req.body;
    if (project_id) {
      await db.query(
        `INSERT INTO feedback (user_id, project_id, rating)
         VALUES($1,$2,$3)
         ON CONFLICT (user_id, project_id) DO UPDATE SET rating=$3`,
        [req.userId, project_id, rating]
      );
    }
    console.log('✓ Rating saved:', rating, 'stars');
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// LOGOUT — deletes session from database
// ─────────────────────────────────────────────
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await db.query('DELETE FROM sessions WHERE token=$1', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Server error.' }); }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('✓ Posttiva DB server  →  http://localhost:' + PORT);
  console.log('✓ Database            →', process.env.DATABASE_URL ? 'Connected' : '❌ NOT SET');
  console.log('✓ Email sender        →', process.env.SMTP_USER   || '❌ NOT SET');
  console.log('');
});