export const RESOURCE_NAMES = {
  attachmentsBucket: "pw-support-attachments",
  triageWakeQueue: "pw-support-triage-wake",
  triageWakeDlq: "pw-support-triage-wake-dlq",
  linearAdapterQueue: "pw-support-adapter-linear",
  linearAdapterDlq: "pw-support-adapter-linear-dlq",
  secretsPrefix: "pw-support/",
} as const;

export const TRIAGE_WAKE_MAX_RECEIVES = 5;
