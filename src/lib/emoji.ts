/**
 * Keepsake emoticon vocabulary.
 *
 * The agent does not emit Unicode emoji; it writes shortcodes like `:smile:`,
 * and the client renders each one as a face from the bundled EmoticonesTityly
 * pixel font. That font maps the 26 letters A-Z to 26 distinct faces and
 * carries no semantic information of its own (the glyphs are literally named
 * "A", "B", ...), so this file is our own vocabulary: it decides which face
 * each shortcode means. The letter values were chosen by looking at the
 * rendered faces.
 *
 * Keep this in sync with the list in `server/prompt.ts`; the system prompt
 * tells the model which shortcodes exist, and it should never invent others.
 */
export const KEEPSAKE_EMOJI: Record<string, string> = {
  smile: "A", // ^_^ simple smile
  happy: "C", // big open smile, closed eyes
  grin: "E", // wide toothy grin
  laugh: "D", // laughing, mouth wide open
  content: "U", // soft, settled smile
  wink: "L", // one eye closed
  tongue: "G", // tongue out
  silly: "K", // lopsided, tongue to the side
  cheeky: "N", // tongue poking out
  derp: "P", // goofy, eyes off
  relaxed: "H", // easy, head-tilt smile
  meh: "F", // flat, unbothered
  neutral: "I", // straight face
  deadpan: "M", // blank stare
  thinking: "S", // looking up, considering
  speechless: "T", // flat mouth, at a loss
  sad: "J", // downturned
  frown: "V", // clear frown
  grimace: "W", // unhappy, clenched
  cry: "B", // tears
  wail: "O", // crying hard
  distressed: "X", // worried, frayed
  angry: "Y", // cross, X eyes
  shock: "Q", // mouth open in surprise
  wow: "R", // round-mouthed surprise
  dead: "Z", // eyes x-ed out
};

/** A `:shortcode:` token, lowercase, as the agent writes it. */
export const KEEPSAKE_EMOJI_RE = /:([a-z][a-z0-9_-]*):/g;
