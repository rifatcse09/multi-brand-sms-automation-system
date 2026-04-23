import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
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

  const [email, setEmail] = useState('ops@example.com')
  const [password, setPassword] = useState('password')
  const [loading, setLoading] = useState(false)

  if (isAuthenticated) {
    return <Navigate to={from} replace />
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    window.setTimeout(() => {
      login(email.trim() || 'ops@example.com')
      setLoading(false)
      navigate(from, { replace: true })
    }, 450)
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
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="mt-2 w-full" size="lg" loading={loading}>
            Continue
          </Button>
        </form>
      </Card>
    </AuthLayout>
  )
}
