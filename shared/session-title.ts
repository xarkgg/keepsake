/**
 * Naming a chat session from the person's own words. Kept free of database and
 * network use so the rule is directly testable: strip leading pleasantries,
 * then take the first sentence, capped to a readable length.
 */

/** The longest a session name may be. Short enough to sit on one line. */
export const SESSION_NAME_MAX = 20;

/**
 * Openers that carry no information about what the person actually wants:
 * greetings, acknowledgements and pleasantries. A session should not be named
 * after one, so they are skipped until something substantive appears.
 */
const GREETING_RE =
  /^(hi|hey|heyy+|hello|helo|yo|sup|hiya|howdy|hola|good (morning|afternoon|evening)|morning|evening|greetings|what'?s up|whats up|wassup|thanks|thank you|thx|ty|ok|okay|cool|nice|great|awesome|sure|alright|got it|gotcha|yes|yep|yeah|no|nope|nah|lol|haha|hmm+|hm+|welcome|please|kindly|hey there|hi there|hello there|how are you|how r u|you there|are you there|test|testing)($|[.!?,\s])/i;

/** True when a message is only an opener and nothing more. */
export function isGreetingOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Strip a greeting, then see what is left: "hi, find me a laptop" keeps its
  // request while a bare "hey there" leaves nothing behind.
  let rest = trimmed.replace(GREETING_RE, "").trim();
  rest = rest.replace(/^[!?.,;:…\s]+/, "").trim();
  if (!rest) return true;
  // A lone emoji or two is also not a request.
  const withoutEmoji = rest.replace(/[\p{Extended_Pictographic}\u200d\uFE0F]/gu, "").trim();
  return withoutEmoji.length < 3;
}

/** First sentence, or the whole text when there is no clean break. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (match ? match[1] : text).trim();
}

/**
 * The name for a session, from the first message that is an actual request.
 * Returns null when every message so far is only an opener, so the caller
 * leaves the session untitled until something real arrives.
 */
export function deriveSessionTitle(messages: string[]): string | null {
  const request = messages
    .map((message) => (message ?? "").replace(/\s+/g, " ").trim())
    .find((message) => message && !isGreetingOnly(message));
  if (!request) return null;
  const name = capName(firstSentence(request));
  return name || null;
}

/**
 * Cut a name to the cap, preferring a whole word. A bare slice would end names
 * mid-word ("Summarise this contr"); dropping back to the last space keeps them
 * readable, as long as that space is not so early the name loses its meaning.
 */
function capName(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SESSION_NAME_MAX) return trimmed;
  const cut = trimmed.slice(0, SESSION_NAME_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const bounded = lastSpace >= SESSION_NAME_MAX - 8 ? cut.slice(0, lastSpace) : cut;
  return bounded.trim().replace(/[,;:.\-–]+$/, "").trim();
}

/**
 * Clean a name the model proposed. Models add quotes, a "Name:" prefix, a
 * trailing period, markdown or several candidates on separate lines; only the
 * first clean line, capped to the same limit as a derived name, is kept.
 * Pure, so it is directly tested.
 */
export function sanitizeSessionName(raw: string): string | null {
  if (!raw) return null;
  let name = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!name) return null;
  // Drop a "Name:"/"Title:" style prefix the model may add.
  name = name.replace(/^(name|title|session)\s*[:\-–]\s*/i, "");
  // Strip surrounding quotes, backticks, asterisks and hashes.
  name = name.replace(/^["'`*#\s]+/, "").replace(/["'`*#\s]+$/, "");
  // A trailing full stop reads oddly on a label; other punctuation is kept.
  name = name.replace(/\.+$/, "").trim();
  name = name.replace(/\s+/g, " ");
  if (!name) return null;
  return capName(name) || null;
}
