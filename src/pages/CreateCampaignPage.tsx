import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { Textarea } from '../components/ui/Textarea'
import { Select } from '../components/ui/Select'
import { Button } from '../components/ui/Button'
import { useAppData } from '../context/AppDataContext'
import { fetchWorkerBrandTags, type WorkerBrandTag } from '../services/smsWorkerApi'

export function CreateCampaignPage() {
  const { brands, addCampaign, workerLinked } = useAppData()
  const navigate = useNavigate()
  const [brandId, setBrandId] = useState('')
  const [tag, setTag] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [tags, setTags] = useState<WorkerBrandTag[]>([])
  const [loadingTags, setLoadingTags] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)
  const [scheduleLater, setScheduleLater] = useState(false)
  const [scheduleTimezone, setScheduleTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  )
  const [scheduleAtLocal, setScheduleAtLocal] = useState('')

  const timezoneOptions = useMemo(() => {
    const primary = [
      'UTC',
      'Asia/Dhaka',
      'Asia/Kolkata',
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Berlin',
      'Australia/Sydney',
    ]
    const current = Intl.DateTimeFormat().resolvedOptions().timeZone
    const set = new Set([current, ...primary].filter(Boolean) as string[])
    return Array.from(set)
  }, [])

  function timezoneOffsetMinutes(timeZone: string, epochMs: number) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = dtf.formatToParts(new Date(epochMs))
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    )
    return (asUtc - epochMs) / 60000
  }

  function toUtcIsoFromTimezone(localValue: string, timeZone: string) {
    const m = localValue.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
    )
    if (!m) return null
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    const hour = Number(m[4])
    const minute = Number(m[5])
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)
    const firstOffset = timezoneOffsetMinutes(timeZone, localAsUtc)
    let utcMs = localAsUtc - firstOffset * 60000
    const secondOffset = timezoneOffsetMinutes(timeZone, utcMs)
    utcMs = localAsUtc - secondOffset * 60000
    return new Date(utcMs).toISOString()
  }

  useEffect(() => {
    if (!brandId || !workerLinked) {
      setTags([])
      setTag('')
      return
    }
    let cancelled = false
    setLoadingTags(true)
    setFormError(null)
    void (async () => {
      try {
        const next = await fetchWorkerBrandTags(brandId)
        if (cancelled) return
        setTags(next)
        setTag((prev) => (next.some((t) => t.tag === prev) ? prev : ''))
      } catch (e) {
        if (cancelled) return
        setTags([])
        setTag('')
        const msg = e instanceof Error ? e.message : 'Failed to load ActiveCampaign tags.'
        setFormError(msg)
      } finally {
        if (!cancelled) setLoadingTags(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [brandId, workerLinked])

  const filteredTags = useMemo(() => {
    const q = tag.trim().toLowerCase()
    if (!q) return tags
    return tags.filter((t) => t.tag.toLowerCase().includes(q))
  }, [tags, tag])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const tagTrim = tag.trim()
    const messageTrim = message.trim()
    if (!brandId) {
      setFormError('Choose a brand.')
      return
    }
    if (!tagTrim) {
      setFormError('ActiveCampaign tag is required.')
      return
    }
    if (!messageTrim) {
      setFormError('Message is required.')
      return
    }
    let scheduledAtUtc: string | undefined
    if (scheduleLater) {
      if (!scheduleAtLocal) {
        setFormError('Scheduled date/time is required.')
        return
      }
      const parsed = toUtcIsoFromTimezone(scheduleAtLocal, scheduleTimezone)
      if (!parsed) {
        setFormError('Invalid schedule date/time.')
        return
      }
      if (new Date(parsed).getTime() <= Date.now() + 15000) {
        setFormError('Scheduled time must be at least 15 seconds in the future.')
        return
      }
      scheduledAtUtc = parsed
    }
    setLoading(true)
    try {
      const c = await addCampaign({
        brandId,
        tag: tagTrim,
        message: messageTrim,
        scheduledAtUtc,
        scheduleTimezone: scheduleLater ? scheduleTimezone : undefined,
        scheduleAtLocal: scheduleLater ? scheduleAtLocal : undefined,
      })
      navigate(`/campaigns/${c.id}`)
    } catch {
      setFormError('Could not create campaign. Check the Worker response or your connection.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          Create campaign
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Queue an SMS send against an ActiveCampaign tag.
          {workerLinked ? ' Connected to Cloudflare Worker.' : ' Running in local mock mode.'}
        </p>
      </div>

      <Card padding="md">
        <CardHeader title="Campaign details" />
        {brands.length === 0 ? (
          <p className="text-sm text-slate-600">
            Add a brand first, then return here to send a campaign.
          </p>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {formError ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {formError}
              </p>
            ) : null}
            <div>
              <Label htmlFor="brand" required>
                Brand
              </Label>
              <Select
                id="brand"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                required
              >
                <option value="">Select Brand</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="relative">
              <Label htmlFor="tag" required>
                Tag (ActiveCampaign)
              </Label>
              <div className="relative">
                <Input
                  id="tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  disabled={!brandId || loadingTags || tags.length === 0}
                  onFocus={() => setShowTagMenu(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowTagMenu(false), 120)
                  }}
                  placeholder={
                    !brandId
                      ? 'Select Tag'
                      : 
                    loadingTags
                      ? 'Loading tags...'
                      : tags.length > 0
                        ? 'Type to search tags'
                        : 'No ActiveCampaign tags found for this brand'
                  }
                  className="pr-9"
                />
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
              {showTagMenu ? (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-300 bg-white shadow-lg">
                  {filteredTags.length > 0 ? (
                    filteredTags.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setTag(t.tag)
                          setShowTagMenu(false)
                        }}
                      >
                        {t.tag}
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-sm text-slate-500">No matching tags</p>
                  )}
                </div>
              ) : null}
              <p className="mt-1.5 text-xs text-slate-500">
                Start typing to search tag names from the selected brand.
              </p>
            </div>
            <div>
              <Label htmlFor="message" required>
                Message
              </Label>
              <Textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                placeholder={
                  'Hi {{first_name}}, thanks for being a customer. Reply STOP to opt out.'
                }
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Merge fields like <span className="font-mono">{'{{first_name}}'}</span> are
                supported in the real product; here they are display-only.
              </p>
            </div>
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <input
                  type="checkbox"
                  checked={scheduleLater}
                  onChange={(e) => setScheduleLater(e.target.checked)}
                />
                Schedule for later
              </label>
              {scheduleLater ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="scheduleTimezone">Timezone</Label>
                    <Select
                      id="scheduleTimezone"
                      value={scheduleTimezone}
                      onChange={(e) => setScheduleTimezone(e.target.value)}
                    >
                      {timezoneOptions.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="scheduleAtLocal" required>
                      Date &amp; time
                    </Label>
                    <Input
                      id="scheduleAtLocal"
                      type="datetime-local"
                      value={scheduleAtLocal}
                      onChange={(e) => setScheduleAtLocal(e.target.value)}
                      required={scheduleLater}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" loading={loading} disabled={!brandId || !tag}>
                {scheduleLater ? 'Schedule campaign' : 'Send campaign'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate('/campaigns')}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  )
}
