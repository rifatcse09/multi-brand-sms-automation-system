import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { hasError: boolean; message: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message || 'Unknown error' }
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('App error:', err, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-slate-50 px-4 py-10 text-center">
          <h1 className="text-lg font-semibold text-slate-900">This page failed to load</h1>
          <p className="max-w-md text-sm text-slate-600">
            {this.state.message}. Try a hard refresh (Ctrl+Shift+R). If you just deployed, wait a minute and reload.
          </p>
          <button
            type="button"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
