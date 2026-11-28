# Keepsake

Keepsake is a writing assistant for people who handle other people's documents.
A recruiter can draft a reply to a candidate, a paralegal can unpack a clause,
and a case manager can summarise notes. By default, the prompt stays on the
device. A badge under each answer tells you whether it came from the device or
the cloud.

## Try it

Open [Keepsake](https://ourkeepsake.vercel.app) and choose **Sign in**. You can
use the shared demo account with a sample document:

| Email | Password |
| --- | --- |
| `demo@ourkeepsake.vercel.app` | `KeepsakeDemo2026` |

Chats stay in the browser where you start them. Signing into the same account
on another device does not bring your chats with you.

## Choose where an answer comes from

**Vault Mode** uses only Chrome's built-in model. If it can't answer, Keepsake
explains why. It never sends your prompt to a cloud model in this mode.

**Hybrid Mode** tries the device first. If the device can't answer, Keepsake
checks the prompt for details such as email addresses, phone numbers and card
numbers. When it finds a match, you see the exact redacted text and its
destination. Choose **Approve and send** or **Keep it local**. Leaving the
chat dismisses a request still waiting for approval. If the rules
find no matches, Hybrid can send the text through Firebase AI Logic without
asking for approval. Use Vault if the text must stay on the device.

## Set up Vault Mode

Use desktop Chrome 148 or later on a supported computer. The initial model
download needs an unmetered connection, 22 GB of free space on Chrome's profile
drive, and either more than 4 GB of video memory or 16 GB of RAM with four CPU
cores. In the side pane, open **Where it thinks**. If Chrome offers **Start the
download**, select it and keep the tab open until it says **Ready on this
device**. Your messages aren't sent during setup.

## Honest limits

Redaction matches known patterns: email addresses, phone numbers, card
numbers and the like. A match is reliable. A clean result is not proof the
text is safe. A confidential plan, a client's finances or a relationship
problem can pass with no match, and a clean payload is sent without asking.
Use Vault for anything you would not put in an email. Conversations have no
end-to-end encryption, and clearing browser storage deletes the local chats.
Only use documents you're allowed to process, and check answers before
relying on them.

## Documentation

[Using Keepsake](docs/PRODUCT.md) · [How inference and storage work](docs/KEEPSAKE.md) ·
[Self-hosting](docs/OPERATIONS.md) · [Firebase setup](docs/FIREBASE_SETUP.md) ·
[Apache-2.0 licence](LICENSE)
