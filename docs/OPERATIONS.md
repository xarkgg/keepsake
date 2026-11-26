# Keepsake, operations

Use this guide to run Keepsake locally or host it with Postgres and Firebase.
For the hosted app and device requirements, see the [README](../README.md).

## Requirements

- Node.js 24 is recommended.
- A Postgres database for production. Neon through the Vercel Marketplace is the
  supported shape; any Postgres 14+ instance works. Development and tests need no
  database server, they use the embedded PGlite.
- A Firebase project for inference in either mode: the same project backs
  **Firebase Authentication** (sign-in) and **Firebase AI Logic** (the only cloud
  inference path). No service-account key or model API key is ever configured
  here, inference runs through the client SDK, gated by App Check.
- Without Firebase web configuration the app can start, but neither mode can
  generate an answer. Cloud inference also needs App Check.

## Run it

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The API runs on <http://127.0.0.1:8787> and Vite
proxies `/api` to it. Development and tests use PGlite, an embedded Postgres, so
no database server is needed; each process starts its own instance and PGlite's
first start takes a few seconds. The first account created becomes the owner of
the install.

For a production-style run:

```bash
npm run build
npm start
```

`npm start` serves `dist/` and binds to `0.0.0.0` by default. Put TLS in front of
it before opening it to the internet, and set `KEEPSAKE_PUBLIC_URL` to the exact
public origin (for example `https://keepsake.example.com`) so cookies are
correct.

```bash
KEEPSAKE_PUBLIC_URL=https://keepsake.example.com \
KEEPSAKE_TRUST_PROXY=1 \
npm start
```

`KEEPSAKE_SIGNUPS=closed` stops new registrations after the first account.
`KEEPSAKE_COOKIE_SECURE=always` forces Secure cookies when TLS terminates at a proxy.

### Shared demo accounts

`KEEPSAKE_DEMO_ACCOUNTS` takes a comma-separated list of email addresses. An
account on that list can sign in, but visitors cannot change its password or
delete it. Other accounts keep their normal account controls.

To offer a shared account on your own deployment, register it and complete
onboarding so that visitors land in the chat:

```bash
curl -c jar -X POST "$URL/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"<password>","name":"Demo"}'
curl -b jar -c jar -X POST "$URL/api/onboarding" -H 'Content-Type: application/json' \
  -d '{"name":"Demo"}'
```

### On-device model setup

**Vault Mode in development** needs desktop Chrome with Chrome's built-in model
(Gemini Nano) installed. Chrome **148+** exposes the Prompt API by default;
**139–147** additionally need
`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` enabled. The model
is downloaded separately. In Keepsake, open the side pane, find **Where it
thinks**, and press **Start the download**. The control starts Chrome's model
download after the click and displays its progress, then initializes the
device model in Firebase AI Logic. Readiness is checked again when
initialization completes. The temporary installation session receives no user
messages, and all inference runs through Firebase AI Logic.

The floor is 22 GB free on the drive holding the Chrome profile, and either a
GPU with more than 4 GB of VRAM or 16 GB of RAM with four CPU cores. The initial
download needs an unmetered internet connection. Keep the tab open while it
downloads. For Chrome's model and download status, open
`chrome://on-device-internals` in another tab.

On an unsupported browser Vault Mode reports itself unavailable. Cloud
inference needs the Firebase project configured (below).

## Deploy on Vercel

Keepsake runs on Vercel as a Vite frontend plus one function that serves the API,
with Postgres for durable storage. Vercel's filesystem is ephemeral, so nothing is
written to disk in production.

1. Add a Postgres database in the Vercel Marketplace (Neon, Supabase, …) and
   connect it to the project. The integration injects `DATABASE_URL` (Supabase
   injects `POSTGRES_URL`); Keepsake reads any of those, or set
   `KEEPSAKE_DATABASE_URL` explicitly. The connection is opened over TLS for any host
   that is not loopback.
2. Import the project on Vercel. The detected framework is Vite; `vercel.json`
   sets the build command, the static output directory, the `/api/*` rewrite to
   the function, and the security headers. There is no cron entry. Keepsake
   runs no background work.

   > **The headers are in `vercel.json`, not only in Express.** On Vercel the
   > static files are served by the platform, not by the Express app (the
   > `express.static` branch runs only when *not* on Vercel), so the middleware
   > in `server/index.ts` never sees the HTML document. Without the `headers`
   > block the deployed page is served with no CSP. The value there must stay
   > identical to `contentSecurityPolicy()` in `server/csp.ts`; the same origins
   > cloud inference needs are required in both places.
