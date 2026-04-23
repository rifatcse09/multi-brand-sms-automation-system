import { useMemo, useState } from 'react'
import { Pencil, Plus, Trash2, Building2 } from 'lucide-react'
import { Card, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { EmptyState } from '../components/ui/EmptyState'
import { useAppData } from '../context/AppDataContext'
import type { Brand } from '../types'

const emptyBrand: Omit<Brand, 'id'> = {
  name: '',
  twilioAccountSid: '',
  twilioApiKey: '',
  twilioSecret: '',
  messagingServiceSid: '',
  activeCampaignApiUrl: '',
  activeCampaignApiKey: '',
}

export function BrandsPage() {
  const { brands, addBrand, updateBrand, deleteBrand } = useAppData()
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Brand | null>(null)
  const [form, setForm] = useState<Omit<Brand, 'id'>>(emptyBrand)

  const title = useMemo(() => (editing ? 'Edit brand' : 'Add brand'), [editing])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyBrand)
    setModalOpen(true)
  }

  const openEdit = (b: Brand) => {
    setEditing(b)
    const { id: _id, ...rest } = b
    void _id
    setForm(rest)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
    setForm(emptyBrand)
  }

  const save = () => {
    if (!form.name.trim()) return
    if (editing) {
      updateBrand(editing.id, form)
    } else {
      addBrand(form)
    }
    closeModal()
  }

  return (
    <div className="space-y-6">
      <Card padding="md">
        <CardHeader
          title="Brands"
          description="Connect Twilio and ActiveCampaign per brand."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden />
              Add brand
            </Button>
          }
        />
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
                  <dt className="text-xs font-medium text-slate-500">Messaging Service SID</dt>
                  <dd className="mt-0.5 font-mono text-xs text-slate-700">{b.messagingServiceSid}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">ActiveCampaign API URL</dt>
                  <dd className="mt-0.5 truncate text-slate-700">{b.activeCampaignApiUrl}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={title}
        description="Credentials stay in this demo UI only — nothing is sent to a server."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={save}>Save brand</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="brand-name">Brand name</Label>
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
            <Label htmlFor="twilio-secret">Twilio Secret</Label>
            <Input
              id="twilio-secret"
              type="password"
              value={form.twilioSecret}
              onChange={(e) => setForm((f) => ({ ...f, twilioSecret: e.target.value }))}
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
            <Label htmlFor="ac-url">ActiveCampaign API URL</Label>
            <Input
              id="ac-url"
              value={form.activeCampaignApiUrl}
              onChange={(e) => setForm((f) => ({ ...f, activeCampaignApiUrl: e.target.value }))}
              placeholder="https://…"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ac-key">ActiveCampaign API Key</Label>
            <Input
              id="ac-key"
              type="password"
              value={form.activeCampaignApiKey}
              onChange={(e) => setForm((f) => ({ ...f, activeCampaignApiKey: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(deleteId)}
        onClose={() => setDeleteId(null)}
        title="Delete brand?"
        description="Campaigns linked to this brand will be removed from the demo dataset."
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
