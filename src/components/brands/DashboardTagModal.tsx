import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { TagPicker } from './TagPicker'
import {
  fetchWorkerBrandTags,
  isWorkerConfigured,
  refreshWorkerSubscribers,
  type WorkerBrandTag,
} from '../../services/smsWorkerApi'

type DashboardTagModalProps = {
  open: boolean
  brandId: string
  brandName: string
  initialTag?: string
  acCredentialsChanged?: boolean
  workerLinked: boolean
  onClose: () => void
  onSave: (tag: string) => Promise<void>
}

export function DashboardTagModal({
  open,
  brandId,
  brandName,
  initialTag = '',
  acCredentialsChanged = false,
  workerLinked,
  onClose,
  onSave,
}: DashboardTagModalProps) {
  const [tag, setTag] = useState(initialTag)
  const [tags, setTags] = useState<WorkerBrandTag[]>([])
  const [loadingTags, setLoadingTags] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTag(initialTag)
    setError(null)
  }, [open, initialTag])

  useEffect(() => {
    if (!open || !brandId || !workerLinked) {
      setTags([])
      return
    }
    let cancelled = false
    setLoadingTags(true)
    void (async () => {
      try {
        const next = await fetchWorkerBrandTags(brandId)
        if (cancelled) return
        setTags(next)
        if (initialTag && next.some((t) => t.tag === initialTag)) {
          setTag(initialTag)
        } else if (initialTag && !next.some((t) => t.tag === initialTag)) {
          setTag('')
        }
      } catch (e) {
        if (cancelled) return
        setTags([])
        setError(e instanceof Error ? e.message : 'Failed to load tags.')
      } finally {
        if (!cancelled) setLoadingTags(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, brandId, workerLinked, initialTag])

  const handleSave = async () => {
    const trimmed = tag.trim()
    if (!trimmed) {
      setError('Select a tag from the list.')
      return
    }
    if (!tags.some((t) => t.tag === trimmed)) {
      setError('Choose a tag from the ActiveCampaign list.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed)
      if (isWorkerConfigured()) {
        await refreshWorkerSubscribers({ brandId, maxPages: 10 })
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save tag.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose dashboard audience tag"
      description={`${brandName} — used for dashboard subscriber counts and as the default when creating campaigns.`}
      size="lg"
      bodyClassName="relative z-10 !overflow-visible min-h-[14rem]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Skip for now
          </Button>
          <Button onClick={() => void handleSave()} loading={saving} disabled={!workerLinked}>
            Save tag
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        {acCredentialsChanged ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            ActiveCampaign credentials changed. Confirm the audience tag for this brand.
          </p>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {!workerLinked ? (
          <p className="text-sm text-amber-700">
            Connect the Worker to load tags from ActiveCampaign.
          </p>
        ) : (
          <TagPicker
            value={tag}
            onChange={setTag}
            tags={tags}
            loading={loadingTags}
            menuPlacement="above"
            helperText="Counts on the dashboard will reflect contacts with this tag only."
          />
        )}
      </div>
    </Modal>
  )
}
