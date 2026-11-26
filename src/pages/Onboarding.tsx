import { Sparkles } from "lucide-react";
import { useState } from "react";
import { KeepsakeWordmark } from "../components/KeepsakeMark";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useToast } from "../lib/toast";

/**
 * One question, then in. Keepsake has no location, no focus list and no
 * personalisation to gather, the only thing worth knowing is what to call
 * the person, and even that is skippable.
 */
export function Onboarding() {
  const { bootstrap, reloadBootstrap } = useApp();
  // Prefill with the name we already have (Firebase/Google display name or the
  // sign-up name) so a returning person is not asked for it again.
  const [name, setName] = useState(bootstrap?.profile.name ?? bootstrap?.account.name ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const finish = async (skip = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ name: skip ? "" : name.trim() }),
      });
      await reloadBootstrap();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save that", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-bg" />
      <div className="onboarding-card">
        <header className="onboarding-brand">
          <span className="brand-lockup">
            <KeepsakeWordmark />
          </span>
        </header>

        <div className="onboarding-step">
          <p className="eyebrow">A quieter system</p>
          <h1 className="display onboarding-title">
            What should I <em>call you?</em>
          </h1>
          <p className="onboarding-copy">
            Everything you tell Keepsake stays on this device unless you explicitly send it to the cloud.
            Start by telling me your name.
          </p>
          <input
            className="input big-input"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your first name"
            onKeyDown={(event) => {
              if (event.key === "Enter") void finish();
            }}
          />
        </div>

        <footer className="onboarding-foot">
          <div>
            <button className="ghost-btn quiet" onClick={() => void finish(true)} disabled={busy}>
              Skip for now
            </button>
          </div>
          <button className="primary-btn" onClick={() => void finish()} disabled={busy}>
            <Sparkles size={15} /> Meet Keepsake
          </button>
        </footer>
      </div>
      <p className="onboarding-footnote">Private by default. No ads. No feed. No parasocial nonsense.</p>
    </div>
  );
}
