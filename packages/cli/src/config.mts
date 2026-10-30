/* Config resolution: config file under MOTIONFIELD_CONFIG_DIR or
 * XDG_CONFIG_HOME/motionfield (default ~/.config/motionfield); env wins. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { usage } from "./util.mts";

export interface CliConfig {
  url?: string;
  key?: string;
}

/** Base URL when neither --url, MOTIONFIELD_URL, nor a stored config provides
 *  one - the local dev server. */
export const DEFAULT_URL = "http://localhost:3000";

export function configDir(): string {
  if (process.env.MOTIONFIELD_CONFIG_DIR) return process.env.MOTIONFIELD_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "motionfield");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): CliConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    usage(`config file ${p} is not valid JSON - fix it or run \`motionfield logout\``);
  }
  // Shape-check before trusting: a hand-edited file that isn't {url?,key?}
  // strings must not flow into Authorization headers or URLs.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    usage(`config file ${p} is not a JSON object - fix it or run \`motionfield logout\``);
  const cfg = parsed as Record<string, unknown>;
  for (const k of ["url", "key"] as const) {
    if (cfg[k] != null && typeof cfg[k] !== "string")
      usage(`config file ${p}: "${k}" must be a string - fix it or run \`motionfield logout\``);
  }
  return cfg as CliConfig;
}

/** url + key for API calls - MOTIONFIELD_URL / MOTIONFIELD_API_KEY override the
 *  stored config, and the URL falls back to DEFAULT_URL so MOTIONFIELD_API_KEY
 *  alone is enough. Never logs the key.
 *
 *  Key safety: when MOTIONFIELD_URL points at a different server than the stored
 *  login, the stored key must not ride along - require MOTIONFIELD_API_KEY to be
 *  set explicitly for the new target. */
export function resolveAuth(): { url: string; key: string } {
  const cfg = loadConfig();
  const envUrl = process.env.MOTIONFIELD_URL;
  const envKey = process.env.MOTIONFIELD_API_KEY;
  const url = envUrl ?? cfg.url ?? DEFAULT_URL;
  if (envUrl && cfg.key && cfg.url && envUrl.replace(/\/+$/, "") !== cfg.url.replace(/\/+$/, "") && !envKey)
    usage(`MOTIONFIELD_URL (${envUrl}) differs from the stored login (${cfg.url}) - ` +
      "set MOTIONFIELD_API_KEY for the new target too, or the stored key would be sent there");
  const key = envKey ?? cfg.key;
  if (!key)
    usage("not logged in - run `motionfield login --key <of_…>` " +
      "or set MOTIONFIELD_API_KEY (MOTIONFIELD_URL overrides the default " + DEFAULT_URL + ")");
  return { url: url.replace(/\/+$/, ""), key };
}

/** config.json is written 0600 inside a 0700 dir - it holds the API key. */
export function saveConfig(cfg: CliConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on exotic fs */ }
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* idempotent writes keep 0600 anyway */ }
  return p;
}

export function clearConfig(): boolean {
  const p = configPath();
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}
