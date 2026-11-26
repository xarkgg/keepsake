import markLight from "../assets/brand/mark-light.png";

/**
 * The Keepsake mark: three stacked cards, drawn from the brand artwork and
 * keyed to white-on-transparent so it sits on the app's dark ground. It is a
 * raster because the source art is; at 256px it is crisp up to ~3x the sizes
 * the interface uses (26px in the chat header, 74px on the profile pane).
 */
export function KeepsakeMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <img
      className={className}
      src={markLight}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** The mark beside the `keepsake.` wordmark, sized to the surrounding text. */
export function KeepsakeWordmark() {
  return (
    <>
      <KeepsakeMark className="brand-mark" />
      <span className="brand-word">
        keepsake<span className="brand-dot">.</span>
      </span>
    </>
  );
}
