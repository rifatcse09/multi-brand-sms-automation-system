import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { initialBrands, initialCampaigns } from '../data/mockData'
import type { Brand, Campaign, CampaignStatus } from '../types'

let idSeq = 100

function nextId(prefix: string) {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

type AppDataContextValue = {
  brands: Brand[]
  campaigns: Campaign[]
  addBrand: (brand: Omit<Brand, 'id'>) => void
  updateBrand: (id: string, patch: Partial<Brand>) => void
  deleteBrand: (id: string) => void
  addCampaign: (input: {
    brandId: string
    tag: string
    message: string
  }) => Campaign
  setCampaignImportant: (id: string, important: boolean) => void
  retryPhone: (campaignId: string, phoneId: string) => void
  getBrandName: (id: string) => string
}

const AppDataContext = createContext<AppDataContextValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [brands, setBrands] = useState<Brand[]>(() => [...initialBrands])
  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    initialCampaigns.map((c) => structuredClone(c)),
  )

  const getBrandName = useCallback(
    (id: string) => brands.find((b) => b.id === id)?.name ?? 'Unknown brand',
    [brands],
  )

  const addBrand = useCallback((brand: Omit<Brand, 'id'>) => {
    const id = nextId('brand')
    setBrands((prev) => [...prev, { ...brand, id }])
  }, [])

  const updateBrand = useCallback((id: string, patch: Partial<Brand>) => {
    setBrands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }, [])

  const deleteBrand = useCallback((id: string) => {
    setBrands((prev) => prev.filter((b) => b.id !== id))
    setCampaigns((prev) => prev.filter((c) => c.brandId !== id))
  }, [])

  const addCampaign = useCallback(
    (input: { brandId: string; tag: string; message: string }) => {
      const id = nextId('camp')
      const preview =
        input.message.length > 64 ? `${input.message.slice(0, 64)}…` : input.message
      const total = 800 + Math.floor(Math.random() * 400)
      const sent = Math.floor(total * 0.15)
      const failed = Math.floor(sent * 0.04)
      const batches: Campaign['batches'] = [
        {
          id: `${id}-b1`,
          name: 'Batch 1',
          total: Math.ceil(total / 3),
          sent: sent,
          failed,
          progress: Math.min(100, Math.round((sent / Math.ceil(total / 3)) * 100)),
        },
        {
          id: `${id}-b2`,
          name: 'Batch 2',
          total: Math.ceil(total / 3),
          sent: 0,
          failed: 0,
          progress: 0,
        },
        {
          id: `${id}-b3`,
          name: 'Batch 3',
          total: Math.floor(total / 3),
          sent: 0,
          failed: 0,
          progress: 0,
        },
      ]
      const phones: Campaign['phones'] = Array.from({ length: 8 }, (_, i) => ({
        id: `${id}-p-${i}`,
        phone: `+1 (555) ${300 + i}-${String(2000 + i).slice(-4)}`,
        status: i % 5 === 4 ? 'Failed' : 'Success',
        error: i % 5 === 4 ? 'Rate limit (429)' : undefined,
      }))
      const campaign: Campaign = {
        id,
        name: `${getBrandName(input.brandId)} — ${input.tag}`,
        messagePreview: preview,
        brandId: input.brandId,
        tag: input.tag,
        message: input.message,
        total,
        sent,
        failed,
        status: 'Running' as CampaignStatus,
        important: false,
        createdAt: new Date().toISOString(),
        batches,
        phones,
        queueProgress: Math.round((sent / total) * 100),
      }
      setCampaigns((prev) => [campaign, ...prev])
      return campaign
    },
    [getBrandName],
  )

  const setCampaignImportant = useCallback((id: string, important: boolean) => {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, important } : c)))
  }, [])

  const retryPhone = useCallback((campaignId: string, phoneId: string) => {
    setCampaigns((prev) =>
      prev.map((c) => {
        if (c.id !== campaignId) return c
        const phones = c.phones.map((p) =>
          p.id === phoneId
            ? { ...p, status: 'Success' as const, error: undefined }
            : p,
        )
        const failed = phones.filter((p) => p.status === 'Failed').length
        return { ...c, phones, failed }
      }),
    )
  }, [])

  const value = useMemo(
    () => ({
      brands,
      campaigns,
      addBrand,
      updateBrand,
      deleteBrand,
      addCampaign,
      setCampaignImportant,
      retryPhone,
      getBrandName,
    }),
    [
      brands,
      campaigns,
      addBrand,
      updateBrand,
      deleteBrand,
      addCampaign,
      setCampaignImportant,
      retryPhone,
      getBrandName,
    ],
  )

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData() {
  const ctx = useContext(AppDataContext)
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider')
  return ctx
}
