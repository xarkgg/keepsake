import { approve as bindApproval } from "../../../shared/privacy/consent.js";
import { ask, send, type AskOutcome, type Operation } from "./ask.js";
import type { Engine, InferenceResult, KeepsakeMode } from "./types.js";

export interface TurnOwner {
  readonly sessionId: string;
  readonly turnId: string; // The persisted user message.
}

type Card = Extract<AskOutcome, { kind: "needs-consent" }> & { readonly owner: TurnOwner };
export type TurnState =
  | { phase: "idle" }
  | { phase: "asking"; owner: TurnOwner; controller: AbortController }
  | { phase: "blocked"; owner: TurnOwner; message: string }
  | { phase: "failed"; owner: TurnOwner; message: string; prompt: string; operation: Operation }
  | { phase: "review"; card: Card; error?: string }
  | { phase: "sending"; card: Card };

export interface OwnedReply {
  readonly owner: TurnOwner;
  result: InferenceResult;
  consentHash?: string;
}

export function turnBusy(state: TurnState): boolean {
  return state.phase === "asking" || state.phase === "sending";
}

/** One live chat view owns a turn. Only the original message can approve its card. */
export class ChatTurns {
  private state: TurnState = { phase: "idle" };
  private listeners = new Set<() => void>();

  constructor(private readonly load: () => Promise<Engine>) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: TurnState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  reset = () => {
    if (this.state.phase === "asking") this.state.controller.abort();
    if (this.state.phase !== "idle") this.publish({ phase: "idle" });
  };

  async request(origin: TurnOwner, mode: KeepsakeMode, prompt: string, operation: Operation = "chat"): Promise<OwnedReply | null> {
    if (turnBusy(this.state)) return null;
    const owner = Object.freeze({ sessionId: origin.sessionId, turnId: origin.turnId });
    const run = { phase: "asking" as const, owner, controller: new AbortController() };
    this.publish(run);
    let engine: Engine;
    try {
      engine = await this.load();
    } catch (err) {
      const message = mode === "vault"
        ? "Vault Mode is unavailable: the on-device model could not be reached on this device."
        : err instanceof Error ? err.message : "Cloud inference is unavailable right now.";
      if (this.state === run) this.publish({ phase: "blocked", owner, message });
      return null;
    }
    if (this.state !== run) return null;
    try {
      const outcome = await ask({ mode, text: prompt, engine, operation, signal: run.controller.signal });
      if (outcome.kind === "answered") {
        if (this.state === run) this.publish({ phase: "idle" });
        return { owner, result: outcome.result, consentHash: outcome.consentHash };
      }
      if (this.state === run) {
        this.publish(outcome.kind === "blocked"
          ? { phase: "blocked", owner, message: outcome.message }
          : { phase: "review", card: { ...outcome, owner } });
      }
    } catch (err) {
      if (this.state === run) this.publish({ phase: "failed", owner, prompt, operation,
        message: err instanceof Error ? err.message : "Inference failed." });
    }
    return null;
  }

  async approve(owner: TurnOwner): Promise<OwnedReply | null> {
    const state = this.state;
    if (state.phase !== "review" || state.card.owner.sessionId !== owner.sessionId || state.card.owner.turnId !== owner.turnId) return null;
    const { card } = state;
    const run = { phase: "sending" as const, card };
    this.publish(run);
    try {
      const engine = await this.load();
      if (this.state !== run) return null;
      const result = await send({ engine, request: card.request, redaction: card.redaction, approval: bindApproval(card.request) });
      if (this.state === run) this.publish({ phase: "idle" });
      // An already-sent request can finish after navigation. Its owner never changes.
      return { owner: card.owner, result, consentHash: card.request.hash };
    } catch (err) {
      if (this.state === run) this.publish({ phase: "review", card,
        error: err instanceof Error ? err.message : "The cloud request was refused." });
      return null;
    }
  }
}
