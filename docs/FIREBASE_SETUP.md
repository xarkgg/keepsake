# Firebase setup

Everything Keepsake needs from Firebase lives in **one project**: sign-in
(Firebase Authentication), cloud inference (Firebase AI Logic) and the App Check
enforcement that protects it. This is the operator's click-by-click runbook.

You do the console steps; the wiring (env vars, App Check, CSP) is done for you
once the five values below exist.

**What you will end up with:** the five values Keepsake reads:

| Value | Env var | Secret? |
| --- | --- | --- |
| Project ID | `FIREBASE_PROJECT_ID` | no (public) |
| API key | `FIREBASE_API_KEY` | no (public) |
| Auth domain | `FIREBASE_AUTH_DOMAIN` | no (public) |
| App ID | `FIREBASE_APP_ID` | no (public) |
| App Check site key | `FIREBASE_APPCHECK_SITE_KEY` | no (public) |

These are the Firebase **web** config values. They are designed to be shipped to
browsers; the real protection is App Check, not secrecy of these strings. No
service-account key is ever created or stored, the server verifies ID tokens
against Google's public certificates.

> **App Check is mandatory.** Firebase began *requiring* App Check for AI Logic
> on **2 November 2026**. A request without a valid App Check token is rejected.
> Keepsake therefore refuses cloud inference when App Check is not configured
> (it fails closed and says so) rather than calling a model unattested.

---

## Step 1: Create the Firebase project

1. Open <https://console.firebase.google.com/> and click **Create a project**.
2. Project name: `keepsake` (the ID becomes something like `keepsake-1a2b3`).
3. Google Analytics is **not required**. Toggle it off.
4. Click **Create project**, wait, then **Continue**.

## Step 2: Register the web app (this produces four of the values)

1. On the project home, click the **web** icon (`</>`).
2. App nickname: `keepsake-web`.
3. **Do not** tick Firebase Hosting.
4. Click **Register app**. The console shows a `firebaseConfig` block. Copy it.
   You need `projectId`, `apiKey`, `authDomain`, `appId` from it.
5. Click **Continue to console**.

> Keep this block; Step 7 pastes its values into the environment.

## Step 3: Enable AI Logic (cloud inference)

1. Left nav → **AI Services** → **AI Logic**.
2. Click **Get started**. This opens the guided workflow.
3. When asked to choose a **Gemini API provider**, pick the
   **Gemini Developer API** (free tier, no billing). Do *not* pick the Agent
   Platform (Vertex AI), which needs billing.
4. Continue through the workflow. It enables the required APIs and
   **automatically enforces App Check** for AI Logic.
5. If the workflow asks to register an app, it is the app from Step 2. Accept it.

The default cloud model is `gemini-3.5-flash-lite`. Check your project's model
access and quota in the Firebase console.

## Step 4: Enable sign-in

1. Left nav → **Build** → **Authentication** → **Get started**.
2. **Sign-in method** tab → **Email/Password** → **Enable** → **Save**.
3. **Sign-in method** tab → **Google** → **Enable** → pick a support email →
   **Save**.
4. **Settings** tab → **Authorized domains**: add the domains the app is served
   from. For local sign-in, add `localhost` if it is not already listed.

## Step 5: App Check (produce the site key, confirm enforcement)

1. Left nav → **Security** → **App Check** → **Apps** tab.
2. Find the web app from Step 2 → overflow menu (**⋮**) → **Register** (or
   "Manage" if AI Logic already registered it).
3. Provider: **reCAPTCHA Enterprise**.
4. Select or create a reCAPTCHA Enterprise web key in the linked Google Cloud
   project. Add the deployed hostname to that key's allowed domains. Copy its
   public site key into `FIREBASE_APPCHECK_SITE_KEY`.
5. Now confirm enforcement: **App Check** → **APIs** tab → the row for
   **Firebase AI Logic** must read **Enforced**. If it says `Unenforced`, click
   the row → **Set up** → **Baseline protection: Enforced** → **Replay
   protection: Disabled** → **Continue**.

## Step 6: Choose the origin for cloud inference

Use the registered HTTPS hostname to test cloud inference. This app uses the
reCAPTCHA Enterprise provider. Keep `localhost` off the production key's list
of allowed domains.

## Step 7: Paste the values

**On Vercel** (Project → Settings → Environment Variables):

```
FIREBASE_PROJECT_ID       = <projectId>
FIREBASE_API_KEY          = <apiKey>
FIREBASE_AUTH_DOMAIN      = <authDomain>       # <project-id>.firebaseapp.com
FIREBASE_APP_ID           = <appId>
FIREBASE_APPCHECK_SITE_KEY= <App Check site key>
```

**Locally**, the same names in `.env` (git-ignored).

Cloud inference additionally needs a Postgres connection in production
(`KEEPSAKE_DATABASE_URL` or the `DATABASE_URL` a Vercel Postgres/Neon integration
provides) so accounts persist, see `OPERATIONS.md`.

## Step 8: Check the deployment

1. `/api/auth/config` returns the Firebase web config, and `/api/health`
   reports `capabilities.appCheck: true`.
2. **One real cloud request** through Firebase AI Logic on the deployed URL: a
   prompt that needs the cloud returns an answer with the `IN_CLOUD` source badge
   (the SDK's own `inferenceSource`, not an assumption). A prompt that carries an
   email address should show the consent card with the sanitized payload first.
3. **One real on-device request** for Vault Mode, which needs desktop Chrome with the
   built-in model (Gemini Nano) installed. Chrome 148+ needs no flag; 139–147
   need the Prompt API flag.

---

## Credentials

The five Firebase web configuration values are public. App Check protects
cloud inference. Keep database credentials private. Keepsake does not need a
service-account private key.
