import {
  countSmsContactsPage,
  countSmsContactsPageByTag,
  fetchActiveCampaignTags,
  fetchPhonePageFromActiveCampaignByTag,
  fetchPhonesFromActiveCampaign,
  getActiveCampaignContactTotal,
  getActiveCampaignTagContactTotal,
  normalizePhone,
  resolveActiveCampaignTagId,
} from "./activecampaign";
import { appendUnique, defaultMeta, key, kvGetJSON, kvPutJSON } from "./kv";
import type {
  CampaignPhoneDelivery,
  AuthSession,
  AuthUser,
  Brand,
  BrandSubscriberCache,
  BrandSubscriberCursor,
  Campaign,
  CampaignDetail,
  CampaignMeta,
  CampaignQueueMessage,
  CampaignStatus,
  Env,
  MessageBatch,
  PasswordReset,
  PhoneResult,
  PhoneStatus,
} from "./types";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-worker-secret,x-twilio-token",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });

const now = () => new Date().toISOString();

const preview = (message: string) =>
  message.length > 64 ? `${message.slice(0, 64)}...` : message;

const randomId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

// Security gates for public/protected routes.
function isProtectedRequest(url: URL) {
  const open = [
    "/",
    "/health",
    "/twilio/status",
    "/twilio/inbound",
    "/auth/login",
    "/auth/forgot-password",
    "/auth/reset-password",
  ];
  return !open.includes(url.pathname);
}

function authOk(request: Request, env: Env, url: URL) {
  if (!env.BLAST_SECRET) return true;
  const q = url.searchParams.get("secret");
  const h = request.headers.get("x-worker-secret");
  return q === env.BLAST_SECRET || h === env.BLAST_SECRET;
}

function twilioTokenOk(request: Request, env: Env, url: URL) {
  if (!env.TWILIO_STATUS_TOKEN) return false;
  const q = url.searchParams.get("token");
  const h = request.headers.get("x-twilio-token");
  return q === env.TWILIO_STATUS_TOKEN || h === env.TWILIO_STATUS_TOKEN;
}

async function getBrandUnsubscribedTotal(env: Env, brandId: string): Promise<number> {
  const campaigns = (await listCampaigns(env)).filter((c) => c.brandId === brandId);
  if (campaigns.length === 0) return 0;
  const metas = await Promise.all(campaigns.map((c) => getCampaignMeta(env, c.id)));
  return metas.reduce((sum, m) => sum + (m.unsubs || 0), 0);
}

function tagKeySlug(tagName: string): string {
  const slug = tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
  return slug || "tag";
}

function tagsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function brandSubscriberKeys(
  brand: Brand,
  tagOverride?: string,
): { cacheKey: string; cursorKey: string } {
  const tagName = (tagOverride ?? brand.dashboardTag ?? "").trim();
  if (tagName) {
    const slug = tagKeySlug(tagName);
    return {
      cacheKey: key.brandSubsTagCache(brand.id, slug),
      cursorKey: key.brandSubsTagCursor(brand.id, slug),
    };
  }
  return {
    cacheKey: key.brandSubsCache(brand.id),
    cursorKey: key.brandSubsCursor(brand.id),
  };
}

async function invalidateBrandTagSubscriberCache(
  env: Env,
  brandId: string,
  tagName: string,
) {
  const slug = tagKeySlug(tagName);
  await env.SMS_KV.delete(key.brandSubsTagCache(brandId, slug));
  await env.SMS_KV.delete(key.brandSubsTagCursor(brandId, slug));
}

type BrandTagRefreshCursor = { tagIndex: number; updatedAt: string };

async function getBrandAcTags(
  env: Env,
  brand: Brand,
): Promise<Array<{ id: string; tag: string }>> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) return [];
  const cached = await kvGetJSON<{
    fetchedAt: number;
    tags: Array<{ id: string; tag: string }>;
  }>(env.SMS_KV, key.brandTagsCache(brand.id));
  if (cached?.tags?.length) return cached.tags;
  const tags = await fetchActiveCampaignTags(brand);
  await kvPutJSON(env.SMS_KV, key.brandTagsCache(brand.id), {
    fetchedAt: Date.now(),
    tags,
  });
  return tags;
}

async function readTagSubscriberCount(
  env: Env,
  brandId: string,
  tagName: string,
): Promise<{ totalSubscribers: number; status: BrandSubscriberCache["status"] } | null> {
  const slug = tagKeySlug(tagName);
  const cache = await kvGetJSON<BrandSubscriberCache>(
    env.SMS_KV,
    key.brandSubsTagCache(brandId, slug),
  );
  if (!cache) return null;
  return { totalSubscribers: cache.totalSubscribers, status: cache.status };
}

/** Seed/increment subscriber cache for many tags without blocking HTTP responses. */
async function warmBrandTagSubscriberCaches(
  env: Env,
  brand: Brand,
  opts: { maxTags?: number; maxPages?: number; resetCursor?: boolean } = {},
) {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) {
    return { tagCount: 0, warmed: 0 };
  }
  const maxTags = Math.max(1, Math.min(opts.maxTags ?? 5, 30));
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 1, 5));
  const tags = await getBrandAcTags(env, brand);
  if (tags.length === 0) return { tagCount: 0, warmed: 0 };

  if (opts.resetCursor !== false) {
    await kvPutJSON(env.SMS_KV, key.brandTagRefreshCursor(brand.id), {
      tagIndex: 0,
      updatedAt: now(),
    });
  }

  let warmed = 0;
  const seen = new Set<string>();
  const dashboardTag = (brand.dashboardTag || "").trim();

  if (dashboardTag) {
    await refreshBrandSubscriberCache(env, brand, maxPages, dashboardTag);
    seen.add(tagKeySlug(dashboardTag));
    warmed += 1;
  }

  for (const row of tags) {
    if (warmed >= maxTags) break;
    const tagName = row.tag.trim();
    if (!tagName) continue;
    const slug = tagKeySlug(tagName);
    if (seen.has(slug)) continue;
    seen.add(slug);
    await refreshBrandSubscriberCache(env, brand, maxPages, tagName);
    warmed += 1;
  }

  return { tagCount: tags.length, warmed };
}

/** Cron helper: advance one tag per tick with minimal AC load (1 page). */
async function refreshNextBrandTagInCron(env: Env, brand: Brand, maxPages = 1) {
  const tags = await getBrandAcTags(env, brand);
  if (tags.length === 0) return;

  const cursor =
    (await kvGetJSON<BrandTagRefreshCursor>(
      env.SMS_KV,
      key.brandTagRefreshCursor(brand.id),
    )) ?? { tagIndex: 0, updatedAt: now() };

  const idx = ((cursor.tagIndex % tags.length) + tags.length) % tags.length;
  const tagName = tags[idx]?.tag?.trim();
  if (tagName) {
    await refreshBrandSubscriberCache(env, brand, maxPages, tagName);
  }

  await kvPutJSON(env.SMS_KV, key.brandTagRefreshCursor(brand.id), {
    tagIndex: cursor.tagIndex + 1,
    updatedAt: now(),
  });
}

