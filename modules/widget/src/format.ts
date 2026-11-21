import { SupportApiError } from "./client";
import type { Author, OriginChannel, RejectionReason } from "./types";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const CHANNEL_LABELS: Record<OriginChannel, string> = {
  widget: "this widget",
  linear: "Linear",
  slack: "Slack",
  email: "email",
  claude_code: "Claude Code",
};

const AUTHOR_LABELS: Record<Author, string> = {
  customer: "You",
  staff: "Support",
  system: "System",
};

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  too_many_files: "only 10 files fit in one message",
  too_large: "the file is larger than 25 MB",
  empty: "the file is empty",
  executable: "programs and scripts are not accepted",
  video: "video files are not accepted",
  type_not_allowed: "this file type is not accepted",
  storage_failed: "the upload failed, so try again",
};

export function authorLabel(author: Author, name?: string | null): string {
  const label = AUTHOR_LABELS[author];
  const trimmed = name?.trim();
  return author === "staff" && trimmed ? `${trimmed} (${label})` : label;
}

export const channelLabel = (channel: OriginChannel): string =>
  CHANNEL_LABELS[channel];

export const rejectionMessage = (
  reason: RejectionReason | undefined,
): string =>
  reason ? REJECTION_MESSAGES[reason] : "the file was not accepted";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

export function describeError(error: unknown): string {
  if (error instanceof SupportApiError) {
    if (error.status === 429) {
      return "Too many requests. Wait a moment and try again.";
    }
    if (error.status === 401) {
      return "Support is not available for this site.";
    }
    if (error.status === 413) return "That message is too large to send.";
  }
  return "Something went wrong. Check your connection and try again.";
}
