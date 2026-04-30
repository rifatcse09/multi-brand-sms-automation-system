import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { ProgressBar } from '../components/ui/ProgressBar'
import { TableWrap, Th, Td } from '../components/ui/Table'
import { StatusBadge } from '../components/ui/Badge'
import { useAppData } from '../context/AppDataContext'
import { fetchWorkerCampaignById, isWorkerConfigured } from '../services/smsWorkerApi'
import type { Campaign } from '../types'

export function CampaignDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { campaigns, getBrandName, retryPhone, deleteCampaign } = useAppData()
  const campaign = campaigns.find((c) => c.id === id)
  const [remoteCampaign, setRemoteCampaign] = useState<Campaign | null>(null)
  const [loadingRemote, setLoadingRemote] = useState(false)

  useEffect(() => {
    if (!id || campaign || !isWorkerConfigured()) return
    setLoadingRemote(true)
    void (async () => {
      try {
        const res = await fetchWorkerCampaignById(id)
        setRemoteCampaign(res.campaign)
      } catch {
        setRemoteCampaign(null)
      } finally {
        setLoadingRemote(false)
      }
    })()
  }, [id, campaign])

  const activeCampaign = campaign ?? remoteCampaign

  if (!activeCampaign) {
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

  const pct =
    activeCampaign.total > 0 ? Math.round((activeCampaign.sent / activeCampaign.total) * 100) : 0

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
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={activeCampaign.status} />
          <Button
            variant="secondary"
            size="sm"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => {
              if (window.confirm(`Delete campaign "${activeCampaign.name}"?`)) {
                deleteCampaign(activeCampaign.id)
                navigate('/campaigns')
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card padding="md" className="lg:col-span-2">
          <CardHeader title="Overview" description="High-level delivery metrics for this send." />
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Total</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {activeCampaign.total.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Sent</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {activeCampaign.sent.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-4">
              <p className="text-xs font-medium text-slate-500">Failed</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {activeCampaign.failed.toLocaleString()}
              </p>
            </div>
          </div>
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-slate-700">Queue processing</span>
              <span className="tabular-nums text-slate-500">{pct}%</span>
            </div>
            <ProgressBar value={activeCampaign.status === 'Running' ? activeCampaign.queueProgress : pct} />
          </div>
        </Card>

        <Card padding="md">
          <CardHeader title="Message" />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{activeCampaign.message}</p>
        </Card>
      </div>

      <Card padding="md">
        <CardHeader title="Batch progress" description="Parallel workers split the audience into batches." />
        {activeCampaign.batches.length === 0 ? (
          <p className="text-sm text-slate-500">
            No batch data exposed by this backend response yet.
          </p>
        ) : (
          <div className="space-y-3">
            {activeCampaign.batches.map((b) => (
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
          <CardHeader title="Phone number results" description="Per-recipient delivery outcomes (sample)." />
        </div>
        <TableWrap className="rounded-none border-0 shadow-none">
          <thead>
            <tr>
              <Th>Phone number</Th>
              <Th>Status</Th>
              <Th className="hidden sm:table-cell">Error</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {activeCampaign.phones.length === 0 ? (
              <tr>
                <Td colSpan={4} className="py-8 text-center text-sm text-slate-500">
                  No phone-level rows are available from the current endpoint.
                </Td>
              </tr>
            ) : (
              activeCampaign.phones.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/80">
                  <Td className="font-mono text-xs sm:text-sm">{p.phone}</Td>
                  <Td>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.status === 'Success'
                          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/10'
                          : 'bg-red-50 text-red-800 ring-1 ring-red-600/10'
                      }`}
                    >
                      {p.status}
                    </span>
                  </Td>
                  <Td className="hidden max-w-xs truncate text-xs text-slate-500 sm:table-cell">
                    {p.error ?? '—'}
                  </Td>
                  <Td className="text-right">
                    {p.status === 'Failed' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => retryPhone(activeCampaign.id, p.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        Retry
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </Card>
    </div>
  )
}
