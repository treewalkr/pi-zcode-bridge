// pi-zcode-bridge — ZCode Desktop app-server as a pi model provider.
//
// Registers the pi provider "zcode" with every model ZCode Desktop can run
// for this machine: Start Plan (free tier) account models plus all API-key
// providers configured in Desktop. pi is the chat frontend; the ZCode agent
// (spawned from the Desktop bundle) runs its own tools and sessions, and
// streams back through the bridge. See README for the architecture.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppServer } from "./server";
import { StartPlan, type Family } from "./start-plan";
import { readCatalog, type BridgeModel } from "./catalog";
import { TurnEngine, thinkingLevelMapOf } from "./turn";
import { askInPi } from "./ask";
import { fileExists, readJson, writeJson } from "./io";

const HOME = process.env.HOME ?? "~";
const MAC_RESOURCES = "/Applications/ZCode.app/Contents/Resources";
const BUNDLED_CATALOG_PATH =
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ??
  `${MAC_RESOURCES}/config/provider/zcode-builtin.json`;
const APP_SERVER_CJS = [
  "/opt/ZCode/resources/glm/zcode.cjs", // Linux layout
  `${MAC_RESOURCES}/glm/zcode.cjs`, // macOS layout
];
const V2_CONFIG_PATH = process.env.ZCODE_V2_CONFIG ?? `${HOME}/.zcode/v2/config.json`;
const V2_DIR = dirname(V2_CONFIG_PATH);
const SESSION_MAP_PATH =
  process.env.ZCODE_SESSION_MAP ?? `${HOME}/.zcode/cli/pi-zcode-bridge-sessions.json`;
