import type { Brand } from "./types";

// ActiveCampaign domain module: URL normalization, paging, and phone extraction.
export function normalizePhone(raw: string | null): string | null {
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

function phoneFromActiveCampaignContact(
  contact: Record<string, unknown>,
  fieldValuesByContactId?: Map<string, string[]>,
): string | null {
  const direct = normalizePhone(
    (typeof contact.phone === "string" && contact.phone) ||
      (typeof contact.mobile === "string" && contact.mobile) ||
      null,
  );
  if (direct) return direct;
  const contactId = String(contact.id || "");
  const mapped = contactId ? fieldValuesByContactId?.get(contactId) ?? [] : [];
  for (const raw of mapped) {
    const n = normalizePhone(raw);
    if (n) return n;
  }
  const fieldValues = contact.fieldValues as
    | Array<{ value?: string | number | null }>
    | undefined;
  if (!Array.isArray(fieldValues)) return null;
  for (const fv of fieldValues) {
    if (!fv || typeof fv !== "object") continue;
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

function mapFieldValuesByContact(
  pageFieldValues: Array<{ contact?: string | number; value?: string | number | null }>,
): Map<string, string[]> {
  const byContact = new Map<string, string[]>();
  for (const fv of pageFieldValues) {
    const cid = String(fv.contact ?? "").trim();
    if (!cid) continue;
    const raw =
      typeof fv.value === "string"
        ? fv.value.trim()
        : typeof fv.value === "number"
          ? String(fv.value)
          : "";
    if (!raw) continue;
    const arr = byContact.get(cid) ?? [];
    arr.push(raw);
    byContact.set(cid, arr);
  }
  return byContact;
}

export async function acFetchJson(
  brand: Brand,
  path: string,
): Promise<Record<string, unknown>> {
  let base = brand.activeCampaignApiUrl.trim().replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api/3") && normalizedPath.startsWith("/api/3/")) {
    normalizedPath = normalizedPath.replace(/^\/api\/3/, "");
  }
  const res = await fetch(`${base}${normalizedPath}`, {
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

export async function resolveActiveCampaignTagId(
  brand: Brand,
  tagName: string,
): Promise<string | null> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) return null;
  if (!tagName.trim()) return null;

  const tagResp = await acFetchJson(
    brand,
    `/api/3/tags?search=${encodeURIComponent(tagName)}`,
  );
  const tags = (tagResp.tags as Array<{ id?: string; tag?: string }> | undefined) ?? [];
  const exact = tags.find(
    (t) => (t.tag || "").trim().toLowerCase() === tagName.trim().toLowerCase(),
  );
  const tag = exact ?? (tags.length === 1 ? tags[0] : undefined);
  return tag?.id ? String(tag.id) : null;
}

export async function getActiveCampaignTagContactTotal(
  brand: Brand,
  tagId: string,
): Promise<number> {
  const resp = await acFetchJson(
    brand,
    `/api/3/contacts?tagid=${encodeURIComponent(tagId)}&limit=1&offset=0`,
  );
  const meta = (resp.meta as Record<string, unknown> | undefined) ?? {};
  const totalRaw = String(meta.total ?? "0");
  const total = parseInt(totalRaw, 10);
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

export async function countSmsContactsPageByTag(
  brand: Brand,
  tagId: string,
  offset: number,
  pageSize: number,
): Promise<{ count: number; rows: number }> {
  const contactsResp = await acFetchJson(
    brand,
    `/api/3/contacts?tagid=${encodeURIComponent(tagId)}&limit=${pageSize}&offset=${offset}&include=fieldValues`,
  );
  const contacts =
    (contactsResp.contacts as Array<Record<string, unknown>> | undefined) ?? [];
  const pageFieldValues =
    (contactsResp.fieldValues as
      | Array<{ contact?: string | number; value?: string | number | null }>
      | undefined) ?? [];
  const byContact = mapFieldValuesByContact(pageFieldValues);

  let count = 0;
  for (const contact of contacts) {
    const phone = phoneFromActiveCampaignContact(contact, byContact);
    if (phone) count += 1;
  }

  return { count, rows: contacts.length };
}

export async function fetchPhonePageFromActiveCampaignByTag(
  brand: Brand,
  tagName: string,
  offset: number,
  pageSize = 100,
): Promise<{ phones: string[]; rows: number; done: boolean }> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) {
    return { phones: [], rows: 0, done: true };
  }
  if (!tagName) return { phones: [], rows: 0, done: true };

  const tagId = await resolveActiveCampaignTagId(brand, tagName);
  if (!tagId) return { phones: [], rows: 0, done: true };

  const contactsResp = await acFetchJson(
    brand,
    `/api/3/contacts?tagid=${encodeURIComponent(tagId)}&limit=${pageSize}&offset=${offset}&include=fieldValues`,
  );
  const contacts =
    (contactsResp.contacts as Array<Record<string, unknown>> | undefined) ?? [];
  const pageFieldValues =
    (contactsResp.fieldValues as
      | Array<{ contact?: string | number; value?: string | number | null }>
      | undefined) ?? [];
  const byContact = mapFieldValuesByContact(pageFieldValues);

  const phones: string[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    const phone = phoneFromActiveCampaignContact(contact, byContact);
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      phones.push(phone);
    }
  }

  const done = contacts.length === 0 || contacts.length < pageSize;
  return { phones, rows: contacts.length, done };
}

export async function fetchPhonesFromActiveCampaign(
  brand: Brand,
  tagName: string,
  maxCount?: number,
): Promise<string[]> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) return [];
  if (!tagName) return [];

  const result: string[] = [];
  let offset = 0;
  const pageSize = 100;
  while (maxCount === undefined || result.length < maxCount) {
    const page = await fetchPhonePageFromActiveCampaignByTag(brand, tagName, offset, pageSize);
    if (page.rows === 0) break;
    for (const phone of page.phones) {
      if (!result.includes(phone)) result.push(phone);
      if (maxCount !== undefined && result.length >= maxCount) break;
    }
    if (maxCount !== undefined && result.length >= maxCount) break;
    if (page.done) break;
    offset += page.rows;
  }

  return result;
}

