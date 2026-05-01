import type { LabelHTMLAttributes } from 'react'

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  /** Shows a red asterisk (use with client-side validation). */
  required?: boolean
}

export function Label({ className = '', children, required, ...rest }: LabelProps) {
  return (
    <label
      className={`mb-1.5 block text-sm font-medium text-slate-700 ${className}`}
      {...rest}
    >
      {children}
      {required ? (
        <span className="text-red-600" aria-hidden>
          {' '}
          *
        </span>
      ) : null}
    </label>
  )
}
