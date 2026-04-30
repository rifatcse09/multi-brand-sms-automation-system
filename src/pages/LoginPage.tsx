import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Card } from '../components/ui/Card'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: Location })?.from?.pathname ?? '/dashboard'

  const [email, setEmail] = useState('admin@spellsology.com')
  const [password, setPassword] = useState('Admin12345!')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isAuthenticated) {
    return <Navigate to={from} replace />
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        await login({ email: email.trim(), password })
        navigate(from, { replace: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed')
      } finally {
        setLoading(false)
      }
    })()
  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-md shadow-xl" padding="lg">
        <h1 className="text-center text-lg font-semibold tracking-tight text-slate-900">
          Sign in
        </h1>
        <p className="mt-1 text-center text-sm text-slate-500">Welcome back to your workspace.</p>
        <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label htmlFor="password" className="mb-0">
                Password
              </Label>
              <Link
                to="/reset-password"
                className="text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <Button type="submit" className="mt-2 w-full" size="lg" loading={loading}>
            Continue
          </Button>
          {error ? (
            <p className="text-center text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <p className="text-center text-xs text-slate-400">
            Default: admin@spellsology.com / Admin12345!
          </p>
        </form>
      </Card>
    </AuthLayout>
  )
}
