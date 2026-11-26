/**
 * Keepsake's mode and consent state, shared through React context.
 *
 * This is the app-facing half of the inference boundary. Components read the
 * active mode and the parked "needs consent" request, and call `request()` /
 * `approve()`. All the policy lives in `ask.ts`; this only holds the state
 * around it and binds an approval to the exact payload on screen.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { approve, type Approval, type ConsentRequest } from "../../../shared/privacy/consent.js";
import type { Redaction } from "../../../shared/privacy/index.js";
import { ask, send, type Operation } from "./ask.js";
import { getEngine } from "./engine.js";
import type { InferenceResult, KeepsakeMode } from "./types.js";

export interface PendingConsent {
  redaction: Redaction;
  request: ConsentRequest;
  reason: string;
  /** The original text, so the decision can be applied to the exact turn. */
  text: string;
}

/**
 * What happened to one turn. The chat surface branches on `kind` rather than
 * on null-ness, so "the device answered", "the cloud needs approval" and "the
 * device cannot answer at all" stay distinct.
 */
export type TurnResult =
  | {
      kind: "answered";
      result: InferenceResult;
      /**
       * For a cloud answer, the hash of the sanitized payload the approval was
       * bound to. The store keeps the hash, never the payload.
       */
      consentHash?: string | null;
    }
  | { kind: "consent" }
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string };

export interface KeepsakeState {
  mode: KeepsakeMode;
  setMode: (mode: KeepsakeMode) => void;
  /** The payload parked for approval, or null. */
  pending: PendingConsent | null;
  /** Run a turn under the active mode. */
  request: (text: string, operation?: Operation) => Promise<TurnResult>;
  /** Approve the parked payload and send it to the cloud. */
  approve: () => Promise<TurnResult>;
  /** Decline the parked payload. */
  decline: () => void;
  busy: boolean;
  error: string | null;
}

const KeepsakeContext = createContext<KeepsakeState | null>(null);

const MODE_KEY = "keepsake.mode";

export function readMode(): KeepsakeMode {
  if (typeof localStorage === "undefined") return "vault";
  // Vault is the default: a new person gets on-device-only until they choose
  // otherwise. That is the safe default the product promises.
  return localStorage.getItem(MODE_KEY) === "hybrid" ? "hybrid" : "vault";
}

export function KeepsakeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<KeepsakeMode>(readMode);
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The approval bound to the payload currently parked for review.
  const approvalRef = useRef<Approval | null>(null);

  const setMode = useCallback((next: KeepsakeMode) => {
    setModeState(next);
    // Changing mode invalidates any parked consent: the destination may differ.
    approvalRef.current = null;
    setPending(null);
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_KEY, next);
  }, []);

  const request = useCallback(
    async (text: string, operation: Operation = "chat"): Promise<TurnResult> => {
      setBusy(true);
      setError(null);
      setPending(null);
      approvalRef.current = null;
      let engine;
      try {
        engine = await getEngine();
      } catch (err) {
        // The inference boundary itself could not be built (no Firebase project,
        // or the SDK is still starting). Name the real cause rather than leaking
        // a setup message into the chat.
        const message =
          mode === "vault"
            ? "Vault Mode is unavailable: the on-device model could not be reached on this device."
            : err instanceof Error
              ? err.message
              : "Cloud inference is unavailable right now.";
        setError(message);
        return { kind: "blocked", message };
      }
      try {
        const outcome = await ask({ mode, text, engine, operation });
        if (outcome.kind === "answered")
          // A clean Hybrid payload is sent without a tap; the hash travels with
          // the answer so the receipt can still record what left the device.
          return { kind: "answered", result: outcome.result, consentHash: outcome.consentHash };
        if (outcome.kind === "blocked") {
          setError(outcome.message);
          return { kind: "blocked", message: outcome.message };
        }
        setPending({ ...outcome, text });
        return { kind: "consent" };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Inference failed.";
        setError(message);
        return { kind: "failed", message };
      } finally {
        setBusy(false);
      }
    },
    [mode],
  );

  const approveTurn = useCallback(async (): Promise<TurnResult> => {
    const parked = pending;
    if (!parked) return { kind: "failed", message: "There is nothing waiting for approval." };
    setBusy(true);
    setError(null);
    try {
      const engine = await getEngine();
      // Bind an approval to the exact payload that is on screen right now.
      const approval = approve(parked.request);
      approvalRef.current = approval;
      const result = await send({
        engine,
        request: parked.request,
        redaction: parked.redaction,
        approval,
      });
      setPending(null);
      return { kind: "answered", result, consentHash: parked.request.hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : "The cloud request was refused.";
      setError(message);
      return { kind: "failed", message };
    } finally {
      setBusy(false);
    }
  }, [pending]);

  const decline = useCallback(() => {
    approvalRef.current = null;
    setPending(null);
  }, []);

  const value = useMemo<KeepsakeState>(
    () => ({ mode, setMode, pending, request, approve: approveTurn, decline, busy, error }),
    [mode, setMode, pending, request, approveTurn, decline, busy, error],
  );

  return <KeepsakeContext.Provider value={value}>{children}</KeepsakeContext.Provider>;
}

export function useKeepsake(): KeepsakeState {
  const value = useContext(KeepsakeContext);
  if (!value) throw new Error("useKeepsake must be used inside KeepsakeProvider");
  return value;
}
