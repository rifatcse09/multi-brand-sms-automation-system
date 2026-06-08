import type { Brand, Campaign, CampaignStatus } from '../types'

type WorkerMetric = Record<string, unknown>
export type WorkerBrandTag = {
  id: string
  tag: string
  totalSubscribers?: number
  cacheStatus?: WorkerSubscriberCacheStatus
}
export type WorkerSubscriberCacheStatus = 'fresh' | 'partial' | 'stale'

export type WorkerSubscriberBrand = {
  brandId: string
  brandName: string
  allContacts: number
  totalSubscribers: number
  activeSmsSubscribers: number
  unsubscribedTotal: number
  growth: number
  todayActive: number
  yesterdayActive: number
  status: WorkerSubscriberCacheStatus
  fetchOk: boolean
  fetchError: string
  updatedAt: string
  walkedOffset: number
  walkedTotal: number
  walkDone: boolean
  dashboardTag?: string
  audienceScope?: 'tag' | 'account'
}

export type WorkerSubscriberSummary = {
  totalContacts: number
  totalSubscribers: number
  activeSmsSubscribers: number
  unsubscribedTotal: number
  growth: number
  todayActive: number
  yesterdayActive: number
  byBrand: WorkerSubscriberBrand[]
}

const workerBaseUrl = import.meta.env.VITE_SMS_WORKER_BASE_URL?.replace(/\/+$/, '')
const workerSecret = import.meta.env.VITE_SMS_WORKER_SECRET

function buildUrl(path: string, params: Record<string, string>) {
  if (!workerBaseUrl) throw new Error('Worker base URL is not configured')
  const url = new URL(path, workerBaseUrl)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return url
}

async function readJson(url: URL) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(workerSecret ? { 'x-worker-secret': workerSecret } : {}),
    },
  })
  if (!res.ok) {
    throw new Error(`Worker request failed: ${res.status}`)
  }
  return res.json() as Promise<unknown>
}

async function requestJson(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    params?: Record<string, string>
    body?: unknown
    authToken?: string
  } = {},
) {
  if (!workerBaseUrl) throw new Error('Worker base URL is not configured')
  const url = new URL(path, workerBaseUrl)
  Object.entries(init.params ?? {}).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(workerSecret ? { 'x-worker-secret': workerSecret } : {}),
      ...(init.authToken ? { Authorization: `Bearer ${init.authToken}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`)
  }
  return payload
}

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function parseMetricsArray(payload: unknown): WorkerMetric[] {
  if (Array.isArray(payload)) return payload as WorkerMetric[]
  if (payload && typeof payload === 'object') {
    const data = payload as Record<string, unknown>
    const keys = ['items', 'results', 'metrics', 'data', 'blasts']
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key] as WorkerMetric[]
    }
  }
  return []
}

function toCampaignStatus(value: string): CampaignStatus {
  const normalized = value.toLowerCase()
  if (normalized.includes('prep') || normalized.includes('build')) return 'Preparing'
  if (normalized.includes('sched')) return 'Scheduled'
  if (normalized.includes('pause')) return 'Paused'
  if (normalized.includes('run') || normalized.includes('progress')) return 'Running'
  if (normalized.includes('done') || normalized.includes('complete')) return 'Completed'
  return 'Completed'
}

function compactMessage(message: string) {
  return message.length > 64 ? `${message.slice(0, 64)}...` : message
}

