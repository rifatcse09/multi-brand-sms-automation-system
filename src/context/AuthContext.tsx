import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { loginWithWorker } from '../services/smsWorkerApi'

type AuthContextValue = {
  email: string | null
  token: string | null
  isAuthenticated: boolean
  login: (input: { email: string; password: string }) => Promise<void>
  logout: () => void
  setEmail: (next: string) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const STORAGE_KEY = 'sms-dashboard-user-email'
const TOKEN_STORAGE_KEY = 'sms-dashboard-auth-token'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY)
    } catch {
      return null
    }
  })

  const login = useCallback(async (input: { email: string; password: string }) => {
    const res = await loginWithWorker(input)
    setEmail(res.user.email)
    setToken(res.token)
    try {
      localStorage.setItem(STORAGE_KEY, res.user.email)
      localStorage.setItem(TOKEN_STORAGE_KEY, res.token)
    } catch {
      /* ignore */
    }
  }, [])

  const logout = useCallback(() => {
    setEmail(null)
    setToken(null)
    try {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const setEmailOnly = useCallback((next: string) => {
    setEmail(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      email,
      token,
      isAuthenticated: Boolean(email && token),
      login,
      logout,
      setEmail: setEmailOnly,
    }),
    [email, token, login, logout, setEmailOnly],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
