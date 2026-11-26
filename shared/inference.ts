/**
 * The two vocabulary types Keepsake's UI, store and inference layer all share.
 *
 * They live in `shared/` because the on-device store, the privacy core and the
 * browser app must agree on exactly these string values, a stored message
 * records which source answered it, and that value has to be one of these.
 * Keeping them here stops `shared/` from having to import from `src/`, which
 * would invert the dependency direction.
 */

/** How Keepsake decides where an answer comes from. */
export type KeepsakeMode = "vault" | "hybrid";

/** Where an answer actually came from. */
export type InferenceSource = "on-device" | "cloud";