function mapWorkerCampaignRow(
  item: WorkerMetric,
  idx: number,
  fallbackBrandId: string,
): Campaign {
  const rec = item as Record<string, unknown>
  const id =
    asString(rec.blast_id) ||
    asString(rec.id) ||
    asString(rec.bid) ||
    `worker-blast-${idx + 1}`
  const tag = asString(rec.tag, 'SMS_BLAST')
  const message = asString(rec.msg) || asString(rec.message, '')
  const messagePreview =
    asString(rec.messagePreview) || (message ? compactMessage(message) : '')
  const sent =
    asNumber(rec.sent) ||
    asNumber(rec.delivered) ||
    asNumber(rec.success) ||
    asNumber(rec.ok)
  const failed =
    asNumber(rec.failed) || asNumber(rec.errors) || asNumber(rec.undelivered)
  const total =
    asNumber(rec.total) ||
    asNumber(rec.target_total) ||
    asNumber(rec.contacts) ||
    (sent + failed > 0 ? sent + failed : 0)
  const pct = total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0
  const statusRaw = asString(rec.status)
  const status: CampaignStatus =
    statusRaw === 'Running' ||
    statusRaw === 'Completed' ||
    statusRaw === 'Paused' ||
    statusRaw === 'Scheduled' ||
    statusRaw === 'Preparing'
      ? statusRaw
      : statusRaw.length > 0
        ? toCampaignStatus(statusRaw)
        : pct >= 100
          ? 'Completed'
          : sent + failed > 0
            ? 'Running'
            : 'Paused'
  const createdRaw =
    asString(rec.created_at) ||
    asString(rec.createdAt) ||
    asString(rec.ts) ||
    asString(rec.time)
  const createdAt = createdRaw ? new Date(createdRaw).toISOString() : new Date().toISOString()
  const brandId = asString(rec.brandId, fallbackBrandId)
  const qp = asNumber(rec.queueProgress)

  return {
    id,
    name: asString(rec.name) || `Blast ${id}`,
    messagePreview,
    brandId,
    tag,
    message: message || 'SMS blast message',
    total,
    sent,
    failed,
    status,
    important: Boolean(rec.important),
    createdAt,
    deletedAt: rec.deletedAt ? asString(rec.deletedAt) : undefined,
    scheduledAtUtc: asString(rec.scheduledAtUtc) || undefined,
    scheduleTimezone: asString(rec.scheduleTimezone) || undefined,
    scheduleAtLocal: asString(rec.scheduleAtLocal) || undefined,
    batches: [],
    phones: [],
    queueProgress:
      qp > 0 ? Math.min(100, qp) : status === 'Completed' ? 100 : pct,
  }
}

export function isWorkerConfigured() {
  return Boolean(workerBaseUrl && workerSecret)
}

export async function fetchWorkerHealth() {
  if (!workerSecret) return false
  const url = buildUrl('/health', { secret: workerSecret })
  try {
    const payload = await readJson(url)
    return Boolean((payload as { ok?: unknown })?.ok)
  } catch {
    return false
  }
}

export async function fetchWorkerCampaigns(fallbackBrandId: string): Promise<Campaign[]> {
  if (!workerSecret) return []
  const url = buildUrl('/metrics/all', { secret: workerSecret, limit: '50' })
  const payload = await readJson(url)
  const items = parseMetricsArray(payload)

  return items.map((item, idx) => mapWorkerCampaignRow(item, idx, fallbackBrandId))
}

export async function createWorkerCampaign(input: {
  id?: string
  brandId: string
  tag: string
  message: string
  scheduledAtUtc?: string
  scheduleTimezone?: string
  scheduleAtLocal?: string
}) {
  const payload = (await requestJson('/campaigns', {
    method: 'POST',
    body: input,
  })) as { campaign?: WorkerMetric }
  const raw = payload.campaign
  if (!raw || typeof raw !== 'object') throw new Error('Invalid campaign response')
  return mapWorkerCampaignRow(raw, 0, input.brandId)
}

export async function triggerWorkerBlast(input: {
  tag: string
  message: string
  blastId: string
}) {
  if (!workerSecret) throw new Error('Worker secret is not configured')
  const url = buildUrl('/blast', {
    secret: workerSecret,
    tag: input.tag,
    msg: input.message,
    blast_id: input.blastId,
  })
  return readJson(url)
}

export async function loginWithWorker(input: { email: string; password: string }) {
  const payload = await requestJson('/auth/login', {
    method: 'POST',
    body: input,
  })
  return payload as {
    ok: true
    token: string
    user: { email: string }
  }
}

export async function forgotPasswordWithWorker(input: { email: string }) {
  const payload = await requestJson('/auth/forgot-password', {
    method: 'POST',
    body: input,
  })
  return payload as {
    ok: true
    sentToOwner: boolean
    ownerPhoneMasked: string | null
  }
}

export async function resetPasswordWithWorker(input: {
  email: string
  code: string
  newPassword: string
}) {
  const payload = await requestJson('/auth/reset-password', {
    method: 'POST',
    body: input,
  })
  return payload as { ok: true }
}

export async function changePasswordWithWorker(input: {
  token: string
  currentPassword: string
  newPassword: string
}) {
  const payload = await requestJson('/auth/change-password', {
    method: 'POST',
    authToken: input.token,
    body: {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    },
  })
  return payload as { ok: true }
}