// Refreshes one brand cache incrementally to avoid subrequest limits.
// When `dashboardTag` is set, walks only contacts with that AC tag (separate KV cache).
async function refreshBrandSubscriberCache(
  env: Env,
  brand: Brand,
  maxPages = 2,
  tagOverride?: string,
): Promise<BrandSubscriberCache> {
  const nowIso = now();
  const unsubscribedTotal = await getBrandUnsubscribedTotal(env, brand.id);
  const audienceTag = (tagOverride ?? brand.dashboardTag ?? "").trim();
  const audienceScope: BrandSubscriberCache["audienceScope"] = audienceTag ? "tag" : "account";
  const { cacheKey, cursorKey } = brandSubscriberKeys(brand, audienceTag || undefined);

  const baseCache = (): BrandSubscriberCache => ({
    brandId: brand.id,
    brandName: brand.name,
    allContacts: 0,
    totalSubscribers: 0,
    activeSmsSubscribers: 0,
    unsubscribedTotal,
    fetchOk: false,
    fetchError: "",
    status: "stale",
    updatedAt: nowIso,
    dashboardTag: audienceTag || undefined,
    audienceScope,
  });

  try {
    let totalContacts: number;
    let walkPage: (offset: number, pageSize: number) => Promise<{ count: number; rows: number }>;

    if (audienceTag) {
      const tagId = await resolveActiveCampaignTagId(brand, audienceTag);
      if (!tagId) {
        const cache: BrandSubscriberCache = {
          ...baseCache(),
          fetchError: `ActiveCampaign tag not found: "${audienceTag}"`,
        };
        await kvPutJSON(env.SMS_KV, cacheKey, cache);
        return cache;
      }
      totalContacts = await getActiveCampaignTagContactTotal(brand, tagId);
      walkPage = (offset, pageSize) =>
        countSmsContactsPageByTag(brand, tagId, offset, pageSize);
    } else {
      totalContacts = await getActiveCampaignContactTotal(brand);
      walkPage = (offset, pageSize) => countSmsContactsPage(brand, offset, pageSize);
    }

    const prevCursor = await kvGetJSON<BrandSubscriberCursor>(env.SMS_KV, cursorKey);

    let cursor: BrandSubscriberCursor =
      prevCursor ?? {
        totalContacts,
        offset: 0,
        smsContacts: 0,
        done: false,
        updatedAt: nowIso,
      };

    const drift = Math.abs(totalContacts - cursor.totalContacts);
    const driftThreshold = Math.max(
      200,
      Math.round(Math.max(totalContacts, cursor.totalContacts, 1) * 0.02),
    );
    const inheritedLastFresh = cursor.done
      ? cursor.smsContacts
      : (cursor.lastFreshSmsContacts ?? 0);
    const inheritedLastFreshAt = cursor.done ? nowIso : cursor.lastFreshAt;

    if (cursor.offset > totalContacts || drift > driftThreshold) {
      cursor = {
        totalContacts,
        offset: 0,
        smsContacts: 0,
        done: false,
        lastFreshSmsContacts: inheritedLastFresh,
        lastFreshAt: inheritedLastFreshAt,
        updatedAt: nowIso,
      };
    } else if (drift > 0) {
      cursor = {
        ...cursor,
        totalContacts,
        done: cursor.done && cursor.offset >= totalContacts,
        lastFreshSmsContacts: inheritedLastFresh,
        lastFreshAt: inheritedLastFreshAt,
        updatedAt: nowIso,
      };
    }

    const pageSize = 100;
    let pages = 0;
    while (!cursor.done && pages < maxPages) {
      const page = await walkPage(cursor.offset, pageSize);
      if (page.rows === 0) {
        cursor.done = true;
        break;
      }
      cursor.smsContacts += page.count;
      cursor.offset += page.rows;
      if (cursor.offset >= totalContacts || page.rows < pageSize) {
        cursor.done = true;
      }
      pages += 1;
    }

    if (cursor.done) {
      cursor.lastFreshSmsContacts = cursor.smsContacts;
      cursor.lastFreshAt = nowIso;
    }
    cursor.totalContacts = totalContacts;
    cursor.updatedAt = nowIso;
    await kvPutJSON(env.SMS_KV, cursorKey, cursor);

    const displaySmsContacts = cursor.done
      ? cursor.smsContacts
      : cursor.lastFreshSmsContacts && cursor.lastFreshSmsContacts > 0
        ? cursor.lastFreshSmsContacts
        : cursor.smsContacts;

    const cache: BrandSubscriberCache = {
      brandId: brand.id,
      brandName: brand.name,
      allContacts: totalContacts,
      totalSubscribers: displaySmsContacts,
      activeSmsSubscribers: Math.max(0, displaySmsContacts - unsubscribedTotal),
      unsubscribedTotal,
      fetchOk: true,
      fetchError: "",
      status: cursor.done ? "fresh" : "partial",
      updatedAt: nowIso,
      dashboardTag: audienceTag || undefined,
      audienceScope,
    };
    await kvPutJSON(env.SMS_KV, cacheKey, cache);
    return cache;
  } catch (e) {
    const prev = await kvGetJSON<BrandSubscriberCache>(env.SMS_KV, cacheKey);
    const cache: BrandSubscriberCache = {
      brandId: brand.id,
      brandName: brand.name,
      allContacts: prev?.allContacts ?? 0,
      totalSubscribers: prev?.totalSubscribers ?? 0,
      activeSmsSubscribers: Math.max(0, (prev?.totalSubscribers ?? 0) - unsubscribedTotal),
      unsubscribedTotal,
      fetchOk: false,
      fetchError: e instanceof Error ? e.message : String(e),
      status: "stale",
      updatedAt: nowIso,
      dashboardTag: audienceTag || undefined,
      audienceScope,
    };
    await kvPutJSON(env.SMS_KV, cacheKey, cache);
    return cache;
  }
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateCode(length = 6): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

async function getBearerSession(request: Request, env: Env): Promise<AuthSession | null> {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await kvGetJSON<AuthSession>(env.SMS_KV, key.authSession(token));
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  return session;
}

async function ensureDefaultAuthUser(env: Env) {
  const email = (env.DEFAULT_ADMIN_EMAIL || "admin@spellsology.com").toLowerCase();
  const userKey = key.authUser(email);
  const exists = await kvGetJSON<AuthUser>(env.SMS_KV, userKey);
  if (exists) return exists;
  const password = env.DEFAULT_ADMIN_PASSWORD || "Admin12345!";
  const user: AuthUser = {
    email,
    passwordHash: await sha256(password),
    createdAt: now(),
    updatedAt: now(),
  };
  await kvPutJSON(env.SMS_KV, userKey, user);
  return user;
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const clean = phone.replace(/\s+/g, "");
  if (clean.length < 4) return "****";
  return `${"*".repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`;
}

async function missiveShadowLog(env: Env, to: string, body: string) {
  if (!env.MISSIVE_API_TOKEN) return;
  const name = env.MISSIVE_SHADOWLOG_NAME || "ShadowLog";
  const payload = {
    posts: {
      text: `[${name}] ${now()}\n${body}`,
      conversation: { phone_number: to },
    },
  };
  await fetch("https://public.missiveapp.com/v1/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MISSIVE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function getCampaignMeta(env: Env, campaignId: string) {
  return (await kvGetJSON<CampaignMeta>(env.SMS_KV, key.campaignMeta(campaignId))) ?? defaultMeta();
}

async function incrementCampaignMeta(
  env: Env,
  campaignId: string,
  field: keyof CampaignMeta,
  by = 1,
) {
  const meta = await getCampaignMeta(env, campaignId);
  meta[field] += by;
  await kvPutJSON(env.SMS_KV, key.campaignMeta(campaignId), meta);
  return meta;
}

function makeMockPhones(total: number): PhoneResult[] {
  return Array.from({ length: total }, (_, idx) => ({
    id: `p-${idx + 1}`,
    phone: `+1555${String(1000000 + idx).slice(-7)}`,
    status: "Pending",
  }));
}

function calcStatus(
  sent: number,
  failed: number,
  total: number,
  current?: CampaignStatus,
): CampaignStatus {
  if (current === "Preparing") return "Preparing";
  if (current === "Scheduled") return "Scheduled";
  if (total > 0 && sent + failed >= total) return "Completed";
  if (sent + failed === 0 && total === 0) return current ?? "Paused";
  if (sent + failed === 0) return "Running";
  if (sent + failed >= total) return "Completed";
  return "Running";
}

const AUDIENCE_PAGES_PER_CHUNK = 5;
const AUDIENCE_PAGE_SIZE = 100;
const RESUME_SENDS_BATCH_SIZE = 100;

function isSendQueueMessage(
  msg: CampaignQueueMessage,
): msg is Extract<CampaignQueueMessage, { kind: "send" }> {
  return msg.kind === "send" || ("phone" in msg && typeof msg.phone === "string");
}

async function enqueueSendMessage(
  env: Env,
  input: { campaignId: string; phoneId: string; phone: string; body: string },
) {
  await env.CAMPAIGN_QUEUE.send({ kind: "send", ...input });
}

async function enqueueSendMessagesForPhones(
  env: Env,
  campaign: Campaign,
  phones: PhoneResult[],
) {
  let queued = 0;
  for (const p of phones) {
    if (!(await shouldEnqueueCampaignSend(env, campaign.id, p.id, p.phone, p.status))) continue;
    await enqueueSendMessage(env, {
      campaignId: campaign.id,
      phoneId: p.id,
      phone: p.phone,
      body: campaign.message,
    });
    queued += 1;
  }
  return queued;
}

async function startCampaignAudienceBuild(
  env: Env,
  campaignId: string,
  brandId: string,
  tag: string,
) {
  await env.CAMPAIGN_QUEUE.send({
    kind: "build_audience",
    campaignId,
    brandId,
    tag,
    offset: 0,
    nextPhoneSeq: 1,
  });
}

/** Pulls AC contacts in small queue chunks so campaign create never times out. */
async function processAudienceBuildChunk(
  env: Env,
  msg: Extract<CampaignQueueMessage, { kind: "build_audience" }>,
) {
  const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(msg.campaignId));
  if (!campaign || campaign.deletedAt) return;

  const brand = await kvGetJSON<Brand>(env.SMS_KV, key.brand(msg.brandId));
  if (!brand) return;

  const prevPhones =
    (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(msg.campaignId))) ?? [];
  const seen = new Set(prevPhones.map((p) => p.phone));
  const phones = [...prevPhones];
  const prevLen = phones.length;

  let offset = msg.offset;
  let nextSeq = msg.nextPhoneSeq;
  let pagesDone = 0;
  let done = false;

  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) {
    const mock = makeMockPhones(
      Math.max(1, parseInt(env.DEFAULT_CONTACT_COUNT ?? "120", 10)),
    );
    for (const row of mock) {
      if (!seen.has(row.phone)) {
        phones.push({ id: `p-${nextSeq++}`, phone: row.phone, status: "Pending" });
        seen.add(row.phone);
      }
    }
    done = true;
  } else {
    while (pagesDone < AUDIENCE_PAGES_PER_CHUNK) {
      const page = await fetchPhonePageFromActiveCampaignByTag(
        brand,
        msg.tag,
        offset,
        AUDIENCE_PAGE_SIZE,
      );
      if (page.rows === 0) {
        done = true;
        break;
      }
      for (const phone of page.phones) {
        if (seen.has(phone)) continue;
        seen.add(phone);
        phones.push({ id: `p-${nextSeq++}`, phone, status: "Pending" });
      }
      offset += page.rows;
      pagesDone += 1;
      if (page.done) {
        done = true;
        break;
      }
    }
  }

  const added = phones.slice(prevLen);
  const wasPreparing = campaign.status === "Preparing";
  let nextStatus: CampaignStatus = campaign.status;
  if (done) {
    nextStatus =
      campaign.status === "Scheduled"
        ? "Scheduled"
        : "Running";
  } else if (campaign.status !== "Scheduled") {
    nextStatus = "Preparing";
  }

  const updated: Campaign = {
    ...campaign,
    total: phones.length,
    status: nextStatus,
    queueProgress:
      campaign.status === "Running" && phones.length > 0
        ? Math.min(
            100,
            Math.round(((campaign.sent + campaign.failed) / phones.length) * 100),
          )
        : 0,
  };

  await Promise.all([
    kvPutJSON(env.SMS_KV, key.campaign(msg.campaignId), updated),
    kvPutJSON(env.SMS_KV, key.campaignPhones(msg.campaignId), phones),
  ]);

  if (!done) {
    await env.CAMPAIGN_QUEUE.send({
      kind: "build_audience",
      campaignId: msg.campaignId,
      brandId: msg.brandId,
      tag: msg.tag,
      offset,
      nextPhoneSeq: nextSeq,
    });
    return;
  }

  if (updated.status === "Running") {
    if (done) {
      await enqueueSendMessagesForPhones(env, updated, wasPreparing ? phones : added);
    } else if (campaign.status === "Running") {
      await enqueueSendMessagesForPhones(env, updated, added);
    }
  }
}

// phones[] is the source of truth for delivery outcomes. KV writes are eventually
// consistent and not transactional, so the campaign-level aggregates (sent / failed /
// queueProgress / status) can drift if the queue handler and Twilio status callback
// race. This helper rebuilds those aggregates from phones[] and persists them when
// they differ. We never auto-flip a "Scheduled" or "Paused" campaign back to running.
async function reconcileCampaignAggregates(
  env: Env,
  base: Campaign,
  phones: PhoneResult[],
): Promise<Campaign> {
  if (base.status === "Scheduled" || base.status === "Preparing") return base;
  const sent = phones.filter((p) => p.status === "Success").length;
  const failed = phones.filter((p) => p.status === "Failed").length;
  const total = base.total > 0 ? base.total : phones.length;
  const queueProgress =
    total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0;
  const reachedTerminal = total > 0 && sent + failed >= total;
  let status: CampaignStatus = base.status;
  if (base.status === "Paused") {
    if (reachedTerminal) status = "Completed";
  } else if (reachedTerminal) {
    status = "Completed";
  } else if (sent + failed > 0) {
    status = "Running";
  }
  if (
    base.sent === sent &&
    base.failed === failed &&
    base.queueProgress === queueProgress &&
    base.status === status
  ) {
    return base;
  }
  const healed: Campaign = { ...base, sent, failed, queueProgress, status };
  await kvPutJSON(env.SMS_KV, key.campaign(base.id), healed);
  return healed;
}

