import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3000)
const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) throw new Error('Set JWT_SECRET in your environment before starting the server.')
fs.mkdirSync(path.join(here, '..', 'uploads'), { recursive: true })
const db = new Database(path.join(here, 'campusfix.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','admin')),
 student_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reports (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 description TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL,
 location TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Submitted', photo_path TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS reports_user_idx ON reports(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS report_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, actor_id TEXT REFERENCES users(id), status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO report_events (report_id, status, note, created_at) SELECT r.id, r.status, 'Complaint submitted', r.created_at FROM reports r WHERE NOT EXISTS (SELECT 1 FROM report_events e WHERE e.report_id=r.id);
`)

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const adminPassword = process.env.ADMIN_PASSWORD
if (adminEmail && adminPassword) {
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail)
  if (!exists) db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(randomUUID(), process.env.ADMIN_NAME || 'Campus Administrator', adminEmail, bcrypt.hashSync(adminPassword, 12), 'admin')
}
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(express.json({ limit: '1mb' }))
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }))
const uploads = multer({
  storage: multer.diskStorage({ destination: path.join(here, '..', 'uploads'), filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp','image/heic'].includes(file.mimetype)),
})
const safeUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, studentId: row.student_id })
const issueToken = user => jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: '8h', issuer: 'campusfix' })
function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  try {
    const claims = jwt.verify(token, jwtSecret, { issuer: 'campusfix' })
    const user = db.prepare('SELECT id,name,email,role,student_id FROM users WHERE id=?').get(claims.sub)
    if (!user || user.role !== claims.role) return res.status(401).json({ error: 'Your session is no longer valid.' })
    req.user = user
    next()
  } catch { return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }) }
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access is required.' })
const reportSelect = `SELECT r.*, u.name AS student_name, u.email AS student_email, u.student_id AS student_id FROM reports r JOIN users u ON u.id=r.user_id`
function formatReport(row, includeStudent = false) {
  const report = { id: row.id, title: row.title, description: row.description, category: row.category, priority: row.priority, location: row.location, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, photoUrl: row.photo_path ? `/api/reports/${row.id}/photo` : null }
  if (includeStudent) report.student = { name: row.student_name, email: row.student_email, studentId: row.student_id }
  return report
}
function classify(text) {
  const t = text.toLowerCase()
  if (/fire|smoke|sparks|exposed wire|gas leak|danger|injur/.test(t)) return { category: /fire|smoke/.test(t) ? 'Safety' : 'Electrical', priority: 'Urgent' }
  if (/leak|tap|toilet|pipe|water|drain|flood/.test(t)) return { category: 'Plumbing', priority: /flood|burst/.test(t) ? 'High' : 'Medium' }
  if (/light|wire|power|electric|socket/.test(t)) return { category: 'Electrical', priority: 'Medium' }
  if (/clean|trash|rubbish|spill|dirty/.test(t)) return { category: 'Cleaning', priority: 'Low' }
  if (/chair|desk|bench|table|door|window|furniture/.test(t)) return { category: 'Furniture', priority: 'Low' }
  return { category: 'Other', priority: 'Medium' }
}
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, studentId } = req.body || {}
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80 || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 8 characters.' })
  const normalizedEmail = email.trim().toLowerCase()
  try {
    const id = randomUUID()
    db.prepare('INSERT INTO users (id,name,email,password_hash,role,student_id) VALUES (?,?,?,?,?,?)')
      .run(id, name.trim(), normalizedEmail, await bcrypt.hash(password, 12), 'student', typeof studentId === 'string' ? studentId.trim().slice(0,40) : null)
    const user = db.prepare('SELECT id,name,email,role,student_id FROM users WHERE id=?').get(id)
    res.status(201).json({ token: issueToken(user), user: safeUser(user) })
  } catch (error) { res.status(409).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'An account with this email already exists.' : 'Could not create your account.' }) }
})
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Enter your email and password.' })
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase())
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' })
  res.json({ token: issueToken(user), user: safeUser(user) })
})
app.get('/api/auth/me', auth, (req, res) => res.json({ user: safeUser(req.user) }))
app.get('/api/reports', auth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`${reportSelect} ORDER BY r.created_at DESC`).all()
    : db.prepare(`${reportSelect} WHERE r.user_id=? ORDER BY r.created_at DESC`).all(req.user.id)
  res.json({ reports: rows.map(row => formatReport(row, req.user.role === 'admin')) })
})
app.post('/api/reports/analyze', auth, (req, res) => {
  const text = `${req.body?.description || ''} ${req.body?.location || ''}`
  if (!text.trim()) return res.status(400).json({ error: 'Add a description to get suggestions.' })
  res.json({ ...classify(text), source: 'prototype-rules' })
})
app.post('/api/reports', auth, uploads.single('photo'), (req, res) => {
  const { description, location } = req.body || {}
  if (typeof description !== 'string' || description.trim().length < 5 || description.trim().length > 2000 || typeof location !== 'string' || location.trim().length < 2 || location.trim().length > 180) {
    if (req.file) fs.unlinkSync(req.file.path)
    return res.status(400).json({ error: 'Add a clear description and location.' })
  }
  const suggestions = classify(description)
  const requestedCategory = req.body.category
  const requestedPriority = req.body.priority
  const categories = ['Plumbing','Electrical','Furniture','Cleaning','Safety','Other']
  const priorities = ['Low','Medium','High','Urgent']
  const category = categories.includes(requestedCategory) ? requestedCategory : suggestions.category
  const priority = priorities.includes(requestedPriority) ? requestedPriority : suggestions.priority
  const id = `CF-${randomUUID().slice(0,8).toUpperCase()}`
  const title = description.trim().split(/[.!?]/)[0].slice(0,100)
  db.prepare('INSERT INTO reports (id,user_id,title,description,category,priority,location,photo_path) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, title, description.trim(), category, priority, location.trim(), req.file?.filename || null)
  const row = db.prepare(`${reportSelect} WHERE r.id=?`).get(id)
  db.prepare('INSERT INTO report_events (report_id,actor_id,status,note) VALUES (?,?,?,?)').run(id, req.user.id, 'Submitted', 'Complaint submitted');
  res.status(201).json({ report: formatReport(row) })
})
app.get('/api/reports/:id', auth, (req, res) => {
  const row = db.prepare(`${reportSelect} WHERE r.id=?`).get(req.params.id)
  if (!row || (req.user.role !== 'admin' && row.user_id !== req.user.id)) return res.status(404).json({ error: 'Report not found.' })
  const events = db.prepare('SELECT e.status,e.note,e.created_at,u.name AS actor_name,u.role AS actor_role FROM report_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.report_id=? ORDER BY e.id').all(req.params.id)
  res.json({ report: { ...formatReport(row, req.user.role === 'admin'), history: events.map(event => ({ status: event.status, note: event.note, createdAt: event.created_at, actor: event.actor_name, actorRole: event.actor_role })) } })
})
app.get('/api/reports/:id/photo', auth, (req, res) => {
  const row = db.prepare('SELECT user_id,photo_path FROM reports WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Report not found.' })
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(404).json({ error: 'Report not found.' })
  if (!row.photo_path) return res.status(404).json({ error: 'This report has no photo.' })
  res.sendFile(path.join(here, '..', 'uploads', path.basename(row.photo_path)))
})
app.patch('/api/reports/:id/status', auth, adminOnly, (req, res) => {
  const allowed = ['Submitted','Assigned','In progress','Resolved']
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: 'Choose a valid report status.' })
  const updateStatus = db.transaction(() => {
    const result = db.prepare('UPDATE reports SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.status, req.params.id)
    if (!result.changes) return false
    db.prepare('INSERT INTO report_events (report_id,actor_id,status,note) VALUES (?,?,?,?)').run(req.params.id, req.user.id, req.body.status, 'Status changed to ' + req.body.status)
    return true
  })
  if (!updateStatus()) return res.status(404).json({ error: 'Report not found.' })
  const row = db.prepare(`${reportSelect} WHERE r.id=?`).get(req.params.id)
  res.json({ report: formatReport(row, true) })
})
app.delete('/api/reports/:id', auth, adminOnly, (req, res) => {
  const row = db.prepare('SELECT photo_path FROM reports WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Report not found.' })
  db.transaction(() => db.prepare('DELETE FROM reports WHERE id=?').run(req.params.id))()
  if (row.photo_path) {
    const uploadsDir = path.resolve(here, '..', 'uploads')
    const photoPath = path.resolve(uploadsDir, path.basename(row.photo_path))
    if (path.dirname(photoPath) === uploadsDir) {
      try { fs.unlinkSync(photoPath) } catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove complaint photo:', error.message) }
    }
  }
  res.status(204).end()
})
app.get('/api/admin/summary', auth, adminOnly, (_req, res) => {
  const totals = db.prepare(`SELECT COUNT(*) total, SUM(status IN ('Submitted','Assigned','In progress')) open, SUM(status='Resolved') resolved FROM reports`).get()
  const categories = db.prepare('SELECT category,COUNT(*) count FROM reports GROUP BY category ORDER BY count DESC').all()
  res.json({ total: totals.total || 0, open: totals.open || 0, resolved: totals.resolved || 0, categories })
})
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo must be 10 MB or smaller.' : err.message })
  console.error(err)
  res.status(500).json({ error: 'Something went wrong. Please try again.' })
})
app.listen(port, () => console.log(`CampusFix API listening at http://localhost:${port}`))

