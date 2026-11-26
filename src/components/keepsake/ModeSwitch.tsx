import { HardDrive, Cloud } from "lucide-react";
import type { DeviceAvailability, KeepsakeMode } from "../../lib/inference/types";
import { cn } from "../../lib/utils";

/**
 * The Vault / Hybrid switch. This is the control that decides whether an answer
 * is allowed to leave the device, so it is stated plainly rather than implied:
 * Vault is "stays on your device", Hybrid is "may ask before using the cloud".
 */
export function ModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: KeepsakeMode;
  onChange: (mode: KeepsakeMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Inference mode">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "vault"}
        className={cn("mode-option", mode === "vault" && "is-active")}
        onClick={() => onChange("vault")}
        disabled={disabled}
        title="Vault Mode, everything stays on this device"
      >
        <HardDrive size={13} strokeWidth={1.9} />
        <span>Vault</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "hybrid"}
        className={cn("mode-option", mode === "hybrid" && "is-active")}
        onClick={() => onChange("hybrid")}
        disabled={disabled}
        title="Hybrid Mode, on device first, the cloud only with your approval"
      >
        <Cloud size={13} strokeWidth={1.9} />
        <span>Hybrid</span>
      </button>
    </div>
  );
}

/** The one-line explanation of what the current mode means. */
export function ModeHint({ mode, deviceReady }: { mode: KeepsakeMode; deviceReady?: DeviceAvailability }) {
  return (
    <p className="mode-hint">
      {mode === "vault"
        ? "Vault Mode: answers come only from this device. Nothing is sent anywhere."
        : "Hybrid Mode: answers come from this device when they can, and ask before using the cloud when they cannot."}
      {mode === "vault" && deviceReady === "unsupported"
        ? " This browser has no built-in model, so Vault Mode cannot answer here, Hybrid Mode can."
        : null}
      {mode === "vault" && (deviceReady === "downloadable" || deviceReady === "downloading")
        ? " Download the built-in model below before sending a message."
        : null}
    </p>
  );
}