export async function fetchActiveCampaignTags(
  brand: Brand,
  maxCount = 5000,
): Promise<Array<{ id: string; tag: string }>> {
  if (!brand.activeCampaignApiUrl || !brand.activeCampaignApiKey) return [];
  const pageSize = 100;
  const out: Array<{ id: string; tag: string }> = [];
  let offset = 0;
  while (out.length < maxCount) {
    const resp = await acFetchJson(
      brand,
      `/api/3/tags?limit=${pageSize}&offset=${offset}`,
    );
    const tags =
      (resp.tags as Array<{ id?: string; tag?: string }> | undefined) ?? [];
    if (tags.length === 0) break;
    for (const t of tags) {
      const id = String(t.id || "").trim();
      const tag = String(t.tag || "").trim();
      if (!id || !tag) continue;
      if (!out.some((x) => x.id === id)) out.push({ id, tag });
      if (out.length >= maxCount) break;
    }
    if (tags.length < pageSize) break;
    offset += pageSize;
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag));
}

export async function getActiveCampaignContactTotal(brand: Brand): Promise<number> {
  const resp = await acFetchJson(brand, "/api/3/contacts?limit=1&offset=0");
  const meta = (resp.meta as Record<string, unknown> | undefined) ?? {};
  const totalRaw = String(meta.total ?? "0");
  const total = parseInt(totalRaw, 10);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

export async function countSmsContactsPage(
  brand: Brand,
  offset: number,
  pageSize: number,
): Promise<{ count: number; rows: number }> {
  const contactsResp = await acFetchJson(
    brand,
    `/api/3/contacts?limit=${pageSize}&offset=${offset}&include=fieldValues`,
  );
  const contacts =
    (contactsResp.contacts as Array<Record<string, unknown>> | undefined) ?? [];
  const pageFieldValues =
    (contactsResp.fieldValues as
      | Array<{ contact?: string | number; value?: string | number | null }>
      | undefined) ?? [];
  const byContact = mapFieldValuesByContact(pageFieldValues);

  let count = 0;
  for (const contact of contacts) {
    const phone = phoneFromActiveCampaignContact(contact, byContact);
    if (phone) count += 1;
  }

  return { count, rows: contacts.length };
}
