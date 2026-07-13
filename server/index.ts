import express, { type NextFunction, type Request, type Response } from 'express'
import cookieParser from 'cookie-parser'
import { db, type DbUser } from './database.ts'
import { createSessionToken, hashPassword, hashToken, validatePassword, verifyPassword } from './auth.ts'

const app = express()
const port = Number(process.env.API_PORT ?? 3001)
const sessionDays = 7
const cookieName = 'fire_rescue_session'
const attempts = new Map<string, { count: number; resetAt: number }>()

app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))
app.use(cookieParser())
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  next()
})

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const publicUser = (user: DbUser) => ({ id: user.id, username: user.username, email: user.email, displayName: user.display_name, role: user.role, createdAt: user.created_at })
const setSession = (res: Response, userId: number) => {
  const token = createSessionToken()
  const expires = new Date(Date.now() + sessionDays * 86400000)
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires.toISOString())
  res.cookie(cookieName, token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', expires })
}
const clearSession = (req: Request, res: Response) => {
  const token = req.cookies[cookieName] as string | undefined
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' })
}
const currentUser = (req: Request): DbUser | undefined => {
  const token = req.cookies[cookieName] as string | undefined
  if (!token) return undefined
  return db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(hashToken(token), new Date().toISOString()) as DbUser | undefined
}
const rateLimit = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? 'unknown'; const now = Date.now(); const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) { attempts.set(key, { count: 1, resetAt: now + 10 * 60_000 }); next(); return }
  if (entry.count >= 20) { res.status(429).json({ message: '尝试次数过多，请稍后再试' }); return }
  entry.count += 1; next()
}

app.get('/api/auth/me', (req, res) => { const user = currentUser(req); res.status(user ? 200 : 401).json(user ? { user: publicUser(user) } : { message: '未登录' }) })
app.post('/api/auth/register', rateLimit, async (req, res, next) => {
  try {
    const username = clean(req.body.username); const email = clean(req.body.email).toLowerCase(); const displayName = clean(req.body.displayName); const password = typeof req.body.password === 'string' ? req.body.password : ''
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) { res.status(400).json({ message: '用户名需为 3–24 位字母、数字或下划线' }); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { res.status(400).json({ message: '请输入有效的邮箱地址' }); return }
    if (displayName.length < 2 || displayName.length > 32) { res.status(400).json({ message: '姓名需为 2–32 个字符' }); return }
    const passwordError = validatePassword(password); if (passwordError) { res.status(400).json({ message: passwordError }); return }
    const duplicate = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email)
    if (duplicate) { res.status(409).json({ message: '用户名或邮箱已被注册' }); return }
    const passwordHash = await hashPassword(password)
    const result = db.prepare('INSERT INTO users (username, email, display_name, password_hash) VALUES (?, ?, ?, ?)').run(username, email, displayName, passwordHash)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as DbUser
    setSession(res, user.id); res.status(201).json({ user: publicUser(user) })
  } catch (error) { next(error) }
})
app.post('/api/auth/login', rateLimit, async (req, res, next) => {
  try {
    const account = clean(req.body.account); const password = typeof req.body.password === 'string' ? req.body.password : ''
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(account, account) as DbUser | undefined
    if (!user || !(await verifyPassword(password, user.password_hash))) { res.status(401).json({ message: '账号或密码错误' }); return }
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
    setSession(res, user.id); res.json({ user: publicUser(user) })
  } catch (error) { next(error) }
})
app.post('/api/auth/logout', (req, res) => { clearSession(req, res); res.status(204).end() })
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ message: '服务器处理请求失败' }) })
app.listen(port, () => console.log(`Auth API listening on http://localhost:${port}`))
