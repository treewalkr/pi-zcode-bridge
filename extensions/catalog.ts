// Model discovery. Two provider classes, one catalog:
//
//   1. Start Plan (free tier) — account providers from Desktop's bundled
//      provider catalog ("account:<family>-start-plan"). Only models whose
//      family login is present are listed.
//   2. API-key providers — every provider with an inline API key in the
//      shared personal provider config (~/.zcode/v2/provider_config.json),
//      i.e. anything you add in ZCode Desktop. The app-server materializes
//      them itself; the bridge only lists and selects them.
//
// Every pi model pins the exact ZCode providerId/modelId used at turn time,
// so a Start Plan model can never silently route through a paid provider.
// pi model ids use ZCode's own naming, e.g.:
//   "Start Plan/GLM-5.3-Flash"   [zcode]   (free tier)
//   "Z.ai Coding Plan/GLM-5.3"   [zcode]   (API-key provider)
import type { Family } from "./start-plan";
import { tryReadJson } from "./io";

export type PlanKind = "start-plan" | "api-key";

export interface BridgeModel {
  /** pi model id (displayed verbatim by the /model picker). */
  id: string;
  /** Pretty name shown on the highlighted row. */
  name: string;
  /** ZCode ref head: "account:zai-start-plan" or the API-key provider id. */
  providerId: string;
  modelId: string;
  plan: PlanKind;
  contextWindow?: number;
  maxTokens?: number;
  reasoningVariants?: string[];
}

export interface CatalogInput {
  /** Shared ZCode state directory (~/.zcode/v2). */
  stateDirectory: string;
  /** Desktop's bundled provider catalog path. */
  bundledCatalogPath: string;
  /** Families with a readable Start Plan login. */
  signedInFamilies: Set<Family>;
}

// --- Bundled catalog / personal config shapes (only the fields we use) ---

interface ModelSpec {
  properties?: { contextWindow?: number };
  optionSpecs?: {
    maxOutputTokens?: { max?: number };
    reasoningLevel?: { values?: string[] };
  };
}
interface ProviderRule {
  providerId?: string;
  providerName?: string;
  config?: {
    apiKey?: string;
    builtinModelIds?: string[];
    personalModelIds?: string[];
    modelOrder?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
  };
}
interface BundledCatalog {
  revision?: number;
  config?: {
    providerConfigRules?: { providerRules?: ProviderRule[] };
    modelConfigRules?: { modelRules?: Array<{ modelMatch?: string; config?: ModelSpec }> };
  };
}
interface PersonalConfig {
  config?: {
    providerConfigRules?: {
      providerRules?: Array<{ providerId?: string; config?: { enabled?: boolean } }>;
    };
    modelConfigRules?: {
      providerModelRules?: Array<{ providerId?: string; modelId?: string; config?: { enabled?: boolean } }>;
    };
  };
}

export function familyLabel(family: Family): string {
  return family === "zai" ? "Start Plan" : "BigModel Start Plan";
}

/** Read the full bridge catalog; errors reduce to whatever remains listable. */
export function readCatalog(input: CatalogInput): BridgeModel[] {
  const bundled = tryReadJson<BundledCatalog>(input.bundledCatalogPath);
  const personal = tryReadJson<PersonalConfig>(`${input.stateDirectory}/provider_config.json`);
  const modelRules = bundled?.config?.modelConfigRules?.modelRules ?? [];
  const disabled = disabledRefs(personal);
  const models: BridgeModel[] = [];
  const seen = new Set<string>();

  const push = (model: BridgeModel) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    models.push(model);
  };
  const spec = (modelId: string) => {
    let contextWindow: number | undefined;
    let maxTokens: number | undefined;
    let reasoningVariants: string[] | undefined;
    for (const rule of modelRules) {
      if (!rule.modelMatch) continue;
      try {
        if (!new RegExp(rule.modelMatch, "i").test(modelId)) continue;
      } catch {
        continue;
      }
      contextWindow = rule.config?.properties?.contextWindow ?? contextWindow;
      maxTokens = rule.config?.optionSpecs?.maxOutputTokens?.max ?? maxTokens;
      reasoningVariants = rule.config?.optionSpecs?.reasoningLevel?.values ?? reasoningVariants;
    }
    return { contextWindow, maxTokens, reasoningVariants };
  };

  // 1. Start Plan account providers (bundled catalog, signed-in families only).
  for (const rule of bundled?.config?.providerConfigRules?.providerRules ?? []) {
    const access = rule.config?.access;
    if (
      !rule.providerId ||
      access?.type !== "zhipu-account" ||
      access.mode !== "start-plan" ||
      (access.accountType !== "zai" && access.accountType !== "bigmodel")
    ) {
      continue;
    }
    const family = access.accountType;
    if (!input.signedInFamilies.has(family)) continue;
    if (disabled.providers.has(rule.providerId)) continue;
    for (const modelId of rule.config?.builtinModelIds ?? []) {
      if (disabled.models.has(`${rule.providerId}/${modelId}`)) continue;
      const label = familyLabel(family);
      push({
        id: `${label}/${modelId}`,
        name: `${modelId} · ${family === "zai" ? "Z.ai" : "BigModel"} ${label} (free)`,
        providerId: rule.providerId,
        modelId,
        plan: "start-plan",
        ...spec(modelId),
      });
    }
  }

  // 2. API-key providers from the personal config (what Desktop manages).
  for (const rule of personal?.config?.providerConfigRules?.providerRules ?? []) {
    const apiKey = rule.config?.apiKey?.trim();
    if (!rule.providerId || !apiKey || rule.providerId.startsWith("account:")) continue;
    if (disabled.providers.has(rule.providerId)) continue;
    const label = rule.providerName?.trim() || rule.providerId;
    const modelIds = rule.config?.modelOrder?.length
      ? rule.config.modelOrder
      : (rule.config?.personalModelIds ?? []);
    for (const modelId of modelIds) {
      if (disabled.models.has(`${rule.providerId}/${modelId}`)) continue;
      push({
        id: `${label}/${modelId}`,
        name: `${modelId} · ${label}`,
        providerId: rule.providerId,
        modelId,
        plan: "api-key",
        ...spec(modelId),
      });
    }
  }

  return models;
}

function disabledRefs(personal: PersonalConfig | undefined): {
  providers: Set<string>;
  models: Set<string>;
} {
  const providers = new Set<string>();
  const models = new Set<string>();
  for (const rule of personal?.config?.providerConfigRules?.providerRules ?? []) {
    if (rule.providerId && rule.config?.enabled === false) providers.add(rule.providerId);
  }
  for (const rule of personal?.config?.modelConfigRules?.providerModelRules ?? []) {
    if (rule.providerId && rule.modelId && rule.config?.enabled === false) {
      models.add(`${rule.providerId}/${rule.modelId}`);
    }
  }
  return { providers, models };
}
