import { Cloud, HardDrive } from "lucide-react";
import type { InferenceSource } from "../../lib/inference/types";
import { cn } from "../../lib/utils";

/**
 * Display the receipt beneath the reply, separate from the generated text.
 * Cloud receipts include the model name when one is available.
 */
export function SourceBadge({
  source,
  model,
}: {
  source: InferenceSource | null;
  model?: string | null;
}) {
  if (!source) return null;
  const onDevice = source === "on-device";
  return (
    <span className={cn("dlv", "is-in", !onDevice && "is-cloud")}>
      {onDevice ? <HardDrive size={11} strokeWidth={2} /> : <Cloud size={11} strokeWidth={2} />}
      {onDevice ? "On device" : `Cloud${model ? ` · ${model}` : ""}`}
    </span>
  );
}
