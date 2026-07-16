export interface AuthUser { id: number; username: string; email: string; displayName: string; role: string; createdAt: string }
export interface LoginInput { account: string; password: string }
export interface RegisterInput { username: string; email: string; displayName: string; password: string }

// 认证请求统一携带 Cookie；HttpOnly 会话令牌无法也不应由前端 JavaScript 读取。
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({ message: '请求失败' })) as { message?: string }; throw new Error(body.message ?? '请求失败') }
  return response.status === 204 ? undefined as T : await response.json() as T
}

export const authService = {
  // 页面刷新时通过服务端校验 Cookie，而不是相信浏览器本地保存的用户信息。
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  login: (input: LoginInput) => request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  register: (input: RegisterInput) => request<{ user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
}
