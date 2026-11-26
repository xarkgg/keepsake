import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "./utils";

type Tone = "default" | "error" | "success";

interface Toast {
  id: string;
  message: string;
  tone: Tone;
}

interface ToastState {
  toast: (message: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastState | null>(null);
/** How long a toast stays fully visible before it starts to leave. */
const VISIBLE_MS = 3400;
/** Matches the CSS exit duration, with slack; the fallback if no transition fires. */
const EXIT_MS = 260;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: Tone = "default") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((item) => (
          <ToastItem
            key={item.id}
            toast={item}
            onLeave={() => setToasts((current) => current.filter((row) => row.id !== item.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * One toast. It enters with a short rise, then, after its time is up, fades
 * and drops back out the same edge it came in on instead of vanishing. Removal
 * from state waits for that exit, so the element is never torn down
 * mid-transition. A timer backs up `transitionend`, so a toast can never get
 * stuck on screen if the transition does not run.
 */
function ToastItem({ toast, onLeave }: { toast: Toast; onLeave: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setLeaving(true), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onLeave, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onLeave]);

  return (
    <div
      className={cn("toast", `toast-${toast.tone}`, leaving && "is-leaving")}
      onTransitionEnd={(event) => {
        // Only the toast's own exit ends its life; ignore bubbles from children.
        if (leaving && event.target === event.currentTarget) onLeave();
      }}
      aria-hidden={leaving || undefined}
    >
      {toast.message}
    </div>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value.toast;
}
