import { useCallback, useEffect, useState } from "react";
import { Sky } from "./components/Sky";
import { KeepsakeWordmark } from "./components/KeepsakeMark";
import { Spinner } from "./components/UI";
import { AppProvider, useApp } from "./lib/app-context";
import { KeepsakeProvider } from "./lib/inference/keepsake-context";
import { VaultProvider } from "./lib/keepsake/vault-context";
import { ToastProvider } from "./lib/toast";
import { AuthPage } from "./pages/Auth";
import { ChatPage } from "./pages/Chat";
import { PrivacyPage, TermsPage } from "./pages/Legal";
import { Onboarding } from "./pages/Onboarding";

/**
 * Three routes, one screen.
 *
 * Everything that used to be a page of its own, the home list, the settings
 * form, now lives inside the chat device: the conversation on the right, and
 * your chats, the inference mode and the account in the second view. Terms and
 * Privacy stay standalone documents because they must be reachable before
 * sign-in.
 */
type Route = { name: "chat"; id?: string } | { name: "terms" } | { name: "privacy" };

function parse(pathname: string): Route {
  if (pathname.startsWith("/chat/")) return { name: "chat", id: pathname.slice(6) };
  if (pathname === "/tos") return { name: "terms" };
  if (pathname === "/pp") return { name: "privacy" };
  return { name: "chat" };
}

const TITLES: Record<Route["name"], string> = {
  chat: "Keepsake",
  terms: "Terms of Service · Keepsake",
  privacy: "Privacy Policy · Keepsake",
};

function Shell() {
  const { bootstrap, loading, error, phase, reloadBootstrap } = useApp();
  const [location, setLocation] = useState(() => ({ route: parse(window.location.pathname), visit: 0 }));
  const { route } = location;
  const enterLocation = useCallback(() => {
    const next = parse(window.location.pathname);
    setLocation((previous) => ({ route: next, visit: previous.visit + 1 }));
  }, []);

  useEffect(() => {
    window.addEventListener("popstate", enterLocation);
    return () => window.removeEventListener("popstate", enterLocation);
  }, [enterLocation]);

  useEffect(() => {
    document.title = TITLES[route.name];
  }, [route.name]);

  const navigate = useCallback((path: string) => {
    if (path === window.location.pathname) return;
    window.history.pushState({}, "", path);
    enterLocation();
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [enterLocation]);

  // Creating a chat gives this visit a URL without unmounting its first turn.
  const adoptSession = useCallback((id: string) => {
    window.history.replaceState({}, "", `/chat/${id}`);
    setLocation((previous) => ({ ...previous, route: { name: "chat", id } }));
  }, []);

  // Terms and Privacy are public: they render without an account, so they are
  // reachable from the sign-in screen and satisfy the "publicly reachable
  // privacy policy URL" requirement for OAuth verification.
  if (route.name === "terms" || route.name === "privacy") {
    return (
      <>
        <Sky />
        {route.name === "terms" ? (
          <TermsPage navigate={navigate} />
        ) : (
          <PrivacyPage navigate={navigate} />
        )}
      </>
    );
  }

  if (loading) {
    return (
      <>
        <Sky />
        <div className="splash">
          <span className="splash-brand">
            <KeepsakeWordmark />
          </span>
          <Spinner size={16} />
        </div>
      </>
    );
  }

  if (phase === "unauthenticated") {
    return (
      <>
        <Sky />
        <AuthPage navigate={navigate} />
      </>
    );
  }

  if (phase === "error") {
    return (
      <>
        <Sky />
        <div className="splash">
          <span className="splash-brand">
            <KeepsakeWordmark />
          </span>
          <p className="splash-text">{error}</p>
          <button className="ghost-btn" onClick={() => void reloadBootstrap()}>
            Try again
          </button>
        </div>
      </>
    );
  }

  if (phase === "booting" || !bootstrap) {
    return (
      <>
        <Sky />
        <div className="splash">
          <span className="splash-brand">
            <KeepsakeWordmark />
          </span>
        </div>
      </>
    );
  }

  if (phase === "onboarding") {
    return (
      <>
        <Sky />
        <Onboarding />
      </>
    );
  }

  return (
    <KeepsakeProvider key={JSON.stringify([bootstrap.account.id, location.visit])}>
      <ChatPage navigate={navigate} adoptSession={adoptSession} threadId={route.id} />
    </KeepsakeProvider>
  );
}

export default function App() {
  return (
    <AppProvider>
      <VaultProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </VaultProvider>
    </AppProvider>
  );
}
