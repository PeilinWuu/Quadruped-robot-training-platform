import { invoke } from '@tauri-apps/api/core'
import type { AuthAdapter, LoginInput, RegisterInput } from './types'

interface CommandError {
  code?: unknown
  message?: unknown
}

function commandError(error: unknown): Error {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as CommandError
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return new Error(candidate.message)
    }
  }
  return new Error('桌面认证请求失败')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error: unknown) {
    throw commandError(error)
  }
}

export const tauriAuthAdapter: AuthAdapter = {
  me: () => call('auth_current_user'),
  login: (input: LoginInput) => call('auth_login', { input }),
  register: (input: RegisterInput) => call('auth_register', { input }),
  logout: () => call('auth_logout'),
}
