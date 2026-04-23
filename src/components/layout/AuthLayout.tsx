import type { ReactNode } from 'react'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-gradient-to-b from-slate-50 to-slate-100/80">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-sm font-bold text-white shadow-sm">
            MB
          </div>
          <p className="text-sm font-medium text-slate-600">Multi-Brand SMS</p>
        </div>
        {children}
        <p className="mt-10 text-center text-xs text-slate-400">
          Demo UI — no backend connected.
        </p>
      </div>
    </div>
  )
}
