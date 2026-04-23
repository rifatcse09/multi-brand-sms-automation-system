import type { Batch, Brand, Campaign, PhoneResult } from '../types'

const mkPhones = (prefix: string, count: number, failEvery = 5): PhoneResult[] =>
  Array.from({ length: count }, (_, i) => {
    const failed = i % failEvery === failEvery - 1
    return {
      id: `${prefix}-p-${i}`,
      phone: `+1 (555) ${200 + i}-${String(1000 + i).slice(-4)}`,
      status: failed ? 'Failed' : 'Success',
      error: failed ? 'Carrier rejected (21211)' : undefined,
    }
  })

const batches = (id: string): Batch[] => [
  { id: `${id}-b1`, name: 'Batch 1', total: 500, sent: 500, failed: 12, progress: 100 },
  { id: `${id}-b2`, name: 'Batch 2', total: 500, sent: 420, failed: 8, progress: 84 },
  { id: `${id}-b3`, name: 'Batch 3', total: 500, sent: 0, failed: 0, progress: 0 },
]

export const initialBrands: Brand[] = [
  {
    id: 'b1',
    name: 'Northwind Retail',
    twilioAccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    twilioApiKey: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    twilioSecret: '••••••••••••••••',
    messagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    activeCampaignApiUrl: 'https://northwind.api-us1.com',
    activeCampaignApiKey: '••••••••••••••••',
  },
  {
    id: 'b2',
    name: 'Blue Harbor Health',
    twilioAccountSid: 'ACyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    twilioApiKey: 'SKyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    twilioSecret: '••••••••••••••••',
    messagingServiceSid: 'MGyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    activeCampaignApiUrl: 'https://blueharbor.api-us1.com',
    activeCampaignApiKey: '••••••••••••••••',
  },
]

export const initialCampaigns: Campaign[] = [
  {
    id: 'c1',
    name: 'Spring promo — VIP',
    messagePreview: 'Hi {{first_name}}, your VIP early access starts now…',
    brandId: 'b1',
    tag: 'vip-spring',
    message: 'Hi {{first_name}}, your VIP early access starts now. Reply STOP to opt out.',
    total: 1500,
    sent: 920,
    failed: 20,
    status: 'Running',
    important: true,
    createdAt: '2026-04-22T14:10:00Z',
    batches: batches('c1'),
    phones: mkPhones('c1', 12, 4),
    queueProgress: 61,
  },
  {
    id: 'c2',
    name: 'Appointment reminders',
    messagePreview: 'Reminder: you have an appointment tomorrow at…',
    brandId: 'b2',
    tag: 'appointments',
    message: 'Reminder: you have an appointment tomorrow at {{time}}. Reply C to confirm.',
    total: 820,
    sent: 820,
    failed: 6,
    status: 'Completed',
    important: false,
    createdAt: '2026-04-20T09:00:00Z',
    batches: batches('c2').map((b) => ({ ...b, sent: b.total, progress: 100, failed: 2 })),
    phones: mkPhones('c2', 10, 6),
    queueProgress: 100,
  },
  {
    id: 'c3',
    name: 'Cart recovery — 24h',
    messagePreview: 'You left something behind. Finish checkout with…',
    brandId: 'b1',
    tag: 'cart-24h',
    message: 'You left something behind. Finish checkout with code SAVE10 (24h).',
    total: 2400,
    sent: 400,
    failed: 11,
    status: 'Paused',
    important: true,
    createdAt: '2026-04-18T16:45:00Z',
    batches: batches('c3'),
    phones: mkPhones('c3', 8, 3),
    queueProgress: 17,
  },
]

export const analyticsMock = {
  sentVsFailed: [
    { label: 'Mon', sent: 4200, failed: 120 },
    { label: 'Tue', sent: 5100, failed: 95 },
    { label: 'Wed', sent: 4800, failed: 140 },
    { label: 'Thu', sent: 6200, failed: 88 },
    { label: 'Fri', sent: 5400, failed: 102 },
    { label: 'Sat', sent: 2100, failed: 44 },
    { label: 'Sun', sent: 1800, failed: 38 },
  ],
  trends: [
    { label: 'W1', value: 12 },
    { label: 'W2', value: 18 },
    { label: 'W3', value: 15 },
    { label: 'W4', value: 22 },
    { label: 'W5', value: 19 },
    { label: 'W6', value: 26 },
  ],
}
