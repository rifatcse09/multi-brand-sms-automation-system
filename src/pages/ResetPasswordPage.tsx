import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AuthLayout } from '../components/layout/AuthLayout'
import { Card } from '../components/ui/Card'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import {
  forgotPasswordWithWorker,
  resetPasswordWithWorker,
} from '../services/smsWorkerApi'

export function ResetPasswordPage() {
  const [email, setEmail] = useState('admin@spellsology.com')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const sendCode = () => {
    setError(null)
    setInfo(null)
    if (!email.trim()) {
      setError('Enter your email first.')
      return
    }
    setSendingCode(true)
    void (async () => {
      try {
        const res = await forgotPasswordWithWorker({ email: email.trim() })
        if (res.sentToOwner) {
          setInfo(`Reset code sent to owner number ${res.ownerPhoneMasked ?? ''}`.trim())
        } else {
          setInfo('Reset code requested. Check owner SMS logs.')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to request reset code')
      } finally {
        setSendingCode(false)
      }
    })()
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (code.trim().length < 4) {
      setError('Enter the reset code sent to owner number.')
      return
    }
    setLoading(true)
    void (async () => {
      try {
        await resetPasswordWithWorker({
          email: email.trim(),
          code: code.trim(),
          newPassword: password,
        })
        setDone(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Reset failed')
      } finally {
        setLoading(false)
      }
    })()
  }

  return (
    <AuthLayout>
      <Card className="w-full max-w-md shadow-xl" padding="lg">
        <h1 className="text-center text-lg font-semibold tracking-tight text-slate-900">
          Reset password
        </h1>
        <p className="mt-1 text-center text-sm text-slate-500">
          Choose a new password for your account.
        </p>
        {done ? (
          <div className="mt-8 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            Password updated (demo). You can{' '}
            <Link to="/login" className="font-medium text-blue-700 hover:underline">
              return to sign in
            </Link>
            .
          </div>
        ) : (
          <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <div className="flex gap-2">
                <Input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <Button
                  type="button"
                  variant="secondary"
                  loading={sendingCode}
                  onClick={sendCode}
                  className="shrink-0"
                >
                  Send code
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="reset-code">Reset code (SMS)</Label>
              <Input
                id="reset-code"
                name="reset-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter code sent to owner number"
                required
              />
            </div>
            <div>
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            {error ? (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            {info ? (
              <p className="text-sm text-blue-600" role="status">
                {info}
              </p>
            ) : null}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Update password
            </Button>
            <p className="text-center text-sm text-slate-500">
              <Link to="/login" className="font-medium text-blue-600 hover:text-blue-700">
                Back to login
              </Link>
            </p>
          </form>
        )}
      </Card>
    </AuthLayout>
  )
}
