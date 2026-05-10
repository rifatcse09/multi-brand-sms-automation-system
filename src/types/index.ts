export type CampaignStatus = 'Running' | 'Completed' | 'Paused' | 'Scheduled'

export interface PhoneResult {
  id: string
  phone: string
  status: 'Pending' | 'Success' | 'Failed'
  /** Short headline for tables (e.g. Twilio API error code + message). */
  error?: string
  twilioSid?: string
  /** When this row last became Failed (ISO8601). */
  failedAt?: string
  /** twilio_rest | twilio_callback | mock_simulated | unknown */
  failureSource?: string
  /** Multi-line diagnostic: HTTP status, Twilio fields, timestamps. */
  failureDetail?: string
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
  scheduledAtUtc?: string
  scheduleTimezone?: string
  scheduleAtLocal?: string
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
