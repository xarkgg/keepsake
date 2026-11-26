import { ShieldCheck, X } from "lucide-react";
import type { Redaction } from "../../../shared/privacy/index";
import { cn } from "../../lib/utils";

/**
 * The consent preview. What makes this honest is that it shows the exact string
 * that would leave the device, not a summary of it, plus what was replaced.
 * The person approves a payload they can read, and the approval is bound to
 * that payload's hash, so editing the text invalidates it.
 */
export function ConsentPreview({
  redaction,
  destination,
  busy,
  onApprove,
  onDecline,
}: {
  redaction: Redaction;
  /** The human-readable destination, e.g. "Firebase AI Logic · gemini-4-hydrogen". */
  destination: string;
  busy?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const clean = redaction.count === 0;
  return (
    <div className="consent-card" role="dialog" aria-label="Approve cloud inference">
      <header className="consent-head">
        <ShieldCheck size={15} strokeWidth={1.9} />
        <span>
          {clean
            ? "This needs the cloud. Here is exactly what would be sent."
            : "Personal details were found and removed. Here is exactly what would be sent."}
        </span>
      </header>

      <div className="consent-payload" aria-label="Sanitized payload">
        {redaction.spans.length ? (
          <HighlightedText text={redaction.text} spans={redaction.spans} />
        ) : (
          <pre className="consent-text">{redaction.text}</pre>
        )}
      </div>

      <div className="consent-findings">
        {clean ? (
          <span className="consent-clean">No personal data detected.</span>
        ) : (
          <ul className="consent-list">
            {redaction.findings.map((finding) => (
              <li key={finding.rule}>
                <code>{finding.placeholders[0]}</code>
                <span>
                  replaced {finding.count} {finding.label}
                  {finding.count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="consent-meta">
        <div>
          <dt>Goes to</dt>
          <dd>{destination}</dd>
        </div>
        <div>
          <dt>Payload fingerprint</dt>
          <dd>
            <code>{redaction.hash.slice(0, 16)}</code>
          </dd>
        </div>
      </dl>

      <div className="consent-actions">
        <button className="primary-btn small" onClick={onApprove} disabled={busy}>
          {busy ? "Sending…" : "Approve and send"}
        </button>
        <button className="ghost-btn small" onClick={onDecline} disabled={busy}>
          <X size={13} /> Keep it local
        </button>
      </div>
      <p className="consent-note">
        {clean
          ? "Your original text stays on this device. Only the string above is sent."
          : "Your original text stays on this device. Only the redacted string above is sent."}
      </p>
    </div>
  );
}

/**
 * Renders the sanitized payload with each placeholder marked, so the redactions
 * are visible in place rather than only listed beneath.
 */
function HighlightedText({
  text,
  spans,
}: {
  text: string;
  spans: Redaction["spans"];
}) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  spans
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((span, index) => {
      if (span.start > cursor) nodes.push(text.slice(cursor, span.start));
      nodes.push(
        <mark key={`${span.rule}-${index}`} className="consent-span" title={span.label}>
          {span.placeholder}
        </mark>,
      );
      cursor = span.end;
    });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <pre className={cn("consent-text", "has-spans")}>{nodes}</pre>;
}
