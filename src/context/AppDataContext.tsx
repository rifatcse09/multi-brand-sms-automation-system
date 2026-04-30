import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Brand, Campaign, CampaignStatus } from '../types'
import {
  createWorkerBrand,
  deleteWorkerBrand,
  fetchWorkerBrands,
  fetchWorkerCampaigns,
  fetchWorkerHealth,
  isWorkerConfigured,
  triggerWorkerBlast,
  updateWorkerBrand,
} from '../services/smsWorkerApi'

let idSeq = 100

function nextId(prefix: string) {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

type AppDataContextValue = {
  brands: Brand[]
  campaigns: Campaign[]
  workerLinked: boolean
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
  const [brands, setBrands] = useState<Brand[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [workerLinked, setWorkerLinked] = useState(false)
  const workerEnabled = isWorkerConfigured()

  const mergeImportantFlag = useCallback((next: Campaign[]) => {
    setCampaigns((prev) => {
      const importantMap = new Map(prev.map((c) => [c.id, c.important]))
      return next.map((c) => ({
        ...c,
        important: importantMap.get(c.id) ?? c.important,
      }))
    })
  }, [])

  const syncCampaignsFromWorker = useCallback(async () => {
    if (!workerEnabled) return
    const defaultBrandId = brands[0]?.id ?? 'brand-default'
    try {
      const next = await fetchWorkerCampaigns(defaultBrandId)
      mergeImportantFlag(next)
    } catch {
      /* keep local mock data if worker read fails */
    }
  }, [brands, mergeImportantFlag, workerEnabled])

  const syncBrandsFromWorker = useCallback(async () => {
    if (!workerEnabled) return
    try {
      const next = await fetchWorkerBrands()
      setBrands(next)
    } catch {
      /* ignore */
    }
  }, [workerEnabled])

  useEffect(() => {
    if (!workerEnabled) return
    let active = true
    const bootstrap = async () => {
      const ok = await fetchWorkerHealth()
      if (!active || !ok) return
      setWorkerLinked(true)
      await syncBrandsFromWorker()
      await syncCampaignsFromWorker()
    }
    void bootstrap()
    return () => {
      active = false
    }
  }, [syncBrandsFromWorker, syncCampaignsFromWorker, workerEnabled])

  useEffect(() => {
    if (!workerEnabled) return
    const timer = window.setInterval(() => {
      void syncBrandsFromWorker()
      void syncCampaignsFromWorker()
    }, 8000)
    return () => window.clearInterval(timer)
  }, [syncBrandsFromWorker, syncCampaignsFromWorker, workerEnabled])

  const getBrandName = useCallback(
    (id: string) => brands.find((b) => b.id === id)?.name ?? 'Unknown brand',
    [brands],
  )

  const addBrand = useCallback((brand: Omit<Brand, 'id'>) => {
    const optimistic = { ...brand, id: nextId('brand') }
    setBrands((prev) => [...prev, optimistic])
    if (workerEnabled) {
      void (async () => {
        try {
          const created = await createWorkerBrand(brand)
          setBrands((prev) =>
            prev.map((b) => (b.id === optimistic.id ? created.brand : b)),
          )
        } catch {
          setBrands((prev) => prev.filter((b) => b.id !== optimistic.id))
        }
      })()
    }
  }, [workerEnabled])

  const updateBrand = useCallback((id: string, patch: Partial<Brand>) => {
    setBrands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
    if (workerEnabled) {
      void updateWorkerBrand(id, patch).catch(() => {})
    }
  }, [workerEnabled])

  const deleteBrand = useCallback((id: string) => {
    setBrands((prev) => prev.filter((b) => b.id !== id))
    setCampaigns((prev) => prev.filter((c) => c.brandId !== id))
    if (workerEnabled) {
      void deleteWorkerBrand(id).catch(() => {})
    }
  }, [workerEnabled])

  const addCampaign = useCallback(
    (input: { brandId: string; tag: string; message: string }) => {
      const id = workerEnabled ? `blast-${Date.now()}` : nextId('camp')
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
      if (workerEnabled) {
        void (async () => {
          try {
            await triggerWorkerBlast({
              tag: input.tag,
              message: input.message,
              blastId: id,
            })
            await syncCampaignsFromWorker()
          } catch {
            /* optimistic campaign stays visible when worker rejects */
          }
        })()
      }
      return campaign
    },
    [getBrandName, syncCampaignsFromWorker, workerEnabled],
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
      workerLinked,
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
      workerLinked,
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
