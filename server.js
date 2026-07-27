const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const net = require('net');
const Database = require('better-sqlite3');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// ─── Database Setup ───────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    login_attempts INTEGER DEFAULT 0,
    locked_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#6366f1',
    icon TEXT DEFAULT '🎯',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS habit_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
    UNIQUE(habit_id, date)
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ─── DB Migrations ────────────────────────────────────────────────────────────
const usersCols = db.prepare("PRAGMA table_info('users')").all();
if (!usersCols.find(c => c.name === 'is_admin')) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
  console.log('📦 Added is_admin column to users table');
}
if (!usersCols.find(c => c.name === 'login_attempts')) {
  db.exec("ALTER TABLE users ADD COLUMN login_attempts INTEGER DEFAULT 0");
}
if (!usersCols.find(c => c.name === 'locked_until')) {
  db.exec("ALTER TABLE users ADD COLUMN locked_until DATETIME");
}

// ─── Simple SMTP Email Sender (no external deps) ────────────────────────────
const EMAIL_HOST = process.env.EMAIL_HOST || '';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@habitflow.com';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function sendEmail(to, subject, htmlBody) {
  // If SMTP is configured, send via SMTP. Otherwise log to console.
  if (EMAIL_HOST && EMAIL_USER) {
    // Use net module to send SMTP
    const client = new net.Socket();
    let response = '';
    let step = 0;

    client.connect(EMAIL_PORT, EMAIL_HOST, () => {
      client.write(`EHLO habit-flow\r\n`);
    });

    client.on('data', (data) => {
      response += data.toString();
      if (step === 0) {
        client.write(`AUTH LOGIN\r\n`);
        step++;
      } else if (step === 1) {
        client.write(Buffer.from(EMAIL_USER).toString('base64') + '\r\n');
        step++;
      } else if (step === 2) {
        client.write(Buffer.from(EMAIL_PASS).toString('base64') + '\r\n');
        step++;
      } else if (step === 3) {
        client.write(`MAIL FROM:<${EMAIL_FROM}>\r\n`);
        step++;
      } else if (step === 4) {
        client.write(`RCPT TO:<${to}>\r\n`);
        step++;
      } else if (step === 5) {
        client.write('DATA\r\n');
        step++;
      } else if (step === 6) {
        const msg = [
          `From: ${EMAIL_FROM}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=utf-8',
          '',
          htmlBody,
          '.',
        ].join('\r\n');
        client.write(msg + '\r\n');
        step++;
      } else if (step === 7) {
        client.write('QUIT\r\n');
        client.destroy();
        console.log(`📧 Email sent to ${to}: ${subject}`);
      }
    });

    client.on('error', (err) => {
      console.log(`📧 Email send failed (${to}): ${err.message}. Falling back to console.`);
      console.log(`   --- EMAIL TO: ${to}`);
      console.log(`   SUBJECT: ${subject}`);
      console.log(`   BODY: ${htmlBody.replace(/<[^>]*>/g, '').substring(0, 200)}...`);
    });
  } else {
    // Console log for demo
    console.log('');
    console.log(`📧 --- EMAIL TO: ${to}`);
    console.log(`   SUBJECT: ${subject}`);
    const plainText = htmlBody.replace(/<[^>]*>/g, '');
    console.log(`   BODY: ${plainText.substring(0, 300)}...`);
    console.log('');
  }
}

// ─── Seed Admin User ──────────────────────────────────────────────────────────
const ADMIN_EMAIL = 'admin@habitflow.com';
const ADMIN_PASSWORD = 'Admin@123';
const ADMIN_USERNAME = 'Admin';

const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
if (!existingAdmin) {
  const hashed = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare('INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, 1)')
    .run(ADMIN_USERNAME, ADMIN_EMAIL, hashed);
  console.log(`🔐 Admin seeded: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'habit-tracker-secret-key-change-in-production';

app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for auth endpoints
const authLimiter = new RateLimiterMemory({
  points: 10,
  duration: 60,
});

// ─── Middleware ────────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
// ─── Forgot Password ─────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    // Return success anyway to prevent email enumeration
    return res.json({ message: 'If that email exists, a reset link has been generated.', token: null });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour

  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(user.id, token, expires);

  // In production, send this via email. Here we return it for demo purposes.
  res.json({
    message: 'Password reset link generated. Check your email.',
    token: token // In production, remove this and send via email
  });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const resetToken = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime(\'now\')'
  ).get(token);

  if (!resetToken) return res.status(400).json({ error: 'Invalid or expired reset token' });

  const hashedPassword = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, resetToken.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);

  res.json({ message: 'Password reset successful! You can now sign in.' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    await authLimiter.consume(req.ip);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const stmt = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)');
    const result = stmt.run(username, email, hashedPassword);

    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: result.lastInsertRowid, username, email } });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    await authLimiter.consume(req.ip);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // ── Check account lockout ──
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    if (lockedUntil > new Date()) {
      const remaining = Math.ceil((lockedUntil - new Date()) / 60000);
      return res.status(429).json({
        error: `Account locked. Try again in ${remaining} minute(s).`,
        locked: true,
        remaining_minutes: remaining
      });
    } else {
      // Lock expired, reset
      db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    }
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    const attempts = (user.login_attempts || 0) + 1;
    if (attempts >= 5) {
      const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, lockUntil, user.id);
      return res.status(429).json({
        error: 'Too many failed attempts. Account locked for 5 minutes.',
        locked: true,
        remaining_minutes: 5
      });
    } else {
      db.prepare('UPDATE users SET login_attempts = ? WHERE id = ?').run(attempts, user.id);
      return res.status(401).json({
        error: `Invalid email or password. ${5 - attempts} attempt(s) remaining.`,
        attempts_remaining: 5 - attempts
      });
    }
  }

  // Successful login — reset attempts
  db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  const token = jwt.sign({
    id: user.id,
    username: user.username,
    is_admin: user.is_admin
  }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      is_admin: !!user.is_admin
    }
  });
});

