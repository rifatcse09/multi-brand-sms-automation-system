import {
  countSmsContactsPage,
  fetchActiveCampaignTags,
  fetchPhonesFromActiveCampaign,
  getActiveCampaignContactTotal,
  normalizePhone,
} from "./activecampaign";
import { appendUnique, defaultMeta, key, kvGetJSON, kvPutJSON } from "./kv";
import type {
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

// Refreshes one brand cache incrementally to avoid subrequest limits.
//
// Cursor strategy (so the dashboard doesn't reset to 0 every time AC's
// contact count drifts by even 1):
//   - SMALL drift (e.g. a few contacts created/deleted overnight) -> bump
//     the cursor's totalContacts and resume the walk from the previous
//     offset so we only count the new tail.
//   - LARGE drift (mass import/cleanup) -> full restart from offset 0,
//     but preserve the last fully-walked `smsContacts` as
//     `lastFreshSmsContacts` so the UI keeps showing yesterday's number
//     while the new walk catches up.
//   - Once a walk reaches `done: true`, atomically promote
//     cursor.smsContacts -> lastFreshSmsContacts (the displayed value).
async function refreshBrandSubscriberCache(
  env: Env,
  brand: Brand,
  maxPages = 2,
): Promise<BrandSubscriberCache> {
  const nowIso = now();
  const unsubscribedTotal = await getBrandUnsubscribedTotal(env, brand.id);
  try {
    const totalContacts = await getActiveCampaignContactTotal(brand);
    const prevCursor = await kvGetJSON<BrandSubscriberCursor>(
      env.SMS_KV,
      key.brandSubsCursor(brand.id),
    );

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
    const inheritedLastFreshAt = cursor.done
      ? nowIso
      : cursor.lastFreshAt;

    if (cursor.offset > totalContacts || drift > driftThreshold) {
      // Big change in AC -> restart, but keep the last verified count for display.
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
      // Small drift -> resume. If we were "done", reopen so the tail gets walked.
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
      const page = await countSmsContactsPage(brand, cursor.offset, pageSize);
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
      // Atomic promotion: this walk is verified end-to-end, so it becomes the
      // new "last fresh" anchor for future partial walks.
      cursor.lastFreshSmsContacts = cursor.smsContacts;
      cursor.lastFreshAt = nowIso;
    }
    cursor.totalContacts = totalContacts;
    cursor.updatedAt = nowIso;
    await kvPutJSON(env.SMS_KV, key.brandSubsCursor(brand.id), cursor);

    // What we DISPLAY: when fresh, show the just-completed count. When still
    // walking, show the last fully-verified count (if we have one) so the
    // dashboard doesn't visibly drop to a small partial number.
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
    };
    await kvPutJSON(env.SMS_KV, key.brandSubsCache(brand.id), cache);
    return cache;
  } catch (e) {
    const prev = await kvGetJSON<BrandSubscriberCache>(env.SMS_KV, key.brandSubsCache(brand.id));
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
    };
    await kvPutJSON(env.SMS_KV, key.brandSubsCache(brand.id), cache);
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

function calcStatus(sent: number, failed: number, total: number): CampaignStatus {
  if (sent + failed >= total) return "Completed";
  if (sent + failed === 0) return "Paused";
  return "Running";
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
  if (base.status === "Scheduled") return base;
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
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
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

async function processSingleMessage(env: Env, msg: CampaignQueueMessage) {
  const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(msg.campaignId));
  const phones = await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(msg.campaignId));
  if (!campaign || !phones) return;

  const idx = phones.findIndex((p) => p.id === msg.phoneId);
  if (idx === -1) return;
  if (phones[idx].status !== "Pending") return;

  let status: PhoneStatus = "Success";
  let error: string | undefined;
  let twilioSid: string | undefined;
  let failedAt: string | undefined;
  let failureSource: PhoneResult["failureSource"];
  let failureDetail: string | undefined;

  if (env.SEND_MODE === "real") {
    const statusCallbackUrl =
      env.WORKER_BASE_URL && env.TWILIO_STATUS_TOKEN
        ? `${env.WORKER_BASE_URL.replace(/\/+$/, "")}/twilio/status?token=${encodeURIComponent(
            env.TWILIO_STATUS_TOKEN,
          )}`
        : undefined;
    const out = await twilioSendWithDetails(env, msg.phone, msg.body, statusCallbackUrl);
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

  phones[idx] =
    status === "Success"
      ? {
          ...phones[idx],
          status,
          error: undefined,
          twilioSid,
          failedAt: undefined,
          failureSource: undefined,
          failureDetail: undefined,
        }
      : {
          ...phones[idx],
          status,
          error,
          twilioSid,
          failedAt,
          failureSource,
          failureDetail,
        };
  const sent = phones.filter((p) => p.status === "Success").length;
  const failed = phones.filter((p) => p.status === "Failed").length;
  const progress = campaign.total > 0 ? Math.round(((sent + failed) / campaign.total) * 100) : 0;

  const updated: Campaign = {
    ...campaign,
    sent,
    failed,
    queueProgress: Math.min(100, progress),
    status: calcStatus(sent, failed, campaign.total),
  };

  await Promise.all([
    kvPutJSON(env.SMS_KV, key.campaign(msg.campaignId), updated),
    kvPutJSON(env.SMS_KV, key.campaignPhones(msg.campaignId), phones),
    status === "Success" && twilioSid
      ? kvPutJSON(env.SMS_KV, key.sidToPhone(twilioSid), {
          campaignId: msg.campaignId,
          phoneId: msg.phoneId,
          phone: msg.phone,
        })
      : Promise.resolve(),
    status === "Success"
      ? kvPutJSON(env.SMS_KV, key.lastSentTo(msg.phone), {
          campaignId: msg.campaignId,
          phoneId: msg.phoneId,
          at: now(),
        })
      : Promise.resolve(),
    updateDaily(env, status === "Success" ? 1 : 0, status === "Failed" ? 1 : 0),
  ]);

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
  const pending = phones.filter((p) => p.status === "Pending");
  for (const p of pending) {
    await env.CAMPAIGN_QUEUE.send({
      campaignId: campaign.id,
      phoneId: p.id,
      phone: p.phone,
      body: campaign.message,
    });
  }
  return pending.length;
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
          campaigns: "/campaigns",
          campaignDetail: "/campaigns/:id",
          campaignRetryPhone: "POST /campaigns/:id/phones/:phoneId/retry",
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
                status: calcStatus(sent, failed, campaign.total),
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
            return json({ ok: true, tags: cached.tags, cached: true });
          }
          const tags = await fetchActiveCampaignTags(existing);
          await kvPutJSON(env.SMS_KV, key.brandTagsCache(brandId), {
            fetchedAt: Date.now(),
            tags,
          });
          return json({ ok: true, tags, cached: false });
        } catch (e) {
          const reason = e instanceof Error ? e.message : "Unknown error";
          return json(
            { ok: false, error: `Failed to fetch tags from ActiveCampaign: ${reason}` },
            502,
          );
        }
      }

      if (request.method === "PUT") {
        const patch = (await request.json()) as Partial<Brand>;
        const updated: Brand = { ...existing, ...patch, id: brandId, updatedAt: now() };
        await kvPutJSON(env.SMS_KV, key.brand(brandId), updated);
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
      const targetCount = Math.max(1, parseInt(env.DEFAULT_CONTACT_COUNT ?? "120", 10));
      const brand = await kvGetJSON<Brand>(env.SMS_KV, key.brand(brandId));
      if (!brand) {
        return json({ ok: false, error: "Brand not found. Add brand first." }, 400);
      }

      let phoneNumbers: string[] = [];
      let audienceSource: "activecampaign" | "mock" = "mock";
      if (brand.activeCampaignApiUrl && brand.activeCampaignApiKey) {
        try {
          phoneNumbers = await fetchPhonesFromActiveCampaign(
            brand,
            tag,
            targetCount,
          );
          if (phoneNumbers.length > 0) {
            audienceSource = "activecampaign";
          }
        } catch {
          /* fall through to mock audience */
        }
      }
      if (phoneNumbers.length === 0) {
        phoneNumbers = makeMockPhones(targetCount).map((p) => p.phone);
      }

      const phones: PhoneResult[] = phoneNumbers.map((phone, idx) => ({
        id: `p-${idx + 1}`,
        phone,
        status: "Pending",
      }));
      const total = phones.length;
      const item: Campaign = {
        id,
        name: `${brand.name} — ${tag}`,
        messagePreview: preview(message),
        brandId,
        tag,
        message,
        total,
        sent: 0,
        failed: 0,
        status: isScheduled ? "Scheduled" : "Running",
        important: false,
        createdAt: now(),
        queueProgress: 0,
        scheduledAtUtc: isScheduled ? scheduleAtUtc : undefined,
        scheduleTimezone: isScheduled ? scheduleTimezone : undefined,
        scheduleAtLocal: isScheduled ? scheduleAtLocal : undefined,
      };
      await Promise.all([
        kvPutJSON(env.SMS_KV, key.campaign(id), item),
        kvPutJSON(env.SMS_KV, key.campaignPhones(id), phones),
        kvPutJSON(env.SMS_KV, key.campaignMeta(id), defaultMeta()),
        appendUnique(env.SMS_KV, key.campaigns, id),
      ]);
      if (!isScheduled) {
        await enqueuePendingCampaignPhones(env, item);
      }
      return json({ ok: true, campaign: item, audienceSource }, 201);
    }

    if (url.pathname.startsWith("/campaigns/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      const campaignId = segments[1];
      if (!campaignId) return json({ ok: false, error: "Missing campaign id" }, 400);

      if (segments.length === 2 && request.method === "GET") {
        await releaseDueScheduledCampaigns(env, 10);
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

      if (segments[2] === "important" && request.method === "PATCH") {
        const payload = (await request.json()) as { important: boolean };
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base) return json({ ok: false, error: "Campaign not found" }, 404);
        const updated = { ...base, important: Boolean(payload.important) };
        await kvPutJSON(env.SMS_KV, key.campaign(campaignId), updated);
        return json({ ok: true, campaign: updated });
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
          await env.CAMPAIGN_QUEUE.send({
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
        await env.CAMPAIGN_QUEUE.send({
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
            const cached = await kvGetJSON<BrandSubscriberCache>(
              env.SMS_KV,
              key.brandSubsCache(b.id),
            );
            if (cached) return cached;
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
              fetchError: "No cache yet. Run refresh endpoint or wait for cron.",
              status: "stale",
              updatedAt: now(),
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
          const cursor = await kvGetJSON<BrandSubscriberCursor>(
            env.SMS_KV,
            key.brandSubsCursor(b.brandId),
          );
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
        await processSingleMessage(env, message.body);
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
        await refreshBrandSubscriberCache(env, brand, 2);
      }
    }
    await releaseDueScheduledCampaigns(env, 100);
  },
};
