import {
  type AdminEvent,
  type AdminKey,
  type AdminProject,
  type AdminRequestDetail,
  type AdminRequestItem,
  INTEGRATIONS,
  type IntegrationKind,
  type IntegrationStatus,
  integrationKinds,
  maskProjectKey,
  shortHash,
} from "@pw-support/contracts";
import {
  type AdminEventRow,
  type AdminProjectRow,
  type AdminRequestDetailRows,
  type AdminRequestRow,
  displayBody,
  type IntegrationRow,
} from "@pw-support/db";

const CLAIM_PREFIX = "triage.job.";
const REPLY_FLAG_TYPES = new Set(["reply.held", "reply.flagged"]);

export function toRequestItem(row: AdminRequestRow): AdminRequestItem {
  return {
    id: row.id,
    projectId: row.projectId,
    clientSlug: row.clientSlug,
    projectSlug: row.projectSlug,
    customer: shortHash(row.hashedId),
    channelKey: row.channelKey.split(":").slice(0, 2).join(":"),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    ticket:
      row.ticketIdentifier && row.ticketUrl
        ? { identifier: row.ticketIdentifier, url: row.ticketUrl }
        : null,
    triageOutcome: row.triageOutcome,
    needsHumanTriage: row.needsHumanTriage,
    flaggedReplies: row.flaggedReplies,
    heldReplies: row.heldReplies,
    preview: row.preview,
  };
}

function toEvent(row: AdminEventRow): AdminEvent {
  return {
    seq: row.seq,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload,
  };
}

export function toRequestDetail(
  rows: AdminRequestDetailRows,
): AdminRequestDetail {
  const events = rows.events.map(toEvent);
  return {
    request: toRequestItem(rows.request),
    messages: rows.messages.map(({ message, attachments }) => ({
      id: message.id,
      body: displayBody(message),
      bodyFlagged: message.bodyFlagged,
      originChannel: message.originChannel,
      author: message.author,
      audience: message.audience,
      createdAt: message.createdAt.toISOString(),
      attachments: attachments.map((file) => ({
        id: file.id,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })),
    })),
    rejections: rows.rejections.map((row) => ({
      filename: row.filename,
      reason: row.reason,
      sizeBytes: row.sizeBytes,
    })),
    events,
    judgments: rows.judgments.map((row) => ({
      kind: row.kind,
      score: row.score,
      threshold: row.threshold,
      flagged: row.flagged,
      createdAt: row.createdAt.toISOString(),
    })),
    job: rows.job
      ? {
          status: rows.job.status,
          outcome: rows.job.outcome,
          attempts: rows.job.attempts,
          claimedByKind: rows.job.claimedByKind,
          claimedBy: rows.job.claimedBy,
          completedAt: rows.job.completedAt?.toISOString() ?? null,
        }
      : null,
    claims: events.filter((event) => event.type.startsWith(CLAIM_PREFIX)),
    replyFlags: events.filter((event) => REPLY_FLAG_TYPES.has(event.type)),
  };
}

export function toAdminKey(row: AdminProjectRow["keys"][number]): AdminKey {
  return {
    id: row.id,
    masked: maskProjectKey(row.key),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function toAdminProject(row: AdminProjectRow): AdminProject {
  const { project } = row;
  return {
    id: project.id,
    clientSlug: project.clientSlug,
    projectSlug: project.projectSlug,
    name: project.name,
    linearTeamId: project.linearTeamId,
    ccList: project.severeCcEmails,
    createdAt: project.createdAt.toISOString(),
    keys: row.keys.map(toAdminKey),
  };
}

export function toIntegrationStatus(
  kind: IntegrationKind,
  row: IntegrationRow | undefined,
): IntegrationStatus {
  return {
    kind,
    label: INTEGRATIONS[kind].label,
    configured: row !== undefined,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export function toIntegrationStatuses(
  rows: IntegrationRow[],
): IntegrationStatus[] {
  return integrationKinds.map((kind) =>
    toIntegrationStatus(
      kind,
      rows.find((row) => row.kind === kind),
    ),
  );
}
