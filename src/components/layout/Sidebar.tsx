import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Building2,
  Megaphone,
  BarChart3,
  Settings,
} from 'lucide-react'

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/brands', label: 'Brands', icon: Building2 },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
]

const linkClass =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900'

const activeClass = 'bg-slate-900 text-white hover:bg-slate-900 hover:text-white'

export function Sidebar() {
  return (
    <aside className="flex w-full flex-col border-b border-slate-200/80 bg-white lg:w-60 lg:border-b-0 lg:border-r lg:shadow-[var(--shadow-soft)]">
      <div className="flex h-14 items-center gap-2 px-4 lg:h-16 lg:px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white shadow-sm">
          MB
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">SMS Platform</p>
          <p className="text-xs text-slate-500">Campaigns</p>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:overflow-visible lg:px-3 lg:py-4">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `${linkClass} shrink-0 ${isActive ? activeClass : ''}`}>
            <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