export async function fetchWorkerBrands() {
  const payload = await requestJson('/brands')
  return (payload.brands as Brand[] | undefined) ?? []
}

export async function createWorkerBrand(brand: Omit<Brand, 'id'>) {
  const payload = await requestJson('/brands', {
    method: 'POST',
    body: brand,
  })
  return payload as { ok: true; brand: Brand }
}

export async function updateWorkerBrand(id: string, patch: Partial<Brand>) {
  const payload = await requestJson(`/brands/${id}`, {
    method: 'PUT',
    body: patch,
  })
  return payload as { ok: true; brand: Brand }
}

export async function deleteWorkerBrand(id: string) {
  const payload = await requestJson(`/brands/${id}`, {
    method: 'DELETE',
  })
  return payload as { ok: true }
}

export async function fetchWorkerBrandTags(brandId: string) {
  const payload = await requestJson(`/brands/${encodeURIComponent(brandId)}/activecampaign/tags`)
  return ((payload.tags as WorkerBrandTag[] | undefined) ?? []).filter(
    (x) => typeof x?.id === 'string' && typeof x?.tag === 'string',
  )
}

export async function warmupWorkerBrandTagSubscribers(brandId: string) {
  const payload = await requestJson(
    `/brands/${encodeURIComponent(brandId)}/subscribers/warmup`,
    { method: 'POST' },
  )
  return payload as { ok: true; warming: boolean }
}

export async function fetchWorkerBrandTagSubscribers(
  brandId: string,
  tag: string,
  options?: { refresh?: boolean; maxPages?: number },
): Promise<WorkerSubscriberBrand & { tag?: string }> {
  const params: Record<string, string> = { tag }
  if (options?.refresh) params.refresh = '1'
  if (options?.maxPages) params.maxPages = String(options.maxPages)
  const payload = (await requestJson(`/brands/${encodeURIComponent(brandId)}/subscribers`, {
    params,
  })) as { subscribers?: Record<string, unknown> }
  return mapSubscriberBrand(payload.subscribers ?? {})
}

export async function fetchWorkerSentVsFailed(opts: { from: string; to: string } | { days: number } = { days: 14 }) {
  const params: Record<string, string> = 'from' in opts ? { from: opts.from, to: opts.to } : { days: String(opts.days) }
  const payload = await requestJson('/analytics/sent-failed', { params })
  return (
    (payload.sentVsFailed as Array<{ date: string; label: string; sent: number; failed: number }> | undefined) ??
    []
  )
}

export async function fetchWorkerSubscriberTrend(opts: { from: string; to: string } | { days: number } = { days: 14 }) {
  const params: Record<string, string> = 'from' in opts ? { from: opts.from, to: opts.to } : { days: String(opts.days) }
  const payload = await requestJson('/analytics/subscriber-trend', { params })
  return (
    (payload.subscriberTrend as Array<{ date: string; label: string; delivered: number; unsubs: number; net: number }> | undefined) ??
    []
  )
}

function asCacheStatus(value: unknown): WorkerSubscriberCacheStatus {
  return value === 'fresh' || value === 'partial' || value === 'stale' ? value : 'stale'
}

function mapSubscriberBrand(x: Record<string, unknown>): WorkerSubscriberBrand {
  const allContacts = asNumber(x.allContacts, 0)
  return {
    brandId: asString(x.brandId),
    brandName: asString(x.brandName),
    allContacts,
    totalSubscribers: asNumber(x.totalSubscribers, 0),
    activeSmsSubscribers: asNumber(x.activeSmsSubscribers, 0),
    unsubscribedTotal: asNumber(x.unsubscribedTotal, 0),
    growth: asNumber(x.growth, 0),
    todayActive: asNumber(x.todayActive, 0),
    yesterdayActive: asNumber(x.yesterdayActive, 0),
    status: asCacheStatus(x.status),
    fetchOk: Boolean(x.fetchOk),
    fetchError: asString(x.fetchError),
    updatedAt: asString(x.updatedAt),
    walkedOffset: asNumber(x.walkedOffset, 0),
    walkedTotal: asNumber(x.walkedTotal, allContacts),
    walkDone: Boolean(x.walkDone),
    dashboardTag: asString(x.dashboardTag) || undefined,
    audienceScope:
      x.audienceScope === 'tag' || x.audienceScope === 'account' ? x.audienceScope : undefined,
  }
}

