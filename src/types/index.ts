export type CampaignStatus = 'Running' | 'Completed' | 'Paused'

export interface PhoneResult {
  id: string
  phone: string
  status: 'Pending' | 'Success' | 'Failed'
  error?: string
}

export interface Batch {
  id: string
  name: string
  total: number
  sent: number
  failed: number
  progress: number
}

export interface Campaign {
  id: string
  name: string
  messagePreview: string
  brandId: string
  tag: string
  message: string
  total: number
  sent: number
  failed: number
  status: CampaignStatus
  important: boolean
  createdAt: string
  deletedAt?: string
  batches: Batch[]
  phones: PhoneResult[]
  /** Overall queue progress for running campaigns (0–100) */
  queueProgress: number
}

export interface Brand {
  id: string
  name: string
  twilioAccountSid: string
  twilioApiKey: string
  twilioAuthToken: string
  messagingServiceSid: string
  activeCampaignApiUrl: string
  activeCampaignApiKey: string
}
