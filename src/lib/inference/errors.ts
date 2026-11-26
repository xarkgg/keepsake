/**
 * Typed failures for the inference boundary, so the UI can say precisely what
 * went wrong instead of surfacing a raw SDK string.
 */

export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}

/** Vault Mode was asked for an answer the device cannot produce. */
export class DeviceUnavailableError extends InferenceError {
  constructor(message = "The on-device model is not available on this device.") {
    super(message);
    this.name = "DeviceUnavailableError";
  }
}

/** Hybrid Mode wants to use the cloud and has not been approved yet. */
export class ConsentRequiredError extends InferenceError {
  constructor(message = "This needs cloud inference, which requires your approval.") {
    super(message);
    this.name = "ConsentRequiredError";
  }
}

/** A cloud request was attempted without a matching approval. */
export class ConsentInvalidError extends InferenceError {
  reason: string;
  constructor(reason: string) {
    super(`The cloud request was refused: ${reason}.`);
    this.name = "ConsentInvalidError";
    this.reason = reason;
  }
}

/**
 * Translate an App Check rejection into something a person can act on.
 *
 * When attestation fails (reCAPTCHA could not score the device, or the token
 * expired), the SDK sends a placeholder token and the model API answers 401
 * "Firebase App Check token is invalid". Worse, a 403 from the token exchange
 * makes the App Check SDK throttle itself for a day and then throw
 * `appCheck/initial-throttle` ("Attempts allowed again after 01d:00m:00s")
 * before any request is made, which used to read as "the request did not
 * complete", with nothing to do about it. That throttle lives in page memory,
 * so a reload clears it. Returns null for any other failure.
 */
export function appCheckFailureMessage(error: unknown): string | null {
  const message = messageOf(error);
  if (
    /App Check token is invalid|App attestation failed|appCheck\/(?:initial-throttle|throttled)|Attempts allowed again/i.test(
      message,
    )
  ) {
    return "Firebase App Check did not accept this browser, so the request never reached the model. That is normally the attestation check being blocked, an ad blocker, a private window, or a filtered network. Reload the page, then try again in a normal Chrome window.";
  }
  return null;
}

/** The raw string a failure carries, whatever shape it arrived in. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Has the free-tier quota been spent, rather than the model being busy?
 *
 * `429` is a hard "no" until the quota window rolls over, so retrying inside
 * the same turn only adds delay. Capacity errors (`500`/`503`) are the opposite:
 * the same request can succeed seconds later.
 */
export function isQuotaError(error: unknown): boolean {
  return /\[429\b|exceeded your current quota|resource[_ ]exhausted|quota exceeded/i.test(
    messageOf(error),
  );
}

/**
 * Is this the cloud being busy rather than the request being wrong?
 *
 * The free tier returns 500/503 with "This model is currently experiencing high
 * demand" when capacity is short, and the SDK aborts a request with
 * "Timeout has expired." when Google never starts answering. Both are worth
 * retrying: the same payload, operation and destination, so a retry never
 * changes what an approval authorised. A spent quota is not, so it is excluded.
 */
export function isTransientCloudError(error: unknown): boolean {
  if (isQuotaError(error)) return false;
  return /\[(?:500|502|503|504)\b|high demand|overloaded|temporarily unavailable|service unavailable|unavailable|timeout has expired|timed out|network|fetch failed|failed to fetch/i.test(
    messageOf(error),
  );
}

/**
 * A device failure the person can act on.
 *
 * The on-device path has nothing to do with the cloud, so its failures must not
 * be described as cloud failures: a Vault message that says "the cloud request
 * did not complete" is false, and it points at a network that was never used.
 * Each cause here is something the local model actually reports, no browser
 * model, a model still downloading, or a prompt past the local context window.
 */
export function deviceFailureMessage(error: unknown): string {
  const raw = messageOf(error);
  if (/too (?:long|large)|context (?:window|length)|maximum (?:tokens|length)|exceeds? .*tokens/i.test(raw)) {
    return "This message is longer than the on-device model can hold. Shorten it, or switch to Hybrid Mode for a larger model.";
  }
  if (/download|initializ|not ready|still loading|warm ?up|provision/i.test(raw)) {
    return "The on-device model is not ready yet. Open Where it thinks in the side pane to start or watch its download, then try again.";
  }
  if (
    /not (?:available|supported)|unsupported|no (?:on-?device )?model|LanguageModel|capabilit|not be found|undefined/i.test(
      raw,
    )
  ) {
    return "This browser has no on-device model Keepsake can use. It needs desktop Chrome 148 or later with the built-in model installed, so nothing left this device and nothing was sent elsewhere.";
  }
  return "The on-device model could not produce an answer this time. Nothing left this device, try again, or switch to Hybrid Mode.";
}

/** Setup failures describe Chrome's model download, never a private prompt. */
export function deviceDownloadFailureMessage(error: unknown): string {
  const raw = messageOf(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || /user (?:activation|gesture|interaction)/i.test(raw)) {
    return "Chrome needs a click to start the download. Press Start the download again and keep this tab open.";
  }
  if (/disk|storage|space|quota/i.test(raw)) {
    return "Chrome needs at least 22 GB free on the drive holding its profile. Free up space, then try the download again.";
  }
  if (/network|metered|offline|connection/i.test(raw)) {
    return "Chrome needs an unmetered internet connection for the model download. Connect to one, then try again.";
  }
  return "Chrome could not finish preparing the model. Check that you have 22 GB free and an unmetered connection. For the download status, open chrome://on-device-internals in another tab.";
}

/**
 * The failure copy for whichever path failed.
 *
 * Kept in one place so a device failure can never be labelled with the cloud
 * message, which is exactly what happened when `generate()` ended both paths
 * with `cloudFailureMessage`.
 */
export function engineFailureMessage(where: "on-device" | "cloud", error: unknown): string {
  return where === "cloud" ? cloudFailureMessage(error) : deviceFailureMessage(error);
}

/**
 * A cloud failure the person can act on.
 *
 * The SDK's own string names a project, an endpoint and a model id, none of
 * which is useful to a person, and all of which reads like something they did
 * wrong. Anything not recognised here becomes one plain sentence; the raw error
 * is logged to the console for whoever is debugging the deployment.
 */
export function cloudFailureMessage(error: unknown): string {
  const raw = messageOf(error);
  if (isQuotaError(error)) {
    return "The free cloud quota is used up for the moment. It comes back on its own, usually within a minute, try again shortly.";
  }
  if (/timeout has expired|timed out|abort/i.test(raw)) {
    return "The cloud did not start answering in time, so the request was abandoned. That is usually capacity; try again in a moment.";
  }
  if (/network|fetch failed|failed to fetch/i.test(raw)) {
    return "The cloud could not be reached. Check the connection and try again, nothing was sent anywhere else.";
  }
  if (isTransientCloudError(error)) {
    return "The cloud model is at capacity right now, that is Google's queue, not your message. Try again in a moment.";
  }
  if (/\[(?:401|403)\b/.test(raw)) {
    return "The cloud refused this request's credentials. If it keeps happening, the deployment's Firebase settings need attention.";
  }
  if (/\[404\b|not found|unsupported model/i.test(raw)) {
    return "The cloud no longer offers this model. The request was not sent anywhere else.";
  }
  return "The cloud request did not complete. Nothing was saved from it; try again.";
}
