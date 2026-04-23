type ProgressBarProps = {
  value: number
  className?: string
  trackClassName?: string
}

export function ProgressBar({ value, className = '', trackClassName = '' }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full bg-blue-600 transition-[width] duration-500 ease-out ${trackClassName}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
