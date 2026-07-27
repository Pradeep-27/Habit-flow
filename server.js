const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
`);

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

// ─── Auth Routes ──────────────────────────────────────────────────────────────
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

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
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
