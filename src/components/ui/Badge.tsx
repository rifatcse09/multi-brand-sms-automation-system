import type { CampaignStatus } from '../../types'

const styles: Record<CampaignStatus, string> = {
  Running: 'bg-blue-50 text-blue-700 ring-blue-600/10',
  Preparing: 'bg-amber-50 text-amber-800 ring-amber-600/10',
  Completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  Paused: 'bg-slate-100 text-slate-600 ring-slate-500/10',
  Scheduled: 'bg-purple-50 text-purple-700 ring-purple-600/10',
}

function normalizeStatus(status: CampaignStatus | string): CampaignStatus {
  if (
    status === 'Running' ||
    status === 'Completed' ||
    status === 'Paused' ||
    status === 'Scheduled' ||
    status === 'Preparing'
  ) {
    return status
  }
  const s = String(status).toLowerCase()
  if (s.includes('prep') || s.includes('build')) return 'Preparing'
  if (s.includes('run')) return 'Running'
  if (s.includes('sched')) return 'Scheduled'
  if (s.includes('pause')) return 'Paused'
  if (s.includes('complete') || s.includes('done')) return 'Completed'
  return 'Paused'
}

export function StatusBadge({ status }: { status: CampaignStatus | string }) {
  const key = normalizeStatus(status)
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[key]}`}
    >
      {key}
    </span>
  )
}
