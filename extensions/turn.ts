// Turn engine: one pi streamSimple call == one ZCode turn.
//
// Flow per turn: (Start Plan only) balance-validated account config push ->
// session create/resume (with cross-restart continuity sidecar) -> setModel
// (with mapped thinking level) -> subscribe -> send -> live-stream
// model.streaming events (text/reasoning/tool calls) with inline tool
// rendering -> terminal only on the authoritative turn.completed /
// turn.failed notifications -> session/read for authoritative model metadata
// and live context usage.
//
// A per-turn budget interrupts long turns and sends "go on" so they
// checkpoint instead of failing; an abort stops the turn and cancels the
// background tasks it started.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Api,
  SimpleStreamOptions,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { AppServer, ServerMessage } from "./server";
import type { StartPlan } from "./start-plan";
import type { BridgeModel } from "./catalog";
import {
  displayToolName,
  formatBashCallOpen,
  formatBashResultClose,
  formatToolCall,
  formatToolResult,
  normalizeToolInput,
} from "./render";

// ---- wire types (only what the engine reads) ----

interface ToolResult {
  success?: boolean;
  content?: unknown;
  truncated?: boolean;
}
interface TurnError {
  message?: string;
  code?: string;
  attribution?: { statusCode?: number };
}
interface StreamPayload {
  kind?: string;
  delta?: string;
  input?: unknown;
  assistantMessageId?: string;
  toolCallId?: string;
  toolName?: string;
  response?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  result?: ToolResult;
  error?: TurnError;
  taskId?: string;
  status?: string;
  operationId?: string;
  trigger?: string;
  preCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
}
interface StreamEvent {
  type: string;
  payload?: StreamPayload;
}
interface SessionSnapshot {
  runtime?: {
    contextUsage?: {
      used?: number;
      cache?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    };
  };
  settings?: {
    model?: {
      available?: Array<{
        ref?: { providerId?: string; modelId?: string };
        contextWindow?: number;
        maxOutputTokens?: number;
        reasoning?: { levels?: Array<{ value?: string }> };
      }>;
    };
  };
}

export function thinkingLevelMapOf(variants: string[] | undefined): ThinkingLevelMap | undefined {
  if (!variants?.length) return undefined;
  const has = new Set(variants);
  return {
    off: has.has("off") ? "off" : has.has("disabled") ? "disabled" : null,
    minimal: has.has("minimal") ? "minimal" : null,
    low: has.has("low") ? "low" : null,
    medium: has.has("medium") ? "medium" : null,
    high: has.has("high") ? "high" : null,
    xhigh: has.has("xhigh") ? "xhigh" : null,
    max: has.has("max") ? "max" : null,
  };
}

function formatTurnError(error: TurnError): string {
  const message = error.message?.trim() || "unknown error";
  if (error.attribution?.statusCode) return `${message} (HTTP ${error.attribution.statusCode})`;
  if (error.code) return `${message} (${error.code})`;
  return message;
}

function parsePartialJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface TurnEngineDeps {
  server: AppServer;
  startPlan: StartPlan;
  /** Look up the bridge model for a pi model id. */
  resolveModel: (id: string) => BridgeModel | undefined;
  /** pi session UUID for the continuity sidecar (null outside a session). */
  piSessionId: () => string | null;
  /** Remember/resume zcode session ids per pi session. */
  rememberSession: (zcodeSessionId: string, workspacePath: string) => void;
  rememberedSessionId: () => string | null;
  /** Non-fatal user notifications (compaction, ...). */
  notify: (text: string) => void;
  /** Authoritative model metadata observed at runtime, keyed by pi model id. */
  runtimeMetadata: Map<string, { contextWindow?: number; maxTokens?: number; reasoningVariants?: string[] }>;
  turnTimeoutMs: number;
}

export class TurnEngine {
  private sessionId: string | null = null;
  private lastModelId: string | null = null;
  private lastThoughtLevel: string | null = null;
  private authContext: { sessionId: string; signal: AbortSignal } | undefined;
  private runningTasks = new Map<string, Set<string>>();
  private notifiedCompactions = new Set<string>();
  private deps: TurnEngineDeps;

