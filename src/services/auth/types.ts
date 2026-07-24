export interface AuthUser {
  id: number
  username: string
  email: string
  displayName: string
  role: string
  createdAt: string
}

export interface LoginInput {
  account: string
  password: string
}

export interface RegisterInput {
  username: string
  email: string
  displayName: string
  password: string
}

export interface AuthResponse {
  user: AuthUser
}

export interface AuthAdapter {
  me(): Promise<AuthResponse>
  login(input: LoginInput): Promise<AuthResponse>
  register(input: RegisterInput): Promise<AuthResponse>
  logout(): Promise<void>
}
