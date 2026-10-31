// AskUserQuestion bridge: when the ZCode model calls its askUserQuestion
// tool, the app-server sends interaction/requestUserInput to the client.
// Render pi's question dialog (options + descriptions, free-text entry,
// multi-select) and answer the request so the agent continues.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface WireOption {
  label: string;
  description?: string;
}
interface WireQuestion {
  question: string;
  header?: string;
  options?: WireOption[];
  multiSelect?: boolean;
}

/**
 * Collect answers for the app-server's questions. Returns the interaction
 * content: {answer} for one question, {answers: {...}} for several. Throws
 * when cancelled or no interactive UI is available.
 */
export async function askInPi(
  ctx: ExtensionContext | null,
  questions: WireQuestion[],
): Promise<Record<string, unknown>> {
  if (!ctx || ctx.mode !== "tui") throw new Error("no interactive pi UI");
  if (questions.length === 1) {
    const answer = await askOne(ctx, questions[0]);
    if (answer === null) throw new Error("cancelled");
    return { answer };
  }
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = await askOne(ctx, question);
    if (answer === null) throw new Error("cancelled");
    answers[question.question] = answer;
  }
  return { answers };
}

/** One dialog: ↑↓ navigate, Space toggles (multi-select), Enter confirms, Esc cancels. */
function askOne(
  ctx: ExtensionContext,
  question: WireQuestion,
): Promise<string | string[] | null> {
  const options = (question.options ?? []).map((option) => ({
    label: option.label,
    description: option.description,
  }));
  const multi = question.multiSelect === true;
  const title =
    question.header?.trim() ? `[${question.header.trim()}] ${question.question}` : question.question;

  return ctx.ui.custom<string | string[] | null>((tui, theme, _kb, done) => {
    let index = 0; // options.length === the "Type something." row
    let editing = false;
    const toggled = new Set<number>();
    let cached: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.onSubmit = (value) => {
      const trimmed = value.trim();
      if (trimmed) done(multi ? [trimmed] : trimmed);
      else {
        editing = false;
        editor.setText("");
        invalidate();
      }
    };

    const invalidate = () => {
      cached = undefined;
      tui.requestRender();
    };

    const handleInput = (data: string) => {
      if (editing) {
        if (matchesKey(data, Key.escape)) {
          editing = false;
          editor.setText("");
          invalidate();
          return;
        }
        editor.handleInput(data);
        invalidate();
        return;
      }
      if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
      else if (matchesKey(data, Key.down)) index = Math.min(options.length, index + 1);
      else if (multi && matchesKey(data, Key.space) && index < options.length) {
        if (toggled.has(index)) toggled.delete(index);
        else toggled.add(index);
      } else if (matchesKey(data, Key.enter)) {
        if (index === options.length) {
          editing = true; // free-text row
        } else if (multi) {
          if (toggled.size === 0) return; // require a selection
          done([...toggled].map((i) => options[i].label));
        } else {
          done(options[index].label);
        }
      } else if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      } else return;
      invalidate();
    };

    const render = (width: number): string[] => {
      if (cached) return cached;
      const lines: string[] = [];
      const usable = Math.max(1, width);
      const wrap = (text: string) => lines.push(...wrapTextWithAnsi(text, usable));
      const wrapWithPrefix = (prefix: string, text: string) => {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= usable) {
          wrap(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, usable - prefixWidth);
        const blank = " ".repeat(prefixWidth);
        wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : blank}${line}`));
      };

      lines.push(theme.fg("accent", "─".repeat(usable)));
      wrapWithPrefix(" ", theme.fg("text", title));
      lines.push("");

      for (let i = 0; i <= options.length; i++) {
        const isOther = i === options.length;
        const selected = i === index;
        const checked = !isOther && multi && toggled.has(i);
        const cursor = selected ? theme.fg("accent", "> ") : "  ";
        const mark = checked ? theme.fg("success", "✓ ") : multi && !isOther ? "  " : "";
        const label = isOther ? "Type something." : options[i].label;
        const color = selected || (isOther && editing) ? "accent" : checked ? "success" : "text";
        wrapWithPrefix(cursor + mark, theme.fg(color, label));
        if (!isOther && options[i].description) {
          wrapWithPrefix("     ", theme.fg("muted", options[i].description ?? ""));
        }
      }

      if (editing) {
        lines.push("");
        wrapWithPrefix(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, usable - 2))) lines.push(` ${line}`);
      }

      lines.push("");
      const hint = editing
        ? "Enter to submit • Esc to go back"
        : multi
          ? "↑↓ navigate • Space toggle • Enter confirm • Esc cancel"
          : "↑↓ navigate • Enter select • Esc cancel";
      wrapWithPrefix(" ", theme.fg("dim", hint));
      lines.push(theme.fg("accent", "─".repeat(usable)));

      cached = lines;
      return lines;
    };

    return { render, invalidate: () => (cached = undefined), handleInput };
  });
}
