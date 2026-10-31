// Small shared I/O helpers. Reads are sized for config files (KBs), so the
// sync paths stay simple; async text reads prefer the host runtime's native
// fast path when one is present.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface FastFileApi {
  file(path: string): { text(): Promise<string> };
}
const fast: FastFileApi | undefined = (globalThis as { Bun?: FastFileApi }).Bun;

export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function tryReadJson<T>(path: string): T | undefined {
  try {
    return readJson<T>(path);
  } catch {
    return undefined;
  }
}

export async function readText(path: string): Promise<string> {
  if (fast) return fast.file(path).text();
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
