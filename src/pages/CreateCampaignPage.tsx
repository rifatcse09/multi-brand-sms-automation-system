import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader } from '../components/ui/Card'
import { Label } from '../components/ui/Label'
import { Input } from '../components/ui/Input'
import { Textarea } from '../components/ui/Textarea'
import { Select } from '../components/ui/Select'
import { Button } from '../components/ui/Button'
import { useAppData } from '../context/AppDataContext'

export function CreateCampaignPage() {
  const { brands, addCampaign } = useAppData()
  const navigate = useNavigate()
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '')
  const [tag, setTag] = useState('newsletter')
  const [message, setMessage] = useState(
    'Hi {{first_name}}, thanks for being a customer. Reply STOP to opt out.',
  )
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!brandId && brands[0]) setBrandId(brands[0].id)
  }, [brands, brandId])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!brandId) return
    setLoading(true)
    window.setTimeout(() => {
      const c = addCampaign({ brandId, tag: tag.trim(), message: message.trim() })
      setLoading(false)
      navigate(`/campaigns/${c.id}`)
    }, 600)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          Create campaign
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Queue an SMS send against an ActiveCampaign tag (mock only).
        </p>
      </div>

      <Card padding="md">
        <CardHeader title="Campaign details" />
        {brands.length === 0 ? (
          <p className="text-sm text-slate-600">
            Add a brand first, then return here to send a campaign.
          </p>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <Label htmlFor="brand">Brand</Label>
              <Select
                id="brand"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                required
              >
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="tag">Tag (ActiveCampaign)</Label>
              <Input
                id="tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. vip-launch"
                required
              />
            </div>
            <div>
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                required
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Merge fields like <span className="font-mono">{'{{first_name}}'}</span> are
                supported in the real product; here they are display-only.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" loading={loading} disabled={!brandId}>
                Send campaign
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate('/campaigns')}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  )
}
