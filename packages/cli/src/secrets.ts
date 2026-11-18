// Secret resolution for the corpus CLI.
//
// Each `op read` can trigger a 1Password biometric prompt, so the CLI reads
// every secret once and caches them in a RAM-backed, owner-only file under
// $XDG_RUNTIME_DIR (tmpfs, per user, cleared on logout/reboot). Later calls,
// including separate processes started by an agent, read the cache instead of
// calling `op`. Nothing is ever written to persistent disk.

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Secrets {
  apiUrl: string;
  apiKey: string;
  meiliUrl: string;
  meiliKey: string;
}

interface CacheFile {
  expiresAt: number;
  secrets: Secrets;
}

const VAULT = "Arabic Digitization";

// 1Password reference and env-var override for each secret.
const SOURCES: Record<keyof Secrets, { ref: string; env: string }> = {
  apiUrl: {
    ref: `op://${VAULT}/API Connection Vars/ARABIC_OCR_URL`,
    env: "ARABIC_OCR_URL",
  },
  apiKey: {
    ref: `op://${VAULT}/API Connection Vars/ARABIC_OCR_KEY`,
    env: "ARABIC_OCR_KEY",
  },
  meiliUrl: { ref: `op://${VAULT}/Meilisearch/url`, env: "MEILI_URL" },
  // Read-only search key: the CLI never needs Meilisearch write access.
  meiliKey: {
    ref: `op://${VAULT}/Meilisearch/client read key`,
    env: "MEILI_SEARCH_KEY",
  },
};

const SECRET_NAMES = Object.keys(SOURCES) as (keyof Secrets)[];

const opAccount = (): string =>
  process.env.CORPUS_OP_ACCOUNT ?? "my.1password.com";

const ttlMs = (): number => {
  const hours = Number(process.env.CORPUS_SECRET_TTL_HOURS ?? "12");
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;
};

// tmpfs only. Refuse rather than fall back to a disk-backed temp dir.
export const cacheDir = (): string => {
  const base = process.env.XDG_RUNTIME_DIR ?? "/dev/shm";
  if (!existsSync(base)) {
    throw new Error(
      `No RAM-backed directory for the secret cache ($XDG_RUNTIME_DIR unset and /dev/shm missing). Set the env vars ${SECRET_NAMES.map((n) => SOURCES[n].env).join(", ")} instead.`,
    );
  }
  return join(base, "qiraa-corpus");
};

const cachePath = (): string => join(cacheDir(), "secrets.json");

const fromEnv = (): Secrets | null => {
  const values = SECRET_NAMES.map((n) => process.env[SOURCES[n].env]);
  if (values.some((v) => !v)) return null;
  return Object.fromEntries(
    SECRET_NAMES.map((n, i) => [n, values[i]]),
  ) as unknown as Secrets;
};

// Only trust a cache file we own that nobody else can read.
const readCache = (): CacheFile | null => {
  const path = cachePath();
  if (!existsSync(path)) return null;
  const st = statSync(path);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    rmSync(path, { force: true });
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.expiresAt <= Date.now()) return null;
    if (SECRET_NAMES.some((n) => !parsed.secrets?.[n])) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCache = (secrets: Secrets): CacheFile => {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file: CacheFile = { expiresAt: Date.now() + ttlMs(), secrets };
  writeFileSync(cachePath(), JSON.stringify(file), { mode: 0o600 });
  chmodSync(cachePath(), 0o600);
  return file;
};

const opRead = async (ref: string): Promise<string> => {
  try {
    const { stdout } = await run(
      "op",
      ["read", "--account", opAccount(), "--no-newline", ref],
      { timeout: 120_000 },
    );
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    if (e.code === "ENOENT") {
      throw new Error("1Password CLI `op` not found on PATH.");
    }
    if (e.killed) {
      throw new Error(
        "`op read` timed out. Unlock 1Password (or approve the prompt) and retry.",
      );
    }
    throw new Error(
      `\`op read\` failed for ${ref}. Check that 1Password is unlocked and the account (${opAccount()}) holds the "${VAULT}" vault.`,
    );
  }
};

// Sequential on purpose: the first read unlocks the op session, so the rest
// ride the same authorization instead of racing four prompts at once.
const fetchFromOp = async (): Promise<Secrets> => {
  const out: Partial<Secrets> = {};
  for (const name of SECRET_NAMES) {
    out[name] = await opRead(SOURCES[name].ref);
  }
  return out as Secrets;
};

export type SecretSource = "env" | "cache" | "1password";

export const loadSecrets = async ({
  refresh = false,
}: {
  refresh?: boolean;
} = {}): Promise<{ secrets: Secrets; source: SecretSource }> => {
  const env = fromEnv();
  if (env) return { secrets: env, source: "env" };
  if (!refresh) {
    const cached = readCache();
    if (cached) return { secrets: cached.secrets, source: "cache" };
  }
  const secrets = await fetchFromOp();
  writeCache(secrets);
  return { secrets, source: "1password" };
};

export const cacheStatus = (): {
  path: string;
  cached: boolean;
  expiresAt: string | null;
  envOverride: boolean;
} => {
  const cached = readCache();
  return {
    path: cachePath(),
    cached: cached != null,
    expiresAt: cached ? new Date(cached.expiresAt).toISOString() : null,
    envOverride: fromEnv() != null,
  };
};

export const clearCache = (): boolean => {
  const path = cachePath();
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
};