3. Set the environment variables (Production, and Preview if you want it live):

   | Variable | Value |
   | --- | --- |
   | `KEEPSAKE_DATABASE_URL` | Postgres connection string. Optional if the integration already provides `DATABASE_URL`/`POSTGRES_URL`. **Required in production**, without a connection string the function refuses to serve rather than run on an ephemeral, per-instance database. |
   | `KEEPSAKE_PUBLIC_URL` | `https://<your-project>.vercel.app` (falls back to Vercel's own domain when unset) |
   | `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID` | Firebase sign-in and AI Logic (see below). These are public web-config values. |
   | `FIREBASE_APPCHECK_SITE_KEY` | App Check's reCAPTCHA Enterprise site key; required for cloud inference (see below). Public. |

4. Deploy. Vercel builds `dist/` and the `api/index.ts` function.

> A serverless host cannot use the embedded PGlite fallback: each invocation
> would see a fresh, empty database and every account and session would vanish.
> If no connection string is present on Vercel, the function returns a clear
> `NO_DATABASE` error instead of serving broken state. `GET /api/health` reports
> `storage` and `persistent` so this is visible at a glance.

### Host it yourself instead

The same daemon works on any always-on host. Point `KEEPSAKE_DATABASE_URL` at a
Postgres instance and run `npm start`.

## Accounts and data

```text
Postgres
  public                  accounts, sessions, login attempts
  acct_<uuid>             profile (name, email, onboarded, avatar), settings
```

- Every account owns a Postgres schema. Queries run inside a short transaction
  that sets `search_path` to that schema, so isolation is enforced by the
  database rather than by a client-supplied id.
- `KEEPSAKE_DATABASE_URL` selects the network `pg` driver. When it is unset,
  Keepsake uses embedded PGlite under `KEEPSAKE_PGLITE_DIR` (`./data/pglite` by
  default), a real Postgres you can run locally with no server.
- **The server holds no conversation data.** Keepsake is local-first:
  conversations and every other piece of private context live on the device (in
  the browser's IndexedDB), never in this database. What an account schema keeps
  is only what an account needs to exist, a profile row and a settings row.
- Back up your Postgres database. It holds accounts and profiles, not chats.
- Deleting an account drops its schema (`DROP SCHEMA ... CASCADE`) and its rows.
- Because state lives in Postgres and the server is stateless, the API scales
  horizontally; run as many function instances as Vercel gives you.

### Sign-in with Firebase

Firebase Authentication proves who the person is; Keepsake keeps its own session
and its own per-account schema. To turn it on:

1. In the Firebase console, enable the **Email/Password** and **Google**
   providers under Authentication → Sign-in method.
2. Add your domains (your Vercel domain and `localhost` while developing) under
   Authentication → Settings → Authorized domains.
3. Copy the web app config from Project settings → General → *Your apps* → Web app
   → SDK setup into `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`,
   `FIREBASE_AUTH_DOMAIN` and `FIREBASE_APP_ID`. These values are public; the
   server returns them from `/api/auth/config` and verifies the ID token that
   comes back, so nothing secret is stored.

The client signs in, posts the ID token to `/api/auth/firebase`, and Keepsake
mints the same session cookie the password flow uses. Accounts are keyed by email,
so a Google sign-in and a password sign-in for the same address resolve to one
account. Set `FIREBASE_AUTH_ENABLED=0` to keep Keepsake's own password login
alongside Firebase.

## Firebase AI Logic (cloud inference)

Keepsake has **no server-side model calls**. The only model path is the client
SDK: `src/lib/inference/firebase-ai.ts` imports `firebase/ai` lazily and is the
single module that touches it. That is what makes the privacy claim verifiable.
There is no key on the server and no route that could reach a model without the
consent flow in front of it.

To enable cloud inference, follow [`FIREBASE_SETUP.md`](FIREBASE_SETUP.md), the
full click-by-click runbook. In short:

1. In the Firebase console, open **AI Logic** and enable the **Gemini Developer
   API** for the project. The free tier is enough; no Blaze billing is required
   for the default model. (Do not pick the Agent Platform / Vertex AI path.)
2. Under **App Check**, register the web app with the **reCAPTCHA Enterprise**
   provider and set `FIREBASE_APPCHECK_SITE_KEY` to the site key it gives you.
   App Check is what gates the model endpoints to the real app rather than to
   anyone holding the public config. Without a site key, the cloud path refuses.
   **Enforcement is mandatory for AI Logic since 2 November 2026**, and the
   AI Logic setup workflow now enforces it for you. The production CSP adds the
   reCAPTCHA origins automatically when a site key is present, and always allows
   the `firebasevertexai.googleapis.com` gateway the SDK calls.
3. Keep the Firebase web configuration set for the same project as sign-in.
   The client reads it at runtime. Without it, neither mode can initialise.

To check cloud inference, use a deployed origin registered with the reCAPTCHA
Enterprise key. The app uses the Enterprise provider.

The cloud model defaults to `gemini-3.5-flash-lite` (`DEFAULT_CLOUD_MODEL` in
`src/lib/inference/types.ts`). Each cloud attempt has a 12-second timeout.
Transient failures can be retried with the same approved text and destination.
A quota error ends the attempt. Vault uses `ONLY_ON_DEVICE`, and approved cloud
requests use `ONLY_IN_CLOUD`.

**What actually leaves the device.** Nothing, in Vault Mode. In Hybrid Mode, only
the sanitized payload: the text is passed through the deterministic privacy
pipeline (`shared/privacy/`), and the approval is bound to `sha256(payload) +
operation + destination`. When the payload carries personal details the exact
redacted string is shown for approval first; when it carries none, the clean
payload is sent without a tap (the policy layer mints the same bound approval).
Change any of the three and the request is refused.

## Install as an app

Keepsake ships a web app manifest, 192/512 px icons and a service worker. After a
production build, open the site on a phone and choose **Add to Home screen** /
**Install app**. The shell remains readable offline; the service worker caches
the app shell only and never account or conversation data. This is an installable
PWA, not an App Store or Play Store binary.

## Deploy with Docker

The container works for a self-hosted, always-on deployment. It needs a reachable
Postgres via `KEEPSAKE_DATABASE_URL`; the container filesystem is not used for data.

```bash
docker build -t keepsake .
docker run -d --name keepsake \
  -p 8787:8787 \
  -e KEEPSAKE_DATABASE_URL="postgres://user:pass@host:5432/keepsake" \
  -e KEEPSAKE_PUBLIC_URL=https://keepsake.example.com \
  -e KEEPSAKE_TRUST_PROXY=1 \
  -e FIREBASE_PROJECT_ID=your-project \
  --env-file .env \
  keepsake
```

The image builds the client, prunes development dependencies, keeps `tsx` as a
runtime dependency for `npm start`, and exposes `/api/health` as a health check.
Terminate TLS at a reverse proxy and forward the original host and
`X-Forwarded-Proto`. The proxy must not cache `/api/` responses.

## Scripts

```bash
npm run dev        # API + Vite, both watched
npm run typecheck  # tsc --noEmit
npm test           # node:test through tsx
npm run build      # vite build
npm start          # production server (expects dist/ for the UI)
```

The test suite uses embedded Postgres (PGlite). CI runs the type check, tests
and production build on pushes and pull requests.

## Architecture

```text
src/                React 19 client (Vite, Tailwind v4, hand-written design CSS)
  pages/            Chat, Auth, Onboarding, Legal
  components/       KeepsakeMark, UI, Markdown, Sky
  components/keepsake/  ConsentPreview, ModeSwitch, SidePane, SourceBadge
  device.css        the chat template: the device frame, thread, dock, side pane
  lib/inference/    on-device and cloud inference through Firebase AI Logic
  lib/keepsake/     the on-device store: IndexedDB port + vault context
  lib/              API client, app state, toast, Firebase sign-in, emoji
  assets/fonts/     self-hosted woff2 (Prototype, Highway Gothic, R&C Demo, EmoticonesTityly)
  assets/brand/     the mark, the icon set and the auth artwork
  main.tsx          mounts the app and registers the service worker in production
shared/             code shared by the client and the tests
  privacy/          deterministic PII rules, redaction, consent gate, sha256
  keepsake/         the local store's rules and single-turn prompt assembly
  inference.ts      the mode/source vocabulary the UI and store agree on
  types.ts          Profile and Account
public/             manifest, icons, service worker, favicon
api/index.ts        Vercel Function entry: connects the database, runs the app
server/             Express 5 API
  index.ts          security middleware, auth gates, profile/avatar/account routes
  auth.ts           accounts, scrypt passwords, sessions, login limiter
  firebase.ts       Firebase ID-token verification against Google's public keys
  pg.ts             Postgres backend (pg in prod, PGlite in dev), account schemas
  tenant.ts         account context + per-request schema setup
  schema.ts         per-account schema (profile, settings)
  db.ts             the small db.prepare(...) surface over the account schema
tests/              node:test suites (privacy, inference, store, server, …)
```

**Typefaces.** Four faces are self-hosted as woff2 and committed under
`src/assets/fonts`, so the app renders identically offline and needs no font CDN
(the CSP allows only same-origin fonts). **Prototype** is the display face used
for headings and the `keepsake.` wordmark. **Highway Gothic** is the default
interface typeface.
**R&C Demo** is used only for large display headings and the `keepsake.` wordmark; it
is a distressed display cut with no glyphs for `0`, `3`, `9` and several
punctuation marks, so the next font in the stack draws anything it is missing and
it is never used for body copy or numbers. **EmoticonesTityly** maps the letters
`A–Z` to twenty-six pixel emoticon faces; Keepsake renders the model's
`:shortcode:` tokens through it, with the mapping in `src/lib/emoji.ts`.

Licensing is worth noting before this is used commercially. Highway Gothic ships
in the download with no license text (the embedded font is credited to "Ash
Pikachu Font"), and R&C Demo is a free **Demo** cut by Jean Boyault of JBFoundry;
treat both as display use and confirm terms for a commercial product.
EmoticonesTityly is by ivancr72 via FontStruct under CC BY-SA. Prototype and
R&C Demo are for display use only. The mark and background artwork are separate
from the typefaces.

## Security notes

- Passwords use scrypt with a per-password salt. Sessions are 32 random bytes;
  only their SHA-256 hashes are stored.
- The session cookie is httpOnly, SameSite=Lax, and Secure when served over TLS.
- Mutating `/api` requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site`
  are rejected.
- Production responses include a CSP that only allows same-origin scripts,
  styles, fonts and connections. With Firebase sign-in on, the identity endpoints
  and Google popup origins are added explicitly.
- Firebase ID tokens are verified server-side against Google's published signing
  certificates, with the audience and issuer pinned to the configured project;
  the client never talks to the database and no service-account key is stored.
- **No model credential exists on the server.** Cloud inference goes through the
  client SDK, gated by App Check; there is no server route that can reach a model.
- **Conversations never reach the server.** They live in the device's IndexedDB.
  Private Vault content is never logged, sent to an analytics/telemetry path, or
  written to Firestore, a test reads the source tree and fails if the app gains
  such a path.
- Each account's rows live in a separate Postgres schema, selected inside the
  server by `search_path` inside a transaction. The API never accepts an account
  id from the client when choosing a schema.
- Login attempts are limited in Postgres, so the limit holds across serverless
  instances.
- Deleting an account drops its schema and its sessions and rows.

This is a serious baseline, not an audited security product.

## Known limitations

- **Vault Mode is desktop Chrome.** On-device inference needs a desktop Chrome
  with the built-in model (Gemini Nano) installed: 22 GB free disk, and either
  >4 GB of VRAM or 16 GB of RAM. Chrome 148+ has the Prompt API on by default;
  139–147 need its flag. Mobile Chrome cannot run the on-device model.
- **On-device inference is single-turn.** Vault answers are one text-out call;
  Keepsake assembles a short context window around it.
- **Cloud inference needs Firebase AI Logic and App Check.** If the Firebase
  web configuration is missing, neither mode can generate an answer. A missing
  App Check site key blocks only the cloud path.
- **Postgres is required in production.** There is no local-file mode on
  serverless hosts; that is the price of durability on Vercel. Development and
  tests run on embedded PGlite.
- **The cloud model is shared and rate-limited** on the free tier; a rate-limited
  reply surfaces as a clear message rather than a silent failure.
- **No push notifications or native apps.** The installable PWA does not
  register for push, and there are no App Store or Play Store binaries.
- **Not professional advice.** Answers can be wrong, incomplete or out of date.