// ─── Update forgot-password to send email ─────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.json({ message: 'If that email exists, a reset link has been sent.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 3600000).toISOString();

  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(user.id, token, expires);

  const resetUrl = `${BASE_URL}/reset-password?token=${token}`;
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;
                background:#0a0a1a;color:#fff;border-radius:16px;">
      <div style="text-align:center;font-size:48px;margin-bottom:12px;">🌊</div>
      <h2 style="text-align:center;color:#a78bfa;margin-bottom:16px;">Habit Flow — Password Reset</h2>
      <p style="color:rgba(255,255,255,0.7);line-height:1.6;margin-bottom:20px;">
        Hello <strong>${user.username}</strong>, you requested a password reset.
        Click the button below to set a new password:
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${resetUrl}"
           style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);
                  color:#fff;text-decoration:none;border-radius:10px;font-weight:600;">
          🔐 Reset Password
        </a>
      </div>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;">
        This link expires in 1 hour. If you didn't request this, ignore this email.
      </p>
      <p style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:16px;text-align:center;">
        Habit Flow &bull; Build better habits, one day at a time
      </p>
    </div>
  `;

  sendEmail(email, 'Habit Flow — Password Reset', htmlBody);

  // Also return token for demo (frontend uses this for inline reset)
  res.json({
    message: 'Password reset link sent to your email.',
    token: token,
    email_sent: true
  });
});

// ─── Update register to include is_admin ────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    await authLimiter.consume(req.ip);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const stmt = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)');
    const result = stmt.run(username, email, hashedPassword);

    const token = jwt.sign({
      id: result.lastInsertRowid,
      username,
      is_admin: 0
    }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: result.lastInsertRowid,
        username,
        email,
        is_admin: false
      }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Habit Routes ─────────────────────────────────────────────────────────────
app.get('/api/habits', authenticateToken, (req, res) => {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(habits);
});

app.post('/api/habits', authenticateToken, (req, res) => {
  const { name, description, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Habit name is required' });

  const stmt = db.prepare('INSERT INTO habits (user_id, name, description, color, icon) VALUES (?, ?, ?, ?, ?)');
  const result = stmt.run(req.user.id, name, description || '', color || '#6366f1', icon || '🎯');

  const habit = db.prepare('SELECT * FROM habits WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(habit);
});

app.put('/api/habits/:id', authenticateToken, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  const { name, description, color, icon } = req.body;
  db.prepare('UPDATE habits SET name = ?, description = ?, color = ?, icon = ? WHERE id = ?')
    .run(name || habit.name, description ?? habit.description, color || habit.color, icon || habit.icon, req.params.id);

  const updated = db.prepare('SELECT * FROM habits WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/habits/:id', authenticateToken, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  db.prepare('DELETE FROM habits WHERE id = ?').run(req.params.id);
  res.json({ message: 'Habit deleted' });
});

// ─── Track Routes ─────────────────────────────────────────────────────────────
app.post('/api/habits/:id/track', authenticateToken, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  const { date, note } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });

  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO habit_tracks (habit_id, date, note) VALUES (?, ?, ?)');
    const result = stmt.run(req.params.id, date, note || '');
    res.status(result.changes > 0 ? 201 : 200).json({ tracked: result.changes > 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to track habit' });
  }
});

app.delete('/api/habits/:id/track/:date', authenticateToken, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  db.prepare('DELETE FROM habit_tracks WHERE habit_id = ? AND date = ?').run(req.params.id, req.params.date);
  res.json({ message: 'Track record deleted' });
});

app.get('/api/habits/:id/tracks', authenticateToken, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  const { month, year } = req.query;
  let tracks;
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    tracks = db.prepare("SELECT * FROM habit_tracks WHERE habit_id = ? AND date LIKE ?").all(req.params.id, `${prefix}%`);
  } else {
    tracks = db.prepare('SELECT * FROM habit_tracks WHERE habit_id = ?').all(req.params.id);
  }
  res.json(tracks);
});

app.get('/api/tracks/range', authenticateToken, (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

  const habits = db.prepare('SELECT id FROM habits WHERE user_id = ?').all(req.user.id);
  const habitIds = habits.map(h => h.id);
  if (habitIds.length === 0) return res.json([]);

  const placeholders = habitIds.map(() => '?').join(',');
  const tracks = db.prepare(
    `SELECT * FROM habit_tracks WHERE habit_id IN (${placeholders}) AND date >= ? AND date <= ?`
  ).all(...habitIds, start, end);

  res.json(tracks);
});

// ─── Admin Routes ───────────────────────────────────────────────────────────────
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, email, is_admin, login_attempts, locked_until, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json(users.map(u => ({
    ...u,
    is_admin: !!u.is_admin,
    is_locked: u.locked_until ? new Date(u.locked_until + 'Z') > new Date() : false
  })));
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id);
  // Prevent self-deletion
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ message: `User "${user.username}" deleted` });
});

app.put('/api/admin/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hashed = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password = ?, login_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hashed, user.id);

  res.json({ message: `Password updated for "${user.username}"` });
});

app.put('/api/admin/users/:id/unlock', authenticateToken, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  res.json({ message: `User "${user.username}" unlocked` });
});

// ─── User Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', authenticateToken, (req, res) => {
  const habits = db.prepare('SELECT id, name, color, icon FROM habits WHERE user_id = ?').all(req.user.id);
  const habitIds = habits.map(h => h.id);

  const stats = habits.map(habit => {
    const total = db.prepare('SELECT COUNT(*) as count FROM habit_tracks WHERE habit_id = ?').get(habit.id).count;
    // Current streak
    const tracks = db.prepare('SELECT date FROM habit_tracks WHERE habit_id = ? ORDER BY date DESC').all(habit.id);
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < tracks.length; i++) {
      const trackDate = new Date(tracks[i].date + 'T00:00:00');
      const expectedDate = new Date(today);
      expectedDate.setDate(expectedDate.getDate() - i);
      if (trackDate.toDateString() === expectedDate.toDateString()) {
        streak++;
      } else {
        break;
      }
    }

    // Current month count
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthCount = db.prepare("SELECT COUNT(*) as count FROM habit_tracks WHERE habit_id = ? AND date LIKE ?").get(habit.id, `${monthPrefix}%`).count;

    return { ...habit, totalTracks: total, currentStreak: streak, monthCount };
  });

  res.json(stats);
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Habit Tracker running at http://localhost:${PORT}`);
});
