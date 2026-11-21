export type Author = "customer" | "staff" | "system";
export type OriginChannel =
  | "widget"
  | "linear"
  | "slack"
  | "email"
  | "claude_code";
export type RejectionReason =
  | "too_many_files"
  | "too_large"
  | "empty"
  | "executable"
  | "video"
  | "type_not_allowed"
  | "storage_failed";

export interface AttachmentSummary {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ThreadMessage {
  id: string;
  body: string;
  flagged: boolean;
  author: Author;
  audience: "external" | "internal";
  originChannel: OriginChannel;
  createdAt: string;
  attachments: AttachmentSummary[];
}

export interface FileResult {
  filename: string;
  status: "stored" | "rejected";
  reason?: RejectionReason;
}

export interface IntakeResult {
  requestId: string;
  message: ThreadMessage;
  files: FileResult[];
}

export interface RequestSummary {
  id: string;
  status: "open" | "triaged" | "closed";
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  lastMessage: {
    preview: string;
    author: Author;
    originChannel: OriginChannel;
    createdAt: string;
  } | null;
}

export interface RequestList {
  requests: RequestSummary[];
}

export interface Thread {
  id: string;
  status: "open" | "triaged" | "closed";
  createdAt: string;
  messages: ThreadMessage[];
}

export interface SupportWidgetProps {
  projectKey: string;
  userEmail: string;
  apiUrl?: string;
  pollIntervalMs?: number;
}
