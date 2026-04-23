import { Card, CardHeader } from '../components/ui/Card'
import { analyticsMock } from '../data/mockData'

function BarGroup({
  label,
  sent,
  failed,
  max,
}: {
  label: string
  sent: number
  failed: number
  max: number
}) {
  const sentH = Math.round((sent / max) * 100)
  const failH = Math.round((failed / max) * 100)
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <div className="flex h-40 w-full max-w-[52px] items-end justify-center gap-1 sm:h-48">
        <div
          className="w-3 rounded-md bg-blue-500/90 sm:w-4"
          style={{ height: `${Math.max(sentH, 4)}%` }}
          title={`Sent: ${sent}`}
        />
        <div
          className="w-3 rounded-md bg-slate-300 sm:w-4"
          style={{ height: `${Math.max(failH, 4)}%` }}
          title={`Failed: ${failed}`}
        />
      </div>
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
    </div>
  )
}

export function AnalyticsPage() {
  const { sentVsFailed } = analyticsMock
  const maxBar = Math.max(...sentVsFailed.map((d) => d.sent + d.failed))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          Analytics
        </h1>
        <p className="mt-1 text-sm text-slate-500">Mock charts for weekly SMS volume and health.</p>
      </div>

      <Card padding="md">
        <CardHeader
          title="Sent vs failed"
          description="Stacked intent: blue is delivered, gray is failures (mock numbers)."
        />
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-blue-600" /> Sent
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-slate-300" /> Failed
          </span>
        </div>
        <div className="flex items-end justify-between gap-1 sm:gap-2">
          {sentVsFailed.map((d) => (
            <BarGroup key={d.label} label={d.label} sent={d.sent} failed={d.failed} max={maxBar} />
          ))}
        </div>
      </Card>

    </div>
  )
}
