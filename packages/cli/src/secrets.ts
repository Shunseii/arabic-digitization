// Credentials for the corpus CLI.
//
// Each value is looked up on its own: an environment variable wins, otherwise
// the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
// Service via libsecret) through Bun.secrets. `corpus auth login` writes the
// keychain; nothing is ever written to a file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Secrets {
  apiUrl: string;
  apiKey: string;
  meiliUrl: string;
  meiliKey: string;
}

export type SecretName = keyof Secrets;

const VAULT = "Arabic Digitization";

// The env var name doubles as the keychain entry name.
export const SOURCES: Record<
  SecretName,
  { env: string; label: string; opRef: string; hidden: boolean }
> = {
  apiUrl: {
    env: "ARABIC_OCR_URL",
    label: "API URL",
    opRef: `op://${VAULT}/API Connection Vars/ARABIC_OCR_URL`,
    hidden: false,
  },
  apiKey: {
    env: "ARABIC_OCR_KEY",
    label: "API key",
    opRef: `op://${VAULT}/API Connection Vars/ARABIC_OCR_KEY`,
    hidden: true,
  },
  meiliUrl: {
    env: "MEILI_URL",
    label: "Meilisearch URL",
    opRef: `op://${VAULT}/Meilisearch/url`,
    hidden: false,
  },
  // Read-only search key: the CLI never needs Meilisearch write access.
  meiliKey: {
    env: "MEILI_SEARCH_KEY",
    label: "Meilisearch search key",
    opRef: `op://${VAULT}/Meilisearch/client read key`,
    hidden: true,
  },
};

export const SECRET_NAMES = Object.keys(SOURCES) as SecretName[];

export const keychainService = (): string =>
  process.env.CORPUS_KEYCHAIN_SERVICE || "qiraa-corpus";

const ENV_HINT = SECRET_NAMES.map((n) => SOURCES[n].env).join(", ");

export class KeychainUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const linux =
      process.platform === "linux"
        ? " On Linux this needs a Secret Service (gnome-keyring or KWallet) running in your session and libsecret installed; headless servers usually have neither."
        : "";
    super(
      `The OS keychain is not available (${detail}).${linux} Set the environment variables ${ENV_HINT} instead.`,
    );
  }
}

const keychain = async <T>(op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (err) {
    throw new KeychainUnavailableError(err);
  }
};

const keychainGet = (name: SecretName): Promise<string | null> =>
  keychain(() =>
    Bun.secrets.get({ service: keychainService(), name: SOURCES[name].env }),
  );

export const keychainSet = ({
  name,
  value,
}: {
  name: SecretName;
  value: string;
}): Promise<void> =>
  keychain(() =>
    Bun.secrets.set({
      service: keychainService(),
      name: SOURCES[name].env,
      value,
    }),
  );

export const keychainDelete = (name: SecretName): Promise<boolean> =>
  keychain(() =>
    Bun.secrets.delete({ service: keychainService(), name: SOURCES[name].env }),
  );

export type SecretSource = "env" | "keychain";

export const resolveSecret = async (
  name: SecretName,
): Promise<{ value: string; source: SecretSource } | null> => {
  const env = process.env[SOURCES[name].env];
  if (env) return { value: env, source: "env" };
  const stored = await keychainGet(name);
  return stored ? { value: stored, source: "keychain" } : null;
};

const NEEDED: Record<"api" | "meili", [SecretName, SecretName]> = {
  api: ["apiUrl", "apiKey"],
  meili: ["meiliUrl", "meiliKey"],
};

// The URL and key one service needs. Env vars are checked first, so a machine
// with both set never touches the keychain.
export const loadServiceSecrets = async (
  service: "api" | "meili",
): Promise<{ url: string; key: string }> => {
  const [urlName, keyName] = NEEDED[service];
  const url = await resolveSecret(urlName);
  const key = await resolveSecret(keyName);
  if (!url || !key) {
    const missing = [!url && urlName, !key && keyName]
      .filter((n): n is SecretName => Boolean(n))
      .map((n) => SOURCES[n].env);
    const what = service === "api" ? "the API" : "search (Meilisearch)";
    throw new Error(
      `Not configured for ${what}: ${missing.join(" and ")} missing. Run \`corpus auth login\` or set the environment variable(s). \`corpus auth status\` shows what is set.`,
    );
  }
  return { url: url.value, key: key.value };
};

export interface AuthStatus {
  service: string;
  keychain: "available" | "unavailable";
  keychainError?: string;
  values: Record<string, SecretSource | null>;
  ready: { api: boolean; search: boolean };
}

// Never includes a value, only where each one comes from.
export const authStatus = async (): Promise<AuthStatus> => {
  const values: Record<string, SecretSource | null> = {};
  let keychainError: string | undefined;
  for (const name of SECRET_NAMES) {
    const { env } = SOURCES[name];
    if (process.env[env]) {
      values[env] = "env";
      continue;
    }
    if (keychainError) {
      values[env] = null;
      continue;
    }
    try {
      values[env] = (await keychainGet(name)) ? "keychain" : null;
    } catch (err) {
      keychainError = (err as Error).message;
      values[env] = null;
    }
  }
  const set = (name: SecretName) => values[SOURCES[name].env] != null;
  return {
    service: keychainService(),
    keychain: keychainError ? "unavailable" : "available",
    ...(keychainError ? { keychainError } : {}),
    values,
    ready: {
      api: set("apiUrl") && set("apiKey"),
      search: set("meiliUrl") && set("meiliKey"),
    },
  };
};

const opAccount = (): string =>
  process.env.CORPUS_OP_ACCOUNT ?? "my.1password.com";

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
      throw new Error(
        "1Password CLI `op` not found on PATH. Use `corpus auth login` without --1password, or set the environment variables.",
      );
    }
    if (e.killed) {
      throw new Error(
        "`op read` timed out. Unlock 1Password (or approve the prompt) and retry.",
      );
    }
    throw new Error(
      `\`op read\` failed for ${ref}. Check that 1Password is unlocked and the account (${opAccount()}) holds the "${VAULT}" vault (set CORPUS_OP_ACCOUNT for another account).`,
    );
  }
};

// Sequential on purpose: the first read unlocks the op session, so the rest
// ride the same authorization instead of racing four prompts at once.
export const readFrom1Password = async (): Promise<Secrets> => {
  const out: Partial<Secrets> = {};
  for (const name of SECRET_NAMES) {
    out[name] = await opRead(SOURCES[name].opRef);
  }
  return out as Secrets;
};
