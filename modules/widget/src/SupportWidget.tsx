import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createClient } from "./client";
import { Composer, RequestList, ThreadView } from "./components";
import { describeError } from "./format";
import { STYLES } from "./styles";
import type { FileResult, RequestSummary, SupportWidgetProps } from "./types";
import { usePolling } from "./use-polling";

const DEFAULT_POLL_MS = 15_000;

type View =
  | { name: "list" }
  | { name: "new" }
  | { name: "thread"; id: string; notice: FileResult[] };

const CHAT_ICON =
  "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z";

function Shell(
  props: Required<Omit<SupportWidgetProps, "apiUrl">> & {
    apiUrl: string | undefined;
  },
) {
  const { projectKey, userEmail, apiUrl, pollIntervalMs } = props;
  const client = useMemo(
    () => createClient({ projectKey, userEmail, apiUrl }),
    [projectKey, userEmail, apiUrl],
  );
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "list" });
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const loadList = useCallback(async () => {
    try {
      setRequests((await client.listRequests()).requests);
      setListError(null);
    } catch (failure) {
      setListError(describeError(failure));
    }
  }, [client]);
  const refreshList = usePolling(loadList, pollIntervalMs);

  useEffect(() => {
    if (open) panel.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const unread = (requests ?? []).reduce(
    (sum, request) => sum + request.unreadCount,
    0,
  );

  const handleRead = useCallback(() => void refreshList(), [refreshList]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") setOpen(false);
  }

  const heading =
    view.name === "new"
      ? "New request"
      : view.name === "thread"
        ? "Conversation"
        : "Support";

  return (
    <>
      <style>{STYLES}</style>
      <div className="root">
        <button
          ref={launcher}
          type="button"
          className="launcher"
          aria-label={
            unread > 0 ? `Open support, ${unread} unread` : "Open support"
          }
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={CHAT_ICON} />
          </svg>
          {unread > 0 && (
            <span className="badge" aria-hidden="true">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        {open && (
          <div
            ref={panel}
            className="panel"
            role="dialog"
            aria-label="Support"
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <div className="header">
              {view.name !== "list" && (
                <button
                  type="button"
                  className="icon"
                  aria-label="Back to requests"
                  onClick={() => {
                    setView({ name: "list" });
                    void refreshList();
                  }}
                >
                  ‹
                </button>
              )}
              <h2>{heading}</h2>
              <button
                type="button"
                className="icon"
                aria-label="Close support"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            {view.name === "list" && (
              <RequestList
                requests={requests}
                error={listError}
                onOpen={(id) => setView({ name: "thread", id, notice: [] })}
                onNew={() => setView({ name: "new" })}
                onRetry={() => void refreshList()}
              />
            )}
            {view.name === "new" && (
              <div className="body">
                <Composer
                  label="How can we help?"
                  submitLabel="Send request"
                  placeholder="Describe what you need"
                  onSubmit={async (text, files) => {
                    const result = await client.createRequest(text, files);
                    setView({
                      name: "thread",
                      id: result.requestId,
                      notice: result.files.filter(
                        (file) => file.status === "rejected",
                      ),
                    });
                    void refreshList();
                    return result.files;
                  }}
                />
              </div>
            )}
            {view.name === "thread" && (
              <ThreadView
                key={view.id}
                client={client}
                requestId={view.id}
                pollIntervalMs={pollIntervalMs}
                notice={view.notice}
                onRead={handleRead}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

export function SupportWidget(props: SupportWidgetProps) {
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      setShadow(element.shadowRoot ?? element.attachShadow({ mode: "open" }));
    }
  }, []);
  return (
    <div ref={attach} data-pressw-support="">
      {shadow &&
        createPortal(
          <Shell
            projectKey={props.projectKey}
            userEmail={props.userEmail}
            apiUrl={props.apiUrl}
            pollIntervalMs={props.pollIntervalMs ?? DEFAULT_POLL_MS}
          />,
          shadow,
        )}
    </div>
  );
}