  constructor(deps: TurnEngineDeps) {
    this.deps = deps;
  }

  /** Server went down or session ended: drop all in-memory state. */
  reset(): void {
    this.sessionId = null;
    this.lastModelId = null;
    this.lastThoughtLevel = null;
    this.authContext = undefined;
    this.startPlanClear();
    this.runningTasks.clear();
  }

  private startPlanClear(): void {
    this.authContext = undefined;
    this.deps.startPlan.clear();
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "zcode",
      provider: "zcode",
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    void (async () => {
      out.push({ type: "start", partial: output });
      const authController = new AbortController();
      const authSignal = options?.signal
        ? AbortSignal.any([options.signal, authController.signal])
        : authController.signal;
      // ---- transcript block bookkeeping (lazily created; ids interleave) ----
      const textBlocks = new Map<string, { text?: number; thinking?: number }>();
      const toolBlocks = new Map<string, number>();
      const toolNames = new Map<string, string>();
      const finalizedTools = new Set<string>();
      const openBashBlocks = new Map<string, number>();
      const bashStarts = new Map<string, number>();
      const started = new Set<number>();
      const ended = new Set<number>();
      const partialJson = new Map<string, string>();
      let streamedText = false;
      let finalResponse: string | undefined;
      let turnError: string | undefined;
      let settled = false;
      let turnSettled = false;
      let turnStarted = false;
      let failed = false;

      const blockFor = (key: string, kind: "text" | "thinking"): number => {
        const entry = textBlocks.get(key) ?? {};
        const existing = kind === "text" ? entry.text : entry.thinking;
        if (existing !== undefined) return existing;
        const index = output.content.length;
        output.content.push(
          kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
        );
        if (kind === "text") entry.text = index;
        else entry.thinking = index;
        textBlocks.set(key, entry);
        return index;
      };
      const emitStart = (index: number, kind: "text" | "thinking") => {
        if (started.has(index)) return;
        started.add(index);
        out.push({
          type: kind === "text" ? "text_start" : "thinking_start",
          contentIndex: index,
          partial: output,
        });
      };
      const emitDelta = (index: number, delta: string, kind: "text" | "thinking") => {
        const block: any = output.content[index];
        if (kind === "text") block.text += delta;
        else block.thinking += delta;
        emitStart(index, kind);
        out.push({
          type: kind === "text" ? "text_delta" : "thinking_delta",
          contentIndex: index,
          delta,
          partial: output,
        });
      };
      const emitEnd = (index: number, kind: "text" | "thinking") => {
        if (ended.has(index)) return;
        ended.add(index);
        const block: any = output.content[index];
        out.push({
          type: kind === "text" ? "text_end" : "thinking_end",
          contentIndex: index,
          content: kind === "text" ? block.text : block.thinking,
          partial: output,
        });
      };
      const toolBlockFor = (callId: string): number => {
        let index = toolBlocks.get(callId);
        if (index === undefined) {
          index = output.content.length;
          output.content.push({ type: "text", text: "" });
          toolBlocks.set(callId, index);
        }
        return index;
      };
      const emitToolText = (callId: string, markdown: string) => {
        const index = toolBlockFor(callId);
        emitDelta(index, markdown, "text");
        emitEnd(index, "text");
      };
      const openBashBlock = (callId: string, markdown: string) => {
        const index = toolBlockFor(callId);
        openBashBlocks.set(callId, index);
        emitDelta(index, markdown, "text");
      };
      const closeBashBlock = (callId: string, markdown: string) => {
        const index = openBashBlocks.get(callId);
        if (index === undefined) return;
        openBashBlocks.delete(callId);
        emitDelta(index, markdown, "text");
        emitEnd(index, "text");
      };
      const flushOpenBashBlocks = () => {
        for (const [callId, index] of [...openBashBlocks]) {
          openBashBlocks.delete(callId);
          emitDelta(index, "\n```\n", "text");
          emitEnd(index, "text");
        }
      };
      const finish = (reason: "stop" | "error" | "aborted", errorMessage?: string) => {
        if (output.stopReason !== "pending") return;
        authController.abort();
        this.startPlanClear();
        flushOpenBashBlocks();
        if (reason === "stop") {
          output.stopReason = "stop";
          out.push({ type: "done", reason: "stop", message: output });
        } else {
          output.stopReason = reason;
          output.errorMessage = errorMessage ?? output.errorMessage;
          out.push({ type: "error", reason, error: output });
        }
      };

      // ---- live session/event processing ----
      const onEvent = (msg: ServerMessage) => {
        if (!msg.method) return;
        if (msg.method === "state.updated") {
          // "prompt_completed" snapshots race with the next turn and are NOT
          // terminal; only the error patch is kept as a fallback signal.
          const patch = (msg.params as { patch?: { status?: string; lastError?: TurnError } }).patch;
          if (turnStarted && patch?.status === "error") {
            failed = true;
            turnSettled = true;
            if (!turnError && patch.lastError?.message) {
              turnError = formatTurnError(patch.lastError);
            }
          }
          return;
        }
        if (msg.method !== "session/event") return;
        const event = msg.params as StreamEvent;
        const payload = event.payload ?? {};
        switch (event.type) {
          case "turn.started":
            turnStarted = true;
            return;
          case "turn.completed":
            if (typeof payload.response === "string" && payload.response) {
              finalResponse = payload.response;
            }
            if (payload.usage) {
              const cacheRead = payload.usage.cacheReadTokens ?? 0;
              const cacheWrite = payload.usage.cacheWriteTokens ?? 0;
              const outputTokens = payload.usage.outputTokens ?? 0;
              // ZCode's inputTokens includes cached input; pi tracks cache separately.
              const inputTokens = Math.max(0, (payload.usage.inputTokens ?? 0) - cacheRead - cacheWrite);
              output.usage.input = inputTokens;
              output.usage.output = outputTokens;
              output.usage.cacheRead = cacheRead;
              output.usage.cacheWrite = cacheWrite;
              output.usage.totalTokens =
                payload.usage.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheWrite;
            }
            settled = true;
            turnSettled = true;
            return;
          case "turn.failed":
            failed = true;
            turnSettled = true;
            if (!turnError && payload.error?.message) turnError = formatTurnError(payload.error);
            return;
          case "tool.updated": {
            const callId = payload.toolCallId ?? "";
            const name = (toolNames.get(callId) ?? "").toLowerCase();
            if (callId && name === "bash" && payload.kind === "started") {
              if (!bashStarts.has(callId)) bashStarts.set(callId, Date.now());
              return;
            }
            if (callId && payload.kind === "result" && payload.result !== undefined) {
              if (name === "bash" && openBashBlocks.has(callId)) {
                closeBashBlock(callId, formatBashResultClose(payload.result, bashStarts.get(callId)));
              } else {
                const markdown = formatToolResult(toolNames.get(callId) ?? "tool", payload.result);
                if (markdown) emitToolText(`result:${callId}`, markdown);
              }
            }
            return;
          }
          case "session.updated": {
            // ZCode's own auto-compaction: report once per operation, never drive it.
            if (
              payload.trigger === "auto" &&
              payload.status === "completed" &&
              payload.operationId &&
              !this.notifiedCompactions.has(payload.operationId)
            ) {
              this.notifiedCompactions.add(payload.operationId);
              const before = payload.preCompactTokenCount;
              const after = payload.truePostCompactTokenCount;
              const counts =
                typeof before === "number" && typeof after === "number"
                  ? ` (${before.toLocaleString()} → ${after.toLocaleString()} tokens)`
                  : "";
              this.deps.notify(`ZCode automatically compacted its context${counts}.`);
            }
            // Background tasks: track running ids so a pi abort cancels them.
            const taskId = payload.taskId;
            const status = payload.status;
            if (typeof taskId === "string" && taskId && typeof status === "string" && status) {
              const eventSessionId = (msg.params as { sessionId?: string }).sessionId ?? this.sessionId;
              if (eventSessionId) {
                const set = this.runningTasks.get(eventSessionId) ?? new Set<string>();
                if (status === "running") set.add(taskId);
                else set.delete(taskId);
                this.runningTasks.set(eventSessionId, set);
              }
            }
            return;
          }
          case "model.streaming": {
            const kind = payload.kind ?? "";
            const key = payload.assistantMessageId ?? "";
            if (kind === "text_start" || kind === "text_delta") {
              const index = blockFor(key, "text");
              if (typeof payload.delta === "string" && payload.delta) {
                streamedText = true;
                emitDelta(index, payload.delta, "text");
              } else emitStart(index, "text");
            } else if (kind === "text_end") {
              emitEnd(blockFor(key, "text"), "text");
            } else if (kind === "reasoning_start" || kind === "reasoning_delta") {
              const index = blockFor(key, "thinking");
              if (typeof payload.delta === "string" && payload.delta) {
                emitDelta(index, payload.delta, "thinking");
              } else emitStart(index, "thinking");
            } else if (kind === "reasoning_end") {
              emitEnd(blockFor(key, "thinking"), "thinking");
            } else if (kind === "tool_input_start") {
              const callId = payload.toolCallId ?? "";
              if (callId) toolNames.set(callId, displayToolName(payload.toolName ?? "tool"));
            } else if (kind === "tool_input_delta") {
              const callId = payload.toolCallId ?? "";
              if (callId) {
                partialJson.set(callId, (partialJson.get(callId) ?? "") + (payload.delta ?? ""));
              }
            } else if (kind === "tool_input_end" || kind === "tool_call") {
              const callId = payload.toolCallId ?? "";
              if (callId && !finalizedTools.has(callId)) {
                finalizedTools.add(callId);
                const args =
                  kind === "tool_call" && payload.input !== undefined
                    ? normalizeToolInput(payload.input)
                    : parsePartialJson(partialJson.get(callId) ?? "");
                const name = toolNames.get(callId) ?? displayToolName(payload.toolName ?? "tool");
                if (name.toLowerCase() === "bash") {
                  if (!bashStarts.has(callId)) bashStarts.set(callId, Date.now());
                  openBashBlock(callId, formatBashCallOpen(args));
                } else {
                  emitToolText(`call:${callId}`, formatToolCall(name, args));
                }
              }
            }
            return;
          }
          default:
            return;
        }
      };

      // ---- setup: auth, session, model selection ----
      let prompt = "";
      try {
        const bridgeModel = this.deps.resolveModel(model.id);
        if (!bridgeModel) throw new Error(`unknown zcode model: ${model.id}`);
        const ref = { providerId: bridgeModel.providerId, modelId: bridgeModel.modelId };
        if (bridgeModel.plan === "start-plan") {
          const accountConfig = await this.deps.startPlan.prepare(ref.providerId, ref.modelId, authSignal);
          authSignal.throwIfAborted();
          await this.deps.server.request("provider/updateAccountConfig", accountConfig);
        }
        this.sessionId = await this.ensureSession();
        if (bridgeModel.plan === "start-plan") {
          this.authContext = { sessionId: this.sessionId, signal: authSignal };
        }
        const requestedThinking = options?.reasoning;
        const mapped = requestedThinking ? model.thinkingLevelMap?.[requestedThinking] : undefined;
        const reasoningLevel = typeof mapped === "string" ? mapped : undefined;
        if (model.reasoning && !reasoningLevel) {
          const supported = Object.entries(model.thinkingLevelMap ?? {})
            .filter(([, value]) => typeof value === "string")
            .map(([level]) => level)
            .join(", ");
          throw new Error(`select a supported thinking level for ${model.id}: ${supported || "none"}`);
        }
        if (this.lastModelId !== model.id) {
          await this.deps.server.request("session/setModel", {
            sessionId: this.sessionId,
            model: reasoningLevel ? { ...ref, options: { reasoningLevel } } : ref,
          });
          this.lastModelId = model.id;
          this.lastThoughtLevel = reasoningLevel ?? null;
        } else if (reasoningLevel && reasoningLevel !== this.lastThoughtLevel) {
          await this.deps.server.request("session/setThoughtLevel", {
            sessionId: this.sessionId,
            thoughtLevel: reasoningLevel,
          });
          this.lastThoughtLevel = reasoningLevel;
        }
        const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
        prompt =
          typeof lastUser?.content === "string"
            ? lastUser.content
            : (lastUser?.content ?? [])
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("");
        if (!prompt) throw new Error("no user message in context");
        authSignal.throwIfAborted();
      } catch (error) {
        finish(
          options?.signal?.aborted ? "aborted" : "error",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const sessionId = this.sessionId;

      // ---- abort handling: stop the turn and cancel its background tasks ----
      this.deps.server.on(onEvent);
      const abortHandler = () => {
        this.deps.server.off(onEvent);
        clearTimeout(budget);
        void (async () => {
          try {
            await this.deps.server.request("session/stop", { sessionId });
            const tasks = this.runningTasks.get(sessionId);
            if (tasks) {
              for (const taskId of [...tasks]) {
                await this.deps.server
                  .request("session/cancelBackgroundTask", { sessionId, taskId })
                  .catch(() => {});
              }
              this.runningTasks.delete(sessionId);
            }
          } catch {
            /* server may already be gone */
          }
        })();
        finish("aborted", "aborted by user");
      };
      options?.signal?.addEventListener("abort", abortHandler, { once: true });

      // ---- per-turn budget: interrupt + "go on" checkpoint ----
      const budget = setTimeout(() => {
        if (settled || output.stopReason !== "pending") return;
        void (async () => {
          try {
            turnSettled = false;
            await this.deps.server.request("session/stop", { sessionId });
            const deadline = Date.now() + 10_000;
            while (!turnSettled && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (settled) return; // completed right at the boundary
            await this.deps.server.request("session/send", { sessionId, content: "go on" });
            budget.refresh?.();
          } catch (error) {
            this.deps.server.off(onEvent);
            finish("error", error instanceof Error ? error.message : String(error));
          }
        })();
      }, this.deps.turnTimeoutMs);
      budget.unref?.();

      // ---- send ----
      try {
        // Subscribe BEFORE send: the first deltas stream while send awaits,
        // and only turn.completed/turn.failed are race-free terminal signals.
        await this.deps.server.request("session/subscribe", {
          sessionId,
          deliveryKind: "desktop-continuous",
        });
        authSignal.throwIfAborted();
        await this.deps.server.request("session/send", { sessionId, content: prompt });
      } catch (error) {
        this.deps.server.off(onEvent);
        clearTimeout(budget);
        finish("error", error instanceof Error ? error.message : String(error));
        return;
      }

      // ---- await terminal event ----
      while (!settled && !failed) {
        if (output.stopReason !== "pending") return; // aborted/errored already
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      clearTimeout(budget);
      this.deps.server.off(onEvent);

      if (failed) {
        finish(
          "error",
          turnError ? `zcode turn failed: ${turnError}` : "zcode turn ended with failure",
        );
        return;
      }
      try {
        // turn.completed.usage is cumulative across ZCode's internal tool
        // loop; pi needs the final request's live context usage instead.
        const snapshot = await this.deps.server.request<SessionSnapshot>("session/read", {
          sessionId,
          messageLimit: 1,
        });
        const bridgeModel = this.deps.resolveModel(model.id);
        if (bridgeModel) {
          const available = snapshot.settings?.model?.available?.find(
            (candidate) =>
              candidate.ref?.providerId === bridgeModel.providerId &&
              candidate.ref?.modelId === bridgeModel.modelId,
          );
          if (available) {
            if (typeof available.contextWindow === "number" && available.contextWindow > 0) {
              model.contextWindow = available.contextWindow;
            }
            if (typeof available.maxOutputTokens === "number" && available.maxOutputTokens > 0) {
              model.maxTokens = available.maxOutputTokens;
            }
            const variants = available.reasoning?.levels
              ?.map((level) => level.value)
              .filter((value): value is string => typeof value === "string");
            if (variants?.length) {
              model.reasoning = true;
              model.thinkingLevelMap = thinkingLevelMapOf(variants);
            }
            this.deps.runtimeMetadata.set(model.id, {
              contextWindow: available.contextWindow,
              maxTokens: available.maxOutputTokens,
              reasoningVariants: variants,
            });
          }
        }
        const usage = snapshot.runtime?.contextUsage;
        const used = usage?.used;
        if (typeof used === "number" && used >= 0) {
          const rawInput = Math.min(used, Math.max(0, usage?.cache?.inputTokens ?? used));
          const cacheRead = Math.min(rawInput, Math.max(0, usage?.cache?.cacheReadTokens ?? 0));
          const cacheWrite = Math.min(rawInput - cacheRead, Math.max(0, usage?.cache?.cacheWriteTokens ?? 0));
          output.usage.input = Math.max(0, rawInput - cacheRead - cacheWrite);
          output.usage.output = Math.max(0, used - rawInput);
          output.usage.cacheRead = cacheRead;
          output.usage.cacheWrite = cacheWrite;
          output.usage.totalTokens = used;
        }
      } catch {
        /* keep cumulative turn.completed usage as a compatibility fallback */
      }
      if (!streamedText) {
        // No live deltas arrived: fall back to the final response, then to
        // the persisted messages store.
        const full = (finalResponse ?? "").trim() || (await this.harvestLastAssistantText(sessionId));
        if (full) {
          const index = blockFor("", "text");
          streamedText = true;
          emitDelta(index, full, "text");
          emitEnd(index, "text");
        }
      }
      finish("stop");
    })();
    return out;
  }

  /** Authorize the app-server's runtime-header request for the active turn. */
  async providerRuntimeHeaders(params: {
    sessionId?: string;
    providerId?: string;
    reason?: string;
    modelSelection?: { providerId?: string; modelId?: string };
    accountAccess?: { type?: string; mode?: string; accountType?: string };
  }): Promise<unknown> {
    const auth = this.authContext;
    if (!auth || params.sessionId !== auth.sessionId) {
      return { headersApplied: false, errorMessage: "No active Start Plan authorization for this session." };
    }
    try {
      return await this.deps.startPlan.runtimeAuth(params, auth.signal);
    } catch (error) {
      return {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : "Start Plan authorization failed.",
      };
    }
  }

  /** Persist the zcode session (close) at shutdown; keep the resume sidecar. */
  async shutdown(): Promise<void> {
    this.startPlanClear();
    this.runningTasks.clear();
    if (this.sessionId) {
      try {
        await this.deps.server.request("session/close", { sessionId: this.sessionId });
      } catch {
        /* server may already be gone */
      }
      this.sessionId = null;
      this.lastModelId = null;
      this.lastThoughtLevel = null;
    }
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) {
      const remembered = this.deps.rememberedSessionId();
      if (remembered) {
        try {
          await this.deps.server.request("session/resume", { sessionId: remembered });
          this.lastModelId = null;
          this.lastThoughtLevel = null;
          return remembered;
        } catch {
          /* purged server-side: fall through to a fresh session */
        }
      }
      const created = await this.deps.server.request<{ session: { sessionId: string } }>(
        "session/create",
        { workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() } },
      );
      this.lastModelId = null;
      this.lastThoughtLevel = null;
      this.deps.rememberSession(created.session.sessionId, process.cwd());
      return created.session.sessionId;
    }
    // The app-server evicts idle sessions (10-min default) and then rejects
    // session-bound calls; resume rehydrates from its persisted store.
    await this.deps.server.request("session/resume", { sessionId: this.sessionId });
    return this.sessionId;
  }

  private async harvestLastAssistantText(sessionId: string): Promise<string> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 500)); // settle delay
      const messages = await this.deps.server.request<{
        messages?: Array<{ info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }>;
      }>("session/messages", { sessionId });
      const last = [...(messages.messages ?? [])]
        .reverse()
        .find((message) => message.info?.role === "assistant");
      return (last?.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
    } catch {
      return "";
    }
  }
}
