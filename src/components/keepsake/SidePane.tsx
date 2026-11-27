import {
  Check,
  ChevronRight,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { useKeepsake } from "../../lib/inference/keepsake-context";
import { getEngine } from "../../lib/inference/engine";
import { DEFAULT_CLOUD_MODEL, type DeviceAvailability, type Engine } from "../../lib/inference/types";
import { deviceDownloadFailureMessage } from "../../lib/inference/errors";
import { useVault } from "../../lib/keepsake/vault-context";
import { useToast } from "../../lib/toast";
import { cn, downscaleToDataUrl, timeAgo } from "../../lib/utils";
import { SESSION_NAME_MAX } from "../../../shared/session-title";
import type { VaultSession } from "../../../shared/keepsake/store";
import { Spinner } from "../UI";
import { KeepsakeMark } from "../KeepsakeMark";
import { ModeHint, ModeSwitch } from "./ModeSwitch";

/** How long a press must be held before a row offers rename and delete. */
const HOLD_MS = 500;

function sessionLabel(session: VaultSession): string {
  const title = session.title?.trim();
  return title || "Untitled chat";
}

/** The pane's plain-language reading of Chrome's on-device model state. */
function deviceLabel(state: DeviceAvailability): string {
  switch (state) {
    case "available":
      return "Ready on this device";
    case "downloadable":
      return "Ready to download";
    case "downloading":
      return "Downloading";
    case "unknown":
      return "Checking…";
    default:
      return "Not in this browser";
  }
}

/**
 * The second view: everything about you rather than the conversation.
 *
 * It is the chat list (the conversations kept on this device), the switch that
 * decides where Keepsake is allowed to think, and the account and exit doors.
 * On a phone it slides in over the chat from the right; on a wide screen it is
 * the left column of the split, the way a chat app lists its threads.
 */
export function SidePane({
  open,
  turnInProgress,
  activeId,
  onClose,
  onOpenSession,
  onNewChat,
  onActiveDeleted,
  navigate,
}: {
  open: boolean;
  turnInProgress: boolean;
  activeId?: string;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
  onActiveDeleted: () => void;
  navigate: (path: string) => void;
}) {
  const vault = useVault();
  const { mode, setMode, busy } = useKeepsake();
  const { bootstrap, account, signOut, reloadBootstrap } = useApp();
  const toast = useToast();
  /* What this browser can actually do on-device. Vault Mode has no other
     source of answers, so the pane states the truth up front rather than after
     someone has typed a message and waited for nothing. */
  const [device, setDevice] = useState<DeviceAvailability>("unknown");
  const engineRef = useRef<Engine | null>(null);
  const downloadInFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const engine = await getEngine();
        const availability = await engine.availability();
        if (alive) {
          engineRef.current = engine;
          setDevice(availability);
        }
      } catch {
        if (alive) setDevice("unsupported");
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  /* Initialization follows the click. Chrome owns the model download;
     the pane reports its progress and readiness before AI Logic can use it. */
  const [deviceDownload, setDeviceDownload] = useState<{ progress: number | null } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const startDeviceDownload = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || downloadInFlight.current) return;
    downloadInFlight.current = true;
    setDownloadError(null);
    setDeviceDownload({ progress: null });
    try {
      await engine.initializeDeviceModel((value) => {
        if (mounted.current && Number.isFinite(value)) {
          setDeviceDownload({ progress: Math.max(0, Math.min(1, value)) });
        }
      });
      const state = await engine.availability();
      if (!mounted.current) return;
      setDevice(state);
      if (state === "available") {
        toast("The built-in model is ready.");
      } else {
        setDownloadError("Chrome does not report the model as ready yet. Check chrome://on-device-internals, then try again.");
      }
    } catch (error) {
      if (!mounted.current) return;
      setDownloadError(deviceDownloadFailureMessage(error));
      try {
        const state = await engine.availability();
        if (mounted.current) setDevice(state);
      } catch {
        if (mounted.current) setDevice("unknown");
      }
    } finally {
      downloadInFlight.current = false;
      if (mounted.current) setDeviceDownload(null);
    }
  }, [toast]);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);

  const [name, setName] = useState(bootstrap?.profile.name ?? "");
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [clearingVault, setClearingVault] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const holdRef = useRef<number | null>(null);
  const heldRef = useRef(false);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(bootstrap?.profile.name ?? "");
  }, [bootstrap?.profile.name]);

  useEffect(() => {
    if (editing) renameRef.current?.focus();
  }, [editing]);

  // The picture lives behind an endpoint of its own; fetch it only when the
  // profile says there is one.
  useEffect(() => {
    if (!bootstrap?.profile.has_avatar) {
      setAvatar(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ avatar: string }>("/api/profile/avatar");
        if (!cancelled) setAvatar(data.avatar);
      } catch {
        if (!cancelled) setAvatar(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrap?.profile.has_avatar]);

  // Escape closes the pane, the same as any other sheet in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuFor(null);
      setEditing(null);
      setConfirming(null);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const beginHold = useCallback((id: string) => {
    heldRef.current = false;
    if (holdRef.current) window.clearTimeout(holdRef.current);
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null;
      heldRef.current = true;
      setEditing(null);
      setConfirming(null);
      setMenuFor(id);
    }, HOLD_MS);
  }, []);

  const cancelHold = useCallback(() => {
    if (holdRef.current) {
      window.clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  }, []);

  const removeSession = async (session: VaultSession) => {
    await vault.deleteSession(session.id);
    setConfirming(null);
    setMenuFor(null);
    if (session.id === activeId) onActiveDeleted();
    else toast("Chat deleted");
  };

  const commitRename = async (session: VaultSession) => {
    const next = draft.trim().replace(/\s+/g, " ").slice(0, SESSION_NAME_MAX);
    setEditing(null);
    if (!next || next === sessionLabel(session)) return;
    await vault.renameSession(session.id, next);
  };

  const displayName = bootstrap?.profile.name?.trim() || account?.name?.trim() || "You";
  const hasPassword = account?.has_password !== false;

  const clearVault = async () => {
    if (!window.confirm("Delete every Keepsake conversation kept on this device? This cannot be undone."))
      return;
    setClearingVault(true);
    try {
      await vault.clearAll();
      onActiveDeleted();
      toast("On-device conversations deleted.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not clear the local store", "error");
    } finally {
      setClearingVault(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarBusy(true);
    try {
      const dataUrl = await downscaleToDataUrl(file, 256);
      await api("/api/profile/avatar", { method: "PUT", body: JSON.stringify({ avatar: dataUrl }) });
      await reloadBootstrap();
      toast("Picture updated.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the picture", "error");
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      await api("/api/profile/avatar", { method: "DELETE" });
      await reloadBootstrap();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove the picture", "error");
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveName = async () => {
    setSaving(true);
    try {
      await api("/api/profile", { method: "PATCH", body: JSON.stringify({ name }) });
      await reloadBootstrap();
      toast("Saved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save", "error");
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    if (nextPassword !== confirmPassword) {
      toast("The two new passwords do not match.", "error");
      return;
    }
    setPasswordBusy(true);
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ current: currentPassword, next: nextPassword }),
      });
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      toast("Password changed. Other sessions were signed out.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change the password", "error");
    } finally {
      setPasswordBusy(false);
    }
  };

  const removeAccount = async () => {
    if (
      !window.confirm(
        "Delete this account and its profile? On-device conversations are not touched. This cannot be undone.",
      )
    ) {
      return;
    }
    setDeleteBusy(true);
    try {
      await api("/api/account", {
        method: "DELETE",
        body: JSON.stringify({ password: deletePassword }),
      });
      setDeleteBusy(false);
      await signOut();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the account", "error");
      setDeleteBusy(false);
    }
  };

  return (
    <section
      className="view"
      id="side"
      aria-label="Your chats and settings"
    >
      <div className="pbar">
        <button className="back circ glass" type="button" onClick={onClose} aria-label="Back to the chat">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <h2>You</h2>
      </div>

      <div className="phero">
        {avatar ? (
          <img className="big" src={avatar} alt="" />
        ) : (
          <div className="big is-mark" aria-hidden="true">
            <KeepsakeMark className="brand-mark" size={74} />
          </div>
        )}
        <h1>{displayName}</h1>
        <p className="h">{account?.email ?? ""}</p>
        <p className="tl">
          {mode === "vault"
            ? "Vault Mode, answers come only from this device."
            : "Hybrid Mode, on this device first, the cloud only with your approval."}
        </p>
      </div>

      <div className="sec">
        <h3>Chats</h3>
        <div className="group tiled">
          <button className="li" type="button" onClick={onNewChat}>
            <span className="ico i-new" aria-hidden="true">
              <MessageSquarePlus />
            </span>
            <span className="t">
              <b>New chat</b>
              <span>Start with a clean page</span>
            </span>
          </button>

          {vault.sessions.length ? (
            vault.sessions.map((session) => {
              const label = sessionLabel(session);
              const isMenu = menuFor === session.id;
              const isEditing = editing === session.id;
              const isConfirming = confirming === session.id;
              return (
                <div key={session.id} className={cn("session-row", isMenu && "is-held")}>
                  {isEditing ? (
                    <form
                      className="session-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void commitRename(session);
                      }}
                    >
                      <input
                        ref={renameRef}
                        value={draft}
                        maxLength={SESSION_NAME_MAX}
                        aria-label={`Rename ${label}`}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => void commitRename(session)}
                      />
                      <span className="session-count" aria-hidden="true">
                        {draft.length}/{SESSION_NAME_MAX}
                      </span>
                    </form>
                  ) : isConfirming ? (
                    <div className="session-confirm" role="alertdialog" aria-label={`Delete ${label}?`}>
                      <span className="session-confirm-text">Delete “{label}”?</span>
                      <button
                        className="session-action danger"
                        type="button"
                        onClick={() => void removeSession(session)}
                      >
                        Delete
                      </button>
                      <button className="session-action" type="button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="session-open"
                      type="button"
                      onClick={() => {
                        // A long press ends with a click on release; consume it
                        // so the menu it just opened is not closed again.
                        if (heldRef.current) {
                          heldRef.current = false;
                          return;
                        }
                        if (isMenu) {
                          setMenuFor(null);
                          return;
                        }
                        onOpenSession(session.id);
                      }}
                      onPointerDown={() => beginHold(session.id)}
                      onPointerUp={cancelHold}
                      onPointerLeave={cancelHold}
                      onPointerCancel={cancelHold}
                      aria-current={session.id === activeId ? "true" : undefined}
                    >
                      <span className="session-title">{label}</span>
                      <span className="session-meta">{timeAgo(session.updated_at)}</span>
                    </button>
                  )}

                  {isMenu ? (
                    <div className="session-actions">
                      <button
                        className="session-action"
                        type="button"
                        onClick={() => {
                          setMenuFor(null);
                          setEditing(session.id);
                          setDraft(session.title ?? "");
                        }}
                        aria-label={`Rename ${label}`}
                      >
                        <Pencil size={13} /> Rename
                      </button>
                      <button
                        className="session-action danger"
                        type="button"
                        onClick={() => {
                          setMenuFor(null);
                          setConfirming(session.id);
                        }}
                        aria-label={`Delete ${label}`}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="empty-line">
              Nothing yet. Every chat you start is kept in this browser, never on the server.
            </p>
          )}
        </div>
      </div>

      <div className="sec">
        <h3>Where it thinks</h3>
        <div className="group pad">
          <ModeSwitch mode={mode} onChange={setMode} disabled={turnInProgress || busy} />
          <ModeHint mode={mode} deviceReady={device} />
          <dl className="mode-meta">
            <div>
              <dt>Cloud model</dt>
              <dd>{mode === "hybrid" ? DEFAULT_CLOUD_MODEL : "Not used in Vault Mode"}</dd>
            </div>
            <div>
              <dt>Built-in model</dt>
              <dd aria-live="polite">
                {deviceDownload
                  ? deviceDownload.progress === null
                    ? "Starting download"
                    : `Downloading, ${Math.round(deviceDownload.progress * 100)}%`
                  : deviceLabel(device)}
              </dd>
            </div>
            <div>
              <dt>Chats stored here</dt>
              <dd>
                {vault.sessions.length
                  ? `${vault.sessions.length} chat${vault.sessions.length === 1 ? "" : "s"}`
                  : "Nothing stored"}
              </dd>
            </div>
          </dl>
          {(device === "downloadable" || device === "downloading" || deviceDownload) && (
            <div className="model-download">
              <button
                className="ghost-btn small"
                type="button"
                onClick={() => void startDeviceDownload()}
                disabled={Boolean(deviceDownload) || busy}
              >
                {deviceDownload
                  ? "Downloading model"
                  : device === "downloading" ? "Watch download" : "Start the download"}
              </button>
              {deviceDownload && (
                <progress
                  aria-label="Built-in model download"
                  max={1}
                  value={deviceDownload.progress ?? undefined}
                />
              )}
              <p className="mode-hint">
                Keep this tab open. Chrome needs an unmetered connection and 22 GB free on its profile drive for the initial download. Your messages are not sent during setup.
              </p>
            </div>
          )}
          {downloadError && <p className="mode-hint model-download-error" role="alert">{downloadError}</p>}
          <button
            className="ghost-btn small danger mode-clear"
            type="button"
            onClick={() => void clearVault()}
            disabled={clearingVault || !vault.sessions.length}
          >
            {clearingVault ? <Spinner size={12} /> : <Trash2 size={12} />} Delete on-device chats
          </button>
        </div>
      </div>

      <div className="sec">
        <h3>Account</h3>
        <div className="group">
          <details>
            <summary className="li">
              <span className="ico i-account" aria-hidden="true">
                <Pencil />
              </span>
              <span className="t">
                <b>Name</b>
                <span>{displayName}</span>
              </span>
              <ChevronRight className="chev" aria-hidden="true" />
            </summary>
            <div className="xd">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="What should Keepsake call you?"
                maxLength={60}
                aria-label="Your name"
              />
              <button
                className="primary-btn small xd-save"
                type="button"
                onClick={() => void saveName()}
                disabled={saving}
              >
                {saving ? <Spinner size={13} /> : <Check size={13} />} Save
              </button>
            </div>
          </details>

          <details>
            <summary className="li">
              <span className="ico i-account" aria-hidden="true">
                <ShieldCheck />
              </span>
              <span className="t">
                <b>Picture</b>
                <span>{avatar ? "Shown on this device" : "None yet"}</span>
              </span>
              <ChevronRight className="chev" aria-hidden="true" />
            </summary>
            <div className="xd xd-row">
              <label className="ghost-btn small">
                {avatarBusy ? "Saving…" : "Upload"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  disabled={avatarBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadAvatar(file);
                  }}
                />
              </label>
              {avatar ? (
                <button
                  className="ghost-btn small"
                  type="button"
                  disabled={avatarBusy}
                  onClick={() => void removeAvatar()}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </details>

          <details>
            <summary className="li">
              <span className="ico i-account" aria-hidden="true">
                <KeyRound />
              </span>
              <span className="t">
                <b>{hasPassword ? "Password" : "Add a password"}</b>
                <span>{hasPassword ? "Change it here" : "Sign in with email too"}</span>
              </span>
              <ChevronRight className="chev" aria-hidden="true" />
            </summary>
            <div className="xd">
              {hasPassword ? (
                <input
                  className="input"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  placeholder="Current password"
                  autoComplete="current-password"
                  aria-label="Current password"
                />
              ) : (
                <p className="xd-note">
                  This account signs in through Firebase. Setting a password here lets you also sign in with
                  your email.
                </p>
              )}
              <input
                className="input"
                type="password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
                placeholder="New password"
                autoComplete="new-password"
                aria-label="New password"
              />
              <input
                className="input"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Once more"
                autoComplete="new-password"
                aria-label="Confirm new password"
              />
              <button
                className="primary-btn small xd-save"
                type="button"
                onClick={() => void changePassword()}
                disabled={passwordBusy || !nextPassword || (hasPassword && !currentPassword)}
              >
                {passwordBusy ? <Spinner size={13} /> : <Check size={13} />}{" "}
                {hasPassword ? "Update password" : "Set password"}
              </button>
            </div>
          </details>

          <button className="li" type="button" onClick={() => void signOut()}>
            <span className="ico i-account" aria-hidden="true">
              <LogOut />
            </span>
            <span className="t">
              <b>Sign out</b>
              <span>Your chats stay in this browser</span>
            </span>
          </button>

          <details>
            <summary className="li">
              <span className="ico i-danger" aria-hidden="true">
                <Trash2 />
              </span>
              <span className="t">
                <b>Delete account</b>
                <span>Removes the account and its profile</span>
              </span>
              <ChevronRight className="chev" aria-hidden="true" />
            </summary>
            <div className="xd">
              <p className="xd-note">
                On-device chats are not touched.{" "}
                {hasPassword ? "Type your password to confirm." : "Confirm with your session."}
              </p>
              {hasPassword ? (
                <input
                  className="input"
                  type="password"
                  value={deletePassword}
                  onChange={(event) => setDeletePassword(event.target.value)}
                  placeholder="Your password"
                  autoComplete="current-password"
                  aria-label="Your password"
                />
              ) : null}
              <button
                className="ghost-btn small danger xd-save"
                type="button"
                onClick={() => void removeAccount()}
                disabled={deleteBusy || (hasPassword && !deletePassword)}
              >
                {deleteBusy ? <Spinner size={12} /> : <Trash2 size={12} />} Delete
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="sec">
        <h3>Small print</h3>
        <div className="group tiled">
          <button className="li" type="button" onClick={() => navigate("/tos")}>
            <span className="t">
              <b>Terms of Service</b>
            </span>
            <ChevronRight className="chev" aria-hidden="true" />
          </button>
          <button className="li" type="button" onClick={() => navigate("/pp")}>
            <span className="t">
              <b>Privacy Policy</b>
            </span>
            <ChevronRight className="chev" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="pfoot">
        <span>Keepsake 0.1.0</span>
        <span>Your AI. Your memory. Your control.</span>
      </div>
    </section>
  );
}
