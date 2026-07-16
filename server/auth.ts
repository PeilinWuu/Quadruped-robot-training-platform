import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const KEY_LENGTH = 64

// 每个密码使用独立随机盐；存储格式中保留算法和盐，方便以后升级哈希方案。
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, KEY_LENGTH) as Buffer
  return `scrypt$${salt}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, encoded] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !encoded) return false
  const expected = Buffer.from(encoded, 'hex')
  const actual = await scrypt(password, salt, expected.length) as Buffer
  // 使用恒定时间比较，降低通过响应时间推测密码摘要的风险。
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createSessionToken(): string { return randomBytes(32).toString('base64url') }
// 数据库只保存令牌摘要；浏览器 Cookie 中的原始令牌不会明文落库。
export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex') }

// 前后端都会校验密码，服务端校验才是最终安全边界。
export function validatePassword(password: string): string | null {
  if (password.length < 8) return '密码至少需要 8 个字符'
  if (password.length > 128) return '密码不能超过 128 个字符'
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码必须同时包含字母和数字'
  return null
}
