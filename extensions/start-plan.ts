// Z.ai / BigModel Start Plan (free tier) account access.
//
// Three boundaries, mirroring how ZCode itself uses the shared login:
//   1. Shared login: decrypt the Desktop credential store (plain values or
//      "enc:v1:" AES-256-GCM with the same local secret). Read-only.
//   2. Entitlements: authenticated billing/balance check per turn; only an
//      active, non-expired, non-exhausted grant authorizes the requested
//      model. No fallback to any other plan, ever.
//   3. Runtime: the bridge answers the app-server's runtime-header request
//      with the current shared JWT; nothing is persisted anywhere.
//
// Desktop owns sign-in, token renewal and CAPTCHA. A CAPTCHA-retry request
// fails with an instruction to complete verification in Desktop.
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform, userInfo, version as osVersion } from "node:os";
import { join, resolve } from "node:path";
import { readJson, tryReadJson } from "./io";

const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const BALANCE_DEADLINE_MS = 15_000;
// Revalidate on every turn; cap runtime authorization when the server omits
// expiry information.
const GRANT_CAP_SECONDS = 300;

export type Family = "zai" | "bigmodel";

export interface StartPlanLogin {
  family: Family;
  token: string;
}

// ---- Credential store ----

function decryptValue(value: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof value !== "string") return "";
  if (!value.startsWith("enc:v1:")) return value.trim();
  const parts = value.slice("enc:v1:".length).split(".");
  if (parts.length !== 3) throw new Error("Cannot decrypt ZCode login: invalid credential format.");
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* same fallback ZCode uses */
  }
  const secret =
    env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform()}:${env.HOME ?? ""}:${username}`;
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) throw new Error("format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      iv,
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
  } catch {
    throw new Error("Cannot decrypt ZCode login. Start ZCode Desktop and sign in again.");
  }
}

export function readLogin(directory: string, env: NodeJS.ProcessEnv): StartPlanLogin | undefined {
  const record = tryReadJson<Record<string, unknown>>(join(directory, "credentials.json"));
  if (!record) return undefined;
  const family = decryptValue(record["oauth:active_provider"], env);
  if (family !== "zai" && family !== "bigmodel") return undefined;
  const token = decryptValue(record.zcodejwttoken, env);
  return token ? { family, token } : undefined;
}

// ---- Balance payload -> active grant ----

interface BalancePlan {
  plan_id?: string;
  user_plan_id?: string;
  status?: string;
  starts_at?: number;
  ends_at?: number;
}
interface BalanceBucket {
  plan_id?: string;
  user_plan_id?: string;
  show_name?: string;
  capabilities?: string[];
  available_units?: number;
  remaining_units?: number;
  expires_at?: number;
  period_start?: number;
  period_end?: number;
}

function seconds(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid Start Plan expiry response.");
  return n;
}

export interface StartPlanGrant {
  /** Lowercased model ids the active grant covers. */
  modelIds: Set<string>;
  /** When the cached authorization must be revalidated (epoch ms). */
  expiresAtMs: number;
}

export function parseGrant(payload: unknown, nowMs: number): StartPlanGrant {
  const envelope = payload as {
    code?: number;
    success?: boolean;
    data?: { server_time?: number; plans?: BalancePlan[]; balances?: BalanceBucket[] };
  } | null;
  if (!envelope || envelope.code !== 0 || envelope.success === false ||
      !Array.isArray(envelope.data?.plans) || !Array.isArray(envelope.data?.balances)) {
    throw new Error("Start Plan balance is unavailable. Open ZCode Desktop and check your account.");
  }
  const now = typeof envelope.data.server_time === "number" && Number.isFinite(envelope.data.server_time)
    ? envelope.data.server_time
    : nowMs / 1000;
  const active = envelope.data.plans.filter((plan) =>
    plan &&
    plan.status?.toLowerCase() === "active" &&
    !(seconds(plan.starts_at) > now) &&
    !(seconds(plan.ends_at) > 0 && seconds(plan.ends_at) <= now));
  const modelIds = new Set<string>();
  let validFor = Infinity;
  for (const bucket of envelope.data.balances) {
    if (!bucket) continue;
    const plan = active.find((candidate) =>
      bucket.user_plan_id && candidate.user_plan_id
        ? bucket.user_plan_id === candidate.user_plan_id
        : !!bucket.plan_id && bucket.plan_id === candidate.plan_id);
    const units = bucket.available_units ?? bucket.remaining_units;
    if (!plan || typeof units !== "number" || !Number.isFinite(units) || units <= 0) continue;
    if (seconds(bucket.period_start) > now) continue;
    const expiries = [plan.ends_at, bucket.expires_at, bucket.period_end]
      .map(seconds)
      .filter((value) => value > 0);
    if (expiries.some((value) => value <= now)) continue;
    const covered = (bucket.capabilities ?? [])
      .filter((value) => typeof value === "string" && /^model:/i.test(value))
      .map((value) => value.slice(6).trim());
    if (covered.length === 0 && typeof bucket.show_name === "string") {
      covered.push(bucket.show_name.trim());
    }
    for (const modelId of covered) if (modelId) modelIds.add(modelId.toLowerCase());
    validFor = Math.min(validFor, ...expiries.map((value) => value - now));
  }
  if (modelIds.size === 0) {
    throw new Error(
      "Start Plan has no active model quota (expired, pending or exhausted). No fallback to another plan was made.",
    );
  }
  return { modelIds, expiresAtMs: nowMs + Math.min(validFor, GRANT_CAP_SECONDS) * 1000 };
}

// ---- Client ----

export interface StartPlanOptions {
  /** Directory of the shared ZCode state (credentials, telemetry, personal config). */
  directory: string;
  /** Bundled provider catalog path (Desktop app resources). */
  catalogPath: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface Prepared {
  providerId: string;
  /** Lowercased entitled model ids (auth matching). */
  modelIds: string[];
  /** Entitled model ids in catalog casing (registry materialization). */
  casedModelIds: string[];
  tokenHash: string;
  expiresAtMs: number;
}

export class StartPlan {
  private prepared: Prepared | undefined;
  private generation = 0;
  private options: StartPlanOptions;

  constructor(options: StartPlanOptions) {
    this.options = options;
  }

  providerIdFor(family: Family): string {
    return `account:${family}-start-plan`;
  }

  login(): StartPlanLogin | undefined {
    return readLogin(this.options.directory, this.options.env);
  }

  /**
   * Validate the grant and produce the account config pushed to the
   * app-server before the turn (provider/updateAccountConfig).
   * `catalogModelIds` are the provider's listable model ids in catalog
   * casing; the grant's lowercase ids only gate which of them are entitled.
   */
  async prepare(
    providerId: string,
    modelId: string,
    catalogModelIds: string[],
    signal?: AbortSignal,
  ): Promise<{
    revision: string;
    basedOnZCodeBuiltinRevision: string;
    providers: Record<string, unknown>;
    states: Record<string, unknown>;
  }> {
    const generation = ++this.generation;
    this.prepared = undefined;
    signal?.throwIfAborted();
    const login = this.requireLoginFor(providerId);
    const grant = await this.fetchGrant(login, signal);
    if (!grant.modelIds.has(modelId.toLowerCase())) {
      throw new Error(
        `Your Start Plan package does not include ${modelId}. Choose an included Start Plan model; no other plan was used.`,
      );
    }
    this.requireUnchanged(generation, login);
    // Entitled models in catalog casing; the app-server matches setModel refs
    // against this list case-sensitively.
    const entitled = catalogModelIds.filter((id) => grant.modelIds.has(id.toLowerCase()));
    const bundled = readJson<{ revision?: number }>(this.options.catalogPath);
    const providers = {
      [providerId]: { access: { type: "zhipu-account", entitled: true }, builtinModelIds: entitled },
    };
    const states = { [providerId]: { availability: "available", entitled: true, current: true } };
    const revision = `pi-zcode-bridge:${sha(
      JSON.stringify([providers, states, grant.expiresAtMs]),
    )}`;
    this.prepared = {
      providerId,
      modelIds: entitled.map((id) => id.toLowerCase()),
      casedModelIds: entitled,
      tokenHash: sha(login.token),
      expiresAtMs: grant.expiresAtMs,
    };
    return {
      revision,
      basedOnZCodeBuiltinRevision: `zcode-builtin:${bundled.revision ?? 0}:${sha(resolve(this.options.catalogPath))}`,
      providers,
      states,
    };
  }

  /**
   * Answer the app-server's runtime-header request for the prepared session.
   * `params` carries the session's model selection and account access.
   */
  async runtimeAuth(
    params: {
      sessionId?: string;
      providerId?: string;
      reason?: string;
      modelSelection?: { providerId?: string; modelId?: string };
      accountAccess?: { type?: string; mode?: string; accountType?: string };
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const prepared = this.prepared;
    if (
      !prepared ||
      params.providerId !== prepared.providerId ||
      params.modelSelection?.providerId !== prepared.providerId ||
      !params.modelSelection?.modelId ||
      !prepared.modelIds.includes(params.modelSelection.modelId.toLowerCase()) ||
      params.accountAccess?.type !== "zhipu-account" ||
      params.accountAccess.mode !== "start-plan" ||
      `account:${params.accountAccess.accountType}-start-plan` !== prepared.providerId
    ) {
      throw new Error("Unexpected ZCode account authorization request; no credentials were supplied.");
    }
    if (params.reason === "captcha-retry") {
      throw new Error("Start Plan requires CAPTCHA verification. Complete it in ZCode Desktop, then retry.");
    }
    signal?.throwIfAborted();
    if ((this.options.now ?? Date.now)() >= prepared.expiresAtMs) {
      await this.prepare(
        prepared.providerId,
        params.modelSelection.modelId,
        prepared.casedModelIds,
        signal,
      );
    }
    const login = this.requireLoginFor(prepared.providerId);
    if (sha(login.token) !== this.prepared?.tokenHash) {
      throw new Error("ZCode login changed or expired. Sign in again; no fallback was made.");
    }
    const appVersion = this.appVersion();
    return {
      headersApplied: true,
      requestAuth: { apiKey: login.token, headers: sourceHeaders(appVersion, this.options.directory) },
    };
  }

  /** Invalidate any prepared authorization (turn end, cancel, shutdown). */
  clear(): void {
    this.generation += 1;
    this.prepared = undefined;
  }

  // ---- internals ----

  private requireLoginFor(providerId: string): StartPlanLogin {
    const login = this.login();
    if (!login || this.providerIdFor(login.family) !== providerId) {
      throw new Error(
        "Not signed in to a Start Plan account. Open ZCode Desktop, sign in with your Z.ai or BigModel account, then retry.",
      );
    }
    return login;
  }

  private requireUnchanged(generation: number, login: StartPlanLogin): void {
    const latest = this.login();
    if (generation !== this.generation) {
      throw new Error("Start Plan authorization was cancelled or superseded.");
    }
    if (!latest || latest.family !== login.family || latest.token !== login.token) {
      throw new Error("ZCode login changed while checking Start Plan. Retry the request.");
    }
  }

  private async fetchGrant(login: StartPlanLogin, signal?: AbortSignal): Promise<StartPlanGrant> {
    const url = new URL(BALANCE_URL);
    url.searchParams.set("app_version", this.appVersion());
    const deadline = AbortSignal.timeout(BALANCE_DEADLINE_MS);
    let response: Response;
    try {
      response = await (this.options.fetchFn ?? fetch)(url, {
        headers: {
          ...sourceHeaders(this.appVersion(), this.options.directory),
          Authorization: `Bearer ${login.token}`,
        },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("Cannot check Start Plan balance (network error or timeout). No fallback was made.");
    }
    if (!response.ok) {
      throw new Error(`Start Plan balance HTTP ${response.status}. Check your login and package in ZCode Desktop.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Invalid Start Plan balance response.");
    }
    return parseGrant(payload, (this.options.now ?? Date.now)());
  }

  /** Desktop version used in billing headers: env override, then the app's Info.plist. */
  appVersion(): string {
    const configured = this.options.env.ZCODE_APP_VERSION;
    if (configured) return configured;
    try {
      const plist = readFileSync(resolve(this.options.catalogPath, "../../../../Info.plist"), "utf8");
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      if (match) return match[1];
    } catch {
      /* non-standard layouts can set the env override */
    }
    throw new Error("Cannot detect the ZCode Desktop version. Set ZCODE_APP_VERSION to use Start Plan.");
  }
}

function sourceHeaders(appVersion: string, directory: string): Record<string, string> {
  const telemetry = tryReadJson<{ deviceMid?: unknown }>(join(directory, "telemetry-state.json"));
  const deviceMid = telemetry?.deviceMid;
  if (typeof deviceMid !== "string" || !/^[a-f0-9-]{36}$/i.test(deviceMid)) {
    throw new Error("ZCode device identity is missing. Start ZCode Desktop once before using Start Plan.");
  }
  const locale = Intl.DateTimeFormat().resolvedOptions();
  return {
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${appVersion}`,
    "X-Title": "Z Code@pi",
    "X-ZCode-App-Version": appVersion,
    "X-Platform": `${platform()}-${arch()}`,
    "X-Device-Mid": deviceMid,
    "X-Client-Language": locale.locale,
    "X-Client-Timezone": locale.timeZone,
    "X-Os-Category": platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux",
    "X-Os-Version": osVersion(),
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
