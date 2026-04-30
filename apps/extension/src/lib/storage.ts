/// Settings storage (synced across the user's Chrome profiles via storage.sync)
/// and per-session counters/queues (storage.local — survives SW shutdown).

export type Settings = {
  endpoint: string;
  enabled: boolean;
};

const DEFAULTS: Settings = {
  endpoint: "http://localhost:3001/api/ingest/kajabi",
  enabled: true,
};

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(DEFAULTS)) as Settings;
  return { ...DEFAULTS, ...stored };
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
