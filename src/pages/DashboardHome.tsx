import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Button } from '../components/ui/Button'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { StatusBadge } from '../components/ui/Badge'
import { useAppData } from '../context/AppDataContext'
import { useDelayedReady } from '../hooks/useDelayedReady'
import {
  fetchWorkerSubscriberSummary,
  isWorkerConfigured,
  refreshWorkerSubscribers,
  type WorkerSubscriberBrand,
  type WorkerSubscriberSummary,
} from '../services/smsWorkerApi'

const ALL_BRANDS = 'all'

const brandCardThemes = [
  'border-violet-200 bg-violet-50/70 hover:border-violet-300 hover:bg-violet-100/60',
  'border-sky-200 bg-sky-50/70 hover:border-sky-300 hover:bg-sky-100/60',
  'border-emerald-200 bg-emerald-50/70 hover:border-emerald-300 hover:bg-emerald-100/60',
  'border-amber-200 bg-amber-50/70 hover:border-amber-300 hover:bg-amber-100/60',
]

function formatRelativeTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusPill(b: WorkerSubscriberBrand) {
  if (!b.fetchOk) {
    return {
      label: 'Stale',
      className: 'bg-rose-100 text-rose-700',
      title: b.fetchError || 'Last refresh failed.',
    }
  }
  if (b.status === 'fresh' || b.walkDone) {
    return {
      label: 'Fresh',
      className: 'bg-emerald-100 text-emerald-700',
      title: `Subscriber walk complete · ${formatRelativeTime(b.updatedAt)}`,
    }
  }
  return {
    label: 'Syncing',
    className: 'bg-amber-100 text-amber-700',
    title: 'Subscriber walk still in progress. Numbers will keep climbing.',
  }
}

type BrandStat = {
  id: string
  name: string
  campaigns: number
  sent: number
  failed: number
  active: number
}

