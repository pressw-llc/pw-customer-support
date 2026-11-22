import type { RequestSummary, ThreadMessage } from "@pw-support/contracts";
import {
  type AttachmentRow,
  displayBody,
  type MessageRow,
  type RequestListItem,
} from "@pw-support/db";

export function toThreadMessage(
  message: MessageRow,
  attachments: AttachmentRow[],
): ThreadMessage {
  return {
    id: message.id,
    body: displayBody(message),
    flagged: message.bodyFlagged,
    author: message.author as ThreadMessage["author"],
    authorName: message.authorName,
    audience: message.audience as ThreadMessage["audience"],
    originChannel: message.originChannel as ThreadMessage["originChannel"],
    createdAt: message.createdAt.toISOString(),
    attachments: attachments.map((file) => ({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  };
}

export function toRequestSummary(item: RequestListItem): RequestSummary {
  const { request, lastMessage } = item;
  return {
    id: request.id,
    status: request.status as RequestSummary["status"],
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    unreadCount: item.unreadCount,
    lastMessage: lastMessage
      ? {
          preview: lastMessage.preview,
          author: lastMessage.author as NonNullable<
            RequestSummary["lastMessage"]
          >["author"],
          originChannel: lastMessage.originChannel as NonNullable<
            RequestSummary["lastMessage"]
          >["originChannel"],
          createdAt: lastMessage.createdAt.toISOString(),
        }
      : null,
  };
}
