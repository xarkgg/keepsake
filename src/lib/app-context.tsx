import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";
import { configureFirebase, firebaseReady, firebaseSignInWithPassword, firebaseSignOut, firebaseSignUp } from "./firebase";
import { signInWithFallback } from "./sign-in";
import { SessionRequests } from "./session-requests";
import type { Account, Bootstrap } from "./types";

/**
 * The app is in exactly one of these phases at a time. This replaces four
 * independent booleans (loading/needsAuth/error/bootstrap) whose priority
 * ordering lived implicitly in App.tsx.
 */
export type AppPhase = "booting" | "unauthenticated" | "error" | "onboarding" | "ready";

interface AppState {
  bootstrap: Bootstrap | null;
  phase: AppPhase;
  /** True only during the very first bootstrap, before any phase is known. */
  loading: boolean;
  error: string | null;
  needsAuth: boolean;
  reloadBootstrap: () => Promise<Bootstrap | null>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string }) => Promise<void>;
  signOut: () => Promise<void>;
  account: Account | null;
}

interface SessionState {
  bootstrap: Bootstrap | null;
  booted: boolean;
  needsAuth: boolean;
  error: string | null;
}

type SessionAction =
  | { type: "loaded"; bootstrap: Bootstrap }
  | { type: "unauthenticated" }
  | { type: "failed"; error: string };

const initial: SessionState = {
  bootstrap: null,
  booted: false,
  needsAuth: false,
  error: null,
};

/**
 * Every transition clears the fields that do not belong to the destination
 * phase, so the state can never hold contradictory flags.
 */
function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "loaded":
      return { bootstrap: action.bootstrap, booted: true, needsAuth: false, error: null };
    case "unauthenticated":
      return { bootstrap: null, booted: true, needsAuth: true, error: null };
    case "failed":
      return { ...state, booted: true, error: action.error };
  }
}

function phaseOf(state: SessionState): AppPhase {
  // Same priority the old App.tsx rendered in: a known-unauthenticated state
  // wins over a stale error, and an error only shows when there is no bootstrap.
  if (state.needsAuth) return "unauthenticated";
  if (state.error && !state.bootstrap) return "error";
  if (!state.bootstrap) return "booting";
  return state.bootstrap.onboarded ? "ready" : "onboarding";
}

const AppContext = createContext<AppState | null>(null);

async function clearOfflineCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.delete("keepsake-runtime-v1");
  } catch {
    // ignore
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initial);
  const requests = useRef(new SessionRequests());

  const reloadBootstrap = useCallback(async () => {
    const current = requests.current.beginLoad();
    if (!current) return null;
    try {
      const data = await api<Bootstrap>("/api/bootstrap");
      if (!current()) return null;
      configureFirebase(data.firebase ?? null);
      dispatch({ type: "loaded", bootstrap: data });
      return data;
    } catch (err) {
      if (!current()) return null;
      if (err instanceof ApiError && err.status === 401) {
        await clearOfflineCache();
        if (current()) dispatch({ type: "unauthenticated" });
        return null;
      }
      dispatch({ type: "failed", error: err instanceof Error ? err.message : "Could not reach Keepsake" });
      return null;
    }
  }, []);

  const authenticate = useCallback(async (action: () => Promise<void>) => {
    const change = requests.current.beginChange();
    try {
      await clearOfflineCache();
      if (!change.current()) return;
      await action();
    } catch (error) {
      change.finish();
      throw error;
    }
    if (change.finish()) await reloadBootstrap();
  }, [reloadBootstrap]);

  const signIn = useCallback(
    (email: string, password: string) => authenticate(async () => {
      await signInWithFallback({
        firebaseReady: firebaseReady(),
        firebaseSignIn: () => firebaseSignInWithPassword(email, password),
        serverSignIn: async () => {
          await api<{ account: Account }>("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password }),
          });
        },
      });
    }),
    [authenticate],
  );

  const signUp = useCallback(
    (input: { email: string; password: string; name: string }) => authenticate(async () => {
      if (firebaseReady()) {
        await firebaseSignUp(input);
      } else {
        await api<{ account: Account }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify(input),
        });
      }
    }),
    [authenticate],
  );

  const signOut = useCallback(async () => {
    const change = requests.current.beginChange();
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // The local state still needs to clear.
    }
    if (!change.current()) return;
    await firebaseSignOut().catch(() => undefined);
    if (!change.current()) return;
    await clearOfflineCache();
    if (change.finish()) dispatch({ type: "unauthenticated" });
  }, []);

  useEffect(() => {
    void (async () => {
      await reloadBootstrap();
    })();
  }, [reloadBootstrap]);

  const phase = phaseOf(state);

  return (
    <AppContext.Provider
      value={{
        bootstrap: state.bootstrap,
        phase,
        loading: !state.booted,
        error: state.error,
        needsAuth: state.needsAuth,
        reloadBootstrap,
        signIn,
        signUp,
        signOut,
        account: state.bootstrap?.account ?? null,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
