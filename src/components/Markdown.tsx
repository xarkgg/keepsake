import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { KEEPSAKE_EMOJI, KEEPSAKE_EMOJI_RE } from "../lib/emoji";

/**
 * Split a text value into plain strings and `:shortcode:` faces. The face is
 * always the same uppercase letter from the EmoticonesTityly font, so the same
 * text is produced every render.
 */
function splitEmoji(value: string): Array<string | { name: string; letter: string }> {
  const out: Array<string | { name: string; letter: string }> = [];
  let last = 0;
  for (const match of value.matchAll(KEEPSAKE_EMOJI_RE)) {
    const letter = KEEPSAKE_EMOJI[match[1]];
    if (!letter) continue; // unknown shortcode: leave it as literal text
    const index = match.index ?? 0;
    if (index > last) out.push(value.slice(last, index));
    out.push({ name: match[1], letter });
    last = index + match[0].length;
  }
  if (last < value.length) out.push(value.slice(last));
  return out;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * Replace `:shortcode:` tokens in text nodes with a span the emoji font draws.
 * Code and pre subtrees are left untouched so literal shortcodes in code stay
 * literal.
 */
function rehypeKeepsakeEmoji() {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    if (node.tagName === "code" || node.tagName === "pre") return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string" && child.value.includes(":")) {
        for (const piece of splitEmoji(child.value)) {
          if (typeof piece === "string") {
            next.push({ type: "text", value: piece });
          } else {
            next.push({
              type: "element",
              tagName: "span",
              properties: {
                className: ["keepsake-emoji"],
                role: "img",
                "aria-label": piece.name,
              },
              children: [{ type: "text", value: piece.letter }],
            });
          }
        }
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => walk(tree);
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeKeepsakeEmoji]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ),
          code: ({ children: code, className }) => {
            const isBlock = Boolean(className);
            return isBlock ? (
              <pre>
                <code>{code}</code>
              </pre>
            ) : (
              <code>{code}</code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
