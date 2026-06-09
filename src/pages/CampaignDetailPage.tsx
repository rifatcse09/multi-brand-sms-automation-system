import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCheck, MessageSquareReply, MousePointerClick, RefreshCw, ScrollText, Trash2, UserMinus, XCircle } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { ProgressBar } from '../components/ui/ProgressBar'
import { TableWrap, Th, Td } from '../components/ui/Table'
import { StatusBadge } from '../components/ui/Badge'
import { useAppData } from '../context/AppDataContext'
import {
  fetchWorkerCampaignById,
  fetchWorkerCampaignProgress,
  isWorkerConfigured,
  resumeWorkerCampaign,
} from '../services/smsWorkerApi'
import type { Campaign, PhoneResult } from '../types'

function processedCount(c: Campaign | null | undefined) {
  if (!c) return 0
  return (c.sent ?? 0) + (c.failed ?? 0)
}

function failureSourceLabel(source?: string) {
  switch (source) {
    case 'twilio_rest':
      return 'Rejected by Twilio API before sending'
    case 'twilio_callback':
      return 'Carrier rejected after sending'
    case 'opted_out':
      return 'Opted out — replied STOP'
    case 'mock_simulated':
      return 'Mock simulated failure'
    default:
      return 'Other / unknown'
  }
}

function failureGroupLabel(phone: PhoneResult) {
  if (phone.failureSource === 'opted_out') return 'Opted out — recipient replied STOP'
  const summary = phone.error?.trim()
  // Backwards-compat: old opted-out rows have failureSource "twilio_callback" but
  // the error text contains 21610.
  if (summary?.includes('21610')) return 'Opted out — recipient replied STOP (21610)'
  if (summary) return summary
  return failureSourceLabel(phone.failureSource)
}

type FailureGroupRow = {
  key: string
  label: string
  source?: string
  count: number
  percentOfFailed: number
  percentOfTotal: number
}

