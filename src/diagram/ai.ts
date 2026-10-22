// The diagram editor's chat with Claude: each message goes with the picture as it is now, the
// TikZ-related part of the preamble and an image of how it looks. Claude answers, and when it
// changes the picture the new one is built; if it doesn't compile, the errors go back to Claude
// for another try (up to MAX_FIXES times).

import type { AiSettings } from "../workspace/config";
import type { Host } from "../host/types";
import type { DiagramError } from "./build";

export const MAX_FIXES = 2;

const SYSTEM = `You help with a TikZ picture in a LaTeX document, in a chat beside it. Answer questions about the picture briefly, without changing it. When asked to change it, reply with a sentence on what you changed and the complete updated picture, from \\begin{tikzpicture} to \\end{tikzpicture}, in a single \`\`\`latex code block.

- Keep the existing code, node names, styles and layout wherever the request doesn't change them.
- Use only the packages and TikZ libraries the preamble loads; you can't change the preamble, so do without anything it doesn't load.
- Prefer plain coordinates like (2,1) and named nodes, so the picture stays easy to edit by hand.
- Keep the document's LaTeX fonts: write labels as text or $…$ math, and don't change the font family or size (\\sffamily, \\ttfamily, font=\\small…) unless asked.`;

const PREAMBLE_LINE = /^\s*\\(usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary|tikzset|pgfplotsset|newcommand|renewcommand|providecommand|DeclareMathOperator|def|let|definecolor|colorlet)\b/;

/** The preamble lines that matter for a picture (packages, libraries, styles, macros), whole statements. */
export function preambleContext(preamble: string, max = 4000): string {
  const lines = preamble.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PREAMBLE_LINE.test(lines[i])) continue;
    // Take following lines until the braces balance (a multi-line \tikzset{…}).
    let text = lines[i];
    let depth = 0;
    const count = (s: string) => { for (const c of s.replace(/\\[{}]/g, "").replace(/(^|[^\\])%.*$/, "$1")) depth += c === "{" ? 1 : c === "}" ? -1 : 0; };
    count(text);
    while (depth > 0 && i + 1 < lines.length) { text += "\n" + lines[++i]; count(lines[i]); }
    out.push(text);
  }
  const joined = out.join("\n");
  return joined.length > max ? joined.slice(0, max) + "\n% …" : joined;
}

/** A reply without its pictures (and their code blocks), for the chat. */
export function withoutPicture(text: string): string {
  return text
    .replace(/```[a-z]*\n?\s*\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}\s*```/g, "")
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, "")
    .trim();
}

/** The last tikzpicture in a reply. */
export function extractPicture(text: string): string | null {
  const end = text.lastIndexOf("\\end{tikzpicture}");
  if (end < 0) return null;
  const begin = text.lastIndexOf("\\begin{tikzpicture}", end);
  return begin < 0 ? null : text.slice(begin, end + "\\end{tikzpicture}".length);
}

export interface Usage {
  input: number;
  output: number;
}

interface ApiMessage {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

/** An earlier message in the chat (the picture is only sent as it is now, with the last one). */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface AskOptions {
  settings: AiSettings;
  picture: string;
  preamble: string;
  /** The document text just before and after the picture, so Claude knows what it's for. */
  context?: { before: string; after: string };
  request: string;
  /** The chat so far, oldest first, in user/assistant pairs. */
  history?: Turn[];
  /** PNG of the picture as it looks now (base64), if it built. */
  image?: string | null;
  /** Builds a candidate picture; returns its errors (none = it compiled). */
  check(picture: string): Promise<DiagramError[]>;
  onStatus?(status: string): void;
}

export interface AskResult {
  /** The new picture, if Claude gave one that compiles. */
  picture: string | null;
  /** Claude's answer without the picture's code. */
  reply?: string;
  usage: Usage;
  error?: string;
}

const errorText = (errors: DiagramError[]) => errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join("\n");

export async function askClaude(host: Host, o: AskOptions): Promise<AskResult> {
  const usage: Usage = { input: 0, output: 0 };
  const context = preambleContext(o.preamble);
  const system = context ? `${SYSTEM}\n\nThe document's preamble (the parts that matter for pictures):\n\`\`\`latex\n${context}\n\`\`\`` : SYSTEM;
  const first: unknown[] = [];
  if (o.image) {
    first.push({ type: "image", source: { type: "base64", media_type: "image/png", data: o.image } });
    first.push({ type: "text", text: "This is how the picture looks now." });
  }
  if (o.context && (o.context.before + o.context.after).trim()) {
    first.push({ type: "text", text: `The text around the picture in the document:\n\`\`\`latex\n${o.context.before}[the picture]${o.context.after}\n\`\`\`` });
  }
  first.push({ type: "text", text: `The picture as it is now:\n\`\`\`latex\n${o.picture}\n\`\`\`\n\n${o.request}` });
  const messages: unknown[] = [...(o.history ?? []).map((t) => ({ role: t.role, content: t.text })), { role: "user", content: first }];
  let reply = "";

  for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
    o.onStatus?.(attempt === 0 ? "Asking Claude…" : `Fixing errors (${attempt}/${MAX_FIXES})…`);
    let res: ApiMessage;
    try {
      res = (await host.aiMessages({
        model: o.settings.model,
        max_tokens: 16000,
        system,
        output_config: { effort: o.settings.effort },
        messages,
      })) as ApiMessage;
    } catch (err) {
      return { picture: null, usage, error: String(err).replace(/^Error: /, "") };
    }
    const u = res.usage ?? {};
    usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    usage.output += u.output_tokens ?? 0;
    if (res.stop_reason === "refusal") return { picture: null, usage, error: "Claude declined this request" };
    if (res.stop_reason === "max_tokens") return { picture: null, usage, error: "Claude's answer was cut off (too long)" };

    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const picture = extractPicture(text);
    // The answer is the first reply's; the fixes after it only repeat the picture.
    if (attempt === 0) reply = withoutPicture(text);
    if (!picture) return attempt === 0 ? { picture: null, reply, usage } : { picture: null, usage, error: "Claude didn't answer with a picture" };
    o.onStatus?.("Building…");
    const errors = await o.check(picture);
    if (!errors.length) return { picture, reply, usage };
    if (attempt === MAX_FIXES) return { picture: null, usage, error: `Claude's picture still doesn't compile: ${errorText(errors)}` };
    // The whole reply goes back as it came (thinking blocks included), then the errors.
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: `That picture doesn't compile:\n${errorText(errors)}\n\nReply with the corrected complete picture.` });
  }
  return { picture: null, usage };
}
