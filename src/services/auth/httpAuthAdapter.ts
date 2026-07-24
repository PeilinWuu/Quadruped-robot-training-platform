import type { AuthAdapter, LoginInput, RegisterInput } from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: '请求失败' })) as { message?: string }
    throw new Error(body.message ?? '请求失败')
  }
  return response.status === 204 ? undefined as T : await response.json() as T
}

export const httpAuthAdapter: AuthAdapter = {
  me: () => request('/api/auth/me'),
  login: (input: LoginInput) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  register: (input: RegisterInput) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
}
