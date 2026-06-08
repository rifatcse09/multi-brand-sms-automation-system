import { useEffect, useMemo, useState, useCallback } from 'react'
import { TrendingUp, TrendingDown, Minus, CalendarDays } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import {
  fetchWorkerSentVsFailed,
  fetchWorkerSubscriberTrend,
  isWorkerConfigured,
} from '../services/smsWorkerApi'
import { useAppData } from '../context/AppDataContext'
import { useDelayedReady } from '../hooks/useDelayedReady'
import type { Campaign } from '../types'

type SentRow = { date: string; label: string; sent: number; failed: number }
type SubRow = { date: string; label: string; delivered: number; unsubs: number; net: number }

// ─── helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return toDateStr(d)
}

function todayStr() {
  return toDateStr(new Date())
}

function estimateCost(c: Campaign, costPerSegment?: number) {
  if (!costPerSegment || c.sent === 0) return null
  const msg = c.message ?? ''
  const segments = msg.length === 0 ? 1 : Math.ceil(msg.length / 160)
  return c.sent * segments * costPerSegment
}

// ─── presentational components ────────────────────────────────────────────────

function TrendBadge({ current, prior }: { current: number; prior: number }) {
  if (prior === 0 && current === 0) return null
  const delta = current - prior
  const pct = prior > 0 ? Math.round((delta / prior) * 100) : null

  if (delta > 0)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        <TrendingUp className="h-3 w-3" aria-hidden />
        {pct != null ? `+${pct}%` : `+${delta.toLocaleString()}`} vs prior period
      </span>
    )
  if (delta < 0)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
        <TrendingDown className="h-3 w-3" aria-hidden />
        {pct != null ? `${pct}%` : delta.toLocaleString()} vs prior period
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
      <Minus className="h-3 w-3" aria-hidden />
      flat vs prior period
    </span>
  )
}

function SuccessRate({ sent, total }: { sent: number; total: number }) {
  const rate = total > 0 ? Math.round((sent / total) * 1000) / 10 : null
  if (rate === null) return <span className="text-slate-400">—</span>
  const color = rate >= 95 ? 'text-emerald-700' : rate >= 80 ? 'text-amber-700' : 'text-rose-700'
  return <span className={`font-semibold tabular-nums ${color}`}>{rate}%</span>
}

function SentBar({ label, sent, failed, max }: { label: string; sent: number; failed: number; max: number }) {
  const sentH = Math.round((sent / max) * 100)
  const failH = Math.round((failed / max) * 100)
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <div className="flex h-36 w-full max-w-[44px] items-end justify-center gap-0.5 sm:h-44">
        <div className="w-3 rounded-sm bg-blue-500/90 sm:w-3.5" style={{ height: `${Math.max(sentH, 3)}%` }} title={`Sent: ${sent.toLocaleString()}`} />
        <div className="w-3 rounded-sm bg-slate-300 sm:w-3.5" style={{ height: `${Math.max(failH, 3)}%` }} title={`Failed: ${failed.toLocaleString()}`} />
      </div>
      <span className="text-[10px] font-medium text-slate-400">{label}</span>
    </div>
  )
}

function NetBar({ label, net, max }: { label: string; net: number; max: number }) {
  const isPos = net >= 0
  const h = max > 0 ? Math.max(Math.round((Math.abs(net) / max) * 100), 3) : 3
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <div className="flex h-36 w-full max-w-[44px] flex-col items-center justify-end sm:h-44">
        <div
          className={`w-4 rounded-sm sm:w-5 ${isPos ? 'bg-emerald-500/90' : 'bg-rose-400/90'}`}
          style={{ height: `${h}%` }}
          title={`Net: ${net > 0 ? '+' : ''}${net.toLocaleString()}`}
        />
      </div>
      <span className="text-[10px] font-medium text-slate-400">{label}</span>
    </div>
  )
}

// ─── date range presets ───────────────────────────────────────────────────────

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
]