function formatTwilioRestError(httpStatus: number, bodyText: string): { summary: string; detail: string } {
  const trimmed = bodyText.trim();
  let code: string | number | undefined;
  let message: string | undefined;
  let moreInfo: string | undefined;
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    if (j.code !== undefined && j.code !== null) code = j.code as string | number;
    if (typeof j.message === "string") message = j.message;
    if (typeof j.more_info === "string") moreInfo = j.more_info;
  } catch {
    /* body not JSON */
  }
  const summary =
    code !== undefined && message
      ? `Twilio API error ${code}: ${message}`
      : `Twilio HTTP ${httpStatus}${trimmed ? `: ${trimmed.slice(0, 160)}` : ""}`;
  const detail = [
    `Time: ${now()}`,
    `HTTP status: ${httpStatus}`,
    code !== undefined ? `Twilio code: ${code}` : null,
    message ? `Twilio message: ${message}` : null,
    moreInfo ? `More info: ${moreInfo}` : null,
    trimmed.length > 0 ? `Raw response (truncated):\n${trimmed.slice(0, 1800)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { summary, detail };
}

type TwilioSendOutcome =
  | { ok: true; sid?: string }
  | { ok: false; summary: string; detail: string };

async function twilioSendWithDetails(
  env: Env,
  to: string,
  body: string,
  statusCallbackUrl?: string,
  idempotencyKey?: string,
): Promise<TwilioSendOutcome> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const mg = env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || !mg) {
    return {
      ok: false,
      summary: "Twilio is not configured for this Worker.",
      detail: [
        `Time: ${now()}`,
        `SEND_MODE=${env.SEND_MODE || "(unset)"}`,
        "Missing one or more: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID.",
        "Use SEND_MODE=mock to exercise failures without Twilio, or set the secrets for real sends.",
      ].join("\n"),
    };
  }
  const form = new URLSearchParams();
  form.set("To", to);
  form.set("Body", body);
  form.set("MessagingServiceSid", mg);
  if (statusCallbackUrl) form.set("StatusCallback", statusCallbackUrl);
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  const txt = await res.text();
  if (!res.ok) {
    const { summary, detail } = formatTwilioRestError(res.status, txt);
    return { ok: false, summary, detail };
  }
  try {
    const j = JSON.parse(txt) as { sid?: string };
    return { ok: true, sid: j.sid };
  } catch {
    return { ok: true, sid: undefined };
  }
}

async function twilioSend(env: Env, to: string, body: string, statusCallbackUrl?: string) {
  const r = await twilioSendWithDetails(env, to, body, statusCallbackUrl);
  if (!r.ok) throw new Error(r.summary);
  return { sid: r.sid };
}

async function updateDaily(env: Env, sentDelta: number, failedDelta: number) {
  const day = now().slice(0, 10);
  const current =
    (await kvGetJSON<{ sent: number; failed: number }>(env.SMS_KV, key.daily(day))) ?? {
      sent: 0,
      failed: 0,
    };
  current.sent += sentDelta;
  current.failed += failedDelta;
  await kvPutJSON(env.SMS_KV, key.daily(day), current);
}

const DELIVERY_INFLIGHT_MAX_MS = 3 * 60 * 1000;
/** Merge row patches into the full phones blob after this many sends (cuts KV writes ~40x). */
const PHONES_FLUSH_EVERY = 40;
/** Batch global daily analytics instead of one KV write per SMS. */
const DAILY_STATS_FLUSH_EVERY = 30;

function campaignSendIdempotencyKey(campaignId: string, phoneId: string) {
  return `${campaignId}:${phoneId}`.slice(0, 128);
}

async function getPhoneDelivery(
  env: Env,
  campaignId: string,
  phoneId: string,
): Promise<CampaignPhoneDelivery | null> {
  return kvGetJSON<CampaignPhoneDelivery>(
    env.SMS_KV,
    key.campaignPhoneDelivery(campaignId, phoneId),
  );
}

async function setPhoneDelivery(
  env: Env,
  campaignId: string,
  phoneId: string,
  delivery: CampaignPhoneDelivery,
) {
  await kvPutJSON(env.SMS_KV, key.campaignPhoneDelivery(campaignId, phoneId), delivery);
}

async function getCampaignSentPhoneRecord(
  env: Env,
  campaignId: string,
  phone: string,
): Promise<{ phoneId: string; at: string; twilioSid?: string } | null> {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  return kvGetJSON(env.SMS_KV, key.campaignSentPhone(campaignId, norm));
}

async function markCampaignSentPhone(
  env: Env,
  campaignId: string,
  phone: string,
  phoneId: string,
  twilioSid?: string,
) {
  const norm = normalizePhone(phone);
  if (!norm) return;
  await kvPutJSON(env.SMS_KV, key.campaignSentPhone(campaignId, norm), {
    phoneId,
    at: now(),
    twilioSid,
  });
}

/** True if this campaign already delivered to this number (never call Twilio again). */
async function wasAlreadySentForCampaign(
  env: Env,
  campaignId: string,
  phoneId: string,
  phone: string,
): Promise<CampaignPhoneDelivery | null> {
  const byId = await getPhoneDelivery(env, campaignId, phoneId);
  if (byId?.state === "sent") return byId;

  const byPhone = await getCampaignSentPhoneRecord(env, campaignId, phone);
  if (byPhone) {
    return {
      state: "sent",
      at: byPhone.at,
      phone: normalizePhone(phone) ?? phone,
      twilioSid: byPhone.twilioSid,
    };
  }

  const norm = normalizePhone(phone);
  if (norm) {
    const last = await kvGetJSON<{ campaignId: string; phoneId: string; at: string }>(
      env.SMS_KV,
      key.lastSentTo(norm),
    );
    if (last?.campaignId === campaignId) {
      return {
        state: "sent",
        at: last.at,
        phone: norm,
        twilioSid: undefined,
      };
    }
  }

  return null;
}

async function healPendingRowFromPriorSend(
  env: Env,
  campaign: Campaign,
  phones: PhoneResult[],
  idx: number,
  prior: CampaignPhoneDelivery,
  phoneId: string,
  phone: string,
): Promise<Campaign | null> {
  if (phones[idx].status !== "Pending") return null;
  applyDeliveryToPhoneRow(phones, idx, prior);
  await setPhoneDelivery(env, campaign.id, phoneId, prior);
  await markCampaignSentPhone(env, campaign.id, phone, phoneId, prior.twilioSid);
  return recordSendOutcome(
    env,
    campaign,
    { campaignId: campaign.id, phoneId, phone },
    phones[idx],
    { sent: 1, failed: 0 },
    prior.twilioSid,
  );
}

/** Mark Pending rows as Success when we already sent but KV phone list lagged — no Twilio. */
async function reconcilePendingWithoutResend(env: Env, campaignId: string) {
  await flushCampaignPhonePatches(env, campaignId);
  const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
  const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId));
  if (!campaign || campaign.deletedAt || !phones?.length) {
    return { healed: 0, stillPending: 0 };
  }

  let healed = 0;
  let current = campaign;
  for (let i = 0; i < phones.length; i += 1) {
    if (phones[i].status !== "Pending") continue;
    const prior = await wasAlreadySentForCampaign(env, campaignId, phones[i].id, phones[i].phone);
    if (!prior) continue;
    const updated = await healPendingRowFromPriorSend(
      env,
      current,
      phones,
      i,
      prior,
      phones[i].id,
      phones[i].phone,
    );
    if (updated) {
      healed += 1;
      current = updated;
    }
  }

  if (healed > 0) await flushCampaignPhonePatches(env, campaignId);
  const phonesFresh =
    (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId))) ?? phones;
  const stillPending = phonesFresh.filter((p) => p.status === "Pending").length;
  return { healed, stillPending };
}

async function shouldEnqueueCampaignSend(
  env: Env,
  campaignId: string,
  phoneId: string,
  phone: string,
  phoneStatus: PhoneStatus,
): Promise<boolean> {
  if (phoneStatus !== "Pending") return false;
  if (await wasAlreadySentForCampaign(env, campaignId, phoneId, phone)) return false;
  const delivery = await getPhoneDelivery(env, campaignId, phoneId);
  if (
    delivery?.state === "inflight" &&
    Date.now() - Date.parse(delivery.at) < DELIVERY_INFLIGHT_MAX_MS
  ) {
    return false;
  }
  return true;
}

async function incrementCampaignProgress(
  env: Env,
  campaign: Campaign,
  deltas: { sent: number; failed: number },
): Promise<Campaign> {
  const sent = campaign.sent + deltas.sent;
  const failed = campaign.failed + deltas.failed;
  const total = campaign.total > 0 ? campaign.total : sent + failed;
  const queueProgress =
    total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0;
  const updated: Campaign = {
    ...campaign,
    sent,
    failed,
    queueProgress,
    status: calcStatus(sent, failed, total, campaign.status),
  };
  await Promise.all([
    kvPutJSON(env.SMS_KV, key.campaign(campaign.id), updated),
    kvPutJSON(env.SMS_KV, key.campaignProgressSnapshot(campaign.id), {
      processed: sent + failed,
      at: now(),
    }),
  ]);
  return updated;
}

async function bufferDailyStats(env: Env, sentDelta: number, failedDelta: number) {
  if (sentDelta === 0 && failedDelta === 0) return;
  const day = now().slice(0, 10);
  const bufKey = `${key.daily(day)}:buf`;
  const cur =
    (await kvGetJSON<{ sent: number; failed: number }>(env.SMS_KV, bufKey)) ?? {
      sent: 0,
      failed: 0,
    };
  cur.sent += sentDelta;
  cur.failed += failedDelta;
  if (cur.sent + cur.failed >= DAILY_STATS_FLUSH_EVERY) {
    await updateDaily(env, cur.sent, cur.failed);
    await env.SMS_KV.delete(bufKey);
  } else {
    await kvPutJSON(env.SMS_KV, bufKey, cur);
  }
}

async function flushBufferedDailyStats(env: Env) {
  const day = now().slice(0, 10);
  const bufKey = `${key.daily(day)}:buf`;
  const cur = await kvGetJSON<{ sent: number; failed: number }>(env.SMS_KV, bufKey);
  if (!cur || (cur.sent === 0 && cur.failed === 0)) return;
  await updateDaily(env, cur.sent, cur.failed);
  await env.SMS_KV.delete(bufKey);
}

/** Merge pending per-phone patches into the master phones list (one large write per batch). */
async function flushCampaignPhonePatches(env: Env, campaignId: string): Promise<number> {
  const dirty =
    (await kvGetJSON<string[]>(env.SMS_KV, key.campaignPhoneDirty(campaignId))) ?? [];
  if (dirty.length === 0) return 0;

  const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId));
  if (!phones?.length) {
    await env.SMS_KV.delete(key.campaignPhoneDirty(campaignId));
    return 0;
  }

  const patches = await Promise.all(
    dirty.map((id) =>
      kvGetJSON<PhoneResult>(env.SMS_KV, key.campaignPhonePatch(campaignId, id)),
    ),
  );
  const byId = new Map<string, PhoneResult>();
  dirty.forEach((id, i) => {
    const patch = patches[i];
    if (patch) byId.set(id, patch);
  });

  for (let i = 0; i < phones.length; i += 1) {
    const patch = byId.get(phones[i].id);
    if (patch) phones[i] = patch;
  }

  await kvPutJSON(env.SMS_KV, key.campaignPhones(campaignId), phones);
  await Promise.all([
    ...dirty.map((id) => env.SMS_KV.delete(key.campaignPhonePatch(campaignId, id))),
    env.SMS_KV.delete(key.campaignPhoneDirty(campaignId)),
  ]);
  return dirty.length;
}

async function queuePhonePatch(
  env: Env,
  campaignId: string,
  phoneId: string,
  row: PhoneResult,
): Promise<void> {
  await kvPutJSON(env.SMS_KV, key.campaignPhonePatch(campaignId, phoneId), row);
  const dirty =
    (await kvGetJSON<string[]>(env.SMS_KV, key.campaignPhoneDirty(campaignId))) ?? [];
  if (!dirty.includes(phoneId)) dirty.push(phoneId);
  await kvPutJSON(env.SMS_KV, key.campaignPhoneDirty(campaignId), dirty);
  if (dirty.length >= PHONES_FLUSH_EVERY) {
    await flushCampaignPhonePatches(env, campaignId);
  }
}

async function recordSendOutcome(
  env: Env,
  campaign: Campaign,
  msg: { campaignId: string; phoneId: string; phone: string },
  row: PhoneResult,
  deltas: { sent: number; failed: number },
  twilioSid?: string,
): Promise<Campaign> {
  const writes: Promise<void>[] = [queuePhonePatch(env, msg.campaignId, msg.phoneId, row)];
  if (deltas.sent > 0 && twilioSid) {
    writes.push(
      kvPutJSON(env.SMS_KV, key.sidToPhone(twilioSid), {
        campaignId: msg.campaignId,
        phoneId: msg.phoneId,
        phone: msg.phone,
      }),
    );
  }
  if (deltas.sent > 0) {
    const norm = normalizePhone(msg.phone);
    if (norm) {
      writes.push(
        kvPutJSON(env.SMS_KV, key.lastSentTo(norm), {
          campaignId: msg.campaignId,
          phoneId: msg.phoneId,
          at: now(),
        }),
      );
    }
  }
  await Promise.all(writes);
  await bufferDailyStats(env, deltas.sent, deltas.failed);
  return incrementCampaignProgress(env, campaign, deltas);
}

async function persistCampaignPhonesAndStats(
  env: Env,
  campaignId: string,
  phones: PhoneResult[],
  campaign: Campaign,
  opts: { sentDelta: number; failedDelta: number; twilioSid?: string; phone?: string; phoneId?: string },
) {
  const sent = phones.filter((p) => p.status === "Success").length;
  const failed = phones.filter((p) => p.status === "Failed").length;
  const progress = campaign.total > 0 ? Math.round(((sent + failed) / campaign.total) * 100) : 0;
  const updated: Campaign = {
    ...campaign,
    sent,
    failed,
    queueProgress: Math.min(100, progress),
    status: calcStatus(sent, failed, campaign.total, campaign.status),
  };
  await Promise.all([
    kvPutJSON(env.SMS_KV, key.campaign(campaignId), updated),
    kvPutJSON(env.SMS_KV, key.campaignPhones(campaignId), phones),
    opts.sentDelta > 0 && opts.twilioSid
      ? kvPutJSON(env.SMS_KV, key.sidToPhone(opts.twilioSid), {
          campaignId,
          phoneId: opts.phoneId ?? "",
          phone: opts.phone ?? "",
        })
      : Promise.resolve(),
    opts.sentDelta > 0 && opts.phone
      ? kvPutJSON(env.SMS_KV, key.lastSentTo(opts.phone), {
          campaignId,
          phoneId: opts.phoneId ?? "",
          at: now(),
        })
      : Promise.resolve(),
    updateDaily(env, opts.sentDelta, opts.failedDelta),
    kvPutJSON(env.SMS_KV, key.campaignProgressSnapshot(campaignId), {
      processed: sent + failed,
      at: now(),
    }),
  ]);
  return updated;
}

function applyDeliveryToPhoneRow(
  phones: PhoneResult[],
  idx: number,
  delivery: CampaignPhoneDelivery,
): PhoneStatus {
  if (delivery.state === "sent") {
    phones[idx] = {
      ...phones[idx],
      status: "Success",
      error: undefined,
      twilioSid: delivery.twilioSid,
      failedAt: undefined,
      failureSource: undefined,
      failureDetail: undefined,
    };
    return "Success";
  }
  phones[idx] = {
    ...phones[idx],
    status: "Failed",
    error: delivery.error ?? "Send failed",
    failedAt: delivery.at,
    failureSource: "twilio_rest",
    failureDetail: delivery.error,
  };
  return "Failed";
}

async function updateSubscriberDaily(
  env: Env,
  brandId: string | null,
  deliveredDelta: number,
  unsubDelta: number,
) {
  const day = now().slice(0, 10);
  const current =
    (await kvGetJSON<{ delivered: number; unsubs: number }>(
      env.SMS_KV,
      key.subsDaily(day),
    )) ?? {
      delivered: 0,
      unsubs: 0,
    };
  current.delivered += deliveredDelta;
  current.unsubs += unsubDelta;
  const writes: Promise<void>[] = [kvPutJSON(env.SMS_KV, key.subsDaily(day), current)];
  if (brandId) {
    const byBrand =
      (await kvGetJSON<{ delivered: number; unsubs: number }>(
        env.SMS_KV,
        key.subsDailyByBrand(day, brandId),
      )) ?? {
        delivered: 0,
        unsubs: 0,
      };
    byBrand.delivered += deliveredDelta;
    byBrand.unsubs += unsubDelta;
    writes.push(kvPutJSON(env.SMS_KV, key.subsDailyByBrand(day, brandId), byBrand));
  }
  await Promise.all(writes);
}

async function processSingleMessage(
  env: Env,
  msg: Extract<CampaignQueueMessage, { kind: "send" }>,
) {
  const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(msg.campaignId));
  if (!campaign) return;
  if (campaign.status === "Preparing" || campaign.status === "Scheduled") return;

  const priorSend = await wasAlreadySentForCampaign(
    env,
    msg.campaignId,
    msg.phoneId,
    msg.phone,
  );
  if (priorSend) {
    const healedRow: PhoneResult = {
      id: msg.phoneId,
      phone: msg.phone,
      status: "Success",
      twilioSid: priorSend.twilioSid,
    };
    await setPhoneDelivery(env, msg.campaignId, msg.phoneId, priorSend);
    await markCampaignSentPhone(env, msg.campaignId, msg.phone, msg.phoneId, priorSend.twilioSid);
    await recordSendOutcome(
      env,
      campaign,
      msg,
      healedRow,
      { sent: 1, failed: 0 },
      priorSend.twilioSid,
    );
    return;
  }

  const priorDelivery = await getPhoneDelivery(env, msg.campaignId, msg.phoneId);
  if (
    priorDelivery?.state === "inflight" &&
    Date.now() - Date.parse(priorDelivery.at) < DELIVERY_INFLIGHT_MAX_MS
  ) {
    return;
  }

  await setPhoneDelivery(env, msg.campaignId, msg.phoneId, {
    state: "inflight",
    at: now(),
    phone: msg.phone,
  });

  let status: PhoneStatus = "Success";
  let error: string | undefined;
  let twilioSid: string | undefined;
  let failedAt: string | undefined;
  let failureSource: PhoneResult["failureSource"];
  let failureDetail: string | undefined;
  const idempotencyKey = campaignSendIdempotencyKey(msg.campaignId, msg.phoneId);

  if (env.SEND_MODE === "real") {
    const statusCallbackUrl =
      env.WORKER_BASE_URL && env.TWILIO_STATUS_TOKEN
        ? `${env.WORKER_BASE_URL.replace(/\/+$/, "")}/twilio/status?token=${encodeURIComponent(
            env.TWILIO_STATUS_TOKEN,
          )}`
        : undefined;
    const out = await twilioSendWithDetails(
      env,
      msg.phone,
      msg.body,
      statusCallbackUrl,
      idempotencyKey,
    );
    if (out.ok) {
      twilioSid = out.sid;
    } else {
      status = "Failed";
      error = out.summary;
      failureDetail = out.detail;
      failureSource = "twilio_rest";
      failedAt = now();
    }
  } else {
    const roll = Math.random();
    if (roll < 0.1) {
      status = "Failed";
      error = "Mock failure (simulated)";
      failureSource = "mock_simulated";
      failedAt = now();
      failureDetail = [
        `Time: ${now()}`,
        `SEND_MODE=${env.SEND_MODE || "mock"}`,
        "This failure was generated randomly in mock mode (~10% of messages).",
        "It is not from Twilio or the carrier. Use it to test retries and the failure UI.",
        `Roll: ${roll.toFixed(4)} (fails when < 0.1).`,
      ].join("\n");
    }
  }

  if (status === "Success") {
    await setPhoneDelivery(env, msg.campaignId, msg.phoneId, {
      state: "sent",
      at: now(),
      phone: msg.phone,
      twilioSid,
    });
    await markCampaignSentPhone(env, msg.campaignId, msg.phone, msg.phoneId, twilioSid);
  } else {
    await setPhoneDelivery(env, msg.campaignId, msg.phoneId, {
      state: "failed",
      at: failedAt ?? now(),
      phone: msg.phone,
      error: error ?? "Send failed",
    });
  }

  const row: PhoneResult =
    status === "Success"
      ? {
          id: msg.phoneId,
          phone: msg.phone,
          status,
          twilioSid,
        }
      : {
          id: msg.phoneId,
          phone: msg.phone,
          status,
          error,
          twilioSid,
          failedAt,
          failureSource,
          failureDetail,
        };

  await recordSendOutcome(
    env,
    campaign,
    msg,
    row,
    { sent: status === "Success" ? 1 : 0, failed: status === "Failed" ? 1 : 0 },
    twilioSid,
  );

  if (status === "Success") {
    void missiveShadowLog(
      env,
      msg.phone,
      `Outbound SMS (${msg.campaignId}): ${msg.body}`,
    ).catch(() => {});
  }
}

async function listCampaigns(env: Env): Promise<Campaign[]> {
  const ids = (await kvGetJSON<string[]>(env.SMS_KV, key.campaigns)) ?? [];
  const campaigns = await Promise.all(ids.map((id) => kvGetJSON<Campaign>(env.SMS_KV, key.campaign(id))));
  return campaigns.filter((x): x is Campaign => {
    if (!x) return false;
    return !x.deletedAt;
  });
}

async function enqueuePendingCampaignPhones(env: Env, campaign: Campaign) {
  const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaign.id));
  if (!phones || phones.length === 0) return 0;
  return enqueueSendMessagesForPhones(env, campaign, phones);
}

/** Re-queue pending sends in chunks so resume does not time out on large audiences. */
async function processResumeSendsBatch(
  env: Env,
  msg: Extract<CampaignQueueMessage, { kind: "resume_sends" }>,
) {
  const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(msg.campaignId));
  const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(msg.campaignId));
  if (!campaign || campaign.deletedAt || !phones?.length) return;

  let cursor = Math.max(0, msg.cursor);
  let queued = 0;
  while (cursor < phones.length && queued < RESUME_SENDS_BATCH_SIZE) {
    const row = phones[cursor];
    cursor += 1;
    if (!(await shouldEnqueueCampaignSend(env, msg.campaignId, row.id, row.phone, row.status))) {
      continue;
    }
    await enqueueSendMessage(env, {
      campaignId: msg.campaignId,
      phoneId: row.id,
      phone: row.phone,
      body: campaign.message,
    });
    queued += 1;
  }

  const morePending = phones.slice(cursor).some((p) => p.status === "Pending");
  if (morePending) {
    await env.CAMPAIGN_QUEUE.send({
      kind: "resume_sends",
      campaignId: msg.campaignId,
      cursor,
    });
  }
}

const STUCK_PROGRESS_MS = 2 * 60 * 1000;
const RESUME_THROTTLE_MS = 2 * 60 * 1000;
/** Re-kick build_audience if a campaign stays Preparing for longer than this. */
const STUCK_PREPARING_MS = 10 * 60 * 1000;

/** Re-queue pending phones when a Running campaign has had no progress for several minutes. */
async function maybeResumeStuckRunningCampaigns(env: Env) {
  const campaigns = await listCampaigns(env);
  for (const c of campaigns) {
    if (c.status !== "Running") continue;
    const phones =
      (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(c.id))) ?? [];
    const pending = phones.filter((p) => p.status === "Pending").length;
    if (pending === 0) continue;

    const throttle =
      (await kvGetJSON<{ at: string }>(env.SMS_KV, key.campaignResumeThrottle(c.id))) ??
      null;
    if (throttle && Date.now() - Date.parse(throttle.at) < RESUME_THROTTLE_MS) continue;

    await reconcilePendingWithoutResend(env, c.id);
    const phonesAfter = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(c.id));
    const pendingAfter = (phonesAfter ?? []).filter((p) => p.status === "Pending").length;
    if (pendingAfter === 0) continue;

    const fresh = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(c.id));
    if (!fresh) continue;
    const processed = fresh.sent + fresh.failed;
    const snap =
      (await kvGetJSON<{ processed: number; at: string }>(
        env.SMS_KV,
        key.campaignProgressSnapshot(c.id),
      )) ?? null;
    const unchanged =
      snap &&
      snap.processed === processed &&
      Date.now() - Date.parse(snap.at) >= STUCK_PROGRESS_MS;

    if (!unchanged) {
      await kvPutJSON(env.SMS_KV, key.campaignProgressSnapshot(c.id), {
        processed,
        at: now(),
      });
      continue;
    }

    await env.CAMPAIGN_QUEUE.send({
      kind: "resume_sends",
      campaignId: c.id,
      cursor: 0,
    });
    await kvPutJSON(env.SMS_KV, key.campaignResumeThrottle(c.id), { at: now() });
  }
}

/** Re-send a build_audience message when a campaign stays Preparing for too long (dropped message). */
async function maybeRestartStuckPreparingCampaigns(env: Env) {
  const campaigns = await listCampaigns(env);
  for (const c of campaigns) {
    if (c.status !== "Preparing") continue;
    const createdMs = Date.parse(c.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    if (Date.now() - createdMs < STUCK_PREPARING_MS) continue;

    const throttleKey = key.campaignResumeThrottle(c.id) + ":preparing";
    const throttle = await kvGetJSON<{ at: string }>(env.SMS_KV, throttleKey);
    if (throttle && Date.now() - Date.parse(throttle.at) < STUCK_PREPARING_MS) continue;

    const phones =
      (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(c.id))) ?? [];
    const existingTotal = phones.length;

    await startCampaignAudienceBuild(env, c.id, c.brandId, c.tag);
    await kvPutJSON(env.SMS_KV, throttleKey, { at: now() });

    if (existingTotal > 0) {
      await env.CAMPAIGN_QUEUE.send({ kind: "resume_sends", campaignId: c.id, cursor: 0 });
    }
  }
}

async function releaseDueScheduledCampaigns(env: Env, limit = 25) {
  const campaigns = await listCampaigns(env);
  const due = campaigns
    .filter(
      (c) =>
        c.status === "Scheduled" &&
        Boolean(c.scheduledAtUtc) &&
        Date.parse(c.scheduledAtUtc as string) <= Date.now(),
    )
    .slice(0, limit);
  for (const campaign of due) {
    const running: Campaign = {
      ...campaign,
      status: "Running",
      queueProgress: campaign.queueProgress || 0,
    };
    await kvPutJSON(env.SMS_KV, key.campaign(campaign.id), running);
    await enqueuePendingCampaignPhones(env, running);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (isProtectedRequest(url) && !authOk(request, env, url)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    // Health + route map
    if (url.pathname === "/") {
      return json({
        ok: true,
        routes: {
          health: "/health",
          brands: "/brands",
          brandAcTags: "GET /brands/:id/activecampaign/tags",
          brandTagSubscribers: "GET /brands/:id/subscribers?tag=TAG_NAME",
          brandTagSubscribersWarmup: "POST /brands/:id/subscribers/warmup",
          brandTwilioPricing: "GET /brands/:id/twilio-pricing?country=US",
          campaigns: "/campaigns",
          campaignDetail: "/campaigns/:id",
          campaignRetryPhone: "POST /campaigns/:id/phones/:phoneId/retry",
          campaignResume: "POST /campaigns/:id/resume",
          campaignReconcile: "POST /campaigns/:id/reconcile",
          blastCompat: "/blast?secret=...&tag=...&msg=...&blast_id=...",
          metricsAllCompat: "/metrics/all?secret=...&limit=25",
          metricsOneCompat: "/metrics?secret=...&id=BLAST_ID",
          clickRedirect: "/c?bid=BLAST_ID&u=https%3A%2F%2Fexample.com",
          twilioStatus: "/twilio/status?token=...",
          twilioInbound: "/twilio/inbound?token=...",
          testMissive: "/test-missive?secret=...&to=+1...&msg=hello",
          authLogin: "POST /auth/login",
          authForgotPassword: "POST /auth/forgot-password",
          authResetPassword: "POST /auth/reset-password",
          authChangePassword: "POST /auth/change-password (Bearer token)",
          analytics: "/analytics/sent-failed",
          subscriberSummary: "/analytics/subscribers-summary",
          subscriberRefresh: "POST /analytics/subscribers-summary/refresh?brandId=<id|all>",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        mode: env.SEND_MODE ?? "mock",
        hasKv: Boolean(env.SMS_KV),
        hasQueue: Boolean(env.CAMPAIGN_QUEUE),
        hasTwilioStatusToken: Boolean(env.TWILIO_STATUS_TOKEN),
        hasMissiveToken: Boolean(env.MISSIVE_API_TOKEN),
        defaultAdminEmail: env.DEFAULT_ADMIN_EMAIL || "admin@spellsology.com",
      });
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      await ensureDefaultAuthUser(env);
      const body = (await request.json()) as { email?: string; password?: string };
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) return json({ ok: false, error: "Email and password are required" }, 400);
      const user = await kvGetJSON<AuthUser>(env.SMS_KV, key.authUser(email));
      if (!user) return json({ ok: false, error: "Invalid credentials" }, 401);
      const hash = await sha256(password);
      if (hash !== user.passwordHash) return json({ ok: false, error: "Invalid credentials" }, 401);
      const token = crypto.randomUUID();
      const session: AuthSession = {
        email,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };
      await kvPutJSON(env.SMS_KV, key.authSession(token), session);
      return json({ ok: true, token, user: { email } });
    }

    if (url.pathname === "/auth/forgot-password" && request.method === "POST") {
      await ensureDefaultAuthUser(env);
      const body = (await request.json()) as { email?: string };
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return json({ ok: false, error: "Email is required" }, 400);
      const user = await kvGetJSON<AuthUser>(env.SMS_KV, key.authUser(email));
      if (!user) return json({ ok: true, sentToOwner: false, ownerPhoneMasked: null });
      const code = generateCode(6);
      const reset: PasswordReset = {
        code,
        expiresAt: Date.now() + 10 * 60 * 1000,
        requestedAt: now(),
      };
      await kvPutJSON(env.SMS_KV, key.authReset(email), reset);

      const ownerPhone = normalizePhone(env.OWNER_PHONE || null);
      if (ownerPhone) {
        const text = `Password reset code for ${email}: ${code} (valid 10 min).`;
        try {
          if (env.SEND_MODE === "real") {
            await twilioSend(env, ownerPhone, text);
          } else {
            await missiveShadowLog(env, ownerPhone, `MOCK SMS: ${text}`);
          }
        } catch {
          /* ignore send failure for response safety */
        }
      }
      return json({
        ok: true,
        sentToOwner: Boolean(ownerPhone),
        ownerPhoneMasked: maskPhone(ownerPhone),
      });
    }

    if (url.pathname === "/auth/reset-password" && request.method === "POST") {
      await ensureDefaultAuthUser(env);
      const body = (await request.json()) as {
        email?: string;
        code?: string;
        newPassword?: string;
      };
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      const newPassword = String(body.newPassword || "");
      if (!email || !code || !newPassword) {
        return json({ ok: false, error: "Email, code and newPassword are required" }, 400);
      }
      if (newPassword.length < 8) return json({ ok: false, error: "Password too short" }, 400);
      const user = await kvGetJSON<AuthUser>(env.SMS_KV, key.authUser(email));
      if (!user) return json({ ok: false, error: "User not found" }, 404);
      const reset = await kvGetJSON<PasswordReset>(env.SMS_KV, key.authReset(email));
      if (!reset || reset.expiresAt < Date.now() || reset.code !== code) {
        return json({ ok: false, error: "Invalid or expired reset code" }, 400);
      }
      const updated: AuthUser = {
        ...user,
        passwordHash: await sha256(newPassword),
        updatedAt: now(),
      };
      await Promise.all([
        kvPutJSON(env.SMS_KV, key.authUser(email), updated),
        env.SMS_KV.delete(key.authReset(email)),
      ]);
      return json({ ok: true });
    }

    if (url.pathname === "/auth/change-password" && request.method === "POST") {
      await ensureDefaultAuthUser(env);
      const session = await getBearerSession(request, env);
      if (!session) return json({ ok: false, error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        currentPassword?: string;
        newPassword?: string;
      };
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (!currentPassword || !newPassword) {
        return json({ ok: false, error: "currentPassword and newPassword are required" }, 400);
      }
      if (newPassword.length < 8) return json({ ok: false, error: "Password too short" }, 400);
      const user = await kvGetJSON<AuthUser>(env.SMS_KV, key.authUser(session.email));
      if (!user) return json({ ok: false, error: "User not found" }, 404);
      const currentHash = await sha256(currentPassword);
      if (currentHash !== user.passwordHash) {
        return json({ ok: false, error: "Current password is incorrect" }, 400);
      }
      const updated: AuthUser = {
        ...user,
        passwordHash: await sha256(newPassword),
        updatedAt: now(),
      };
      await kvPutJSON(env.SMS_KV, key.authUser(session.email), updated);
      return json({ ok: true });
    }

    if (url.pathname === "/test-missive" && request.method === "GET") {
      const to = normalizePhone(url.searchParams.get("to")) || "+15551230000";
      const msg = url.searchParams.get("msg") || "Test from /test-missive";
      await missiveShadowLog(env, to, msg).catch(() => {});
      return json({ ok: true, queued: true, to, msg });
    }

    if (url.pathname === "/c" && request.method === "GET") {
      const bid = url.searchParams.get("bid");
      const redirectTo = url.searchParams.get("u");
      if (!bid || !redirectTo) return json({ ok: false, error: "Missing bid or u" }, 400);
      await incrementCampaignMeta(env, bid, "clicks", 1).catch(() => {});
      return new Response(null, { status: 302, headers: { location: redirectTo } });
    }

    if (url.pathname === "/twilio/status") {
      if (!twilioTokenOk(request, env, url)) {
        return json({ ok: false, error: "Unauthorized token" }, 401);
      }
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      const form = await request.formData();
      const sid = String(form.get("MessageSid") || form.get("SmsSid") || "");
      const status = String(form.get("MessageStatus") || form.get("SmsStatus") || "").toLowerCase();
      if (!sid || !status) {
        return json({ ok: false, error: "Missing MessageSid/MessageStatus" }, 400);
      }

      const map = await kvGetJSON<{ campaignId: string; phoneId: string; phone: string }>(
        env.SMS_KV,
        key.sidToPhone(sid),
      );
      if (!map) return json({ ok: true, note: "No mapping for sid", sid, status });

      if (status === "delivered") {
        await incrementCampaignMeta(env, map.campaignId, "delivered", 1);
        const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(map.campaignId));
        await updateSubscriberDaily(env, campaign?.brandId ?? null, 1, 0);
      } else if (status === "undelivered" || status === "failed") {
        await incrementCampaignMeta(env, map.campaignId, "deliveryFailed", 1);
        const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(map.campaignId));
        const phones = await kvGetJSON<PhoneResult[]>(
          env.SMS_KV,
          key.campaignPhones(map.campaignId),
        );
        if (campaign && phones) {
          const idx = phones.findIndex((p) => p.id === map.phoneId);
          if (idx >= 0 && phones[idx].status !== "Failed") {
            const errorCode = String(form.get("ErrorCode") || "").trim();
            const errorMessage = String(form.get("ErrorMessage") || "").trim();
            const toVal = String(form.get("To") || "").trim();
            const summary =
              errorCode && errorMessage
                ? `Twilio delivery ${errorCode}: ${errorMessage}`
                : errorMessage
                  ? `${errorMessage} (${status})`
                  : `Twilio carrier status: ${status}`;
            const failureDetail = [
              `Time: ${now()}`,
              "Source: Twilio status callback (after the message was accepted by the REST API).",
              `MessageSid: ${sid}`,
              `MessageStatus: ${status}`,
              errorCode ? `ErrorCode: ${errorCode}` : null,
              errorMessage ? `ErrorMessage: ${errorMessage}` : null,
              toVal ? `To: ${toVal}` : null,
              `Campaign: ${map.campaignId}, phone row: ${map.phoneId}`,
            ]
              .filter(Boolean)
              .join("\n");
            phones[idx] = {
              ...phones[idx],
              status: "Failed",
              error: summary,
              failureDetail,
              failureSource: "twilio_callback",
              failedAt: now(),
            };
            const sent = phones.filter((p) => p.status === "Success").length;
            const failed = phones.filter((p) => p.status === "Failed").length;
            const progress =
              campaign.total > 0 ? Math.round(((sent + failed) / campaign.total) * 100) : 0;
            await Promise.all([
              kvPutJSON(env.SMS_KV, key.campaignPhones(map.campaignId), phones),
              kvPutJSON(env.SMS_KV, key.campaign(map.campaignId), {
                ...campaign,
                sent,
                failed,
                queueProgress: Math.min(100, progress),
                status: calcStatus(sent, failed, campaign.total, campaign.status),
              } satisfies Campaign),
            ]);
          }
        }
      }

      return json({ ok: true, sid, status, campaignId: map.campaignId });
    }

    if (url.pathname === "/twilio/inbound") {
      if (!twilioTokenOk(request, env, url)) {
        return json({ ok: false, error: "Unauthorized token" }, 401);
      }
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      const form = await request.formData();
      const from = normalizePhone(String(form.get("From") || ""));
      const body = String(form.get("Body") || "").trim();
      if (!from) return json({ ok: false, error: "Missing/invalid From" }, 400);

      const lastSent = await kvGetJSON<{ campaignId: string; phoneId: string; at: string }>(
        env.SMS_KV,
        key.lastSentTo(from),
      );

      if (lastSent) {
        const lower = body.toLowerCase();
        const isStop =
          lower === "stop" ||
          lower === "unsubscribe" ||
          lower === "cancel" ||
          lower === "end" ||
          lower === "quit" ||
          lower.startsWith("stop ");
        await incrementCampaignMeta(
          env,
          lastSent.campaignId,
          isStop ? "unsubs" : "replies",
          1,
        );
        if (isStop) {
          const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(lastSent.campaignId));
          await updateSubscriberDaily(env, campaign?.brandId ?? null, 0, 1);
        }
      }

      void missiveShadowLog(env, from, `Inbound SMS: ${body}`).catch(() => {});
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
        status: 200,
        headers: { "content-type": "text/xml; charset=utf-8" },
      });
    }

    // Brands
    if (url.pathname === "/brands" && request.method === "GET") {
      const ids = (await kvGetJSON<string[]>(env.SMS_KV, key.brands)) ?? [];
      const brands = await Promise.all(ids.map((id) => kvGetJSON<Brand>(env.SMS_KV, key.brand(id))));
      return json({ ok: true, brands: brands.filter((b): b is Brand => Boolean(b)) });
    }

    if (url.pathname === "/brands" && request.method === "POST") {
      const body = (await request.json()) as Omit<Brand, "id" | "createdAt" | "updatedAt">;
      const id = randomId("brand");
      const item: Brand = { ...body, id, createdAt: now(), updatedAt: now() };
      await Promise.all([
        kvPutJSON(env.SMS_KV, key.brand(id), item),
        appendUnique(env.SMS_KV, key.brands, id),
      ]);
      if (item.activeCampaignApiUrl && item.activeCampaignApiKey) {
        ctx.waitUntil(
          warmBrandTagSubscriberCaches(env, item, { maxTags: 8, maxPages: 1 }).catch(
            () => undefined,
          ),
        );
      }
      return json({ ok: true, brand: item }, 201);
    }

    if (url.pathname.startsWith("/brands/")) {
      const brandId = url.pathname.split("/")[2];
      if (!brandId) return json({ ok: false, error: "Missing brand id" }, 400);
      const existing = await kvGetJSON<Brand>(env.SMS_KV, key.brand(brandId));
      if (!existing) return json({ ok: false, error: "Brand not found" }, 404);

      if (
        (url.pathname.endsWith("/activecampaign/tags") ||
          url.pathname.endsWith("/tags")) &&
        request.method === "GET"
      ) {
        if (!existing.activeCampaignApiUrl || !existing.activeCampaignApiKey) {
          return json(
            { ok: false, error: "ActiveCampaign is not configured for this brand." },
            400,
          );
        }
        try {
          const ttlMs = 2 * 60 * 1000;
          const cached = await kvGetJSON<{ fetchedAt: number; tags: Array<{ id: string; tag: string }> }>(
            env.SMS_KV,
            key.brandTagsCache(brandId),
          );
          if (cached && Date.now() - cached.fetchedAt < ttlMs) {
            const tagsWithCounts = await Promise.all(
              cached.tags.map(async (t) => {
                const row = await readTagSubscriberCount(env, brandId, t.tag);
                return {
                  ...t,
                  totalSubscribers: row?.totalSubscribers ?? (t as { totalSubscribers?: number }).totalSubscribers ?? 0,
                  cacheStatus: row?.status ?? (t as { cacheStatus?: string }).cacheStatus ?? "stale",
                };
              }),
            );
            return json({ ok: true, tags: tagsWithCounts, cached: true });
          }
          const tags = await fetchActiveCampaignTags(existing);
          const tagsWithCounts = await Promise.all(
            tags.map(async (t) => {
              const cached = await readTagSubscriberCount(env, brandId, t.tag);
              return {
                ...t,
                totalSubscribers: cached?.totalSubscribers ?? 0,
                cacheStatus: cached?.status ?? "stale",
              };
            }),
          );
          await kvPutJSON(env.SMS_KV, key.brandTagsCache(brandId), {
            fetchedAt: Date.now(),
            tags: tagsWithCounts,
          });
          return json({ ok: true, tags: tagsWithCounts, cached: false });
        } catch (e) {
          const reason = e instanceof Error ? e.message : "Unknown error";
          return json(
            { ok: false, error: `Failed to fetch tags from ActiveCampaign: ${reason}` },
            502,
          );
        }
      }

      if (url.pathname.endsWith("/subscribers/warmup") && request.method === "POST") {
        if (!existing.activeCampaignApiUrl || !existing.activeCampaignApiKey) {
          return json(
            { ok: false, error: "ActiveCampaign is not configured for this brand." },
            400,
          );
        }
        ctx.waitUntil(
          warmBrandTagSubscriberCaches(env, existing, {
            maxTags: 5,
            maxPages: 1,
            resetCursor: false,
          }).catch(() => undefined),
        );
        return json({ ok: true, warming: true });
      }

      if (url.pathname.endsWith("/subscribers") && request.method === "GET") {
        const tagName = url.searchParams.get("tag")?.trim() ?? "";
        if (!tagName) {
          return json({ ok: false, error: "tag query parameter is required." }, 400);
        }
        if (!existing.activeCampaignApiUrl || !existing.activeCampaignApiKey) {
          return json(
            { ok: false, error: "ActiveCampaign is not configured for this brand." },
            400,
          );
        }
        const shouldRefresh = url.searchParams.get("refresh") === "1";
        const maxPages = Math.max(
          1,
          Math.min(parseInt(url.searchParams.get("maxPages") || "2", 10), 20),
        );
        const { cacheKey, cursorKey } = brandSubscriberKeys(existing, tagName);
        let cache = await kvGetJSON<BrandSubscriberCache>(env.SMS_KV, cacheKey);
        let cursorKeyResolved = cursorKey;
        if (!cache) {
          const dashboardTag = (existing.dashboardTag || "").trim();
          if (dashboardTag && tagsMatch(tagName, dashboardTag)) {
            const dashKeys = brandSubscriberKeys(existing);
            cache = await kvGetJSON<BrandSubscriberCache>(env.SMS_KV, dashKeys.cacheKey);
            cursorKeyResolved = dashKeys.cursorKey;
          }
        }
        const hadCache = Boolean(cache);
        if (shouldRefresh) {
          cache = await refreshBrandSubscriberCache(env, existing, maxPages, tagName);
          cursorKeyResolved = brandSubscriberKeys(existing, tagName).cursorKey;
        } else if (!cache) {
          cache = {
            brandId: existing.id,
            brandName: existing.name,
            allContacts: 0,
            totalSubscribers: 0,
            activeSmsSubscribers: 0,
            unsubscribedTotal: 0,
            fetchOk: false,
            fetchError: "No tag audience cache yet. Wait for cron or run Recount on the dashboard.",
            status: "stale",
            updatedAt: now(),
            dashboardTag: tagName,
            audienceScope: "tag",
          };
        }
        const cursor = await kvGetJSON<BrandSubscriberCursor>(env.SMS_KV, cursorKeyResolved);
        return json({
          ok: true,
          subscribers: {
            ...cache,
            tag: tagName,
            walkedOffset: cursor?.offset ?? 0,
            walkedTotal: cursor?.totalContacts ?? cache.allContacts ?? 0,
            walkDone: cursor?.done ?? false,
          },
          cached: hadCache && !shouldRefresh,
        });
      }

      if (url.pathname.endsWith("/twilio-pricing") && request.method === "GET") {
        if (!existing.twilioAccountSid || !existing.twilioAuthToken) {
          return json({ ok: false, error: "Twilio credentials not configured for this brand." }, 400);
        }
        const country = (url.searchParams.get("country") || "US").toUpperCase().slice(0, 4);
        try {
          const pricingRes = await fetch(
            `https://pricing.twilio.com/v1/Messaging/Countries/${encodeURIComponent(country)}`,
            {
              headers: {
                Authorization: `Basic ${btoa(`${existing.twilioAccountSid}:${existing.twilioAuthToken}`)}`,
              },
            },
          );
          if (!pricingRes.ok) {
            const txt = await pricingRes.text().catch(() => "");
            return json(
              { ok: false, error: `Twilio Pricing API returned ${pricingRes.status}${txt ? `: ${txt.slice(0, 200)}` : ""}` },
              502,
            );
          }
          const data = (await pricingRes.json()) as {
            price_unit?: string;
            outbound_sms_prices?: Array<{
              carrier?: string;
              prices?: Array<{ number_type?: string; current_price?: string; base_price?: string }>;
            }>;
          };
          const prices: number[] = [];
          for (const carrier of data.outbound_sms_prices ?? []) {
            for (const p of carrier.prices ?? []) {
              if (p.number_type === "local" || p.number_type === "mobile" || p.number_type === "shortcode") {
                const val = parseFloat(p.current_price ?? p.base_price ?? "");
                if (Number.isFinite(val) && val > 0) prices.push(val);
              }
            }
          }
          const avgPrice =
            prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
          const minPrice = prices.length > 0 ? Math.min(...prices) : null;
          const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
          return json({
            ok: true,
            country,
            priceUnit: data.price_unit ?? "USD",
            averagePrice: avgPrice,
            minPrice,
            maxPrice,
            carrierCount: prices.length,
          });
        } catch (e) {
          return json(
            { ok: false, error: e instanceof Error ? e.message : "Pricing fetch failed" },
            502,
          );
        }
      }

      if (request.method === "PUT") {
        const patch = (await request.json()) as Partial<Brand>;
        const acUrlChanged =
          patch.activeCampaignApiUrl !== undefined &&
          patch.activeCampaignApiUrl !== existing.activeCampaignApiUrl;
        const acKeyChanged =
          patch.activeCampaignApiKey !== undefined &&
          patch.activeCampaignApiKey !== existing.activeCampaignApiKey;
        const prevTag = (existing.dashboardTag || "").trim();
        const nextTag =
          patch.dashboardTag !== undefined
            ? String(patch.dashboardTag || "").trim()
            : prevTag;
        const tagChanged = patch.dashboardTag !== undefined && nextTag !== prevTag;

        const updated: Brand = { ...existing, ...patch, id: brandId, updatedAt: now() };
        await kvPutJSON(env.SMS_KV, key.brand(brandId), updated);

        if (acUrlChanged || acKeyChanged) {
          await env.SMS_KV.delete(key.brandTagsCache(brandId));
          await env.SMS_KV.delete(key.brandTagRefreshCursor(brandId));
          ctx.waitUntil(
            warmBrandTagSubscriberCaches(env, updated, { maxTags: 8, maxPages: 1 }).catch(
              () => undefined,
            ),
          );
        }
        if (tagChanged) {
          if (prevTag) await invalidateBrandTagSubscriberCache(env, brandId, prevTag);
          if (nextTag) await invalidateBrandTagSubscriberCache(env, brandId, nextTag);
        }
        if (tagChanged || acUrlChanged || acKeyChanged) {
          void refreshBrandSubscriberCache(env, updated, 3).catch(() => undefined);
        }

        return json({ ok: true, brand: updated });
      }

      if (request.method === "DELETE") {
        await env.SMS_KV.delete(key.brand(brandId));
        const list = (await kvGetJSON<string[]>(env.SMS_KV, key.brands)) ?? [];
        await kvPutJSON(
          env.SMS_KV,
          key.brands,
          list.filter((x) => x !== brandId),
        );
        return json({ ok: true });
      }
    }

    // Campaigns list with filters
    if (url.pathname === "/campaigns" && request.method === "GET") {
      await releaseDueScheduledCampaigns(env, 10);
      const brand = url.searchParams.get("brand");
      const status = url.searchParams.get("status");
      const important = url.searchParams.get("important");
      let campaigns = await listCampaigns(env);
      if (brand) campaigns = campaigns.filter((c) => c.brandId === brand);
      if (status) campaigns = campaigns.filter((c) => c.status === status);
      if (important === "true") campaigns = campaigns.filter((c) => c.important);
      return json({ ok: true, campaigns });
    }

    // Campaign create
    if (url.pathname === "/campaigns" && request.method === "POST") {
      const body = (await request.json()) as {
        id?: string;
        brandId?: string;
        tag?: string;
        message?: string;
        scheduledAtUtc?: string;
        scheduleTimezone?: string;
        scheduleAtLocal?: string;
      };
      const tag =
        typeof body.tag === "string" ? body.tag.trim() : "";
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!tag) {
        return json({ ok: false, error: "Tag is required (ActiveCampaign tag name)." }, 400);
      }
      if (!message) {
        return json({ ok: false, error: "Message is required." }, 400);
      }
      const id = body.id || randomId("blast");
      const brandId = body.brandId || env.DEFAULT_BRAND_ID || "brand-default";
      const scheduleAtUtc =
        typeof body.scheduledAtUtc === "string" ? body.scheduledAtUtc.trim() : "";
      const scheduleTimezone =
        typeof body.scheduleTimezone === "string" ? body.scheduleTimezone.trim() : "";
      const scheduleAtLocal =
        typeof body.scheduleAtLocal === "string" ? body.scheduleAtLocal.trim() : "";
      const isScheduled = Boolean(scheduleAtUtc);
      if (isScheduled) {
        const ms = Date.parse(scheduleAtUtc);
        if (!Number.isFinite(ms)) {
          return json({ ok: false, error: "Invalid scheduledAtUtc." }, 400);
        }
        if (ms <= Date.now() + 5000) {
          return json({ ok: false, error: "Scheduled time must be in the future." }, 400);
        }
      }
      const brand = await kvGetJSON<Brand>(env.SMS_KV, key.brand(brandId));
      if (!brand) {
        return json({ ok: false, error: "Brand not found. Add brand first." }, 400);
      }

      const audienceSource =
        brand.activeCampaignApiUrl && brand.activeCampaignApiKey ? "activecampaign" : "mock";
      const item: Campaign = {
        id,
        name: `${brand.name} — ${tag}`,
        messagePreview: preview(message),
        brandId,
        tag,
        message,
        total: 0,
        sent: 0,
        failed: 0,
        status: isScheduled ? "Scheduled" : "Preparing",
        important: false,
        createdAt: now(),
        queueProgress: 0,
        scheduledAtUtc: isScheduled ? scheduleAtUtc : undefined,
        scheduleTimezone: isScheduled ? scheduleTimezone : undefined,
        scheduleAtLocal: isScheduled ? scheduleAtLocal : undefined,
      };
      await Promise.all([
        kvPutJSON(env.SMS_KV, key.campaign(id), item),
        kvPutJSON(env.SMS_KV, key.campaignPhones(id), [] as PhoneResult[]),
        kvPutJSON(env.SMS_KV, key.campaignMeta(id), defaultMeta()),
        appendUnique(env.SMS_KV, key.campaigns, id),
      ]);
      await startCampaignAudienceBuild(env, id, brandId, tag);
      return json(
        { ok: true, campaign: item, audienceSource, audienceBuilding: true },
        201,
      );
    }

    if (url.pathname.startsWith("/campaigns/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      const campaignId = segments[1];
      if (!campaignId) return json({ ok: false, error: "Missing campaign id" }, 400);

      if (segments.length === 2 && request.method === "GET") {
        await releaseDueScheduledCampaigns(env, 10);
        await flushCampaignPhonePatches(env, campaignId);
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base || base.deletedAt) return json({ ok: false, error: "Campaign not found" }, 404);
        const phones = (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId))) ?? [];
        const healed = await reconcileCampaignAggregates(env, base, phones);
        const counters = await getCampaignMeta(env, campaignId);
        const detail = {
          ...healed,
          phones,
          counters,
          batches: [],
        } as CampaignDetail & { counters: CampaignMeta; batches: [] };
        return json({ ok: true, campaign: detail });
      }

      if (segments[2] === "progress" && request.method === "GET") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base || base.deletedAt) return json({ ok: false, error: "Campaign not found" }, 404);
        const total = base.total > 0 ? base.total : 0;
        const processed = base.sent + base.failed;
        const pending = total > 0 ? Math.max(0, total - processed) : 0;
        const queueProgress =
          base.queueProgress > 0
            ? base.queueProgress
            : total > 0
              ? Math.min(100, Math.round((processed / total) * 100))
              : 0;
        return json({
          ok: true,
          progress: {
            id: base.id,
            status: base.status,
            total,
            sent: base.sent,
            failed: base.failed,
            pending,
            queueProgress,
          },
        });
      }

      if (segments[2] === "important" && request.method === "PATCH") {
        const payload = (await request.json()) as { important: boolean };
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base) return json({ ok: false, error: "Campaign not found" }, 404);
        const updated = { ...base, important: Boolean(payload.important) };
        await kvPutJSON(env.SMS_KV, key.campaign(campaignId), updated);
        return json({ ok: true, campaign: updated });
      }

      if (segments[2] === "reconcile" && request.method === "POST") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base || base.deletedAt) {
          return json({ ok: false, error: "Campaign not found" }, 404);
        }
        const result = await reconcilePendingWithoutResend(env, campaignId);
        return json({ ok: true, ...result });
      }

      if (segments[2] === "resume" && request.method === "POST") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId));
        if (!base || base.deletedAt || !phones) {
          return json({ ok: false, error: "Campaign not found" }, 404);
        }
        if (base.status === "Preparing") {
          return json(
            { ok: false, error: "Audience still building. Wait until status is Running." },
            409,
          );
        }
        if (base.status === "Scheduled") {
          return json(
            { ok: false, error: "Campaign is scheduled. It will start automatically at send time." },
            409,
          );
        }
        if (base.status === "Completed") {
          const pendingCount = phones.filter((p) => p.status === "Pending").length;
          if (pendingCount === 0) {
            return json({ ok: false, error: "Campaign already completed." }, 409);
          }
        }
        const { healed, stillPending } = await reconcilePendingWithoutResend(env, campaignId);
        if (stillPending === 0) {
          return json({
            ok: true,
            queued: 0,
            pending: 0,
            healed,
            message:
              healed > 0
                ? `Healed ${healed} row(s) from prior sends (no duplicate SMS).`
                : "No pending phones to resume.",
          });
        }
        if (base.status !== "Running") {
          await kvPutJSON(env.SMS_KV, key.campaign(campaignId), { ...base, status: "Running" });
        }
        await env.CAMPAIGN_QUEUE.send({
          kind: "resume_sends",
          campaignId,
          cursor: 0,
        });
        return json({
          ok: true,
          pending: stillPending,
          queued: stillPending,
          healed,
          resuming: true,
          message:
            healed > 0
              ? `Healed ${healed} without resending. Queuing ${stillPending} remaining.`
              : `Queuing ${stillPending} pending message(s) (no duplicate sends).`,
        });
      }

      if (segments[2] === "retry-failed" && request.method === "POST") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId));
        if (!base || base.deletedAt || !phones) return json({ ok: false, error: "Campaign not found" }, 404);
        const retriable = phones.filter((p) => p.status === "Failed");
        for (const phone of retriable) {
          phone.status = "Pending";
          phone.error = undefined;
          phone.failureDetail = undefined;
          phone.failureSource = undefined;
          phone.failedAt = undefined;
          phone.twilioSid = undefined;
          await env.SMS_KV.delete(key.campaignPhoneDelivery(campaignId, phone.id));
          const norm = normalizePhone(phone.phone);
          if (norm) await env.SMS_KV.delete(key.campaignSentPhone(campaignId, norm));
          await enqueueSendMessage(env, {
            campaignId,
            phoneId: phone.id,
            phone: phone.phone,
            body: base.message,
          });
        }
        await kvPutJSON(env.SMS_KV, key.campaignPhones(campaignId), phones);
        return json({ ok: true, queued: retriable.length });
      }

      if (
        segments[2] === "phones" &&
        segments[4] === "retry" &&
        request.method === "POST"
      ) {
        const phoneId = segments[3];
        if (!phoneId) return json({ ok: false, error: "Missing phone id" }, 400);
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId));
        if (!base || base.deletedAt || !phones) return json({ ok: false, error: "Campaign not found" }, 404);
        const idx = phones.findIndex((p) => p.id === phoneId);
        if (idx === -1) return json({ ok: false, error: "Phone not found" }, 404);
        if (phones[idx].status !== "Failed") {
          return json({ ok: false, error: "Only failed phones can be retried" }, 400);
        }
        phones[idx] = {
          ...phones[idx],
          status: "Pending",
          error: undefined,
          failureDetail: undefined,
          failureSource: undefined,
          failedAt: undefined,
          twilioSid: undefined,
        };
        await env.SMS_KV.delete(key.campaignPhoneDelivery(campaignId, phoneId));
        const norm = normalizePhone(phones[idx].phone);
        if (norm) await env.SMS_KV.delete(key.campaignSentPhone(campaignId, norm));
        await enqueueSendMessage(env, {
          campaignId,
          phoneId: phones[idx].id,
          phone: phones[idx].phone,
          body: base.message,
        });
        await kvPutJSON(env.SMS_KV, key.campaignPhones(campaignId), phones);
        return json({ ok: true, queued: 1 });
      }

      if (segments.length === 2 && request.method === "DELETE") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base) return json({ ok: false, error: "Campaign not found" }, 404);
        const updated: Campaign = { ...base, deletedAt: now() };
        await kvPutJSON(env.SMS_KV, key.campaign(campaignId), updated);
        return json({ ok: true, campaign: updated });
      }
    }

    // Analytics
    if (url.pathname === "/analytics/sent-failed" && request.method === "GET") {
      const out: Array<{ label: string; sent: number; failed: number }> = [];
      for (let i = 6; i >= 0; i -= 1) {
        const dt = new Date(Date.now() - i * 86400000);
        const day = dt.toISOString().slice(0, 10);
        const item = (await kvGetJSON<{ sent: number; failed: number }>(env.SMS_KV, key.daily(day))) ?? {
          sent: 0,
          failed: 0,
        };
        out.push({ label: day.slice(5), sent: item.sent, failed: item.failed });
      }
      return json({ ok: true, sentVsFailed: out });
    }

    if (url.pathname === "/analytics/subscribers-summary" && request.method === "GET") {
      const brandIds = (await kvGetJSON<string[]>(env.SMS_KV, key.brands)) ?? [];
      const brandRows = await Promise.all(
        brandIds.map((id) => kvGetJSON<Brand>(env.SMS_KV, key.brand(id))),
      );
      const configuredBrands = brandRows.filter(
        (b): b is Brand =>
          Boolean(
            b &&
              b.activeCampaignApiUrl &&
              b.activeCampaignApiKey,
          ),
      );
      const byBrand = (
        await Promise.all(
          configuredBrands.map(async (b) => {
            const { cacheKey } = brandSubscriberKeys(b);
            const cached = await kvGetJSON<BrandSubscriberCache>(env.SMS_KV, cacheKey);
            if (cached) return cached;
            const dashboardTag = (b.dashboardTag || "").trim();
            return {
              brandId: b.id,
              brandName: b.name,
              allContacts: 0,
              totalSubscribers: 0,
              activeSmsSubscribers: 0,
              unsubscribedTotal: 0,
              todayActive: 0,
              yesterdayActive: 0,
              growth: 0,
              fetchOk: false,
              fetchError: dashboardTag
                ? "No tag audience cache yet. Configure tag or run Recount."
                : "No cache yet. Run refresh endpoint or wait for cron.",
              status: "stale",
              updatedAt: now(),
              dashboardTag: dashboardTag || undefined,
              audienceScope: dashboardTag ? "tag" : "account",
            } as BrandSubscriberCache & {
              todayActive: number;
              yesterdayActive: number;
              growth: number;
            };
          }),
        )
      ).sort((a, b) => b.totalSubscribers - a.totalSubscribers);
      const totalContacts = byBrand.reduce((sum, x) => sum + x.allContacts, 0);
      const totalSubscribers = byBrand.reduce((sum, x) => sum + x.totalSubscribers, 0);
      const activeSmsSubscribers = byBrand.reduce((sum, x) => sum + x.activeSmsSubscribers, 0);
      const unsubscribedTotal = byBrand.reduce((sum, x) => sum + x.unsubscribedTotal, 0);

      const today = new Date();
      const y = new Date(today.getTime() - 86400000);
      const todayKey = today.toISOString().slice(0, 10);
      const yesterdayKey = y.toISOString().slice(0, 10);
      const todayStat =
        (await kvGetJSON<{ delivered: number; unsubs: number }>(
          env.SMS_KV,
          key.subsDaily(todayKey),
        )) ?? { delivered: 0, unsubs: 0 };
      const yesterdayStat =
        (await kvGetJSON<{ delivered: number; unsubs: number }>(
          env.SMS_KV,
          key.subsDaily(yesterdayKey),
        )) ?? { delivered: 0, unsubs: 0 };
      const todayActive = Math.max(0, todayStat.delivered - todayStat.unsubs);
      const yesterdayActive = Math.max(0, yesterdayStat.delivered - yesterdayStat.unsubs);
      const growth = todayActive - yesterdayActive;
      const byBrandWithGrowth = await Promise.all(
        byBrand.map(async (b) => {
          const todayBrand =
            (await kvGetJSON<{ delivered: number; unsubs: number }>(
              env.SMS_KV,
              key.subsDailyByBrand(todayKey, b.brandId),
            )) ?? { delivered: 0, unsubs: 0 };
          const yesterdayBrand =
            (await kvGetJSON<{ delivered: number; unsubs: number }>(
              env.SMS_KV,
              key.subsDailyByBrand(yesterdayKey, b.brandId),
            )) ?? { delivered: 0, unsubs: 0 };
          const todayBrandActive = Math.max(0, todayBrand.delivered - todayBrand.unsubs);
          const yesterdayBrandActive = Math.max(0, yesterdayBrand.delivered - yesterdayBrand.unsubs);
          const brandRow = configuredBrands.find((x) => x.id === b.brandId);
          const { cursorKey } = brandRow
            ? brandSubscriberKeys(brandRow)
            : { cursorKey: key.brandSubsCursor(b.brandId) };
          const cursor = await kvGetJSON<BrandSubscriberCursor>(env.SMS_KV, cursorKey);
          return {
            ...b,
            todayActive: todayBrandActive,
            yesterdayActive: yesterdayBrandActive,
            growth: todayBrandActive - yesterdayBrandActive,
            walkedOffset: cursor?.offset ?? 0,
            walkedTotal: cursor?.totalContacts ?? b.allContacts,
            walkDone: cursor?.done ?? false,
          };
        }),
      );

      return json({
        ok: true,
        summary: {
          totalSubscribers,
          totalContacts,
          activeSmsSubscribers,
          unsubscribedTotal,
          growth,
          todayActive,
          yesterdayActive,
          byBrand: byBrandWithGrowth,
        },
      });
    }

    if (url.pathname === "/analytics/subscribers-summary/refresh" && request.method === "POST") {
      const brandId = url.searchParams.get("brandId");
      const maxPages = Math.max(
        1,
        Math.min(parseInt(url.searchParams.get("maxPages") || "2", 10), 20),
      );
      const brandIds = (await kvGetJSON<string[]>(env.SMS_KV, key.brands)) ?? [];
      const brandRows = await Promise.all(
        brandIds.map((id) => kvGetJSON<Brand>(env.SMS_KV, key.brand(id))),
      );
      let targets = brandRows.filter(
        (b): b is Brand => Boolean(b && b.activeCampaignApiUrl && b.activeCampaignApiKey),
      );
      if (brandId && brandId !== "all") {
        targets = targets.filter((b) => b.id === brandId);
      }
      const refreshed = await Promise.all(
        targets.map((b) => refreshBrandSubscriberCache(env, b, maxPages)),
      );
      return json({ ok: true, refreshedCount: refreshed.length, brands: refreshed });
    }

    // Compatibility routes for current frontend + existing links
    if (url.pathname === "/blast" && request.method === "GET") {
      const blastId = url.searchParams.get("blast_id") || randomId("blast");
      const tag = url.searchParams.get("tag") || "SMS_BLAST";
      const message = url.searchParams.get("msg") || "SMS blast message";
      const brandId = env.DEFAULT_BRAND_ID || "brand-default";
      const fakeReq = new Request(`${url.origin}/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: blastId, brandId, tag, message }),
      });
      const created = await this.fetch(fakeReq, env);
      const body = (await created.json()) as { campaign?: Campaign; ok?: boolean };
      if (!body.ok || !body.campaign) return json({ ok: false, error: "blast creation failed" }, 500);
      return json({
        ok: true,
        blast_id: body.campaign.id,
        attempted: body.campaign.total,
        sent: body.campaign.sent,
        failed: body.campaign.failed,
      });
    }

    if (url.pathname === "/metrics/all" && request.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "25", 10), 200);
      const campaigns = (await listCampaigns(env)).slice(0, limit);
      const blasts = await Promise.all(
        campaigns.map(async (c) => {
          const phones =
            (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(c.id))) ?? [];
          const healed = await reconcileCampaignAggregates(env, c, phones);
          const counters = await getCampaignMeta(env, c.id);
          return { ...healed, counters };
        }),
      );
      return json({ ok: true, blasts });
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(id));
      if (!campaign || campaign.deletedAt) return json({ ok: false, error: "Not found" }, 404);
      const phones =
        (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(id))) ?? [];
      const healed = await reconcileCampaignAggregates(env, campaign, phones);
      const counters = await getCampaignMeta(env, id);
      return json({ ok: true, blast: { ...healed, counters } });
    }

    return json({ ok: false, error: "Route not found" }, 404);
  },

  async queue(batch: MessageBatch<CampaignQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        if (body.kind === "build_audience") {
          await processAudienceBuildChunk(env, body);
        } else if (body.kind === "resume_sends") {
          await processResumeSendsBatch(env, body);
        } else if (isSendQueueMessage(body)) {
          await processSingleMessage(env, body);
        }
        message.ack();
      } catch {
        message.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Two crons can trigger this handler:
    // - "* * * * *"      -> release due scheduled campaigns every minute
    // - "*/15 * * * *"   -> refresh heavier subscriber cache
    const cronExpr = controller.cron;
    const runCacheRefresh = cronExpr === "*/15 * * * *" || !cronExpr;
    if (runCacheRefresh) {
      const brandIds = (await kvGetJSON<string[]>(env.SMS_KV, key.brands)) ?? [];
      const brandRows = await Promise.all(
        brandIds.map((id) => kvGetJSON<Brand>(env.SMS_KV, key.brand(id))),
      );
      const targets = brandRows.filter(
        (b): b is Brand => Boolean(b && b.activeCampaignApiUrl && b.activeCampaignApiKey),
      );
      for (const brand of targets) {
        // Dashboard tag (or account) — 2 pages; separate from SMS queue consumer.
        await refreshBrandSubscriberCache(env, brand, 2);
        // One extra tag per brand per 15 min (1 page) — keeps AC load low vs campaign sends.
        await refreshNextBrandTagInCron(env, brand, 1);
      }
    }
    await releaseDueScheduledCampaigns(env, 100);
    await flushBufferedDailyStats(env);
    const campaigns = await listCampaigns(env);
    for (const c of campaigns) {
      if (c.status !== "Running" && c.status !== "Paused") continue;
      const dirty = await kvGetJSON<string[]>(env.SMS_KV, key.campaignPhoneDirty(c.id));
      if (dirty?.length) await flushCampaignPhonePatches(env, c.id);
    }
    await maybeResumeStuckRunningCampaigns(env);
    await maybeRestartStuckPreparingCampaigns(env);
  },
};
