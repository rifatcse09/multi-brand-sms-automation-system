import { LogOut, ChevronDown } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { Button } from '../ui/Button'

export function TopBar() {
  const { email, logout } = useAuth()

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-md sm:px-6 lg:h-16">
      <div className="min-w-0 flex-1 lg:hidden" />
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="flex max-w-[220px] items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3 py-1.5 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          <span className="truncate font-medium text-slate-800">{email ?? '—'}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        </button>
        <Button
          variant="secondary"
          size="sm"
          className="hidden sm:inline-flex"
          onClick={logout}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Logout
        </Button>
        <Button variant="ghost" size="sm" className="sm:hidden" onClick={logout} aria-label="Logout">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
