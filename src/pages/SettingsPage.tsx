import { useEffect, useState, type FormEvent } from 'react'
import { Card, CardHeader } from '../components/ui/Card'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'

export function SettingsPage() {
  const { email, login } = useAuth()
  const [nextEmail, setNextEmail] = useState(email ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [emailSaved, setEmailSaved] = useState(false)
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [loadingEmail, setLoadingEmail] = useState(false)
  const [loadingPassword, setLoadingPassword] = useState(false)

  useEffect(() => {
    setNextEmail(email ?? '')
  }, [email])

  const saveEmail = (e: FormEvent) => {
    e.preventDefault()
    setLoadingEmail(true)
    setEmailSaved(false)
    window.setTimeout(() => {
      login(nextEmail.trim())
      setLoadingEmail(false)
      setEmailSaved(true)
    }, 400)
  }

  const savePassword = (e: FormEvent) => {
    e.preventDefault()
    setPasswordSaved(false)
    if (newPassword.length < 8) return
    if (newPassword !== confirmPassword) return
    setLoadingPassword(true)
    window.setTimeout(() => {
      setLoadingPassword(false)
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    }, 450)
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Account preferences (mock persistence via localStorage).</p>
      </div>

      <Card padding="md">
        <CardHeader title="Change email" description="Updates the address shown in the top bar." />
        <form className="max-w-md space-y-4" onSubmit={saveEmail}>
          <div>
            <Label htmlFor="settings-email">Email</Label>
            <Input
              id="settings-email"
              type="email"
              value={nextEmail}
              onChange={(e) => setNextEmail(e.target.value)}
              required
            />
          </div>
          {emailSaved ? (
            <p className="text-sm text-emerald-600" role="status">
              Email updated.
            </p>
          ) : null}
          <Button type="submit" loading={loadingEmail}>
            Save email
          </Button>
        </form>
      </Card>

      <Card padding="md">
        <CardHeader title="Change password" description="Demo only — no password is stored." />
        <form className="max-w-md space-y-4" onSubmit={savePassword}>
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="new-password-settings">New password</Label>
            <Input
              id="new-password-settings"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
            />
          </div>
          <div>
            <Label htmlFor="confirm-password-settings">Confirm new password</Label>
            <Input
              id="confirm-password-settings"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
            />
          </div>
          {passwordSaved ? (
            <p className="text-sm text-emerald-600" role="status">
              Password change recorded (demo).
            </p>
          ) : null}
          <Button type="submit" loading={loadingPassword}>
            Update password
          </Button>
        </form>
      </Card>
    </div>
  )
}
