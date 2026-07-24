import { httpAuthAdapter } from './auth/httpAuthAdapter'
import { isDesktopRuntime } from './auth/runtime'
import { tauriAuthAdapter } from './auth/tauriAuthAdapter'
import type { AuthAdapter, LoginInput, RegisterInput } from './auth/types'

const adapter: AuthAdapter = isDesktopRuntime() ? tauriAuthAdapter : httpAuthAdapter

// 组件只依赖这个稳定入口；浏览器保留 HTTP/Cookie，Tauri 使用 Rust commands。
export const authService = {
  me: () => adapter.me(),
  login: (input: LoginInput) => adapter.login(input),
  register: (input: RegisterInput) => adapter.register(input),
  logout: () => adapter.logout(),
}

export type { AuthUser, LoginInput, RegisterInput } from './auth/types'
