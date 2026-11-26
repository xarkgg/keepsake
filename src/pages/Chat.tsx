import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsentPreview } from "../components/keepsake/ConsentPreview";
import { SidePane } from "../components/keepsake/SidePane";
import { SourceBadge } from "../components/keepsake/SourceBadge";
import { KeepsakeMark } from "../components/KeepsakeMark";
import { Markdown } from "../components/Markdown";
import { useKeepsake } from "../lib/inference/keepsake-context";
import { DEFAULT_CLOUD_MODEL } from "../lib/inference/types";
import { useVault } from "../lib/keepsake/vault-context";
import { useToast } from "../lib/toast";
import { cn } from "../lib/utils";
import { assemblePrompt } from "../../shared/keepsake/prompt";
import { deriveSessionTitle } from "../../shared/session-title";
import type { VaultMessage } from "../../shared/keepsake/store";

/**
 * The three openers offered on an empty conversation.
 *
 * They are written for the person this is built for: someone whose work is other
 * people's text, a clause to explain, a message to soften, notes to condense.
 * Each one leads to pasting real material, which is exactly when the consent
 * card earns its keep, and none of them is a generic "help me think" prompt that
 * any chatbot could answer.
 */
const SUGGESTIONS = [
  "Explain a clause plainly",
  "Draft a reply to a hard email",
  "Summarise these notes",
];

/**
 * The conversation, and the whole device around it.
 *
 * The layout is the chat template's, unchanged: a header with the avatar, one
 * name and one glass pill; a thread of 18px bubbles that hug their own side; a
 * dock with suggestion chips and a 52px pill field whose send button grows out
 * of it; and two blurred bands pinning the thread between them. The second view
 * (your chats, the mode, the account) slides in over it, and on a wide screen
 * both sit side by side.
 */
