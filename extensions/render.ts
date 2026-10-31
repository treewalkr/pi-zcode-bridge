// Inline tool rendering. ZCode executes its own tools inside its session,
// so the bridge never emits pi toolCall blocks (pi would try to execute them
// itself, and its TUI renders toolCall boxes below the message). Instead each
// call and result becomes an inline markdown text block appended in stream
// order, so reasoning, tools, results and the final answer interleave exactly
// like ZCode's own transcript.

const MAX_RESULT_CHARS = 6000;
const BASH_PREVIEW_LINES = 10;
const READ_TOOLS = new Set(["read", "read_file", "view_file"]);

/** "mcp__server__tool" -> "server__tool"; builtins pass through. */
export function displayToolName(toolName: string): string {
  return toolName.startsWith("mcp__") ? toolName.slice("mcp__".length) : toolName;
}

function escapeInlineCode(s: string): string {
  return s.replace(/`/g, "\\`").replace(/\s*\n\s*/g, " ");
}

function numArg(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function parsePartialJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return typeof input === "string" ? parsePartialJson(input) : {};
}

function toolArgsSummary(name: string, args: Record<string, unknown>): string | null {
  if (name === "askUserQuestion") {
    const questions = args.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0] as { question?: string; header?: string };
      const label = first?.question || first?.header || "";
      if (label) return questions.length === 1 ? label : `${label} (+${questions.length - 1} more)`;
    }
  }
  const command = args.command;
  if (typeof command === "string" && command.trim()) return command.trim();
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const value = args[keys[0]];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Echo pi's read call display: "read <path>:<from>-<to>". */
function readRangeSuffix(name: string, args: Record<string, unknown>): string {
  if (!READ_TOOLS.has(name.toLowerCase())) return "";
  const offset = numArg(args.offset);
  const limit = numArg(args.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  if (limit === undefined) return `:${start}`;
  return `:${start}-${start + limit - 1}`;
}

/** Call line, e.g. "**🔧 bash** — `ls -la`" (or a JSON block for complex args). */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const header = `**🔧 ${name}**`;
  const summary = toolArgsSummary(name, args);
  if (summary) return `${header} — \`${escapeInlineCode(summary)}${readRangeSuffix(name, args)}\``;
  const keys = Object.keys(args);
  if (keys.length === 0) return header;
  return `${header}\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``;
}

/** Bash calls open ONE fenced block ("$ cmd"); the result later appends and closes it. */
export function formatBashCallOpen(args: Record<string, unknown>): string {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  return "```text\n$ " + (command || "(no command)") + "\n";
}

export interface ToolResult {
  success?: boolean;
  content?: unknown;
  truncated?: boolean;
}

function resultContent(result: ToolResult): string {
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" ? ((part as { text?: string }).text ?? "") : String(part),
      )
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content, null, 2);
}

function resultBody(result: ToolResult): string {
  let text = resultContent(result);
  if (!text.trim()) text = result.success === false ? "Tool failed" : "";
  if (!text.trim()) return "";
  let body = text;
  if (body.length > MAX_RESULT_CHARS) {
    body = body.slice(0, MAX_RESULT_CHARS) + `\n… (${body.length - MAX_RESULT_CHARS} more chars)`;
  }
  if (result.truncated) body += "\n… (truncated by ZCode)";
  return body;
}

/** Non-bash results: a capped ```text block; read results collapse to nothing. */
export function formatToolResult(name: string, result: ToolResult): string {
  const lower = name.toLowerCase();
  if (READ_TOOLS.has(lower)) {
    if (result.success === false) {
      const body = resultBody(result);
      return body ? `**⚠️ Tool failed**\n\n\`\`\`text\n${body}\n\`\`\`` : "";
    }
    return "";
  }
  const body = resultBody(result);
  if (!body) return "";
  const marker = result.success === false ? "**⚠️ Tool failed**\n\n" : "";
  return `${marker}\`\`\`text\n${body}\n\`\`\``;
}

/** Tail preview: last `maxLines` lines within `maxChars`, with omission markers. */
function truncateTail(text: string, maxLines: number, maxChars: number): {
  text: string;
  omittedLines: number;
  omittedChars: number;
} {
  const totalChars = text.length;
  if (text.length <= maxChars) {
    const lines = text.split("\n");
    const cut = lines.length - maxLines;
    if (cut <= 0) return { text, omittedLines: 0, omittedChars: 0 };
    return { text: lines.slice(-maxLines).join("\n"), omittedLines: cut, omittedChars: 0 };
  }
  const lines = text.split("\n");
  const kept: string[] = [];
  let keptChars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (keptChars + cost > maxChars) {
      if (kept.length === 0) kept.push("…" + lines[i].slice(-(maxChars - 1)));
      break;
    }
    kept.unshift(lines[i]);
    keptChars += cost;
  }
  const visible = kept.join("\n");
  return {
    text: visible,
    omittedLines: lines.length - kept.length,
    omittedChars: totalChars - visible.length,
  };
}

/** Appended inside the open bash fence: tail preview + duration, then closes it. */
export function formatBashResultClose(result: ToolResult, startedAt?: number): string {
  const footer: string[] = [];
  if (result.truncated) footer.push("truncated by ZCode");
  if (startedAt !== undefined) footer.push(`Took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  const preview = truncateTail(resultContent(result).trim(), BASH_PREVIEW_LINES, MAX_RESULT_CHARS);
  const markers: string[] = [];
  if (result.success === false) markers.push("⚠️ Tool failed");
  if (preview.omittedLines > 0) markers.push(`... (${preview.omittedLines} earlier lines)`);
  else if (preview.omittedChars > 0) markers.push(`... (${preview.omittedChars} more chars)`);
  const body = [markers.join(" · "), preview.text].filter((s) => s !== "").join("\n");
  const tail = footer.length > 0 ? `\n\n${footer.join(" · ")}` : "";
  if (!body && !tail) return "\n```\n";
  return `\n${body}${tail}\n\`\`\`\n`;
}
