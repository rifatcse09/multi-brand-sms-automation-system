import type { CampaignMeta, KVNamespace } from "./types";

// KV keyspace and helpers used across routes/business logic.
export const key = {
  brands: "brands:index",
  campaigns: "campaigns:index",
  brand: (id: string) => `brand:${id}`,
  campaign: (id: string) => `campaign:${id}`,
  campaignPhones: (id: string) => `campaign:${id}:phones`,
  campaignMeta: (id: string) => `campaign:${id}:meta`,
  sidToPhone: (sid: string) => `sid:${sid}`,
  lastSentTo: (phone: string) => `lastsent:${phone}`,
  daily: (yyyyMmDd: string) => `analytics:daily:${yyyyMmDd}`,
  subsDaily: (yyyyMmDd: string) => `analytics:subs:${yyyyMmDd}`,
  subsDailyByBrand: (yyyyMmDd: string, brandId: string) =>
    `analytics:subs:${yyyyMmDd}:brand:${brandId}`,
  brandSubsCache: (brandId: string) => `analytics:brand:${brandId}:subs`,
  brandSubsCursor: (brandId: string) => `analytics:brand:${brandId}:subs:cursor`,
  brandSubsTagCache: (brandId: string, tagSlug: string) =>
    `analytics:brand:${brandId}:subs:tag:${tagSlug}`,
  brandSubsTagCursor: (brandId: string, tagSlug: string) =>
    `analytics:brand:${brandId}:subs:tag:${tagSlug}:cursor`,
  brandTagsCache: (brandId: string) => `brand:${brandId}:tags:cache`,
  brandTagRefreshCursor: (brandId: string) =>
    `analytics:brand:${brandId}:subs:tags:refresh:cursor`,
  authUser: (email: string) => `auth:user:${email.toLowerCase()}`,
  authSession: (token: string) => `auth:session:${token}`,
  authReset: (email: string) => `auth:reset:${email.toLowerCase()}`,
} as const;

export const defaultMeta = (): CampaignMeta => ({
  clicks: 0,
  replies: 0,
  unsubs: 0,
  delivered: 0,
  deliveryFailed: 0,
});

export async function kvGetJSON<T>(kv: KVNamespace, k: string): Promise<T | null> {
  const raw = await kv.get(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvPutJSON(kv: KVNamespace, k: string, value: unknown) {
  await kv.put(k, JSON.stringify(value));
}

export async function appendUnique(kv: KVNamespace, indexKey: string, id: string) {
  const list = (await kvGetJSON<string[]>(kv, indexKey)) ?? [];
  if (!list.includes(id)) {
    list.unshift(id);
    await kvPutJSON(kv, indexKey, list.slice(0, 1000));
  }
}