export async function fetchWorkerSubscriberSummary(): Promise<WorkerSubscriberSummary> {
  const payload = (await requestJson('/analytics/subscribers-summary')) as {
    summary?: Partial<WorkerSubscriberSummary>
  }
  const s = payload.summary ?? {}
  const byBrandRaw = Array.isArray((s as { byBrand?: unknown }).byBrand)
    ? ((s as { byBrand: Array<Record<string, unknown>> }).byBrand ?? [])
    : []
  return {
    totalSubscribers: asNumber(s.totalSubscribers, 0),
    totalContacts: asNumber(s.totalContacts, 0),
    activeSmsSubscribers: asNumber(s.activeSmsSubscribers, 0),
    unsubscribedTotal: asNumber(s.unsubscribedTotal, 0),
    growth: asNumber(s.growth, 0),
    todayActive: asNumber(s.todayActive, 0),
    yesterdayActive: asNumber(s.yesterdayActive, 0),
    byBrand: byBrandRaw.map(mapSubscriberBrand),
  }
}

export async function refreshWorkerSubscribers(input: {
  brandId?: string
  maxPages?: number
}): Promise<WorkerSubscriberBrand[]> {
  const params: Record<string, string> = {
    brandId: input.brandId ?? 'all',
    maxPages: String(Math.max(1, Math.min(input.maxPages ?? 20, 20))),
  }
  const payload = (await requestJson('/analytics/subscribers-summary/refresh', {
    method: 'POST',
    params,
  })) as { brands?: Array<Record<string, unknown>> }
  const rows = Array.isArray(payload.brands) ? payload.brands : []
  return rows.map(mapSubscriberBrand)
}

export async function retryWorkerPhone(campaignId: string, phoneId: string) {
  await requestJson(`/campaigns/${campaignId}/phones/${encodeURIComponent(phoneId)}/retry`, {
    method: 'POST',
  })
}

export async function resumeWorkerCampaign(campaignId: string) {
  const payload = (await requestJson(`/campaigns/${campaignId}/resume`, {
    method: 'POST',
  })) as {
    ok?: boolean
    queued?: number
    pending?: number
    resuming?: boolean
    message?: string
    error?: string
  }
  if (!payload.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Resume failed')
  }
  return {
    queued: typeof payload.queued === 'number' ? payload.queued : 0,
    pending: typeof payload.pending === 'number' ? payload.pending : 0,
    resuming: Boolean(payload.resuming),
    message: typeof payload.message === 'string' ? payload.message : undefined,
  }
}

export type WorkerCampaignProgress = {
  id: string
  status: CampaignStatus
  total: number
  sent: number
  failed: number
  pending: number
  queueProgress: number
}

export async function fetchWorkerCampaignProgress(id: string) {
  const payload = (await requestJson(`/campaigns/${id}/progress`)) as {
    ok?: boolean
    progress?: WorkerCampaignProgress
    error?: string
  }
  if (!payload.ok || !payload.progress) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Progress fetch failed')
  }
  return payload.progress
}

export async function fetchWorkerCampaignById(id: string) {
  const payload = (await requestJson(`/campaigns/${id}`)) as {
    ok?: boolean
    campaign?: Campaign & { phones?: unknown[]; batches?: unknown[] }
  }
  const c = payload.campaign
  if (!c || typeof c !== 'object') {
    throw new Error('Worker returned no campaign payload')
  }
  return {
    ok: true as const,
    campaign: {
      ...c,
      batches: Array.isArray(c.batches) ? c.batches : [],
      phones: (Array.isArray(c.phones) ? c.phones : []) as Campaign['phones'],
    },
  }
}

export async function deleteWorkerCampaign(id: string) {
  const payload = await requestJson(`/campaigns/${id}`, {
    method: 'DELETE',
  })
  return payload as { ok: true; campaign: Campaign }
}

export type WorkerTwilioPricing = {
  country: string
  priceUnit: string
  averagePrice: number | null
  minPrice: number | null
  maxPrice: number | null
  carrierCount: number
}

export async function fetchWorkerBrandTwilioPricing(
  brandId: string,
  country = 'US',
): Promise<WorkerTwilioPricing> {
  const payload = await requestJson(
    `/brands/${encodeURIComponent(brandId)}/twilio-pricing`,
    { params: { country } },
  )
  return payload as WorkerTwilioPricing
}
