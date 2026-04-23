import type { CampaignStatus } from '../../types'

const styles: Record<CampaignStatus, string> = {
  Running: 'bg-blue-50 text-blue-700 ring-blue-600/10',
  Completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
  Paused: 'bg-amber-50 text-amber-800 ring-amber-600/10',
}

export function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[status]}`}
    >
      {status}
    </span>
  )
}