function buildFailureGroups(phones: PhoneResult[], total: number): FailureGroupRow[] {
  const failed = phones.filter((p) => p.status === 'Failed')
  if (failed.length === 0) return []

  const map = new Map<string, FailureGroupRow>()
  for (const phone of failed) {
    const label = failureGroupLabel(phone)
    const key = `${phone.failureSource ?? 'unknown'}::${label}`
    const existing = map.get(key)
    if (existing) {
      existing.count += 1
    } else {
      map.set(key, {
        key,
        label,
        source: phone.failureSource,
        count: 1,
        percentOfFailed: 0,
        percentOfTotal: 0,
      })
    }
  }

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      percentOfFailed: Math.round((row.count / failed.length) * 1000) / 10,
      percentOfTotal: total > 0 ? Math.round((row.count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)
}

export function CampaignDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { campaigns, brands, getBrandName, retryPhone, deleteCampaign } = useAppData()
  const campaign = campaigns.find((c) => c.id === id)
  const [remoteCampaign, setRemoteCampaign] = useState<Campaign | null>(null)
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [failureLogPhone, setFailureLogPhone] = useState<PhoneResult | null>(null)
  const [resuming, setResuming] = useState(false)
  const [resumeMessage, setResumeMessage] = useState<string | null>(null)
  const [statsUpdatedAt, setStatsUpdatedAt] = useState<number | null>(null)

  const reloadRemoteCampaign = useCallback(async () => {
    if (!id || !isWorkerConfigured()) return
    try {
      const res = await fetchWorkerCampaignById(id)
      setRemoteCampaign(res.campaign as Campaign)
      setStatsUpdatedAt(Date.now())
    } catch {
      setRemoteCampaign(null)
    }
  }, [id])

  const refreshCampaignProgress = useCallback(async () => {
    if (!id || !isWorkerConfigured()) return
    try {
      const p = await fetchWorkerCampaignProgress(id)
      setRemoteCampaign((prev) =>
        prev
          ? {
              ...prev,
              sent: p.sent,
              failed: p.failed,
              status: p.status,
              total: p.total || prev.total,
              queueProgress: p.queueProgress,
            }
          : null,
      )
      setStatsUpdatedAt(Date.now())
    } catch {
      /* keep last snapshot */
    }
  }, [id])

  useEffect(() => {
    if (!id || !isWorkerConfigured()) return
    let cancelled = false
    setLoadingRemote(true)
    void (async () => {
      await reloadRemoteCampaign()
      if (!cancelled) await refreshCampaignProgress()
      if (!cancelled) setLoadingRemote(false)
    })()
    const progressTimer = window.setInterval(() => {
      void refreshCampaignProgress()
    }, 8_000)
    const fullTimer = window.setInterval(() => {
      void reloadRemoteCampaign()
    }, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(progressTimer)
      window.clearInterval(fullTimer)
    }
  }, [id, reloadRemoteCampaign, refreshCampaignProgress])

  const activeCampaign = useMemo<Campaign | null>(() => {
    if (!id) return null
    const local = campaign
    const remote = remoteCampaign

    if (remote && local) {
      const localPhones = local.phones ?? []
      const remotePhones = remote.phones ?? []
      const phones = remotePhones.length > 0 ? remotePhones : localPhones
      const localProcessed = processedCount(local)
      const remoteProcessed = processedCount(remote)
      const metrics = localProcessed >= remoteProcessed ? local : remote
      const queueProgress = Math.max(
        local.queueProgress ?? 0,
        remote.queueProgress ?? 0,
        metrics.total > 0
          ? Math.round((processedCount(metrics) / metrics.total) * 100)
          : 0,
      )
      return {
        ...remote,
        ...local,
        phones,
        batches: metrics.batches ?? remote.batches ?? [],
        sent: metrics.sent,
        failed: metrics.failed,
        queueProgress,
        status: metrics.status ?? remote.status,
        total: metrics.total || remote.total,
        important: local.important,
      }
    }

    if (remote) {
      if (!local) return remote
      return { ...remote, important: local.important }
    }
    return local ?? null
  }, [id, campaign, remoteCampaign])

  const outcomeStats = useMemo(() => {
    if (!activeCampaign) return null
    const phones = activeCampaign.phones ?? []
    const total = activeCampaign.total > 0 ? activeCampaign.total : phones.length
    const sentFromPhones = phones.filter((p) => p.status === 'Success').length
    const failedFromPhones = phones.filter((p) => p.status === 'Failed').length
    // When phone rows are loaded they are the reconciled source of truth; the
    // campaign-level aggregates can lag behind (progress endpoint does not
    // reconcile) so we trust phones directly rather than taking Math.max, which
    // would keep a stale low number after a progress poll overwrites the field.
    const sent = phones.length > 0 ? sentFromPhones : Math.max(sentFromPhones, activeCampaign.sent ?? 0)
    const failed = phones.length > 0 ? failedFromPhones : Math.max(failedFromPhones, activeCampaign.failed ?? 0)
    const optedOut = phones.filter(
      (p) =>
        p.status === 'Failed' &&
        (p.failureSource === 'opted_out' || p.error?.includes('21610')),
    ).length
    const pending = Math.max(0, total - sent - failed)
    const resolved = sent + failed
    const pctOf = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
    const failureRate = resolved > 0 ? Math.round((failed / resolved) * 1000) / 10 : pctOf(failed)
    return {
      total,
      sent,
      failed,
      optedOut,
      pending,
      sentPct: pctOf(sent),
      failedPct: pctOf(failed),
      pendingPct: pctOf(pending),
      failureRate,
      failureGroups: buildFailureGroups(phones, total),
    }
  }, [activeCampaign])

  const costStats = useMemo(() => {
    if (!activeCampaign || activeCampaign.status !== 'Completed') return null
    const brand = brands.find((b) => b.id === activeCampaign.brandId)
    const rate = brand?.smsCostPerSegment
    if (!rate) return null
    const phones = activeCampaign.phones ?? []
    const actualSent = phones.filter((p) => p.status === 'Success').length
    if (actualSent === 0) return null
    const msg = activeCampaign.message ?? ''
    const segments = msg.length === 0 ? 1 : Math.ceil(msg.length / 160)
    const totalCost = actualSent * segments * rate
    return { actualSent, segments, rate, totalCost }
  }, [activeCampaign, brands])

  if (!activeCampaign || !outcomeStats) {
    return (
      <div className="space-y-4">
        <Link to="/campaigns" className="inline-flex text-sm font-medium text-blue-600 hover:underline">
          ← Back to campaigns
        </Link>
        <Card padding="md">
          <p className="text-sm text-slate-600">
            {loadingRemote ? 'Loading campaign...' : 'Campaign not found.'}
          </p>
        </Card>
      </div>
    )
  }

  const sentOnlyPct =
    activeCampaign.total > 0 ? Math.round((activeCampaign.sent / activeCampaign.total) * 100) : 0
  const processedPct =
    outcomeStats.total > 0
      ? Math.round(((outcomeStats.sent + outcomeStats.failed) / outcomeStats.total) * 100)
      : activeCampaign.queueProgress
  const queueDisplayPct =
    activeCampaign.status === 'Running' || activeCampaign.status === 'Preparing'
      ? Math.max(activeCampaign.queueProgress, processedPct)
      : sentOnlyPct
  const scheduledLabel =
    activeCampaign.scheduleAtLocal && activeCampaign.scheduleTimezone
      ? `${activeCampaign.scheduleAtLocal.replace('T', ' ')} (${activeCampaign.scheduleTimezone})`
      : activeCampaign.scheduledAtUtc
        ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(activeCampaign.scheduledAtUtc),
          )
        : null

  const batches = activeCampaign.batches ?? []
  const phones = activeCampaign.phones ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            to="/campaigns"
            className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Campaigns
          </Link>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {activeCampaign.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {getBrandName(activeCampaign.brandId)} · Tag{' '}
            <span className="font-mono text-slate-700">{activeCampaign.tag}</span>
          </p>
          {activeCampaign.status === 'Scheduled' && scheduledLabel ? (
            <p className="mt-1 text-sm font-medium text-purple-700">Scheduled at: {scheduledLabel}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={activeCampaign.status} />
          {isWorkerConfigured() &&
          outcomeStats.pending > 0 &&
          (activeCampaign.status === 'Running' ||
            activeCampaign.status === 'Paused' ||
            activeCampaign.status === 'Completed') ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={resuming}
              onClick={() => {
                if (!id) return
                setResuming(true)
                setResumeMessage(null)
                void (async () => {
                  try {
                    const result = await resumeWorkerCampaign(id)
                    setResumeMessage(
                      result.message ??
                        (result.queued > 0
                          ? `Re-queued ${result.queued.toLocaleString()} pending message(s). Refresh in a few minutes.`
                          : 'No pending messages were re-queued.'),
                    )
                    await reloadRemoteCampaign()
                    await refreshCampaignProgress()
                  } catch (e) {
                    setResumeMessage(
                      e instanceof Error ? e.message : 'Could not resume queue.',
                    )
                  } finally {
                    setResuming(false)
                  }
                })()
              }}
            >
              <RefreshCw className={`h-4 w-4 ${resuming ? 'animate-spin' : ''}`} aria-hidden />
              {resuming ? 'Resuming…' : 'Resume queue'}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card padding="md" className="lg:col-span-2">
          <CardHeader
            title="Overview"
            description={
              statsUpdatedAt
                ? `High-level delivery metrics · live stats updated ${Math.max(
                    0,
                    Math.round((Date.now() - statsUpdatedAt) / 1000),
                  )}s ago`
                : 'High-level delivery metrics for this send.'
            }
          />
          {activeCampaign.status === 'Preparing' ? (
            <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Building audience from ActiveCampaign in the background. Total will climb,
              then SMS sending starts automatically.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Total</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {outcomeStats.total.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Submitted to Carrier</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-800">
                {outcomeStats.sent.toLocaleString()}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                {outcomeStats.sentPct}% of audience · accepted by Twilio
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Failed</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-red-800">
                {outcomeStats.failed.toLocaleString()}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                {outcomeStats.failedPct}% of audience
                {outcomeStats.sent + outcomeStats.failed > 0
                  ? ` · ${outcomeStats.failureRate}% failure rate`
                  : ''}
              </p>
            </div>
          </div>
          {costStats && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Estimated send cost
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                ${costStats.totalCost.toFixed(2)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {costStats.actualSent.toLocaleString()} contacts ×{' '}
                {costStats.segments === 1
                  ? '1 segment'
                  : `${costStats.segments} segments`}{' '}
                × ${costStats.rate.toFixed(4)}/segment
              </p>
            </div>
          )}
          {outcomeStats.failed > 0 ? (
            <div className="mt-6 rounded-lg border border-red-100 bg-red-50/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-red-900">
                Failure breakdown
              </p>
              <p className="mt-1 text-sm text-red-950">
                {outcomeStats.failed.toLocaleString()} failed (
                {outcomeStats.failedPct}% of audience
                {outcomeStats.sent + outcomeStats.failed > 0
                  ? `, ${outcomeStats.failureRate}% of completed sends`
                  : ''}
                )
              </p>
              <ul className="mt-3 space-y-2">
                {outcomeStats.failureGroups.map((group) => (
                  <li key={group.key}>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-900" title={group.label}>
                          {group.label}
                        </p>
                        {group.source ? (
                          <p className="text-[11px] text-slate-500">{failureSourceLabel(group.source)}</p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <span className="font-semibold text-red-800">{group.count}</span>
                        <span className="ml-2 text-xs text-slate-600">
                          {group.percentOfFailed}% of failures
                        </span>
                        <span className="ml-1 text-xs text-slate-400">
                          ({group.percentOfTotal}% total)
                        </span>
                      </div>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-red-100">
                      <div
                        className="h-full rounded-full bg-red-500"
                        style={{ width: `${Math.min(100, group.percentOfFailed)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {outcomeStats.optedOut > 0 ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-900">
                Compliance notice
              </p>
              <p className="mt-1 text-sm text-amber-950">
                <span className="font-semibold">{outcomeStats.optedOut}</span> recipient
                {outcomeStats.optedOut === 1 ? ' has' : 's have'} previously replied STOP and{' '}
                {outcomeStats.optedOut === 1 ? 'was' : 'were'} blocked from receiving this message.
                {' '}These numbers are now on the opt-out blocklist and will be skipped in all
                future campaigns for this brand.
              </p>
            </div>
          ) : null}
          {outcomeStats.pending > 0 ? (
            <p className="mt-4 text-xs tabular-nums text-slate-500">
              {outcomeStats.pending.toLocaleString()} pending ({outcomeStats.pendingPct}% of audience)
            </p>
          ) : null}
          {resumeMessage ? (
            <p className="mt-2 text-sm text-slate-700">{resumeMessage}</p>
          ) : null}
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-slate-700">Queue processing</span>
              <span className="tabular-nums text-slate-500">{queueDisplayPct}%</span>
            </div>
            <ProgressBar value={queueDisplayPct} />
          </div>
        </Card>

        <Card padding="md">
          <CardHeader title="Message" />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{activeCampaign.message}</p>
        </Card>
      </div>

      {activeCampaign.counters ? (
        <Card padding="md">
          <CardHeader
            title="Engagement"
            description="Live event counters from Twilio status &amp; inbound webhooks. &quot;Confirmed Delivered&quot; requires a carrier receipt — not all carriers return one, so this is a floor, not the total that reached recipients. Carrier Failure Events counts webhook callbacks, not unique recipients."
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-100 bg-emerald-50/60 p-4">
              <CheckCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              <div>
                <p className="text-xs font-medium text-slate-500">Confirmed Delivered</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-emerald-800">
                  {activeCampaign.counters.delivered.toLocaleString()}
                </p>
                {activeCampaign.sent > 0 ? (
                  <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                    {Math.round((activeCampaign.counters.delivered / activeCampaign.sent) * 1000) / 10}% carrier receipt returned
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-red-100 bg-red-50/60 p-4">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden />
              <div>
                <p className="text-xs font-medium text-slate-500">Carrier Failure Events</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-red-800">
                  {activeCampaign.counters.deliveryFailed.toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-blue-100 bg-blue-50/60 p-4">
              <MousePointerClick className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden />
              <div>
                <p className="text-xs font-medium text-slate-500">Clicks</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-blue-800">
                  {activeCampaign.counters.clicks.toLocaleString()}
                </p>
                {activeCampaign.counters.delivered > 0 ? (
                  <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                    {Math.round((activeCampaign.counters.clicks / activeCampaign.counters.delivered) * 1000) / 10}% CTR
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-violet-100 bg-violet-50/60 p-4">
              <MessageSquareReply className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" aria-hidden />
              <div>
                <p className="text-xs font-medium text-slate-500">Replies</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-violet-800">
                  {activeCampaign.counters.replies.toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-orange-100 bg-orange-50/60 p-4">
              <UserMinus className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" aria-hidden />
              <div>
                <p className="text-xs font-medium text-slate-500">Unsubscribes</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-orange-800">
                  {activeCampaign.counters.unsubs.toLocaleString()}
                </p>
                {activeCampaign.counters.delivered > 0 ? (
                  <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                    {Math.round((activeCampaign.counters.unsubs / activeCampaign.counters.delivered) * 1000) / 10}% unsub rate
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card padding="md">
        <CardHeader title="Batch progress" description="Parallel workers split the audience into batches." />
        {batches.length === 0 ? (
          <p className="text-sm text-slate-500">
            No batch data exposed by this backend response yet.
          </p>
        ) : (
          <div className="space-y-3">
            {batches.map((b) => (
              <div
                key={b.id}
                className="rounded-lg border border-slate-100 bg-white p-4 shadow-[var(--shadow-soft)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">{b.name}</p>
                  <p className="text-xs text-slate-500">
                    {b.sent}/{b.total} sent · {b.failed} failed
                  </p>
                </div>
                <div className="mt-3">
                  <ProgressBar value={b.progress} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <CardHeader
            title="Phone number results"
            description="Per-recipient outcomes. Open “Root cause” for full diagnostics (Twilio API, carrier callback, or mock)."
          />
        </div>
        <TableWrap className="rounded-none border-0 shadow-none">
          <thead>
            <tr>
              <Th>Phone number</Th>
              <Th>Status</Th>
              <Th className="min-w-[8rem]">Summary</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {phones.length === 0 ? (
              <tr>
                <Td colSpan={4} className="py-8 text-center text-sm text-slate-500">
                  {loadingRemote
                    ? 'Loading phone list from Worker…'
                    : 'No phone-level rows are available from the current endpoint.'}
                </Td>
              </tr>
            ) : (
              phones.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/80">
                  <Td className="font-mono text-xs sm:text-sm">{p.phone}</Td>
                  <Td>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.status === 'Success'
                          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/10'
                          : p.status === 'Pending'
                            ? 'bg-slate-100 text-slate-700 ring-1 ring-slate-400/20'
                            : 'bg-red-50 text-red-800 ring-1 ring-red-600/10'
                      }`}
                    >
                      {p.status}
                    </span>
                  </Td>
                  <Td className="max-w-[14rem] truncate text-xs text-slate-600" title={p.error ?? ''}>
                    {p.error ?? (p.status === 'Pending' ? 'Queued…' : '—')}
                  </Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {p.error || p.failureDetail ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-slate-600 hover:text-slate-900"
                          onClick={() => setFailureLogPhone(p)}
                        >
                          <ScrollText className="h-3.5 w-3.5" aria-hidden />
                          Root cause
                        </Button>
                      ) : null}
                      {p.status === 'Failed' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => retryPhone(activeCampaign.id, p.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                          Retry
                        </Button>
                      ) : null}
                      {!p.error && !p.failureDetail && p.status !== 'Failed' ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </Card>

      <Modal
        open={Boolean(failureLogPhone)}
        onClose={() => setFailureLogPhone(null)}
        title="Delivery root cause"
        description="What the Worker stored for this number (first attempt or after retry)."
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setFailureLogPhone(null)}>
            Close
          </Button>
        }
      >
        {failureLogPhone ? (
          <div className="space-y-3 text-sm">
            <dl className="grid gap-2 text-slate-700">
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-slate-500">Number</dt>
                <dd className="font-mono text-xs">{failureLogPhone.phone}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-slate-500">Status</dt>
                <dd>{failureLogPhone.status}</dd>
              </div>
              {failureLogPhone.failureSource ? (
                <div className="flex flex-wrap gap-2">
                  <dt className="font-medium text-slate-500">Source</dt>
                  <dd className="font-mono text-xs">{failureLogPhone.failureSource}</dd>
                </div>
              ) : null}
              {failureLogPhone.failedAt ? (
                <div className="flex flex-wrap gap-2">
                  <dt className="font-medium text-slate-500">Recorded</dt>
                  <dd className="text-xs">{failureLogPhone.failedAt}</dd>
                </div>
              ) : null}
            </dl>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                Summary
              </p>
              <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800">
                {failureLogPhone.error ?? '—'}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                Full diagnostic
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">
                {failureLogPhone.failureDetail?.trim() ||
                  'No extended log was stored (older Worker version or local demo data). The summary above is all we have.'}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete campaign?"
        description="This removes the campaign from your workspace."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                deleteCampaign(activeCampaign.id)
                setDeleteOpen(false)
                navigate('/campaigns')
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Delete <span className="font-medium text-slate-900">{activeCampaign.name}</span>? This
          cannot be undone.
        </p>
      </Modal>
    </div>
  )
}
