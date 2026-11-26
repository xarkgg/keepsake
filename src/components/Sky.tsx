import { useEffect } from "react";

/**
 * The app ground.
 *
 * The original design painted a time-of-day sky: a gradient, a sun, drifting
 * clouds and film grain, all driven by local sunrise and sunset. The square
 * terminal language it now follows draws depth with hairline borders on one
 * flat surface, so there is no sky to sit behind the content and no phase to
 * track. What remains is a single near-black ground plus the theme-color the
 * OS paints the installed app's status-bar strip with.
 */
export function Sky() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = "#0b0b0c";
  }, []);

  return <div className="sky" aria-hidden="true" />;
}