const SESSION_MAP_MAX_ENTRIES = 32;
const TURN_TIMEOUT_MS = (() => {
  const n = Number(process.env.ZCODE_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();
const DEBUG = Boolean(process.env.ZCODE_DEBUG);

function defaultServeCmd(): string {
  const ordered =
    process.platform === "darwin" ? [...APP_SERVER_CJS].reverse() : APP_SERVER_CJS;
  const found = ordered.find(fileExists);
  return `node ${found ?? ordered[0]} app-server`;
}

// ---- pi session -> zcode session continuity sidecar ----

interface RememberedSession {
  sessionId: string;
  workspacePath: string;
  updatedAt: string;
}

function loadSessionMap(): Record<string, RememberedSession> {
  try {
    return readJson<Record<string, RememberedSession>>(SESSION_MAP_PATH);
  } catch {
    return {};
  }
}

function rememberSession(piSessionId: string | null, zcodeSessionId: string, workspacePath: string): void {
  if (!piSessionId) return;
  try {
    const map = loadSessionMap();
    map[piSessionId] = { sessionId: zcodeSessionId, workspacePath, updatedAt: new Date().toISOString() };
    const entries = Object.entries(map).sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? -1 : 1));
    for (const [key] of entries.slice(0, Math.max(0, entries.length - SESSION_MAP_MAX_ENTRIES))) {
      delete map[key];
    }
    writeJson(SESSION_MAP_PATH, map);
  } catch {
    /* best-effort: without the map a restore starts a fresh zcode session */
  }
}

function rememberedSessionId(piSessionId: string | null): string | null {
  if (!piSessionId) return null;
  const entry = loadSessionMap()[piSessionId];
  if (!entry || entry.workspacePath !== process.cwd()) return null;
  return entry.sessionId;
}

export default function register(pi: ExtensionAPI) {
  const startPlan = new StartPlan({
    directory: V2_DIR,
    catalogPath: BUNDLED_CATALOG_PATH,
    env: process.env,
  });

  // The bridge model table for the current turn of configuration. Model ids
  // pin provider/model refs so a model can never silently switch plans.
  let catalog: BridgeModel[] = [];
  const runtimeMetadata = new Map<
    string,
    { contextWindow?: number; maxTokens?: number; reasoningVariants?: string[] }
  >();
  const catalogById = (id: string) => catalog.find((model) => model.id === id);

  const refreshCatalog = () => {
    const families = new Set<Family>();
    const login = startPlan.login();
    if (login) families.add(login.family);
    try {
      catalog = readCatalog({
        stateDirectory: V2_DIR,
        bundledCatalogPath: BUNDLED_CATALOG_PATH,
        signedInFamilies: families,
      });
    } catch (error) {
      console.warn(
        `[zcode] catalog refresh failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  refreshCatalog();

  const toPiModels = (): Model<Api>[] =>
    catalog.map((model) => {
      const meta = runtimeMetadata.get(model.id) ?? model;
      const variants = meta.reasoningVariants;
      return {
        id: model.id,
        name: model.name,
        reasoning: Boolean(variants?.length),
        ...(variants?.length ? { thinkingLevelMap: thinkingLevelMapOf(variants) } : {}),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow ?? 200000,
        maxTokens: meta.maxTokens ?? 8192,
      } as Model<Api>;
    });

  let uiCtx: ExtensionContext | null = null;
  let piSessionId: string | null = null;
  let probeLog: ((line: string) => void) | null = null;

  const server = new AppServer({
    command: process.env.ZCODE_SERVE_CMD ?? defaultServeCmd(),
    env: (() => {
      const env = { ...process.env };
      // The app-server spawned outside the Desktop process cannot find its
      // own configuration: point it at Desktop's bundled catalog and the
      // shared personal provider config (both read-only for the bridge).
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ??= BUNDLED_CATALOG_PATH;
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ??= `${V2_DIR}/provider_config.json`;
      return env;
    })(),
    hooks: {
      runtimePreferences: () => ({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      }),
      permission: () => ({
        decision: process.env.ZCODE_AUTO_ALLOW === "0" ? "deny" : "allow",
        reason: "pi zcode bridge",
      }),
      providerRuntimeHeaders: (params) => engine.providerRuntimeHeaders(params),
      userInput: async (msg) => {
        try {
          const questions = Array.isArray(msg.params?.questions) ? msg.params.questions : [];
          if (questions.length === 0) throw new Error("no questions in interaction");
          const content = await askInPi(uiCtx, questions);
          server.answerServerRequest(msg.id, { action: "accept", content });
        } catch {
          server.answerServerRequest(msg.id, { action: "cancel", reason: "cancelled by user in pi" });
        }
      },
    },
    onDown: () => engine.reset(),
    debug: (line) => {
      probeLog?.(line);
    },
  });

  const engine = new TurnEngine({
    server,
    startPlan,
    resolveModel: catalogById,
    piSessionId: () => piSessionId,
    rememberSession: (zcodeSessionId, workspacePath) =>
      rememberSession(piSessionId, zcodeSessionId, workspacePath),
    rememberedSessionId: () => rememberedSessionId(piSessionId),
    notify: (text) => uiCtx?.ui.notify(text, "info"),
    runtimeMetadata,
    turnTimeoutMs: TURN_TIMEOUT_MS,
  });

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    piSessionId =
      ctx.sessionManager?.getSessionId() ?? ctx.sessionManager?.getSessionFile() ?? null;
  });

  pi.registerProvider("zcode", {
    name: "ZCode (Desktop app-server)",
    baseUrl: "zcode://app-server",
    api: "zcode",
    // Dummy key: stdio bridge, no real authentication.
    apiKey: "zcode-bridge",
    models: toPiModels(),
    // Re-read on every /model open so Desktop-side changes (sign-in, added
    // providers, model toggles) appear without a reload.
    refreshModels: async () => {
      refreshCatalog();
      return toPiModels();
    },
    streamSimple: (model, context, options) => engine.streamSimple(model, context, options),
  });

  // ZCode owns its conversation history and compacts it independently; pi's
  // transcript is only a UI mirror. Cancel pi-side compaction while the
  // zcode provider is active; ZCode's own compactions are reported live.
  pi.on("session_before_compact", (_event, ctx) => {
    if (ctx.model?.provider !== "zcode") return;
    return { cancel: true };
  });

  pi.registerCommand("zcode-probe", {
    description: "Probe the zcode app-server: one full turn, dump raw protocol lines",
    handler: async (_args, ctx) => {
      const file = "/tmp/zcode-probe.jsonl";
      let lines = 0;
      probeLog = (line) => {
        lines++;
        void appendFile(file, line + "\n");
      };
      try {
        refreshCatalog();
        const model = catalog.find((entry) => entry.plan === "start-plan") ?? catalog[0];
        if (!model) throw new Error("no zcode models available (signed out and no API-key providers)");
        const accountConfig = await startPlan.prepare(model.providerId, model.modelId).catch(() => undefined);
        if (accountConfig) await server.request("provider/updateAccountConfig", accountConfig);
        const created = await server.request<{ session: { sessionId: string } }>("session/create", {
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
        });
        await server.request("session/setModel", {
          sessionId: created.session.sessionId,
          model: { providerId: model.providerId, modelId: model.modelId },
        });
        await server.request("session/send", {
          sessionId: created.session.sessionId,
          content: "Reply with exactly: probe-ok",
        });
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      } finally {
        probeLog = null;
      }
      ctx.ui.notify(`Probe done. Raw protocol in ${file} (${lines} lines).`, "info");
    },
  });

  if (DEBUG) {
    console.error(`[zcode-debug] serve cmd: ${process.env.ZCODE_SERVE_CMD ?? defaultServeCmd()}`);
  }

  pi.on("session_shutdown", async () => {
    await engine.shutdown();
    server.kill();
  });
}
