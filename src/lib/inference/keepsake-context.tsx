import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChatTurns, turnBusy, type TurnState } from "./chat-turns.js";
import { getEngine } from "./engine.js";
import type { KeepsakeMode } from "./types.js";

interface KeepsakeState {
  mode: KeepsakeMode;
  setMode: (mode: KeepsakeMode) => void;
  turns: ChatTurns;
  turn: TurnState;
  busy: boolean;
}

const KeepsakeContext = createContext<KeepsakeState | null>(null);
const MODE_KEY = "keepsake.mode";

export function readMode(): KeepsakeMode {
  if (typeof localStorage === "undefined") return "vault";
  return localStorage.getItem(MODE_KEY) === "hybrid" ? "hybrid" : "vault";
}

export function KeepsakeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<KeepsakeMode>(readMode);
  const [turns] = useState(() => new ChatTurns(getEngine));
  const turn = useSyncExternalStore(turns.subscribe, turns.snapshot);
  const setMode = useCallback((next: KeepsakeMode) => {
    turns.reset();
    setModeState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_KEY, next);
  }, [turns]);
  const value = useMemo<KeepsakeState>(
    () => ({ mode, setMode, turns, turn, busy: turnBusy(turn) }), [mode, setMode, turns, turn],
  );
  return <KeepsakeContext.Provider value={value}>{children}</KeepsakeContext.Provider>;
}

export function useKeepsake(): KeepsakeState {
  const value = useContext(KeepsakeContext);
  if (!value) throw new Error("useKeepsake must be used inside KeepsakeProvider");
  return value;
}
