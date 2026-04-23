import type { LabelHTMLAttributes } from 'react'

export function Label({ className = '', children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={`mb-1.5 block text-sm font-medium text-slate-700 ${className}`}
      {...rest}
    >
      {children}
    </label>
  )
}