export function ChatPage({
  navigate,
  threadId,
}: {
  navigate: (path: string) => void;
  /** The session from the URL (`/chat/<id>`); absent means a fresh chat. */
  threadId?: string;
}) {
  const vault = useVault();
  const { mode, setMode, pending, request, approve, decline, busy, error } = useKeepsake();
  const toast = useToast();

  const [activeId, setActiveId] = useState<string | undefined>(threadId);
  const [messages, setMessages] = useState<VaultMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  /* A cloud turn that failed, kept so the same request can be retried without
     retyping it. The prompt is the exact string that was sent, and the user's
     message is already in the session, a retry must not append it twice. */
  const [failedTurn, setFailedTurn] = useState<{ sessionId: string; prompt: string } | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [value, setValue] = useState("");
  /* The ids that arrived while this view was open. Everything else is
     history and must render already settled. */
  const [entering, setEntering] = useState<string[]>([]);

  const activeIdRef = useRef<string | undefined>(threadId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const composeRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /* The composer grows with the draft instead of scrolling a single line.
     Setting the height back to `auto` first is what lets it shrink again when
     text is deleted; the CSS cap (132px, about six lines) then takes over and
     the field scrolls.

     An empty draft keeps its intrinsic one-line height instead of being measured:
     `scrollHeight` counts a wrapped placeholder, which made the field sit two
     lines tall at 320px before a single character was typed. */
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (!value) {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  }, [value]);

  /* The thread has to know how tall the composer is, because the composer now
     changes height while you type. Measuring it beats guessing: the padding
     under the last bubble is exactly the dock plus a little air, so a five-line
     draft can never cover the answer above it.

     The two blur bands are placed from the same measurements, because both
     edges are the UI's own furniture: the top band stops just under the
     Keepsake icon, the bottom band stops just above the composer's line. A
     fixed pixel height cannot do that, the header grows with a safe area and
     the composer grows with a draft, so the bands follow the real boxes. */
  useEffect(() => {
    const dock = dockRef.current;
    const device = deviceRef.current;
    if (!dock || !device) return;
    const header = headerRef.current;
    const compose = composeRef.current;
    const apply = () => {
      device.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
      // Both edges sit 10px past the furniture they belong to.
      if (header) device.style.setProperty("--top-h", `${header.offsetHeight}px`);
      if (compose) {
        const gap = device.getBoundingClientRect().bottom - compose.getBoundingClientRect().top;
        device.style.setProperty("--compose-top", `${Math.max(0, Math.round(gap))}px`);
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(dock);
    if (header) observer.observe(header);
    if (compose) observer.observe(compose);
    return () => observer.disconnect();
  }, []);

  // Load the session's messages whenever the route changes.
  useEffect(() => {
    activeIdRef.current = threadId;
    setActiveId(threadId);
    setMessages([]);
    setEntering([]);
    setBlocked(null);
    setLoaded(false);
    if (!threadId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await vault.listMessages(threadId);
      if (cancelled) return;
      setMessages(stored);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // `vault.listMessages` is stable; reloading on the session id is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Keep the newest turn in view without yanking the page while it is scrolled.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, thinking, pending, blocked]);

  // Switching to Vault Mode must mean "nothing goes out". A card left waiting
  // from Hybrid would still send its payload if approved, so it is dropped with
  // the mode that authorised it.
  useEffect(() => {
    if (mode === "vault" && pending) decline();
  }, [mode, pending, decline]);

  const ensureSession = useCallback(async () => {
    if (activeIdRef.current) {
      const found = vault.sessions.find((session) => session.id === activeIdRef.current);
      if (found) return found;
    }
    const session = await vault.createSession(mode);
    activeIdRef.current = session.id;
    setActiveId(session.id);
    window.history.replaceState({}, "", `/chat/${session.id}`);
    return session;
  }, [mode, vault]);

  /** Name a session from its first real request, on-device, deterministic. */
  const maybeName = useCallback(
    async (sessionId: string, userTexts: string[]) => {
      const session = vault.sessions.find((item) => item.id === sessionId);
      if (session?.title) return;
      const title = deriveSessionTitle(userTexts);
      if (title) await vault.renameSession(sessionId, title);
    },
    [vault],
  );

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || thinking || busy) return;

      const session = await ensureSession();
      const history =
        activeIdRef.current === session.id ? messages : await vault.listMessages(session.id);
      const prompt = assemblePrompt(history, clean);

      setBlocked(null);
      setFailedTurn(null);
      const userMessage = await vault.appendMessage({
        sessionId: session.id,
        role: "user",
        content: clean,
      });
      setMessages((current) =>
        session.id === activeIdRef.current ? [...current, userMessage] : current,
      );
      setEntering((current) => [...current, userMessage.id]);

      const userTexts = [...history.filter((m) => m.role === "user").map((m) => m.content), clean];
      void maybeName(session.id, userTexts);

      setThinking(true);
      try {
        const outcome = await request(prompt);
        if (outcome.kind === "answered") {
          const assistant = await vault.appendMessage({
            sessionId: session.id,
            role: "assistant",
            content: outcome.result.text,
            source: outcome.result.source,
            model: outcome.result.model,
            consentHash: outcome.consentHash ?? null,
          });
          setMessages((current) => [...current, assistant]);
          setEntering((current) => [...current, assistant.id]);
        } else if (outcome.kind === "blocked") {
          setBlocked(outcome.message);
        } else if (outcome.kind === "failed") {
          setFailedTurn({ sessionId: session.id, prompt });
          toast(outcome.message, "error");
        }
        // "consent": the consent card renders from the parked payload below.
      } finally {
        setThinking(false);
      }
    },
    [thinking, busy, ensureSession, messages, vault, maybeName, request, toast],
  );

  /**
   * Retry the turn that just failed, without appending the person's message a
   * second time. The same prompt goes back out, so a Hybrid turn still resolves
   * through the same sanitize/consent path it would have the first time.
   */
  const retry = useCallback(async () => {
    const last = failedTurn;
    if (!last || thinking || busy) return;
    setBlocked(null);
    setThinking(true);
    try {
      const outcome = await request(last.prompt);
      if (outcome.kind === "answered") {
        const assistant = await vault.appendMessage({
          sessionId: last.sessionId,
          role: "assistant",
          content: outcome.result.text,
          source: outcome.result.source,
          model: outcome.result.model,
          consentHash: outcome.consentHash ?? null,
        });
        setMessages((current) => [...current, assistant]);
        setEntering((current) => [...current, assistant.id]);
        setFailedTurn(null);
      } else if (outcome.kind === "blocked") {
        setBlocked(outcome.message);
        setFailedTurn(null);
      } else if (outcome.kind === "failed") {
        toast(outcome.message, "error");
      }
    } finally {
      setThinking(false);
    }
  }, [failedTurn, thinking, busy, request, vault, toast]);

  const approveTurn = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    setFailedTurn(null);
    setThinking(true);
    try {
      const outcome = await approve();
      if (outcome.kind === "answered") {
        const assistant = await vault.appendMessage({
          sessionId: id,
          role: "assistant",
          content: outcome.result.text,
          source: outcome.result.source,
          model: outcome.result.model,
          consentHash: outcome.consentHash ?? null,
        });
        setMessages((current) => [...current, assistant]);
        setEntering((current) => [...current, assistant.id]);
        toast("Sent with your approval");
      } else if (outcome.kind === "failed") {
        toast(outcome.message, "error");
      }
    } finally {
      setThinking(false);
    }
  }, [approve, vault, toast]);

  const startNew = useCallback(() => {
    setSideOpen(false);
    setActiveId(undefined);
    activeIdRef.current = undefined;
    setMessages([]);
    setEntering([]);
    setBlocked(null);
    setFailedTurn(null);
    setValue("");
    navigate("/chat");
  }, [navigate]);

  const submit = () => {
    const text = value.trim();
    if (!text || thinking || busy) return;
    setValue("");
    void send(text);
  };

  /**
   * Put an opener in the composer instead of sending it.
   *
   * The chips are starting points, not complete requests: "Explain a clause
   * plainly" still needs the clause. Sending it immediately produced a turn the
   * person had to follow up on anyway, so tapping one now fills the field, puts
   * the caret at the end and leaves it focused, type the rest and send.
   *
   * It appends rather than replaces when there is already a draft, so a tap can
   * never silently discard something half-written.
   */
  const usePrompt = (text: string) => {
    setValue((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => {
      const field = fieldRef.current;
      if (!field) return;
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
    });
  };

  const active = vault.sessions.find((session) => session.id === activeId);
  const enteringIds = new Set(entering);
  const empty = loaded && messages.length === 0 && !thinking && !pending && !blocked;
  const canSend = Boolean(value.trim()) && !thinking && !busy;

  return (
    <div ref={deviceRef} className={cn("device", sideOpen && "side-open")}>
      <section className="view" id="chat" aria-label="Chat with Keepsake">
        <header ref={headerRef} className="top">
          <button
            className="av glass"
            type="button"
            onClick={() => setSideOpen(true)}
            aria-label="Your chats and settings"
          >
            <KeepsakeMark className="brand-mark" size={26} />
          </button>
          <b className="nm ell">Keepsake</b>
          <button
            className={cn("views", "glass", mode === "hybrid" && "is-hybrid")}
            type="button"
            onClick={() => setMode(mode === "vault" ? "hybrid" : "vault")}
            disabled={busy}
            aria-label={
              mode === "vault"
                ? "Vault Mode. Tap to switch to Hybrid Mode."
                : "Hybrid Mode. Tap to switch to Vault Mode."
            }
            title={
              mode === "vault"
                ? "Vault Mode, tap to switch to Hybrid"
                : "Hybrid Mode, tap to switch to Vault"
            }
          >
            <i aria-hidden="true" />
            <span>{mode === "vault" ? "On-device" : "Hybrid"}</span>
          </button>
        </header>

        <main className="thread" aria-live="polite">
          <p className="day">
            <b>{active?.title?.trim() || "Today"}</b>
          </p>

          {messages.map((message) => (
            <MessageRow key={message.id} message={message} isNew={enteringIds.has(message.id)} />
          ))}

          {thinking ? (
            <div className="b in typing" aria-label="Keepsake is thinking">
              <span />
              <span />
              <span />
            </div>
          ) : null}

          {blocked ? (
            <div className="b notice" role="alert">
              <strong>{mode === "vault" ? "Vault Mode could not answer." : "Unavailable."}</strong>
              {blocked}
              {mode === "vault" ? (
                <>
                  {" "}
                  <button className="notice-link" type="button" onClick={() => setMode("hybrid")}>
                    Switch to Hybrid Mode
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {error && !blocked ? (
            <div className="b notice" role="alert">
              <strong>That did not go through.</strong>
              {error}
              {failedTurn ? (
                <>
                  {" "}
                  <button className="notice-link" type="button" onClick={() => void retry()} disabled={busy}>
                    Try again
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {pending ? (
            <div className="b wide">
              <ConsentPreview
                redaction={pending.redaction}
                destination={`Firebase AI Logic · ${DEFAULT_CLOUD_MODEL}`}
                busy={busy}
                onApprove={() => void approveTurn()}
                onDecline={() => {
                  decline();
                  toast("Kept local, nothing was sent");
                }}
              />
            </div>
          ) : null}

          <div ref={bottomRef} />
        </main>

        <div className="x-edge x-edge--top" aria-hidden="true" />
        <div className="x-edge x-edge--bot" aria-hidden="true" />

        <div ref={dockRef} className="dock">
          {empty ? (
            <div className="chipw">
              <div className="chips">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="glass"
                    type="button"
                    onClick={() => usePrompt(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <form
            ref={composeRef}
            className="compose"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <button
              className="circ glass"
              type="button"
              onClick={() => setSideOpen(true)}
              aria-label="Your chats"
            >
              <Menu />
            </button>
            <div className="field glass">
              <textarea
                ref={fieldRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  // Enter is a newline: the field has to hold paragraphs. Send
                  // is the button, or Ctrl/Cmd+Enter for the keyboard.
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder={
                  mode === "vault" ? "Message, stays on device" : "Message Keepsake"
                }
                aria-label="Message"
                enterKeyHint="enter"
                autoCapitalize="sentences"
                autoComplete="off"
              />
              <button
                className={cn("send", !canSend && "is-off")}
                type="submit"
                aria-label="Send"
                aria-hidden={canSend ? undefined : true}
                tabIndex={canSend ? undefined : -1}
                disabled={!canSend}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </section>

      <SidePane
        open={sideOpen}
        activeId={activeId}
        onClose={() => setSideOpen(false)}
        onOpenSession={(id) => {
          setSideOpen(false);
          navigate(`/chat/${id}`);
        }}
        onNewChat={startNew}
        onActiveDeleted={startNew}
        navigate={navigate}
      />
    </div>
  );
}

function MessageRow({ message, isNew }: { message: VaultMessage; isNew?: boolean }) {
  const mine = message.role === "user";
  return (
    <>
      <div className={cn("b", mine ? "out" : "in", isNew && "is-new")}>
        {mine ? <p>{message.content}</p> : <Markdown>{message.content}</Markdown>}
      </div>
      {!mine ? <SourceBadge source={message.source} model={message.model} /> : null}
    </>
  );
}
