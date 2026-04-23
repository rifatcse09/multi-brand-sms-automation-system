import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from 'react'

export function TableWrap({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-[var(--shadow-soft)] ${className}`}
      {...rest}
    >
      <table className="min-w-full border-collapse text-left text-sm">{children}</table>
    </div>
  )
}

export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  const { className = '', children, ...rest } = props
  return (
    <th
      className={`border-b border-slate-200 bg-slate-50/80 px-4 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 first:pl-5 last:pr-5 ${className}`}
      {...rest}
    >
      {children}
    </th>
  )
}

export function Td(props: TdHTMLAttributes<HTMLTableCellElement>) {
  const { className = '', children, ...rest } = props
  return (
    <td
      className={`border-b border-slate-100 px-4 py-3 text-slate-700 first:pl-5 last:pr-5 ${className}`}
      {...rest}
    >
      {children}
    </td>
  )
}
