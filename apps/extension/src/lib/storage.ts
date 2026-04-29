/// Settings storage (synced across the user's Chrome profiles via storage.sync)
/// and per-session counters/queues (storage.local — survives SW shutdown).

export type Settings = {
  endpoint: string;
  enabled: boolean;
  capture: {
    "job-search": boolean;
    "job-detail": boolean;
    "category-feed": boolean;
  };
};

const DEFAULTS: Settings = {
  endpoint: "http://localhost:3001/api/ingest/upwork",
  enabled: true,
  capture: { "job-search": true, "job-detail": true, "category-feed": true },
};

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(DEFAULTS)) as Settings;
  // chrome.storage merges shallow keys only — re-merge nested `capture` defaults.
  return { ...stored, capture: { ...DEFAULTS.capture, ...(stored.capture ?? {}) } };
}

export async function saveSettings(s: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(s);
}

export type Status = {
  capturedThisSession: number;
  pendingInQueue: number;
  lastFlushAt: number | null;
  lastError: string | null;
};

const STATUS_KEY = "status";

const ZERO_STATUS: Status = {
  capturedThisSession: 0,
  pendingInQueue: 0,
  lastFlushAt: null,
  lastError: null,
};

export async function getStatus(): Promise<Status> {
  const got = (await chrome.storage.local.get({ [STATUS_KEY]: ZERO_STATUS })) as {
    [STATUS_KEY]: Status;
  };
  return got[STATUS_KEY];
}

export async function patchStatus(patch: Partial<Status>): Promise<Status> {
  const current = await getStatus();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STATUS_KEY]: next });
  return next;
}

/// Dispatch slot for `apply-filters` jobs. The SW writes here right before
/// navigating the managed tab; the content script reads it on load to decide
/// whether to run the filter-apply flow instead of the normal scrape flow.
export type PendingApplyFilters = {
  jobId: string;
  url: string;
  /// JSON-encoded ApplyFiltersPayload (recipe + spec). Stored as a string so
  /// the storage layer doesn't have to know the FilterSpec shape.
  payloadJson: string;
  /// Epoch ms when the SW wrote this entry. The content script discards
  /// entries older than ~5 min so an orphaned task can't ambush a passive
  /// browse session days later.
  writtenAt: number;
};

const PENDING_APPLY_FILTERS_KEY = "pendingApplyFilters";

export async function setPendingApplyFilters(p: PendingApplyFilters): Promise<void> {
  await chrome.storage.local.set({ [PENDING_APPLY_FILTERS_KEY]: p });
}

export async function takePendingApplyFilters(): Promise<PendingApplyFilters | null> {
  const got = (await chrome.storage.local.get(PENDING_APPLY_FILTERS_KEY)) as {
    [PENDING_APPLY_FILTERS_KEY]?: PendingApplyFilters;
  };
  const v = got[PENDING_APPLY_FILTERS_KEY] ?? null;
  if (v) await chrome.storage.local.remove(PENDING_APPLY_FILTERS_KEY);
  return v;
}
