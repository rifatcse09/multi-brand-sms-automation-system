import { useMemo, useState } from 'react'
import { Pencil, Plus, Tag, Trash2, Building2 } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { EmptyState } from '../components/ui/EmptyState'
import { DashboardTagModal } from '../components/brands/DashboardTagModal'
import { useAppData } from '../context/AppDataContext'
import type { Brand } from '../types'

const emptyBrand: Omit<Brand, 'id'> = {
  name: '',
  twilioAccountSid: '',
  twilioApiKey: '',
  twilioAuthToken: '',
  messagingServiceSid: '',
  activeCampaignApiUrl: '',
  activeCampaignApiKey: '',
  dashboardTag: '',
}

type TagModalState = {
  brandId: string
  brandName: string
  initialTag?: string
  acCredentialsChanged?: boolean
}

function acConfigured(form: Omit<Brand, 'id'>) {
  return Boolean(form.activeCampaignApiUrl.trim() && form.activeCampaignApiKey.trim())
}

export function BrandsPage() {
  const { brands, addBrand, updateBrand, deleteBrand, workerError, workerLinked } = useAppData()
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Brand | null>(null)
  const [form, setForm] = useState<Omit<Brand, 'id'>>(emptyBrand)
  const [formError, setFormError] = useState<string | null>(null)
  const [savingBrand, setSavingBrand] = useState(false)
  const [tagModal, setTagModal] = useState<TagModalState | null>(null)

  const title = useMemo(() => (editing ? 'Edit brand' : 'Add brand'), [editing])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyBrand)
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = (b: Brand) => {
    setEditing(b)
    setFormError(null)
    const { id: _id, ...rest } = b
    void _id
    setForm({ ...emptyBrand, ...rest, dashboardTag: rest.dashboardTag ?? '' })
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
    setForm(emptyBrand)
    setFormError(null)
  }

  const shouldPromptForTag = (
    saved: Brand,
    opts: { isNew: boolean; acChanged: boolean },
  ) => {
    if (!acConfigured(saved)) return false
    if (!workerLinked) return false
    if (opts.isNew) return true
    if (opts.acChanged) return true
    if (!saved.dashboardTag?.trim()) return true
    return false
  }

  const openTagModalForBrand = (
    brand: Brand,
    opts?: { acCredentialsChanged?: boolean },
  ) => {
    setTagModal({
      brandId: brand.id,
      brandName: brand.name,
      initialTag: brand.dashboardTag ?? '',
      acCredentialsChanged: opts?.acCredentialsChanged,
    })
  }

  const save = async () => {
    const errs: string[] = []
    if (!form.name.trim()) errs.push('Brand name is required.')
    if (!form.activeCampaignApiUrl.trim()) errs.push('ActiveCampaign API URL is required.')
    if (!form.activeCampaignApiKey.trim()) errs.push('ActiveCampaign API key is required.')
    if (errs.length) {
      setFormError(errs.join(' '))
      return
    }
    setFormError(null)
    setSavingBrand(true)

    const acChanged =
      Boolean(editing) &&
      (form.activeCampaignApiUrl.trim() !== editing!.activeCampaignApiUrl.trim() ||
        form.activeCampaignApiKey.trim() !== editing!.activeCampaignApiKey.trim())

    const payload: Omit<Brand, 'id'> = {
      ...form,
      dashboardTag: editing?.dashboardTag ?? form.dashboardTag?.trim() ?? '',
    }

    try {
      let saved: Brand
      if (editing) {
        const updated = await updateBrand(editing.id, payload)
        saved = updated ?? { ...editing, ...payload }
      } else {
        saved = await addBrand(payload)
      }
      closeModal()
      if (
        shouldPromptForTag(saved, {
          isNew: !editing,
          acChanged,
        })
      ) {
        openTagModalForBrand(saved, { acCredentialsChanged: acChanged })
      }
    } catch {
      setFormError('Could not save brand. Check your connection and try again.')
    } finally {
      setSavingBrand(false)
    }
  }

  const saveDashboardTag = async (tag: string) => {
    if (!tagModal) return
    await updateBrand(tagModal.brandId, { dashboardTag: tag })
  }

  return (
    <div className="space-y-6">
      <Card padding="md">
        <CardHeader
          title="Brands"
          description="Connect Twilio and ActiveCampaign per brand, then choose a dashboard audience tag."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden />
              Add brand
            </Button>
          }
        />
        {!workerLinked ? (
          <p className="mt-2 text-xs text-amber-600">Backend not connected. Changes are local only.</p>
        ) : null}
        {workerError ? <p className="mt-2 text-xs text-red-600">{workerError}</p> : null}
      </Card>

      {brands.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No brands yet"
          description="Add your first brand to start routing SMS through the right Twilio workspace."
          action={<Button onClick={openCreate}>Add brand</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {brands.map((b) => (
            <Card key={b.id} padding="md" className="transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">{b.name}</h3>
                  <p className="mt-1 font-mono text-xs text-slate-500">{b.twilioAccountSid}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(b)} aria-label="Edit">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => setDeleteId(b.id)}
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <dl className="mt-4 grid gap-3 text-sm">
                <div>
                  <dt className="text-xs font-medium text-slate-500">Dashboard audience tag</dt>
                  <dd className="mt-0.5 text-slate-800">
                    {b.dashboardTag?.trim() ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
                        <Tag className="h-3 w-3" aria-hidden />
                        {b.dashboardTag}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-700">Not configured</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Messaging Service SID</dt>
                  <dd className="mt-0.5 font-mono text-xs text-slate-700">{b.messagingServiceSid}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">ActiveCampaign API URL</dt>
                  <dd className="mt-0.5 truncate text-slate-700">{b.activeCampaignApiUrl}</dd>
                </div>
              </dl>
              {acConfigured(b) && workerLinked ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4 w-full"
                  onClick={() => openTagModalForBrand(b)}
                >
                  <Tag className="h-3.5 w-3.5" aria-hidden />
                  Configure audience tag
                </Button>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={title}
        description="Fields marked with * are required. After saving, you can pick the ActiveCampaign tag for dashboard metrics."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={savingBrand}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={savingBrand}>
              Save brand
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {formError ? (
            <p className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {formError}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Label htmlFor="brand-name" required>
              Brand name
            </Label>
            <Input
              id="brand-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Northwind Retail"
            />
          </div>
          <div>
            <Label htmlFor="twilio-sid">Twilio Account SID</Label>
            <Input
              id="twilio-sid"
              value={form.twilioAccountSid}
              onChange={(e) => setForm((f) => ({ ...f, twilioAccountSid: e.target.value }))}
              placeholder="AC…"
            />
          </div>
          <div>
            <Label htmlFor="twilio-key">Twilio API Key</Label>
            <Input
              id="twilio-key"
              value={form.twilioApiKey}
              onChange={(e) => setForm((f) => ({ ...f, twilioApiKey: e.target.value }))}
              placeholder="SK…"
            />
          </div>
          <div>
            <Label htmlFor="twilio-auth-token">Twilio Auth Token</Label>
            <Input
              id="twilio-auth-token"
              type="password"
              value={form.twilioAuthToken}
              onChange={(e) => setForm((f) => ({ ...f, twilioAuthToken: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="msg-sid">Messaging Service SID</Label>
            <Input
              id="msg-sid"
              value={form.messagingServiceSid}
              onChange={(e) => setForm((f) => ({ ...f, messagingServiceSid: e.target.value }))}
              placeholder="MG…"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ac-url" required>
              ActiveCampaign API URL
            </Label>
            <Input
              id="ac-url"
              value={form.activeCampaignApiUrl}
              onChange={(e) => setForm((f) => ({ ...f, activeCampaignApiUrl: e.target.value }))}
              placeholder="https://…"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ac-key" required>
              ActiveCampaign API Key
            </Label>
            <Input
              id="ac-key"
              type="password"
              value={form.activeCampaignApiKey}
              onChange={(e) => setForm((f) => ({ ...f, activeCampaignApiKey: e.target.value }))}
            />
            <p className="mt-1.5 text-xs text-slate-500">
              You will choose the dashboard audience tag in the next step after saving.
            </p>
          </div>
        </div>
      </Modal>

      <DashboardTagModal
        open={Boolean(tagModal)}
        brandId={tagModal?.brandId ?? ''}
        brandName={tagModal?.brandName ?? ''}
        initialTag={tagModal?.initialTag}
        acCredentialsChanged={tagModal?.acCredentialsChanged}
        workerLinked={workerLinked}
        onClose={() => setTagModal(null)}
        onSave={saveDashboardTag}
      />

      <Modal
        open={Boolean(deleteId)}
        onClose={() => setDeleteId(null)}
        title="Delete brand?"
        description="Campaigns linked to this brand may become invalid or hidden depending on your backend."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteId) deleteBrand(deleteId)
                setDeleteId(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">This action cannot be undone in a real product UI.</p>
      </Modal>
    </div>
  )
}
