type CampaignStatus = "Running" | "Completed" | "Paused";
type PhoneStatus = "Pending" | "Success" | "Failed";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Queue<T> {
  send(message: T): Promise<void>;
}

interface MessageBatch<T> {
  messages: Array<{
    body: T;
    ack(): void;
    retry(): void;
  }>;
}

type Env = {
  SMS_KV: KVNamespace;
  CAMPAIGN_QUEUE: Queue<CampaignQueueMessage>;
  BLAST_SECRET?: string;
  TWILIO_STATUS_TOKEN?: string;
  SEND_MODE?: "mock" | "real";
  DEFAULT_BRAND_ID?: string;
  DEFAULT_CONTACT_COUNT?: string;
  WORKER_BASE_URL?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  MISSIVE_API_TOKEN?: string;
  MISSIVE_SHADOWLOG_NAME?: string;
  OWNER_PHONE?: string;
  DEFAULT_ADMIN_EMAIL?: string;
  DEFAULT_ADMIN_PASSWORD?: string;
};

type Brand = {
  id: string;
  name: string;
  twilioAccountSid: string;
  twilioApiKey: string;
  twilioAuthToken: string;
  messagingServiceSid: string;
  activeCampaignApiUrl: string;
  activeCampaignApiKey: string;
  createdAt: string;
  updatedAt: string;
};

type PhoneResult = {
  id: string;
  phone: string;
  status: PhoneStatus;
  error?: string;
  twilioSid?: string;
};

type Campaign = {
  id: string;
  name: string;
  messagePreview: string;
  brandId: string;
  tag: string;
  message: string;
  total: number;
  sent: number;
  failed: number;
  status: CampaignStatus;
  important: boolean;
  createdAt: string;
  queueProgress: number;
  deletedAt?: string;
};

type CampaignDetail = Campaign & {
  phones: PhoneResult[];
};

type CampaignMeta = {
  clicks: number;
  replies: number;
  unsubs: number;
  delivered: number;
  deliveryFailed: number;
};

