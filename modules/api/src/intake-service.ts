import type {
  AttachmentRejectionReason,
  FileResult,
  IntakeResult,
  RequestList,
  Thread,
  TriageTiming,
  WakeSender,
} from "@pw-support/contracts";
import {
  type AttachmentRow,
  type CustomerScope,
  getCustomerAttachment,
  getCustomerThread,
  listCustomerRequests,
  type MessageRow,
  markIntakeComplete,
  markThreadRead,
  persistInboundMessage,
  persistInboundRequest,
  type RequestRow,
  recordAttachment,
  recordAttachmentRejection,
  recordMessageChecks,
  type SupportDb,
} from "@pw-support/db";
import { detectFile, preflightAttachment } from "./file-type";
import { checkMessage } from "./message-checks";
import { toRequestSummary, toThreadMessage } from "./presenters";
import type { ObjectStorage, StoredObject } from "./storage";

export interface Checks {
  checkMessage: typeof checkMessage;
  detectFile: typeof detectFile;
}

export const defaultChecks: Checks = { checkMessage, detectFile };

export interface IntakeDeps {
  db: SupportDb;
  storage: ObjectStorage;
  checks?: Checks;
  wake?: WakeSender;
  timing?: TriageTiming;
}

export class ProcessingError extends Error {
  constructor(
    readonly requestId: string,
    cause: unknown,
  ) {
    super("inbound processing failed", { cause });
  }
}

export interface InboundInput {
  text: string;
  files: File[];
}

const MAX_FILENAME_CHARS = 255;
const MAX_KEY_NAME_CHARS = 100;

export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const printable = Array.from(base)
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .trim();
  return printable.slice(0, MAX_FILENAME_CHARS) || "file";
}

function storageKeyFor(
  scope: CustomerScope,
  request: RequestRow,
  message: MessageRow,
  filename: string,
): string {
  const safe = filename
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(-MAX_KEY_NAME_CHARS);
  return [
    scope.project.id,
    request.id,
    message.id,
    `${crypto.randomUUID()}-${safe}`,
  ].join("/");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createIntakeService(deps: IntakeDeps) {
  const { db, storage } = deps;
  const checks = deps.checks ?? defaultChecks;

  async function reject(
    request: RequestRow,
    message: MessageRow,
    file: { filename: string; size: number },
    reason: AttachmentRejectionReason,
  ): Promise<{ result: FileResult }> {
    await recordAttachmentRejection(db, {
      message,
      request,
      filename: file.filename,
      sizeBytes: file.size,
      reason,
    });
    return { result: { filename: file.filename, status: "rejected", reason } };
  }

  async function handleFile(
    scope: CustomerScope,
    request: RequestRow,
    message: MessageRow,
    file: File,
    index: number,
  ): Promise<{ result: FileResult; stored?: AttachmentRow }> {
    const filename = cleanFilename(file.name || "");
    const meta = { filename, size: file.size };
    const early = preflightAttachment({ index, size: file.size });
    if (early) return reject(request, message, meta, early);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const verdict = checks.detectFile(filename, bytes);
    if (!verdict.ok) return reject(request, message, meta, verdict.reason);
    const storageKey = storageKeyFor(scope, request, message, filename);
    try {
      await storage.put({
        key: storageKey,
        body: bytes,
        contentType: verdict.contentType,
      });
    } catch (error) {
      console.error("attachment upload failed", error);
      return reject(request, message, meta, "storage_failed");
    }
    const stored = await recordAttachment(db, {
      messageId: message.id,
      filename,
      contentType: verdict.contentType,
      sizeBytes: file.size,
      storageKey,
      sha256: await sha256Hex(bytes),
    });
    return { result: { filename, status: "stored" }, stored };
  }

  async function wakeCloud(jobId: string, delaySeconds: number) {
    if (!deps.wake) return;
    try {
      await deps.wake.send(jobId, delaySeconds);
    } catch (error) {
      console.error("triage wake failed; the sweeper recovers the job", error);
    }
  }

  async function processInbound(
    scope: CustomerScope,
    request: RequestRow,
    message: MessageRow,
    files: File[],
  ): Promise<IntakeResult> {
    try {
      const verdict = checks.checkMessage(message.body);
      const checked = await recordMessageChecks(db, {
        message,
        request,
        sanitizedBody: verdict.sanitized,
        flagged: verdict.flagged,
        reasons: verdict.reasons,
      });
      const results: FileResult[] = [];
      const stored: AttachmentRow[] = [];
      for (const [index, file] of files.entries()) {
        const outcome = await handleFile(scope, request, checked, file, index);
        results.push(outcome.result);
        if (outcome.stored) stored.push(outcome.stored);
      }
      return {
        requestId: request.id,
        message: toThreadMessage(checked, stored),
        files: results,
      };
    } catch (error) {
      throw new ProcessingError(request.id, error);
    }
  }

  return {
    async createRequest(
      scope: CustomerScope,
      input: InboundInput,
    ): Promise<IntakeResult> {
      const { request, message, job, delaySeconds } =
        await persistInboundRequest(
          db,
          { scope, body: input.text },
          { timing: deps.timing },
        );
      const result = await processInbound(scope, request, message, input.files);
      await markIntakeComplete(db, request.id);
      await wakeCloud(job.id, delaySeconds);
      return result;
    },

    async addMessage(
      scope: CustomerScope,
      requestId: string,
      input: InboundInput,
    ): Promise<IntakeResult | null> {
      const persisted = await persistInboundMessage(db, {
        scope,
        requestId,
        body: input.text,
      });
      if (!persisted) return null;
      return processInbound(
        scope,
        persisted.request,
        persisted.message,
        input.files,
      );
    },

    async listRequests(scope: CustomerScope): Promise<RequestList> {
      const items = await listCustomerRequests(db, scope);
      return { requests: items.map(toRequestSummary) };
    },

    async getThread(
      scope: CustomerScope,
      requestId: string,
    ): Promise<Thread | null> {
      const thread = await getCustomerThread(db, scope, requestId);
      if (!thread) return null;
      return {
        id: thread.request.id,
        status: thread.request.status as Thread["status"],
        createdAt: thread.request.createdAt.toISOString(),
        messages: thread.messages.map((entry) =>
          toThreadMessage(entry.message, entry.attachments),
        ),
      };
    },

    markRead(scope: CustomerScope, requestId: string): Promise<boolean> {
      return markThreadRead(db, scope, requestId);
    },

    async openAttachment(
      scope: CustomerScope,
      attachmentId: string,
    ): Promise<{ row: AttachmentRow; object: StoredObject } | null> {
      const row = await getCustomerAttachment(db, scope, attachmentId);
      if (!row) return null;
      return { row, object: await storage.get(row.storageKey) };
    },
  };
}

export type IntakeService = ReturnType<typeof createIntakeService>;
