import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Star, Filter, Plus, Trash2 } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Select } from '../components/ui/Select'
import { TableWrap, Th, Td } from '../components/ui/Table'
import { StatusBadge } from '../components/ui/Badge'
import { Skeleton } from '../components/ui/Skeleton'
import { ProgressBar } from '../components/ui/ProgressBar'
import { EmptyState } from '../components/ui/EmptyState'
import { useAppData } from '../context/AppDataContext'
import { useDelayedReady } from '../hooks/useDelayedReady'
import type { CampaignStatus } from '../types'

export function CampaignListPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { campaigns, getBrandName, setCampaignImportant, deleteCampaign } = useAppData()
  const ready = useDelayedReady()

  const initialBrand = searchParams.get('brand')?.trim() || 'all'
  const [brandFilter, setBrandFilter] = useState<string>(initialBrand)
  const [statusFilter, setStatusFilter] = useState<'all' | CampaignStatus>('all')
  const [importantFilter, setImportantFilter] = useState<'all' | 'important'>('all')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  const brandOptions = useMemo(() => {
    const ids = new Set(campaigns.map((c) => c.brandId))
    return [...ids]
  }, [campaigns])

  useEffect(() => {
    const paramBrand = searchParams.get('brand')?.trim() || 'all'
    setBrandFilter(paramBrand)
  }, [searchParams])

  useEffect(() => {
    const current = searchParams.get('brand')?.trim() || 'all'
    if (current === brandFilter) return
    const next = new URLSearchParams(searchParams)
    if (brandFilter !== 'all') next.set('brand', brandFilter)
    else next.delete('brand')
    setSearchParams(next, { replace: true })
  }, [brandFilter, searchParams, setSearchParams])

  const filtered = useMemo(() => {
    return campaigns.filter((c) => {
      if (brandFilter !== 'all' && c.brandId !== brandFilter) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (importantFilter === 'important' && !c.important) return false
      return true
    })
  }, [campaigns, brandFilter, statusFilter, importantFilter])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )
  const shortPreview = (text: string) => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    if (words.length <= 8) return text
    return `${words.slice(0, 8).join(' ')}...`
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            Campaigns
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Gmail-style list with quick filters and importance markers.
          </p>
        </div>
        <Link to="/campaigns/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            Create campaign
          </Button>
        </Link>
      </div>

      <Card padding="md">
        <CardHeader
          title="Filters"
          description="Refine the inbox without leaving the table."
          action={<Filter className="h-4 w-4 text-slate-400" aria-hidden />}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-500">Brand</label>
            <Select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
              <option value="all">All brands</option>
              {brandOptions.map((id) => (
                <option key={id} value={id}>
                  {getBrandName(id)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-500">Status</label>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">All statuses</option>
              <option value="Running">Running</option>
              <option value="Scheduled">Scheduled</option>
              <option value="Completed">Completed</option>
              <option value="Paused">Paused</option>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-500">Important</label>
            <Select
              value={importantFilter}
              onChange={(e) => setImportantFilter(e.target.value as typeof importantFilter)}
            >
              <option value="all">All</option>
              <option value="important">Important only</option>
            </Select>
          </div>
        </div>
      </Card>

      {!ready ? (
        <Card padding="md">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No campaigns match"
          description="Try clearing filters or create a new campaign."
          action={
            <Button variant="secondary" onClick={() => {
              setBrandFilter('all')
              setStatusFilter('all')
              setImportantFilter('all')
            }}>
              Reset filters
            </Button>
          }
        />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th className="w-10 text-center">⭐</Th>
              <Th>Campaign</Th>
              <Th className="hidden lg:table-cell">Brand</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">Sent</Th>
              <Th className="text-right">Failed</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">Created</Th>
              <Th className="w-12 text-center">Delete</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer transition-colors hover:bg-slate-50/90"
                onClick={() => navigate(`/campaigns/${c.id}`)}
              >
                <Td className="w-10 text-center">
                  <button
                    type="button"
                    className="inline-flex rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-amber-500"
                    aria-label={c.important ? 'Unmark important' : 'Mark important'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCampaignImportant(c.id, !c.important)
                    }}
                  >
                    <Star
                      className={`h-4 w-4 ${c.important ? 'fill-amber-400 text-amber-500' : ''}`}
                    />
                  </button>
                </Td>
                <Td>
                  <p className="font-medium text-slate-900">{c.name}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {shortPreview(c.messagePreview)}
                  </p>
                  {c.status === 'Running' ? (
                    <div className="mt-2 max-w-md" onClick={(e) => e.stopPropagation()}>
                      <ProgressBar value={c.queueProgress} />
                    </div>
                  ) : null}
                  {c.status === 'Scheduled' && c.scheduledAtUtc ? (
                    <p className="mt-1 text-xs text-purple-700">
                      Scheduled:{' '}
                      {c.scheduleAtLocal && c.scheduleTimezone
                        ? `${c.scheduleAtLocal.replace('T', ' ')} (${c.scheduleTimezone})`
                        : formatDate(c.scheduledAtUtc)}
                    </p>
                  ) : null}
                </Td>
                <Td className="hidden text-slate-600 lg:table-cell">{getBrandName(c.brandId)}</Td>
                <Td className="text-right tabular-nums text-slate-700">{c.total.toLocaleString()}</Td>
                <Td className="text-right tabular-nums text-slate-700">{c.sent.toLocaleString()}</Td>
                <Td className="text-right tabular-nums text-slate-700">{c.failed.toLocaleString()}</Td>
                <Td>
                  <StatusBadge status={c.status} />
                </Td>
                <Td className="hidden text-xs text-slate-500 md:table-cell">{formatDate(c.createdAt)}</Td>
                <Td className="w-12 text-center">
                  <button
                    type="button"
                    className="inline-flex rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    aria-label="Delete campaign"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget({ id: c.id, name: c.name })
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete campaign?"
        description="This removes the campaign from your workspace."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteTarget) deleteCampaign(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {deleteTarget ? (
          <p className="text-sm text-slate-600">
            Delete <span className="font-medium text-slate-900">{deleteTarget.name}</span>? This
            cannot be undone.
          </p>
        ) : null}
      </Modal>
    </div>
  )
}
