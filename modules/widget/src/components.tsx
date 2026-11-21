import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SupportClient } from "./client";
import {
  authorLabel,
  channelLabel,
  describeError,
  formatBytes,
  formatTime,
  MAX_FILE_BYTES,
  MAX_FILES,
  rejectionMessage,
} from "./format";
import type {
  AttachmentSummary,
  FileResult,
  RequestSummary,
  Thread,
  ThreadMessage,
} from "./types";
import { usePolling } from "./use-polling";

export function RejectionNotice({ files }: { files: FileResult[] }) {
  if (files.length === 0) return null;
  return (
    <div className="alert" role="alert">
      <p>These files were not attached:</p>
      <ul>
        {files.map((file) => (
          <li key={`${file.filename}:${file.reason}`}>
            {file.filename}: {rejectionMessage(file.reason)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function fileWarnings(files: File[]): string[] {
  const warnings = files
    .filter((file) => file.size > MAX_FILE_BYTES)
    .map((file) => `${file.name} is over 25 MB and will be rejected.`);
  if (files.length > MAX_FILES) {
    warnings.push(`Only the first ${MAX_FILES} files are accepted.`);
  }
  return warnings;
}

export interface ComposerProps {
  label: string;
  submitLabel: string;
  placeholder: string;
  onSubmit: (text: string, files: File[]) => Promise<FileResult[]>;
}

export function Composer(props: ComposerProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<{ key: string; file: File }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<FileResult[]>([]);
  const files = picked.map((entry) => entry.file);

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []).map((file) => ({
      key: crypto.randomUUID(),
      file,
    }));
    setPicked((current) => [...current, ...chosen]);
    event.target.value = "";
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const results = await props.onSubmit(text, files);
      setRejected(results.filter((file) => file.status === "rejected"));
      setText("");
      setPicked([]);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  const warnings = fileWarnings(files);
  return (
    <form className="composer" onSubmit={submit}>
      <RejectionNotice files={rejected} />
      <label htmlFor={`${id}-text`}>{props.label}</label>
      <textarea
        id={`${id}-text`}
        value={text}
        placeholder={props.placeholder}
        rows={4}
        onChange={(event) => setText(event.target.value)}
      />
      <label htmlFor={`${id}-files`} className="file-label">
        Attachments
      </label>
      <input id={`${id}-files`} type="file" multiple onChange={addFiles} />
      <p className="hint">
        {files.length} of {MAX_FILES} files. Up to 25 MB each. Images, PDF,
        text, logs, CSV, JSON, Office files, and zip. No video.
      </p>
      {files.length > 0 && (
        <ul className="files" aria-label="Selected files">
          {picked.map(({ key, file }) => (
            <li key={key}>
              <span>
                {file.name} ({formatBytes(file.size)})
              </span>
              <button
                type="button"
                className="link"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setPicked((current) =>
                    current.filter((entry) => entry.key !== key),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="warn">
          {warning}
        </p>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="primary"
        disabled={busy || text.trim() === ""}
      >
        {busy ? "Sending" : props.submitLabel}
      </button>
    </form>
  );
}

export interface RequestListProps {
  requests: RequestSummary[] | null;
  error: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
}

function requestTitle(request: RequestSummary): string {
  const preview = request.lastMessage?.preview ?? "";
  return preview === "" ? "Request" : preview;
}

export function RequestList(props: RequestListProps) {
  const { requests, error } = props;
  return (
    <div className="body">
      <button type="button" className="primary" onClick={props.onNew}>
        New request
      </button>
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" className="link" onClick={props.onRetry}>
            Try again
          </button>
        </div>
      )}
      {requests === null && !error && (
        <p className="muted" role="status">
          Loading your requests
        </p>
      )}
      {requests?.length === 0 && (
        <p className="muted">You have no requests yet. Start one above.</p>
      )}
      {requests && requests.length > 0 && (
        <ul className="requests" aria-label="Your requests">
          {requests.map((request) => (
            <li key={request.id}>
              <button
                type="button"
                className="request"
                onClick={() => props.onOpen(request.id)}
              >
                <span className="request-title">
                  {request.unreadCount > 0 && (
                    <span
                      className="dot"
                      role="img"
                      aria-label={`${request.unreadCount} unread`}
                    />
                  )}
                  {requestTitle(request)}
                </span>
                <span className="request-meta">
                  {request.status} · {formatTime(request.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AttachmentLink(props: {
  client: SupportClient;
  attachment: AttachmentSummary;
}) {
  const [failed, setFailed] = useState(false);
  async function download() {
    try {
      const blob = await props.client.downloadAttachment(props.attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = props.attachment.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <>
      <button type="button" className="link" onClick={download}>
        {props.attachment.filename} ({formatBytes(props.attachment.sizeBytes)})
      </button>
      {failed && (
        <span className="error" role="alert">
          {" "}
          Download failed.
        </span>
      )}
    </>
  );
}

function MessageItem(props: { client: SupportClient; message: ThreadMessage }) {
  const { message } = props;
  const mine = message.author === "customer";
  return (
    <li className={mine ? "message mine" : "message"}>
      <p className="message-head">
        <strong>{authorLabel(message.author, message.authorName)}</strong>
        {message.originChannel !== "widget" && (
          <span> via {channelLabel(message.originChannel)}</span>
        )}
        <span> · {formatTime(message.createdAt)}</span>
      </p>
      <p className="message-body">{message.body}</p>
      {message.flagged && (
        <p className="hint">Some formatting was removed from this message.</p>
      )}
      {message.attachments.length > 0 && (
        <ul className="files">
          {message.attachments.map((file) => (
            <li key={file.id}>
              <AttachmentLink client={props.client} attachment={file} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export interface ThreadViewProps {
  client: SupportClient;
  requestId: string;
  pollIntervalMs: number;
  notice: FileResult[];
  onRead: () => void;
}

export function ThreadView(props: ThreadViewProps) {
  const { client, requestId, onRead } = props;
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markedCount = useRef(-1);
  const log = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await client.getThread(requestId);
      setThread(loaded);
      setError(null);
      if (loaded.messages.length !== markedCount.current) {
        await client.markRead(requestId);
        markedCount.current = loaded.messages.length;
        onRead();
      }
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [client, requestId, onRead]);

  const refresh = usePolling(load, props.pollIntervalMs);

  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    if (count > 0 && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [count]);

  return (
    <div className="body">
      <RejectionNotice files={props.notice} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {thread === null && !error && (
        <p className="muted" role="status">
          Loading the conversation
        </p>
      )}
      {thread && (
        <ul
          className="messages"
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {thread.messages.map((message) => (
            <MessageItem key={message.id} client={client} message={message} />
          ))}
        </ul>
      )}
      <Composer
        label="Reply"
        submitLabel="Send reply"
        placeholder="Write a reply"
        onSubmit={async (text, files) => {
          const result = await client.reply(requestId, text, files);
          await refresh();
          return result.files;
        }}
      />
    </div>
  );
}