type AuthUser = {
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type AuthSession = {
  email: string;
  expiresAt: number;
};

type PasswordReset = {
  code: string;
  expiresAt: number;
  requestedAt: string;
};

type CampaignQueueMessage = {
  campaignId: string;
  phoneId: string;
  phone: string;
  body: string;
};

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

const key = {
  brands: "brands:index",
  campaigns: "campaigns:index",
  brand: (id: string) => `brand:${id}`,
  campaign: (id: string) => `campaign:${id}`,
  campaignPhones: (id: string) => `campaign:${id}:phones`,
  campaignMeta: (id: string) => `campaign:${id}:meta`,
  sidToPhone: (sid: string) => `sid:${sid}`,
  lastSentTo: (phone: string) => `lastsent:${phone}`,
  daily: (yyyyMmDd: string) => `analytics:daily:${yyyyMmDd}`,
  authUser: (email: string) => `auth:user:${email.toLowerCase()}`,
  authSession: (token: string) => `auth:session:${token}`,
  authReset: (email: string) => `auth:reset:${email.toLowerCase()}`,
} as const;

const defaultMeta = (): CampaignMeta => ({
  clicks: 0,
  replies: 0,
  unsubs: 0,
  delivered: 0,
  deliveryFailed: 0,
});

async function kvGetJSON<T>(kv: KVNamespace, k: string): Promise<T | null> {
  const raw = await kv.get(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function kvPutJSON(kv: KVNamespace, k: string, value: unknown) {
  await kv.put(k, JSON.stringify(value));
}

async function appendUnique(kv: KVNamespace, indexKey: string, id: string) {
  const list = (await kvGetJSON<string[]>(kv, indexKey)) ?? [];
  if (!list.includes(id)) {
    list.unshift(id);
    await kvPutJSON(kv, indexKey, list.slice(0, 1000));
  }
}

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

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith("+")) {
    const rest = value.slice(1).replace(/\D/g, "");
    if (rest.length >= 8 && rest.length <= 15) return `+${rest}`;
    return null;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function phoneFromActiveCampaignContact(contact: Record<string, unknown>): string | null {
  const direct = normalizePhone(
    (typeof contact.phone === "string" && contact.phone) ||
      (typeof contact.mobile === "string" && contact.mobile) ||
      null,
  );
  if (direct) return direct;
  const fieldValues = contact.fieldValues as
    | Array<{ value?: string | number | null }>
    | undefined;
  if (!Array.isArray(fieldValues)) return null;
  for (const fv of fieldValues) {
    const raw =
      typeof fv.value === "string"
        ? fv.value.trim()
        : typeof fv.value === "number"
          ? String(fv.value)
          : "";
    if (!raw) continue;
    const n = normalizePhone(raw);
    if (n) return n;
  }
  return null;
}

async function acFetchJson(
  brand: Brand,
  path: string,
): Promise<Record<string, unknown>> {
  const base = brand.activeCampaignApiUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    headers: {
      "Api-Token": brand.activeCampaignApiKey,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`ActiveCampaign ${res.status}`);
  }
  return payload;
}

async function fetchPhonesFromActiveCampaign(
  brand: Brand,
  tagName: string,
  maxCount: number,
): Promise<string[]> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) return [];
  if (!tagName) return [];

  const tagResp = await acFetchJson(
    brand,
    `/api/3/tags?search=${encodeURIComponent(tagName)}`,
  );
  const tags = (tagResp.tags as Array<{ id?: string; tag?: string }> | undefined) ?? [];
  const exact = tags.find(
    (t) => (t.tag || "").trim().toLowerCase() === tagName.trim().toLowerCase(),
  );
  const tag = exact ?? (tags.length === 1 ? tags[0] : undefined);
  if (!tag?.id) return [];

  const result: string[] = [];
  let offset = 0;
  const pageSize = 100;
  while (result.length < maxCount) {
    const contactsResp = await acFetchJson(
      brand,
      `/api/3/contacts?tagid=${encodeURIComponent(tag.id)}&limit=${pageSize}&offset=${offset}`,
    );
    const contacts =
      (contactsResp.contacts as Array<Record<string, unknown>> | undefined) ?? [];
    if (contacts.length === 0) break;

    for (const contact of contacts) {
      const phone = phoneFromActiveCampaignContact(contact);
      if (phone && !result.includes(phone)) {
        result.push(phone);
      }
      if (result.length >= maxCount) break;
    }

    if (contacts.length < pageSize) break;
    offset += pageSize;
  }

  return result;
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

async function twilioSend(env: Env, to: string, body: string, statusCallbackUrl?: string) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const mg = env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || !mg) {
    throw new Error("Twilio credentials are not configured");
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
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${txt.slice(0, 200)}`);
  try {
    return JSON.parse(txt) as { sid?: string };
  } catch {
    return { sid: undefined };
  }
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

  if (env.SEND_MODE === "real") {
    try {
      const statusCallbackUrl =
        env.WORKER_BASE_URL && env.TWILIO_STATUS_TOKEN
          ? `${env.WORKER_BASE_URL.replace(/\/+$/, "")}/twilio/status?token=${encodeURIComponent(
              env.TWILIO_STATUS_TOKEN,
            )}`
          : undefined;
      const out = await twilioSend(env, msg.phone, msg.body, statusCallbackUrl);
      twilioSid = out.sid;
    } catch (e) {
      status = "Failed";
      error = e instanceof Error ? e.message : String(e);
    }
  } else {
    const roll = Math.random();
    if (roll < 0.1) {
      status = "Failed";
      error = "Mock failure (simulated)";
    }
  }

  phones[idx] = { ...phones[idx], status, error, twilioSid };
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
            phones[idx] = { ...phones[idx], status: "Failed", error: `Twilio status: ${status}` };
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
        status: "Running",
        important: false,
        createdAt: now(),
        queueProgress: 0,
      };
      await Promise.all([
        kvPutJSON(env.SMS_KV, key.campaign(id), item),
        kvPutJSON(env.SMS_KV, key.campaignPhones(id), phones),
        kvPutJSON(env.SMS_KV, key.campaignMeta(id), defaultMeta()),
        appendUnique(env.SMS_KV, key.campaigns, id),
      ]);
      for (const p of phones) {
        await env.CAMPAIGN_QUEUE.send({
          campaignId: id,
          phoneId: p.id,
          phone: p.phone,
          body: item.message,
        });
      }
      return json({ ok: true, campaign: item, audienceSource }, 201);
    }

    if (url.pathname.startsWith("/campaigns/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      const campaignId = segments[1];
      if (!campaignId) return json({ ok: false, error: "Missing campaign id" }, 400);

      if (segments.length === 2 && request.method === "GET") {
        const base = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(campaignId));
        if (!base || base.deletedAt) return json({ ok: false, error: "Campaign not found" }, 404);
        const phones = (await kvGetJSON<PhoneResult[]>(env.SMS_KV, key.campaignPhones(campaignId))) ?? [];
        const counters = await getCampaignMeta(env, campaignId);
        const detail = {
          ...base,
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
        phones[idx] = { ...phones[idx], status: "Pending", error: undefined };
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
        campaigns.map(async (c) => ({
          ...c,
          counters: await getCampaignMeta(env, c.id),
        })),
      );
      return json({ ok: true, blasts });
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Missing id" }, 400);
      const campaign = await kvGetJSON<Campaign>(env.SMS_KV, key.campaign(id));
      if (!campaign || campaign.deletedAt) return json({ ok: false, error: "Not found" }, 404);
      const counters = await getCampaignMeta(env, id);
      return json({ ok: true, blast: { ...campaign, counters } });
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
};
