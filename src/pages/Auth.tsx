import { ArrowRight, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { KeepsakeWordmark } from "../components/KeepsakeMark";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import {
  configureFirebase,
  consumeGoogleRedirect,
  firebaseSignInWithGoogle,
  preloadFirebaseAuth,
  type FirebaseWebConfig,
} from "../lib/firebase";
import { Spinner } from "../components/UI";

interface AuthConfig {
  needsSetup: boolean;
  signupsOpen: boolean;
  publicUrl: string;
  google: boolean;
  microsoft: boolean;
  slack: boolean;
  firebase: FirebaseWebConfig | null;
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function AuthPage({ navigate }: { navigate: (path: string) => void }) {
  const { signIn, signUp, reloadBootstrap } = useApp();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<AuthConfig>("/api/auth/config");
        // Set up Firebase before any sign-in so the buttons route through it.
        configureFirebase(data.firebase);
        setConfig(data);
        // Start the SDK downloading now. A popup can only be opened while the
        // click is still fresh, so the import must not happen inside the
        // handler on a phone's first tap.
        preloadFirebaseAuth();
        if (data.needsSetup) setMode("register");
        else if (!data.signupsOpen) setMode("login");
      } catch {
        setConfig(null);
      }
    })();
  }, []);

  const usingFirebase = Boolean(config?.firebase);

  // Phones sign in through a full-page redirect, so the result arrives on a
  // fresh page load rather than inside the click handler. Consume it once the
  // Firebase config is known.
  useEffect(() => {
    if (!usingFirebase) return;
    let cancelled = false;
    void (async () => {
      try {
        if (await consumeGoogleRedirect()) {
          if (!cancelled) await reloadBootstrap();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Google sign-in did not work.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [usingFirebase, reloadBootstrap]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !config) return;
    setError(null);
    if (mode === "register" && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "register") {
        await signUp({ email, password, name });
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    if (googleBusy || !usingFirebase) return;
    setError(null);
    setGoogleBusy(true);
    try {
      // Firebase opens the Google popup and we swap the ID token for the
      // Keepsake session cookie, then load the account.
      await firebaseSignInWithGoogle();
      await reloadBootstrap();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setGoogleBusy(false);
        return;
      }
      setError(err instanceof Error ? err.message : "Google sign-in did not work.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const canRegister = config?.signupsOpen ?? true;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-lockup">
            <KeepsakeWordmark />
          </span>
          <p>
            {config?.needsSetup
              ? "This server is new. Make the first account, then Keepsake is yours."
              : "Sign in to your Keepsake. Your conversations stay on this device; your account keeps only your profile."}
          </p>
        </div>

        {usingFirebase ? (
          <>
            <button
              type="button"
              className="google-btn"
              onClick={() => void google()}
              disabled={googleBusy}
            >
              {googleBusy ? <Spinner size={15} /> : <GoogleMark />}
              Continue with Google
            </button>
            <div className="auth-or">
              <span>or</span>
            </div>
          </>
        ) : null}

        <div className="auth-tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
          >
            Sign in
          </button>
          {canRegister ? (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              className={mode === "register" ? "active" : ""}
              onClick={() => {
                setMode("register");
                setError(null);
              }}
            >
              Create account
            </button>
          ) : null}
        </div>

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === "register" ? (
            <label className="auth-field is-extra">
              <span>Name</span>
              <div>
                <UserRound size={16} />
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="What should Keepsake call you?"
                  autoComplete="name"
                  maxLength={60}
                />
              </div>
            </label>
          ) : null}

          <label className="auth-field">
            <span>Email</span>
            <div>
              <Mail size={16} />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                autoFocus
              />
            </div>
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div>
              <LockKeyhole size={16} />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
                minLength={mode === "register" ? 8 : undefined}
              />
            </div>
          </label>

          {mode === "register" ? (
            <label className="auth-field is-extra">
              <span>Confirm</span>
              <div>
                <LockKeyhole size={16} />
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="Once more"
                  autoComplete="new-password"
                  required
                  minLength={10}
                />
              </div>
            </label>
          ) : null}

          {error ? <div className="auth-error">{error}</div> : null}

          <button className="primary-btn auth-submit" type="submit" disabled={busy}>
            {busy ? <Spinner size={15} /> : <ArrowRight size={16} />}
            {mode === "register" ? "Create my account" : "Sign in"}
          </button>
        </form>

        <p className="auth-note">
          {mode === "register" && canRegister
            ? usingFirebase
              ? "Sign-in is handled by Firebase. Sessions live in an httpOnly cookie. Each account gets its own database."
              : "Passwords are hashed with scrypt. Sessions live in an httpOnly cookie. Each account gets its own database."
            : "Accounts are separate. Nothing in one account is visible to another."}
        </p>

        <p className="auth-legal">
          {mode === "register" && canRegister ? (
            <>
              By creating an account you agree to the{" "}
              <a
                href="/tos"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/tos");
                }}
              >
                Terms
              </a>{" "}
              and the{" "}
              <a
                href="/pp"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/pp");
                }}
              >
                Privacy Policy
              </a>
              .
            </>
          ) : (
            <>
              <a
                href="/tos"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/tos");
                }}
              >
                Terms
              </a>{" "}
              ·{" "}
              <a
                href="/pp"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/pp");
                }}
              >
                Privacy Policy
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
