/**
 * Turning a conversation into a prompt, on the device.
 *
 * The on-device model accepts a single prompt. Assemble the recent history
 * and the new request locally so the whole prompt, including history, passes
 * through redaction if Hybrid Mode needs the cloud.
 */

import type { VaultMessage } from "./store.js";

/** How many earlier messages to carry as context. Single-turn prompts have a
 * small budget, so this is deliberately short. */
export const CONTEXT_TURNS = 6;

/**
 * Who the model is answering as.
 *
 * Without this, a plain "who are you?" returns the provider's own boilerplate:
 * "I am a large language model, trained by Google … How can I help you today?"
 *, which is both wrong for this product and a dump of vendor text a person did
 * not ask for. Keepsake is the thing they are talking to, so Keepsake is the
 * name it answers under.
 *
 * It stays honest: if asked what is behind it, it names the model plainly, and
 * the receipt under every answer already says whether that was the device or
 * the cloud and which model. What is removed is the unprompted self-description,
 * not the truth.
 */
export const SYSTEM_INSTRUCTION = [
  "You are Keepsake, a private assistant.",
  "Answer as Keepsake in plain language, and keep replies short unless depth is asked for.",
  "If asked what you are, say you are Keepsake, an AI assistant that runs on their device, or through Firebase AI Logic with their approval; name the model if asked.",
  "Never say where an answer was produced or that it stayed on the device, the badge under the reply says that.",
  "Do not describe what you were trained on or by whom, and do not close by offering further help.",
].join(" ");

const ROLE_LABEL: Record<VaultMessage["role"], string> = {
  user: "You",
  assistant: "Keepsake",
};

/**
 * Build the single-turn prompt for the latest user message: a short transcript
 * of what came before, then the request itself. With no history, the request is
 * returned unchanged, so a first turn is exactly what the person typed.
 */
export function assemblePrompt(history: VaultMessage[], latest: string): string {
  const prior = history.slice(-CONTEXT_TURNS);
  const request = latest.trim();
  if (prior.length === 0) return request;
  const transcript = prior
    .map((message) => `${ROLE_LABEL[message.role]}: ${message.content.trim()}`)
    .join("\n");
  return `${transcript}\n\n${request}`;
}
