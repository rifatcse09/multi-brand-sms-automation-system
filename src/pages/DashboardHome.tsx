import { Link } from 'react-router-dom'
import { ArrowUpRight, Megaphone } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { ProgressBar } from '../components/ui/ProgressBar'
import { TableWrap, Th, Td } from '../components/ui/Table'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { EmptyState } from '../components/ui/EmptyState'
import { StatusBadge } from '../components/ui/Badge'
import { useAppData } from '../context/AppDataContext'
import { useDelayedReady } from '../hooks/useDelayedReady'

export function DashboardHome() {
  const { campaigns, getBrandName, workerLinked } = useAppData()
  const ready = useDelayedReady()

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.campaigns += 1
      acc.sent += c.sent
      acc.failed += c.failed
      if (c.status === 'Running') acc.active += 1
      return acc
    },
    { campaigns: 0, sent: 0, failed: 0, active: 0 },
  )

  const recent = [...campaigns]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)

  const running = campaigns.filter((c) => c.status === 'Running')

  const statCards = [
    { label: 'Total campaigns', value: totals.campaigns },
    { label: 'Total sent', value: totals.sent.toLocaleString() },
    { label: 'Total failed', value: totals.failed.toLocaleString() },
    { label: 'Active campaigns', value: totals.active },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-500">Overview of SMS performance across brands.</p>
        <p className="mt-2 text-xs text-slate-400">
          Data source: {workerLinked ? 'Cloudflare Worker live metrics' : 'Local mock dataset'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((s) => (
          <Card key={s.label} padding="md" className="transition-shadow hover:shadow-md">
            {!ready ? (
              <div className="space-y-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-16" />
              </div>
            ) : (
              <>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {s.label}
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
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
            description="Live queue progress for active sends."
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

      <Card padding="none">
        <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <CardHeader
            title="Recent campaigns"
            description="Latest activity across your workspace."
            action={
              <Link to="/campaigns">
                <Button variant="secondary" size="sm">
                  View all
                  <ArrowUpRight className="h-4 w-4" aria-hidden />
                </Button>
              </Link>
            }
          />
        </div>
        {!ready ? (
          <div className="space-y-2 px-5 py-4 sm:px-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="p-5 sm:p-6">
            <EmptyState
              icon={Megaphone}
              title="No campaigns yet"
              description="Create a campaign to see it listed here."
              action={
                <Link to="/campaigns/new">
                  <Button>Create campaign</Button>
                </Link>
              }
            />
          </div>
        ) : (
          <TableWrap className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th className="hidden sm:table-cell">Brand</Th>
                <Th className="text-right">Sent</Th>
                <Th className="text-right">Failed</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/80">
                  <Td>
                    <Link
                      to={`/campaigns/${c.id}`}
                      className="font-medium text-slate-900 hover:text-blue-700"
                    >
                      {c.name}
                    </Link>
                    <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{c.messagePreview}</p>
                  </Td>
                  <Td className="hidden text-slate-600 sm:table-cell">{getBrandName(c.brandId)}</Td>
                  <Td className="text-right tabular-nums text-slate-700">{c.sent.toLocaleString()}</Td>
                  <Td className="text-right tabular-nums text-slate-700">{c.failed.toLocaleString()}</Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  )
}
