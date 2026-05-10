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
  createWorkerCampaign,
  deleteWorkerBrand,
  fetchWorkerBrands,
  fetchWorkerCampaigns,
  fetchWorkerCampaignById,
  fetchWorkerHealth,
  isWorkerConfigured,
  retryWorkerPhone,
  updateWorkerBrand,
  deleteWorkerCampaign,
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
  workerError: string | null
  addBrand: (brand: Omit<Brand, 'id'>) => void
  updateBrand: (id: string, patch: Partial<Brand>) => void
  deleteBrand: (id: string) => void
  addCampaign: (input: {
    brandId: string
    tag: string
    message: string
    scheduledAtUtc?: string
    scheduleTimezone?: string
    scheduleAtLocal?: string
  }) => Promise<Campaign>
  setCampaignImportant: (id: string, important: boolean) => void
  retryPhone: (campaignId: string, phoneId: string) => void
  deleteCampaign: (campaignId: string) => void
  getBrandName: (id: string) => string
}

const AppDataContext = createContext<AppDataContextValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [brands, setBrands] = useState<Brand[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [workerLinked, setWorkerLinked] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
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
    const defaultBrandId = 'brand-default'
    try {
      const next = await fetchWorkerCampaigns(defaultBrandId)
      mergeImportantFlag(next)
    } catch {
      setWorkerError('Unable to load campaigns from backend.')
    }
  }, [mergeImportantFlag, workerEnabled])

  const syncBrandsFromWorker = useCallback(async () => {
    if (!workerEnabled) return
    try {
      const next = await fetchWorkerBrands()
      setBrands(next)
    } catch {
      setWorkerError('Unable to load brands from backend.')
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
          setWorkerError(null)
        } catch {
          setWorkerError('Brand save failed on backend. Check Worker secret/env.')
        }
      })()
    }
  }, [workerEnabled])

  const updateBrand = useCallback((id: string, patch: Partial<Brand>) => {
    setBrands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
    if (workerEnabled) {
      void updateWorkerBrand(id, patch).catch(() => {
        setWorkerError('Brand update failed on backend.')
      })
    }
  }, [workerEnabled])

  const deleteBrand = useCallback((id: string) => {
    setBrands((prev) => prev.filter((b) => b.id !== id))
    setCampaigns((prev) => prev.filter((c) => c.brandId !== id))
    if (workerEnabled) {
      void deleteWorkerBrand(id).catch(() => {
        setWorkerError('Brand delete failed on backend.')
      })
    }
  }, [workerEnabled])

  const addCampaign = useCallback(
    async (input: {
      brandId: string
      tag: string
      message: string
      scheduledAtUtc?: string
      scheduleTimezone?: string
      scheduleAtLocal?: string
    }) => {
      if (workerEnabled) {
        const id = `blast-${Date.now()}`
        try {
          const campaign = await createWorkerCampaign({
            id,
            brandId: input.brandId,
            tag: input.tag,
            message: input.message,
            scheduledAtUtc: input.scheduledAtUtc,
            scheduleTimezone: input.scheduleTimezone,
            scheduleAtLocal: input.scheduleAtLocal,
          })
          setCampaigns((prev) => {
            const importantMap = new Map(prev.map((c) => [c.id, c.important]))
            const merged = {
              ...campaign,
              important: importantMap.get(campaign.id) ?? campaign.important,
            }
            const rest = prev.filter((c) => c.id !== merged.id)
            return [merged, ...rest]
          })
          setWorkerError(null)
          await syncCampaignsFromWorker()
          return campaign
        } catch (e) {
          const msg =
            e instanceof Error ? e.message : 'Campaign creation failed on backend.'
          setWorkerError(msg)
          throw e
        }
      }

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
        status: (input.scheduledAtUtc ? 'Scheduled' : 'Running') as CampaignStatus,
        important: false,
        createdAt: new Date().toISOString(),
        scheduledAtUtc: input.scheduledAtUtc,
        scheduleTimezone: input.scheduleTimezone,
        scheduleAtLocal: input.scheduleAtLocal,
        batches,
        phones,
        queueProgress: input.scheduledAtUtc ? 0 : Math.round((sent / total) * 100),
      }
      setCampaigns((prev) => [campaign, ...prev])
      return campaign
    },
    [getBrandName, syncCampaignsFromWorker, workerEnabled],
  )

  const setCampaignImportant = useCallback((id: string, important: boolean) => {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, important } : c)))
  }, [])

  const retryPhone = useCallback(
    async (campaignId: string, phoneId: string) => {
      if (workerEnabled) {
        try {
          await retryWorkerPhone(campaignId, phoneId)
          const res = await fetchWorkerCampaignById(campaignId)
          const fresh = res.campaign
          setCampaigns((prev) => {
            const importantMap = new Map(prev.map((c) => [c.id, c.important]))
            const merged = {
              ...fresh,
              important: importantMap.get(campaignId) ?? fresh.important,
            }
            const idx = prev.findIndex((c) => c.id === campaignId)
            if (idx === -1) return [merged, ...prev]
            return prev.map((c) => (c.id === campaignId ? merged : c))
          })
          setWorkerError(null)
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Retry failed on backend.'
          setWorkerError(msg)
        }
        return
      }

      setCampaigns((prev) =>
        prev.map((c) => {
          if (c.id !== campaignId) return c
          const phones = (c.phones ?? []).map((p) =>
            p.id === phoneId
              ? { ...p, status: 'Success' as const, error: undefined }
              : p,
          )
          const failed = phones.filter((p) => p.status === 'Failed').length
          return { ...c, phones, failed }
        }),
      )
    },
    [workerEnabled],
  )

  const deleteCampaignLocal = useCallback((campaignId: string) => {
    setCampaigns((prev) => prev.filter((c) => c.id !== campaignId))
    if (workerEnabled) {
      void deleteWorkerCampaign(campaignId).catch(() => {
        setWorkerError('Campaign delete failed on backend.')
      })
    }
  }, [workerEnabled])

  const value = useMemo(
    () => ({
      brands,
      campaigns,
      workerLinked,
      workerError,
      addBrand,
      updateBrand,
      deleteBrand,
      addCampaign,
      setCampaignImportant,
      retryPhone,
      deleteCampaign: deleteCampaignLocal,
      getBrandName,
    }),
    [
      brands,
      campaigns,
      workerLinked,
      workerError,
      addBrand,
      updateBrand,
      deleteBrand,
      addCampaign,
      setCampaignImportant,
      retryPhone,
      deleteCampaignLocal,
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
