import type { Brand, Campaign, CampaignStatus } from '../types'

type WorkerMetric = Record<string, unknown>

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
  if (normalized.includes('pause')) return 'Paused'
  if (normalized.includes('run') || normalized.includes('progress')) return 'Running'
  if (normalized.includes('done') || normalized.includes('complete')) return 'Completed'
  return 'Completed'
}

function compactMessage(message: string) {
  return message.length > 64 ? `${message.slice(0, 64)}...` : message
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

  return items.map((item, idx) => {
    const id =
      asString(item.blast_id) ||
      asString(item.id) ||
      asString(item.bid) ||
      `worker-blast-${idx + 1}`
    const tag = asString(item.tag, 'SMS_BLAST')
    const message = asString(item.msg) || asString(item.message, 'SMS blast message')
    const sent =
      asNumber(item.sent) ||
      asNumber(item.delivered) ||
      asNumber(item.success) ||
      asNumber(item.ok)
    const failed =
      asNumber(item.failed) || asNumber(item.errors) || asNumber(item.undelivered)
    const total =
      asNumber(item.total) ||
      asNumber(item.target_total) ||
      asNumber(item.contacts) ||
      sent + failed
    const pct = total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0
    const statusRaw = asString(item.status)
    const status =
      statusRaw.length > 0
        ? toCampaignStatus(statusRaw)
        : pct >= 100
          ? 'Completed'
          : sent + failed > 0
            ? 'Running'
            : 'Paused'

    const createdRaw =
      asString(item.created_at) ||
      asString(item.createdAt) ||
      asString(item.ts) ||
      asString(item.time)
    const createdAt = createdRaw ? new Date(createdRaw).toISOString() : new Date().toISOString()

    return {
      id,
      name: asString(item.name) || `Blast ${id}`,
      messagePreview: compactMessage(message),
      brandId: fallbackBrandId,
      tag,
      message,
      total,
      sent,
      failed,
      status,
      important: false,
      createdAt,
      batches: [],
      phones: [],
      queueProgress: status === 'Completed' ? 100 : pct,
    } satisfies Campaign
  })
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

export async function fetchWorkerSentVsFailed() {
  const payload = await requestJson('/analytics/sent-failed')
  return (
    (payload.sentVsFailed as Array<{ label: string; sent: number; failed: number }> | undefined) ??
    []
  )
}

export async function fetchWorkerCampaignById(id: string) {
  const payload = await requestJson(`/campaigns/${id}`)
  return payload as { ok: true; campaign: Campaign & { phones?: unknown[] } }
}

export async function deleteWorkerCampaign(id: string) {
  const payload = await requestJson(`/campaigns/${id}`, {
    method: 'DELETE',
  })
  return payload as { ok: true; campaign: Campaign }
}