function defaultRange(days: number) {
  const to = todayStr()
  const from = addDays(to, -(days - 1))
  return { from, to }
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const ready = useDelayedReady(250)
  const { campaigns, brands, getBrandName, subscriberSummary } = useAppData()

  const [from, setFrom] = useState(() => defaultRange(7).from)
  const [to, setTo] = useState(() => defaultRange(7).to)
  const [activePreset, setActivePreset] = useState<number | null>(7)

  const [sentData, setSentData] = useState<SentRow[]>([])
  const [subTrend, setSubTrend] = useState<SubRow[]>([])

  const loadData = useCallback((f: string, t: string) => {
    if (!isWorkerConfigured()) return
    void (async () => {
      try {
        const [sent, trend] = await Promise.all([
          fetchWorkerSentVsFailed({ from: f, to: t }),
          fetchWorkerSubscriberTrend({ from: f, to: t }),
        ])
        setSentData(sent)
        setSubTrend(trend)
      } catch { /* ignore */ }
    })()
  }, [])

  useEffect(() => { loadData(from, to) }, [from, to, loadData])

  function applyPreset(days: number) {
    const r = defaultRange(days)
    setFrom(r.from)
    setTo(r.to)
    setActivePreset(days)
  }

  function handleFrom(v: string) {
    if (v > to) return
    setFrom(v)
    setActivePreset(null)
  }

  function handleTo(v: string) {
    if (v < from || v > todayStr()) return
    setTo(v)
    setActivePreset(null)
  }

  // Compute prior period for comparison (same length, immediately before)
  const [priorSentData, setPriorSentData] = useState<SentRow[]>([])
  const [priorSubTrend, setPriorSubTrend] = useState<SubRow[]>([])

  useEffect(() => {
    if (!isWorkerConfigured()) return
    const spanDays = Math.max(
      1,
      Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000) + 1,
    )
    const priorTo = addDays(from, -1)
    const priorFrom = addDays(priorTo, -(spanDays - 1))
    void (async () => {
      try {
        const [s, t] = await Promise.all([
          fetchWorkerSentVsFailed({ from: priorFrom, to: priorTo }),
          fetchWorkerSubscriberTrend({ from: priorFrom, to: priorTo }),
        ])
        setPriorSentData(s)
        setPriorSubTrend(t)
      } catch { /* ignore */ }
    })()
  }, [from, to])

  // Period totals
  const periodSent = sentData.reduce((s, r) => s + r.sent, 0)
  const periodFailed = sentData.reduce((s, r) => s + r.failed, 0)
  const periodNet = subTrend.reduce((s, r) => s + r.net, 0)
  const periodUnsubs = subTrend.reduce((s, r) => s + r.unsubs, 0)
  const periodDelivered = subTrend.reduce((s, r) => s + r.delivered, 0)
  const failRate = periodSent + periodFailed > 0 ? Math.round((periodFailed / (periodSent + periodFailed)) * 1000) / 10 : 0

  const priorSent = priorSentData.reduce((s, r) => s + r.sent, 0)
  const priorNet = priorSubTrend.reduce((s, r) => s + r.net, 0)

  const hasSubData = periodDelivered > 0 || periodUnsubs > 0

  const maxSentBar = Math.max(...sentData.map((d) => d.sent + d.failed), 1)
  const maxNetBar = Math.max(...subTrend.map((r) => Math.abs(r.net)), 1)

  // All-time stats
  const allTime = useMemo(() => {
    const completed = campaigns.filter((c) => c.status === 'Completed' && !c.deletedAt)
    const totalSent = completed.reduce((s, c) => s + c.sent, 0)
    const totalFailed = completed.reduce((s, c) => s + c.failed, 0)
    const totalContacts = completed.reduce((s, c) => s + c.total, 0)
    const successRate = totalContacts > 0 ? Math.round((totalSent / totalContacts) * 1000) / 10 : null
    const totalCost = completed.reduce((sum, c) => {
      const brand = brands.find((b) => b.id === c.brandId)
      return sum + (estimateCost(c, brand?.smsCostPerSegment) ?? 0)
    }, 0)
    const hasCost = brands.some((b) => b.smsCostPerSegment != null)
    return { count: completed.length, totalSent, totalFailed, totalContacts, successRate, totalCost, hasCost }
  }, [campaigns, brands])

  // Brand performance
  const brandPerf = useMemo(() => {
    const completed = campaigns.filter((c) => c.status === 'Completed' && !c.deletedAt)
    const map = new Map<string, { sent: number; failed: number; total: number; count: number; cost: number }>()
    for (const c of completed) {
      const existing = map.get(c.brandId) ?? { sent: 0, failed: 0, total: 0, count: 0, cost: 0 }
      const brand = brands.find((b) => b.id === c.brandId)
      map.set(c.brandId, {
        sent: existing.sent + c.sent,
        failed: existing.failed + c.failed,
        total: existing.total + c.total,
        count: existing.count + 1,
        cost: existing.cost + (estimateCost(c, brand?.smsCostPerSegment) ?? 0),
      })
    }
    return Array.from(map.entries()).map(([brandId, s]) => ({ brandId, ...s })).sort((a, b) => b.sent - a.sent)
  }, [campaigns, brands])

  // Send day of week
  const dowStats = useMemo(() => {
    const completed = campaigns.filter((c) => c.status === 'Completed' && !c.deletedAt && c.total > 0)
    const byDow = Array.from({ length: 7 }, () => ({ sent: 0, total: 0 }))
    for (const c of completed) {
      const dow = new Date(c.createdAt).getDay()
      byDow[dow].sent += c.sent
      byDow[dow].total += c.total
    }
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({
      label,
      rate: byDow[i].total > 0 ? Math.round((byDow[i].sent / byDow[i].total) * 1000) / 10 : null,
    }))
  }, [campaigns])

  const activeSmsTotal = subscriberSummary?.activeSmsSubscribers ?? 0
  const unsubTotal = subscriberSummary?.unsubscribedTotal ?? 0

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Analytics</h1>
        <p className="mt-1 text-sm text-slate-500">Trends, growth, and performance across all campaigns.</p>
      </div>

      {/* Date range picker */}
      <Card padding="md">
        <div className="flex flex-wrap items-center gap-3">
          <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => applyPreset(p.days)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  activePreset === p.days
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                Last {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => handleFrom(e.target.value)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-slate-400">→</span>
            <input
              type="date"
              value={to}
              max={todayStr()}
              min={from}
              onChange={(e) => handleTo(e.target.value)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </Card>

      {/* Period summary */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {from === to ? from : `${from} → ${to}`}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Sent</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{periodSent.toLocaleString()}</p>
            <div className="mt-1"><TrendBadge current={periodSent} prior={priorSent} /></div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Failed</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{periodFailed.toLocaleString()}</p>
            <p className="mt-1 text-xs text-slate-400">{failRate}% failure rate</p>
          </div>
          <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Net subscriber change</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${periodNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {periodNet > 0 ? '+' : ''}{periodNet.toLocaleString()}
            </p>
            <div className="mt-1"><TrendBadge current={periodNet} prior={priorNet} /></div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Unsubscribes</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{periodUnsubs.toLocaleString()}</p>
            {periodDelivered > 0 && (
              <p className="mt-1 text-xs text-slate-400">
                {Math.round((periodUnsubs / periodDelivered) * 1000) / 10}% unsub rate
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardHeader title="Send volume" description="Daily sent vs failed for selected period." />
            <TrendBadge current={periodSent} prior={priorSent} />
          </div>
          <div className="mb-4 flex flex-wrap gap-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-blue-600" /> Sent</span>
            <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-slate-300" /> Failed</span>
          </div>
          <div className="flex items-end justify-between gap-0.5 overflow-x-auto sm:gap-1">
            {ready && sentData.map((d) => (
              <SentBar key={d.date} label={d.label} sent={d.sent} failed={d.failed} max={maxSentBar} />
            ))}
          </div>
        </Card>

        <Card padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardHeader title="Subscriber growth" description="Daily net change for selected period." />
            {hasSubData && <TrendBadge current={periodNet} prior={priorNet} />}
          </div>
          {!hasSubData ? (
            <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-4 py-5 text-center">
              <p className="text-sm font-medium text-amber-800">No subscriber activity data yet</p>
              <p className="mt-1 text-xs text-amber-700">Populates once Twilio delivery &amp; inbound webhooks are configured.</p>
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-4 text-xs text-slate-500">
                <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Growth</span>
                <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-rose-400" /> Decline</span>
              </div>
              <div className="flex items-end justify-between gap-0.5 overflow-x-auto sm:gap-1">
                {ready && subTrend.map((r) => (
                  <NetBar key={r.date} label={r.label} net={r.net} max={maxNetBar} />
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* All-time totals */}
      {allTime.count > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">All-time</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Campaigns run</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{allTime.count}</p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Contacts reached</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{allTime.totalSent.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Overall success rate</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {allTime.successRate != null ? `${allTime.successRate}%` : '—'}
              </p>
            </div>
            {activeSmsTotal > 0 && (
              <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                <p className="text-xs font-medium text-slate-500">Active SMS subscribers</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700">{activeSmsTotal.toLocaleString()}</p>
                {unsubTotal > 0 && <p className="mt-0.5 text-xs text-slate-400">{unsubTotal.toLocaleString()} unsubscribed</p>}
              </div>
            )}
            {allTime.hasCost && allTime.totalCost > 0 && (
              <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                <p className="text-xs font-medium text-slate-500">Est. total spend</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">${allTime.totalCost.toFixed(2)}</p>
                <p className="mt-0.5 text-xs text-slate-400">across all campaigns</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Brand performance */}
      {brandPerf.length > 1 && (
        <Card padding="md">
          <CardHeader title="Brand performance" description="All-time totals across completed campaigns." />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Brand</th>
                  <th className="pb-2 pr-4 text-right">Campaigns</th>
                  <th className="pb-2 pr-4 text-right">Contacts sent</th>
                  <th className="pb-2 pr-4 text-right">Success rate</th>
                  {allTime.hasCost && <th className="pb-2 text-right">Est. spend</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {brandPerf.map((b) => (
                  <tr key={b.brandId} className="text-slate-700">
                    <td className="py-2.5 pr-4 font-medium text-slate-900">{getBrandName(b.brandId)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">{b.count}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{b.sent.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 text-right"><SuccessRate sent={b.sent} total={b.total} /></td>
                    {allTime.hasCost && (
                      <td className="py-2.5 text-right tabular-nums text-slate-600">
                        {b.cost > 0 ? `$${b.cost.toFixed(2)}` : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Send day performance */}
      {campaigns.some((c) => c.status === 'Completed') && (
        <Card padding="md">
          <CardHeader title="Send day performance" description="Avg success rate by day campaigns were launched." />
          <div className="mt-4 flex items-end justify-between gap-1">
            {dowStats.map((d) => {
              const h = d.rate != null ? Math.max(Math.round(d.rate), 4) : 4
              const barColor = d.rate == null ? 'bg-slate-200' : d.rate >= 95 ? 'bg-emerald-400' : d.rate >= 80 ? 'bg-amber-400' : 'bg-rose-400'
              return (
                <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
                  <span className="text-[10px] tabular-nums text-slate-500">{d.rate != null ? `${d.rate}%` : ''}</span>
                  <div className="flex h-24 w-full max-w-[40px] items-end">
                    <div className={`w-full rounded-md ${barColor}`} style={{ height: `${h}%` }} title={d.rate != null ? `${d.label}: ${d.rate}%` : `${d.label}: no data`} />
                  </div>
                  <span className="text-[11px] font-medium text-slate-500">{d.label}</span>
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-slate-400">Green ≥ 95% · Amber 80–94% · Red &lt; 80% · Gray = no sends</p>
        </Card>
      )}
    </div>
  )
}
