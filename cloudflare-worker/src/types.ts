export type CampaignStatus = "Running" | "Completed" | "Paused" | "Scheduled" | "Preparing";
export type PhoneStatus = "Pending" | "Success" | "Failed";

export type CampaignPhoneDelivery = {
  state: "inflight" | "sent" | "failed";
  at: string;
  phone: string;
  twilioSid?: string;
  error?: string;
};

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Queue<T> {
  send(message: T): Promise<void>;
}

export interface MessageBatch<T> {
  messages: Array<{
    body: T;
    ack(): void;
    retry(): void;
  }>;
}

export type Brand = {
  id: string;
  name: string;
  twilioAccountSid: string;
  twilioApiKey: string;
  twilioAuthToken: string;
  messagingServiceSid: string;
  activeCampaignApiUrl: string;
  activeCampaignApiKey: string;
  /** ActiveCampaign tag name used for dashboard audience + default campaign tag. */
  dashboardTag?: string;
  /** Cost charged per SMS segment (in USD). Used for pre-send cost estimates. */
  smsCostPerSegment?: number;
  createdAt: string;
  updatedAt: string;
};

export type PhoneResult = {
  id: string;
  phone: string;
  status: PhoneStatus;
  error?: string;
  twilioSid?: string;
  failedAt?: string;
  failureSource?: "twilio_rest" | "twilio_callback" | "opted_out" | "mock_simulated" | "unknown";
  failureDetail?: string;
};

export type Campaign = {
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
  scheduledAtUtc?: string;
  scheduleTimezone?: string;
  scheduleAtLocal?: string;
  deletedAt?: string;
};

export type CampaignDetail = Campaign & {
  phones: PhoneResult[];
};

export type CampaignMeta = {
  clicks: number;
  replies: number;
  unsubs: number;
  delivered: number;
  deliveryFailed: number;
};

export type AuthUser = {
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthSession = {
  email: string;
  expiresAt: number;
};

export type PasswordReset = {
  code: string;
  expiresAt: number;
  requestedAt: string;
};

export type CampaignQueueMessage =
  | {
      kind: "send";
      campaignId: string;
      phoneId: string;
      phone: string;
      body: string;
    }
  | {
      kind: "build_audience";
      campaignId: string;
      brandId: string;
      tag: string;
      offset: number;
      nextPhoneSeq: number;
    }
  | {
      kind: "resume_sends";
      campaignId: string;
      cursor: number;
    };

export type Env = {
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
  /** Forward inbound Twilio webhooks here so Missive inbox stays in sync. */
  MISSIVE_TWILIO_CALLBACK_URL?: string;
  OWNER_PHONE?: string;
  DEFAULT_ADMIN_EMAIL?: string;
  DEFAULT_ADMIN_PASSWORD?: string;
};

export type BrandSubscriberCache = {
  brandId: string;
  brandName: string;
  allContacts: number;
  totalSubscribers: number;
  activeSmsSubscribers: number;
  unsubscribedTotal: number;
  fetchOk: boolean;
  fetchError: string;
  status: "fresh" | "partial" | "stale";
  updatedAt: string;
  dashboardTag?: string;
  audienceScope?: "tag" | "account";
};

export type BrandSubscriberCursor = {
  totalContacts: number;
  offset: number;
  smsContacts: number;
  done: boolean;
  updatedAt: string;
  // Last value of smsContacts that completed a full walk. Surfaced as the
  // displayed Total Subscribers while a re-walk is in progress so the dashboard
  // doesn't visibly drop to 0 every time AC's contact count changes by 1.
  lastFreshSmsContacts?: number;
  // Updated each time the walk reaches `done: true`. Used by the UI to show
  // when the displayed value was last verified end-to-end.
  lastFreshAt?: string;
};
