import { Cloud, X } from "lucide-react";
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
  return (
    <div className="consent-card" role="dialog" aria-label="Approve cloud inference">
      <header className="consent-head">
        <Cloud size={15} strokeWidth={1.9} />
        <span>Review the text before sending it to Google.</span>
      </header>

      <div className="consent-payload" role="region" aria-label="Text to send" tabIndex={0}>
        {redaction.spans.length ? (
          <HighlightedText text={redaction.text} spans={redaction.spans} />
        ) : (
          <pre className="consent-text">{redaction.text}</pre>
        )}
      </div>

      <div className="consent-findings">
        {redaction.count === 0 ? (
          <span>No patterns matched. The text above would be sent as written.</span>
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

      <p className="consent-note">Check for details the rules can miss, like a name or a confidential plan.</p>
      <div className="consent-actions">
        <button className="primary-btn small" onClick={onApprove} disabled={busy}>
          {busy ? "Sending…" : "Approve and send"}
        </button>
        <button className="ghost-btn small" onClick={onDecline} disabled={busy}>
          <X size={13} /> Keep it local
        </button>
      </div>
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
          {text.slice(span.start, span.end)}
        </mark>,
      );
      cursor = span.end;
    });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <pre className={cn("consent-text", "has-spans")}>{nodes}</pre>;
}
