import { describe, expect, it } from "vitest";
import { askClaude, extractPicture, preambleContext } from "../src/diagram/ai";
import { memoryHost } from "./helpers";

const PIC = "\\begin{tikzpicture}\n  \\node (a) at (0,0) {A};\n\\end{tikzpicture}";
const NEW = "\\begin{tikzpicture}\n  \\node (a) at (0,0) {A};\n  \\node (b) at (2,0) {B};\n\\end{tikzpicture}";
const settings = { model: "claude-haiku-5-5", effort: "low" as const };
const reply = (text: string, extra: object = {}) => ({
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
  stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 }, ...extra,
});

describe("askClaude", () => {
  it("sends the picture, the preamble's TikZ setup and an image, and returns the picture that compiles", async () => {
    const host = memoryHost({});
    host.ai.respond = () => reply(`Here it is:\n\`\`\`latex\n${NEW}\n\`\`\``);
    const checked: string[] = [];
    const res = await askClaude(host, {
      settings, picture: PIC, request: "add B to the right of A", image: "PNGDATA",
      preamble: "\\documentclass{article}\n\\usepackage{tikz}\n\\usetikzlibrary{arrows.meta}\n\\title{x}\n",
      context: { before: "The graph\n", after: "\nhas two nodes." },
      check: async (p) => { checked.push(p); return []; },
    });
    expect(res).toEqual({ picture: NEW, usage: { input: 1000, output: 200 } });
    expect(checked).toEqual([NEW]);
    const body = host.ai.requests[0] as { model: string; system: string; output_config: unknown; messages: { content: { type: string; text?: string; source?: { data: string } }[] }[] };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.system).toContain("\\usetikzlibrary{arrows.meta}");
    expect(body.system).not.toContain("\\title");
    const content = body.messages[0].content;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "PNGDATA" } });
    expect(content[2].text).toContain("The graph\n[the picture]\nhas two nodes.");
    expect(content[3].text).toContain(PIC);
    expect(content[3].text).toContain("add B to the right of A");
    expect(body.system).toContain("\\sffamily");
  });

  it("sends compile errors back with Claude's whole reply, and stops after the last retry", async () => {
    const host = memoryHost({});
    host.ai.respond = () => reply(NEW);
    const res = await askClaude(host, {
      settings, picture: PIC, preamble: "", request: "x",
      check: async () => [{ line: 3, message: "Undefined control sequence" }],
    });
    expect(res.picture).toBeNull();
    expect(res.error).toContain("line 3: Undefined control sequence");
    expect(res.usage).toEqual({ input: 3000, output: 600 });
    expect(host.ai.requests).toHaveLength(3);
    const last = host.ai.requests[2] as { messages: { role: string; content: unknown }[] };
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    // The thinking block goes back unchanged.
    expect(last.messages[1].content).toEqual(reply(NEW).content);
    expect(last.messages[2].content).toContain("line 3: Undefined control sequence");
  });

  it("fixes on the second try", async () => {
    const host = memoryHost({});
    host.ai.respond = () => reply(NEW);
    let n = 0;
    const res = await askClaude(host, { settings, picture: PIC, preamble: "", request: "x", check: async () => (n++ ? [] : [{ line: null, message: "bad" }]) });
    expect(res.picture).toBe(NEW);
    expect(host.ai.requests).toHaveLength(2);
  });

  it("reports refusals, cut-off answers, answers with no picture and API errors", async () => {
    const host = memoryHost({});
    const ask = () => askClaude(host, { settings, picture: PIC, preamble: "", request: "x", check: async () => [] });
    host.ai.respond = () => reply("", { stop_reason: "refusal" });
    expect((await ask()).error).toBe("Claude declined this request");
    host.ai.respond = () => reply("\\begin{tikzpicture}", { stop_reason: "max_tokens" });
    expect((await ask()).error).toMatch(/cut off/);
    host.ai.respond = () => reply("I can't draw that.");
    expect((await ask()).error).toBe("Claude didn't answer with a picture");
    host.ai.respond = () => { throw new Error("No API key yet: add yours in Settings → AI"); };
    expect(await ask()).toEqual({ picture: null, usage: { input: 0, output: 0 }, error: "No API key yet: add yours in Settings → AI" });
  });
});

describe("helpers", () => {
  it("takes the last picture out of a reply", () => {
    expect(extractPicture(`first ${PIC} then\n\`\`\`latex\n${NEW}\n\`\`\``)).toBe(NEW);
    expect(extractPicture("no picture")).toBeNull();
  });

  it("keeps the preamble lines that matter for pictures, whole", () => {
    const pre = "\\documentclass{article}\n\\usepackage{amsmath}\n\\tikzset{\n  dot/.style={circle, fill},\n}\n\\author{A}\n\\newcommand{\\R}{\\mathbb{R}}\n";
    expect(preambleContext(pre)).toBe("\\usepackage{amsmath}\n\\tikzset{\n  dot/.style={circle, fill},\n}\n\\newcommand{\\R}{\\mathbb{R}}");
  });
});
