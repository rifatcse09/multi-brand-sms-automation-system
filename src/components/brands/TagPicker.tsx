import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Label } from '../ui/Label'
import { Input } from '../ui/Input'
import type { WorkerBrandTag } from '../../services/smsWorkerApi'

type TagPickerProps = {
  id?: string
  label?: string
  required?: boolean
  value: string
  onChange: (tag: string) => void
  tags: WorkerBrandTag[]
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  helperText?: string
  /** Show total subscribers beside the selected tag in the dropdown. */
  tagAudienceCount?: number
  /** Open list above the input (best inside modals so it is not clipped by the footer). */
  menuPlacement?: 'below' | 'above'
}

export function TagPicker({
  id = 'dashboard-tag',
  label = 'Dashboard audience tag',
  required,
  value,
  onChange,
  tags,
  loading = false,
  disabled = false,
  placeholder,
  helperText,
  tagAudienceCount,
  menuPlacement = 'below',
}: TagPickerProps) {
  const [showMenu, setShowMenu] = useState(false)

  const filteredTags = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return tags
    return tags.filter((t) => t.tag.toLowerCase().includes(q))
  }, [tags, value])

  const defaultPlaceholder = loading
    ? 'Loading tags…'
    : tags.length > 0
      ? 'Type to search tags'
      : 'No ActiveCampaign tags found'

  return (
    <div className="relative">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || loading || tags.length === 0}
          onFocus={() => setShowMenu(true)}
          onBlur={() => {
            window.setTimeout(() => setShowMenu(false), 120)
          }}
          placeholder={placeholder ?? defaultPlaceholder}
          className="pr-9"
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>
      {showMenu && !disabled ? (
        <div
          className={`absolute left-0 right-0 z-[100] max-h-64 w-full overflow-auto rounded-lg border border-slate-300 bg-white shadow-xl ${
            menuPlacement === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {filteredTags.length > 0 ? (
            filteredTags.map((t) => (
              <button
                key={t.id}
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(t.tag)
                  setShowMenu(false)
                }}
              >
                <span>{t.tag}</span>
                {value.trim().toLowerCase() === t.tag.trim().toLowerCase() &&
                tagAudienceCount !== undefined ? (
                  <span className="shrink-0 text-xs font-medium text-violet-700">
                    {tagAudienceCount.toLocaleString()} subs
                  </span>
                ) : typeof t.totalSubscribers === 'number' && t.totalSubscribers > 0 ? (
                  <span className="shrink-0 text-xs font-medium text-slate-500">
                    {t.totalSubscribers.toLocaleString()} subs
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-sm text-slate-500">No matching tags</p>
          )}
        </div>
      ) : null}
      {helperText ? <p className="mt-1.5 text-xs text-slate-500">{helperText}</p> : null}
    </div>
  )
}
