# Keepsake architecture

The browser runs the conversation. The account API handles sign-in and profile
data. It has no route for generating answers or storing conversation text.

## Inference

[`assemblePrompt`](../shared/keepsake/prompt.ts) combines the current message
and recent conversation context in the browser. Both modes try the local model
through the [Firebase AI Logic adapter](../src/lib/inference/firebase-ai.ts)
using `ONLY_ON_DEVICE`. If generation fails in Vault Mode, the turn ends there.

In Hybrid Mode, [`ask`](../src/lib/inference/ask.ts) passes the assembled text
through the [redaction rules](../shared/privacy/rules.ts) before a cloud request
can be made. Matching values become placeholders such as `[email#1]`. The rules
identify specific patterns and do not guarantee that the text is anonymous.

- If the rules find a match, the consent card shows the redacted text, what was
  replaced, the destination and a fingerprint. Declining sends no cloud request.
- If there are no matches, the same sanitized text can be sent without a prompt
  for approval.

The [consent check](../shared/privacy/consent.ts) binds approval to the payload
hash, operation and destination. A different request needs a new approval.
Cloud generation uses `ONLY_IN_CLOUD` and requires Firebase App Check. The
default cloud model is `gemini-3.5-flash-lite`. The reply badge shows the source
and, for a cloud reply, the model name.

## Storage

The [conversation store](../shared/keepsake/store.ts) keeps messages, titles
and reply metadata in the browser through [IndexedDB](../src/lib/keepsake/idb.ts).
A cloud reply can carry the sanitized payload's fingerprint. Chats do not
sync between devices. Clearing the site's storage removes them.

The server stores accounts and sessions in Postgres. Each account has its own
schema for profile and settings. See [self-hosting](OPERATIONS.md) for database
configuration and [Firebase setup](FIREBASE_SETUP.md) for authentication and
App Check.