function BrandCard({
  brand,
  dashboardTag,
  campaignStats,
  themeIndex,
  loadingSubscribers,
  subscriber,
  refreshing,
  onRefresh,
}: {
  brand: { id: string; name: string }
  dashboardTag?: string
  campaignStats: BrandStat | undefined
  themeIndex: number
  loadingSubscribers: boolean
  subscriber: WorkerSubscriberBrand | undefined
  refreshing: boolean
  onRefresh: (brandId: string) => void
}) {
  const tagForLink = (dashboardTag || subscriber?.dashboardTag || '').trim()
  const campaignHref = tagForLink
    ? `/campaigns/new?brand=${encodeURIComponent(brand.id)}&tag=${encodeURIComponent(tagForLink)}`
    : `/campaigns/new?brand=${encodeURIComponent(brand.id)}`
  const audienceLabel = tagForLink || subscriber?.dashboardTag
  const allContacts = subscriber?.allContacts ?? 0
  const totalSubs = subscriber?.totalSubscribers ?? 0
  const activeSubs = subscriber?.activeSmsSubscribers ?? 0
  const unsubs = subscriber?.unsubscribedTotal ?? 0
  const growth = subscriber?.growth ?? 0
  const todayActive = subscriber?.todayActive ?? 0
  const yesterdayActive = subscriber?.yesterdayActive ?? 0
  const walkedOffset = subscriber?.walkedOffset ?? 0
  const walkedTotal = subscriber?.walkedTotal ?? allContacts
  const walkDone = subscriber?.walkDone ?? false
  const walkPct =
    walkedTotal > 0 ? Math.min(100, Math.round((walkedOffset / walkedTotal) * 100)) : 0
  const pill = subscriber ? statusPill(subscriber) : null

  return (
    <div
      className={`rounded-xl border px-4 py-4 transition-colors ${brandCardThemes[themeIndex % brandCardThemes.length]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={campaignHref}
            className="text-lg font-bold text-slate-900 hover:underline"
            title={tagForLink ? `New campaign with tag ${tagForLink}` : 'New campaign'}
          >
            {brand.name}
          </Link>
          {audienceLabel ? (
            <p className="mt-0.5 text-xs font-medium text-violet-800">
              Tag: {audienceLabel}
              {subscriber?.audienceScope === 'tag' ? (
                <span className="ml-1 font-normal text-slate-500">(tag audience)</span>
              ) : null}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-amber-700">No dashboard tag — configure in Brands</p>
          )}
          {pill ? (
            <span
              title={pill.title}
              className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${pill.className}`}
            >
              {pill.label}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-slate-700">
            {campaignStats?.campaigns ?? 0} campaigns
          </span>
          <Button
            variant="secondary"
            size="sm"
            loading={refreshing}
            onClick={() => onRefresh(brand.id)}
            title={
              tagForLink
                ? `Recount contacts with tag "${tagForLink}" from ActiveCampaign`
                : 'Walk more contacts from ActiveCampaign and update counts'
            }
            aria-label={`Recount subscribers for ${brand.name}`}
          >
            {!refreshing ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : null}
            Recount
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-white/85 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            All Contacts
          </p>
          {loadingSubscribers ? (
            <Skeleton className="mt-2 h-8 w-20" />
          ) : (
            <p className="font-mono text-3xl font-extrabold leading-none text-indigo-800">
              {allContacts.toLocaleString()}
            </p>
          )}
        </div>
        <div className="rounded-lg bg-white/85 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            Total Subscribers
          </p>
          {loadingSubscribers ? (
            <Skeleton className="mt-2 h-8 w-20" />
          ) : (
            <>
              <p className="font-mono text-3xl font-extrabold leading-none text-indigo-800">
                {totalSubs.toLocaleString()}
              </p>
              {!walkDone && walkedTotal > 0 ? (
                <p className="mt-1 text-[10px] font-medium text-amber-700">
                  syncing · walked {walkedOffset.toLocaleString()} /{' '}
                  {walkedTotal.toLocaleString()} ({walkPct}%)
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="rounded-lg bg-white/85 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            Active Subscribers
          </p>
          {loadingSubscribers ? (
            <Skeleton className="mt-2 h-8 w-20" />
          ) : (
            <p className="font-mono text-3xl font-extrabold leading-none text-violet-800">
              {activeSubs.toLocaleString()}
            </p>
          )}
        </div>
        <div className="rounded-lg bg-white/85 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            Unsubscribed
          </p>
          {loadingSubscribers ? (
            <Skeleton className="mt-2 h-8 w-20" />
          ) : (
            <p className="font-mono text-3xl font-extrabold leading-none text-rose-800">
              {unsubs.toLocaleString()}
            </p>
          )}
        </div>
        <div className="rounded-lg bg-white/85 px-2.5 py-2 col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            Growth
          </p>
          {loadingSubscribers ? (
            <div className="mt-2 space-y-1.5">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-28" />
            </div>
          ) : (
            <>
              <p
                className={`font-mono text-3xl font-extrabold leading-none ${
                  growth >= 0 ? 'text-emerald-800' : 'text-rose-800'
                }`}
              >
                {growth > 0 ? '+' : ''}
                {growth.toLocaleString()}
              </p>
              <p className="mt-1 text-[11px] font-medium text-slate-500">
                today {todayActive.toLocaleString()} vs yesterday{' '}
                {yesterdayActive.toLocaleString()}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-rose-700">
          {(campaignStats?.failed ?? 0).toLocaleString()} failed
        </span>
        {(campaignStats?.active ?? 0) > 0 ? (
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-blue-700">
            {campaignStats?.active} running
          </span>
        ) : null}
        {subscriber?.updatedAt ? (
          <span className="ml-auto text-slate-500">
            updated {formatRelativeTime(subscriber.updatedAt)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function DashboardHome() {
  const { campaigns, brands, getBrandName, workerLinked } = useAppData()
  const ready = useDelayedReady()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedBrandId = searchParams.get('brand')?.trim() || ALL_BRANDS

  const [subscriberSummary, setSubscriberSummary] = useState<WorkerSubscriberSummary | null>(
    null,
  )
  const [loadingSubscriberSummary, setLoadingSubscriberSummary] = useState(false)
  const [refreshingBrandIds, setRefreshingBrandIds] = useState<Set<string>>(new Set())

  const totals = useMemo(
    () =>
      campaigns.reduce(
        (acc, c) => {
          acc.campaigns += 1
          acc.sent += c.sent
          acc.failed += c.failed
          if (c.status === 'Running') acc.active += 1
          return acc
        },
        { campaigns: 0, sent: 0, failed: 0, active: 0 },
      ),
    [campaigns],
  )

  const filteredCampaigns = useMemo(
    () =>
      selectedBrandId === ALL_BRANDS
        ? campaigns
        : campaigns.filter((c) => c.brandId === selectedBrandId),
    [campaigns, selectedBrandId],
  )

  const filteredTotals = useMemo(
    () =>
      filteredCampaigns.reduce(
        (acc, c) => {
          acc.campaigns += 1
          acc.sent += c.sent
          acc.failed += c.failed
          if (c.status === 'Running') acc.active += 1
          return acc
        },
        { campaigns: 0, sent: 0, failed: 0, active: 0 },
      ),
    [filteredCampaigns],
  )

  const running = useMemo(
    () => filteredCampaigns.filter((c) => c.status === 'Running'),
    [filteredCampaigns],
  )

  const brandSummaries = useMemo<BrandStat[]>(
    () =>
      brands
        .map((b) => {
          const brandCampaigns = campaigns.filter((c) => c.brandId === b.id)
          return {
            id: b.id,
            name: b.name,
            campaigns: brandCampaigns.length,
            sent: brandCampaigns.reduce((sum, c) => sum + c.sent, 0),
            failed: brandCampaigns.reduce((sum, c) => sum + c.failed, 0),
            active: brandCampaigns.filter((c) => c.status === 'Running').length,
          }
        })
        .sort((a, b) => b.campaigns - a.campaigns || b.sent - a.sent),
    [brands, campaigns],
  )

  const campaignStatsByBrand = useMemo(
    () => new Map(brandSummaries.map((b) => [b.id, b])),
    [brandSummaries],
  )

  const brandSubscriberMap = useMemo(
    () => new Map((subscriberSummary?.byBrand ?? []).map((x) => [x.brandId, x])),
    [subscriberSummary],
  )

  const visibleBrands =
    selectedBrandId === ALL_BRANDS
      ? brandSummaries
      : brandSummaries.filter((b) => b.id === selectedBrandId)

  const isAllBrands = selectedBrandId === ALL_BRANDS

  const statTotals = isAllBrands ? totals : filteredTotals
  const statCards = [
    {
      label: 'Total campaigns',
      value: statTotals.campaigns,
      cardClass: 'border-violet-200 bg-violet-50/80',
      labelClass: 'text-violet-700',
      valueClass: 'text-violet-950',
    },
    {
      label: 'Total sent',
      value: statTotals.sent.toLocaleString(),
      cardClass: 'border-emerald-200 bg-emerald-50/80',
      labelClass: 'text-emerald-700',
      valueClass: 'text-emerald-950',
    },
    {
      label: 'Total failed',
      value: statTotals.failed.toLocaleString(),
      cardClass: 'border-rose-200 bg-rose-50/80',
      labelClass: 'text-rose-700',
      valueClass: 'text-rose-950',
    },
    {
      label: 'Active campaigns',
      value: statTotals.active,
      cardClass: 'border-sky-200 bg-sky-50/80',
      labelClass: 'text-sky-700',
      valueClass: 'text-sky-950',
    },
  ]

  const reloadSummary = useCallback(async () => {
    if (!isWorkerConfigured()) return
    setLoadingSubscriberSummary(true)
    try {
      const data = await fetchWorkerSubscriberSummary()
      setSubscriberSummary(data)
    } catch {
      setSubscriberSummary(null)
    } finally {
      setLoadingSubscriberSummary(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isWorkerConfigured()) return
      setLoadingSubscriberSummary(true)
      try {
        const data = await fetchWorkerSubscriberSummary()
        if (!cancelled) setSubscriberSummary(data)
      } catch {
        if (!cancelled) setSubscriberSummary(null)
      } finally {
        if (!cancelled) setLoadingSubscriberSummary(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedBrandId === ALL_BRANDS) return
    if (brands.length === 0) return
    if (brands.some((b) => b.id === selectedBrandId)) return
    const next = new URLSearchParams(searchParams)
    next.delete('brand')
    setSearchParams(next, { replace: true })
  }, [brands, searchParams, selectedBrandId, setSearchParams])

  const handleBrandChange = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === ALL_BRANDS) {
      next.delete('brand')
    } else {
      next.set('brand', value)
    }
    setSearchParams(next, { replace: false })
  }

  const handleRecount = useCallback(
    async (brandId: string) => {
      if (!isWorkerConfigured()) return
      setRefreshingBrandIds((prev) => {
        const next = new Set(prev)
        next.add(brandId)
        return next
      })
      try {
        await refreshWorkerSubscribers({ brandId, maxPages: 20 })
        await reloadSummary()
      } catch {
        // ignore — fetch error will surface via worker error banner if persistent
      } finally {
        setRefreshingBrandIds((prev) => {
          const next = new Set(prev)
          next.delete(brandId)
          return next
        })
      }
    },
    [reloadSummary],
  )

  const selectedBrandSubscriber =
    selectedBrandId === ALL_BRANDS
      ? null
      : brandSubscriberMap.get(selectedBrandId) ?? null

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-500">Overview of SMS performance across brands.</p>
          <p className="mt-2 text-xs text-slate-400">
            Data source: {workerLinked ? 'Cloudflare Worker live metrics' : 'Local mock dataset'}
          </p>
        </div>
        <div className="w-full sm:w-64">
          <label className="mb-1.5 block text-xs font-medium text-slate-500">Brand</label>
          <Select
            value={selectedBrandId}
            onChange={(e) => handleBrandChange(e.target.value)}
            aria-label="Brand"
          >
            <option value={ALL_BRANDS}>All brands</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((s) => (
          <Card
            key={s.label}
            padding="md"
            className={`border ${s.cardClass} transition-shadow hover:shadow-md`}
          >
            {!ready ? (
              <div className="space-y-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-16" />
              </div>
            ) : (
              <>
                <p
                  className={`font-serif text-xs font-semibold uppercase tracking-wider ${s.labelClass}`}
                >
                  {s.label}
                </p>
                <p
                  className={`mt-2 font-mono text-4xl font-bold leading-none tracking-tight ${s.valueClass}`}
                >
                  {s.value}
                </p>
              </>
            )}
          </Card>
        ))}
      </div>

      {ready && running.length > 0 ? (
        <Card padding="md">
          <CardHeader
            title="Running campaigns"
            description={
              isAllBrands
                ? 'Live queue progress for active sends.'
                : `Live queue progress for ${getBrandName(selectedBrandId)}.`
            }
          />
          <div className="space-y-4">
            {running.map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{c.name}</p>
                    <p className="text-xs text-slate-500">{getBrandName(c.brandId)}</p>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
                <div className="mt-3">
                  <ProgressBar value={c.queueProgress} />
                  <p className="mt-1.5 text-xs text-slate-500">
                    {c.sent.toLocaleString()} / {c.total.toLocaleString()} sent ·{' '}
                    {c.queueProgress}% complete
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {isAllBrands ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card padding="md" className="border border-slate-200 bg-slate-50/80">
            <p className="font-serif text-xs font-semibold uppercase tracking-wider text-slate-600">
              Brands
            </p>
            <p className="mt-2 font-mono text-4xl font-bold leading-none text-slate-900">
              {brandSummaries.length}
            </p>
          </Card>
          <Card padding="md" className="border border-emerald-200 bg-emerald-50/80">
            <p className="font-serif text-xs font-semibold uppercase tracking-wider text-emerald-700">
              Sent
            </p>
            <p className="mt-2 font-mono text-4xl font-bold leading-none text-emerald-950">
              {totals.sent.toLocaleString()}
            </p>
          </Card>
          <Card padding="md" className="border border-rose-200 bg-rose-50/80">
            <p className="font-serif text-xs font-semibold uppercase tracking-wider text-rose-700">
              Failed
            </p>
            <p className="mt-2 font-mono text-4xl font-bold leading-none text-rose-950">
              {totals.failed.toLocaleString()}
            </p>
          </Card>
        </div>
      ) : null}

      <Card padding="md">
        <CardHeader
          title={isAllBrands ? 'Brands' : getBrandName(selectedBrandId)}
          description={
            isAllBrands
              ? 'Per-brand audience snapshot. Click a card to open brand-wise campaign list.'
              : 'Audience snapshot for the selected brand.'
          }
          action={
            <Link to="/brands">
              <Button variant="secondary" size="sm">
                Manage brands
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Button>
            </Link>
          }
        />
        {!ready ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : visibleBrands.length === 0 ? (
          <p className="text-sm text-slate-500">No brands available yet.</p>
        ) : (
          <>
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">All Contacts</span> = contacts on the
              brand&apos;s dashboard tag (or whole account if no tag){' · '}
              <span className="font-semibold text-slate-700">Total Subscribers</span> = SMS-capable
              on that audience{' · '}
              <span className="font-semibold text-slate-700">Active</span> = can still receive
              messages{' · '}
              <span className="font-semibold text-slate-700">Growth</span> = today vs yesterday
              {!isAllBrands && selectedBrandSubscriber && !selectedBrandSubscriber.walkDone ? (
                <span className="ml-1 font-medium text-amber-700">
                  · This brand is still syncing — Total Subscribers will keep climbing until it
                  finishes. Use Recount to speed it up.
                </span>
              ) : null}
            </div>
            <div
              className={
                visibleBrands.length === 1
                  ? 'grid gap-2'
                  : 'grid gap-2 sm:grid-cols-2'
              }
            >
              {visibleBrands.map((b, idx) => {
                const brandRow = brands.find((br) => br.id === b.id)
                return (
                <BrandCard
                  key={b.id}
                  brand={{ id: b.id, name: b.name }}
                  dashboardTag={brandRow?.dashboardTag}
                  campaignStats={campaignStatsByBrand.get(b.id)}
                  themeIndex={idx}
                  loadingSubscribers={loadingSubscriberSummary}
                  subscriber={brandSubscriberMap.get(b.id)}
                  refreshing={refreshingBrandIds.has(b.id)}
                  onRefresh={handleRecount}
                />
              )})}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
