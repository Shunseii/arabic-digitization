// `corpus auth login|status|logout`: manage the credentials in the OS keychain.

import { createInterface } from "node:readline/promises";
import {
  type AuthStatus,
  authStatus,
  keychainDelete,
  keychainService,
  keychainSet,
  readFrom1Password,
  resolveSecret,
  SECRET_NAMES,
  type SecretName,
  type Secrets,
  SOURCES,
} from "./secrets.ts";

export class UsageError extends Error {}

export interface LoginOptions {
  url?: string;
  keyStdin: boolean;
  meiliUrl?: string;
  meiliKeyStdin: boolean;
  onePassword: boolean;
}

export interface CommandOutput {
  data: unknown;
  human: () => string;
}

const checkUrl = ({ name, value }: { name: SecretName; value: string }) => {
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {}
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    throw new UsageError(
      `${SOURCES[name].label} must be an http(s) URL, got "${value}"`,
    );
  }
};

const askVisible = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

// Reads a line with echo off, so the key never shows on screen.
const askHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") {
          return finish(new UsageError("login cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });

const promptAll = async (): Promise<Partial<Secrets>> => {
  const out: Partial<Secrets> = {};
  process.stderr.write(
    `Values are stored in the OS keychain (service "${keychainService()}"). Press Enter to keep a stored value.\n`,
  );
  for (const name of SECRET_NAMES) {
    const { label, hidden } = SOURCES[name];
    const current = await resolveSecret(name);
    const optional = name === "meiliUrl" || name === "meiliKey";
    const suffix = current
      ? " [keep current]"
      : optional
        ? " (optional, needed for search; Enter to skip)"
        : "";
    const question = `${label}${suffix}: `;
    const answer = hidden
      ? await askHidden(question)
      : await askVisible(question);
    if (answer) {
      out[name] = answer;
      continue;
    }
    if (!current && !optional) throw new UsageError(`${label} is required`);
  }
  return out;
};

const readStdinLines = async (): Promise<string[]> =>
  (await Bun.stdin.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const fromFlags = async (options: LoginOptions): Promise<Partial<Secrets>> => {
  const out: Partial<Secrets> = {};
  if (options.url) out.apiUrl = options.url;
  if (options.meiliUrl) out.meiliUrl = options.meiliUrl;
  const wanted: SecretName[] = [
    ...(options.keyStdin ? (["apiKey"] as const) : []),
    ...(options.meiliKeyStdin ? (["meiliKey"] as const) : []),
  ];
  if (wanted.length > 0) {
    if (process.stdin.isTTY) {
      throw new UsageError(
        '--key-stdin / --meili-key-stdin read the key from a pipe, e.g. `printf %s "$KEY" | corpus auth login ...`',
      );
    }
    const lines = await readStdinLines();
    if (lines.length < wanted.length) {
      throw new UsageError(
        wanted.length === 2
          ? "with --key-stdin and --meili-key-stdin, stdin needs two lines: the API key, then the Meilisearch key"
          : "stdin was empty: pipe the key in",
      );
    }
    wanted.forEach((name, i) => {
      out[name] = lines[i];
    });
  }
  return out;
};

const describeStatus = (status: AuthStatus): string => {
  const width = Math.max(...Object.keys(status.values).map((k) => k.length));
  const rows = Object.entries(status.values).map(
    ([env, source]) => `  ${env.padEnd(width)}  ${source ?? "not set"}`,
  );
  const keychain =
    status.keychain === "available"
      ? `Keychain: available (service "${status.service}")`
      : `Keychain: unavailable. ${status.keychainError}`;
  const readiness = [
    `API: ${status.ready.api ? "ready" : "not configured"}`,
    `search: ${status.ready.search ? "ready" : "not configured"}`,
  ].join(" · ");
  const next =
    status.ready.api && status.ready.search
      ? ""
      : status.keychain === "available"
        ? "\nRun `corpus auth login` (or set the environment variables) to configure."
        : "\nSet the environment variables above to configure.";
  return [keychain, ...rows, readiness].join("\n") + next;
};

const login = async (options: LoginOptions): Promise<CommandOutput> => {
  const flagged =
    options.url !== undefined ||
    options.meiliUrl !== undefined ||
    options.keyStdin ||
    options.meiliKeyStdin;
  if (options.onePassword && flagged) {
    throw new UsageError("--1password reads every value; don't combine it");
  }
  let values: Partial<Secrets>;
  let source: "1password" | "flags" | "prompt";
  if (options.onePassword) {
    values = await readFrom1Password();
    source = "1password";
  } else if (flagged) {
    values = await fromFlags(options);
    source = "flags";
  } else if (process.stdin.isTTY) {
    values = await promptAll();
    source = "prompt";
  } else {
    throw new UsageError(
      "no terminal to prompt on: pass --url <u> --key-stdin [--meili-url <u> --meili-key-stdin] with the key(s) on stdin, or --1password",
    );
  }

  const stored = SECRET_NAMES.filter((n) => values[n] !== undefined);
  for (const name of stored) {
    if (name === "apiUrl" || name === "meiliUrl") {
      checkUrl({ name, value: values[name] as string });
    }
  }
  for (const name of stored) {
    await keychainSet({ name, value: values[name] as string });
  }

  const status = await authStatus();
  const shadowed = stored
    .map((n) => SOURCES[n].env)
    .filter((env) => process.env[env]);
  return {
    data: {
      source,
      stored: stored.map((n) => SOURCES[n].env),
      shadowedByEnv: shadowed,
      status,
    },
    human: () =>
      [
        stored.length > 0
          ? `Stored ${stored.map((n) => SOURCES[n].env).join(", ")} in the keychain.`
          : "Nothing changed.",
        ...(shadowed.length > 0
          ? [
              `Note: ${shadowed.join(", ")} also set in the environment, which takes precedence over the keychain.`,
            ]
          : []),
        describeStatus(status),
      ].join("\n"),
  };
};

const logout = async (): Promise<CommandOutput> => {
  const removed: string[] = [];
  for (const name of SECRET_NAMES) {
    if (await keychainDelete(name)) removed.push(SOURCES[name].env);
  }
  const envStill = SECRET_NAMES.map((n) => SOURCES[n].env).filter(
    (env) => process.env[env],
  );
  return {
    data: { service: keychainService(), removed, envStillSet: envStill },
    human: () =>
      [
        removed.length > 0
          ? `Removed ${removed.join(", ")} from the keychain.`
          : "Nothing stored in the keychain.",
        ...(envStill.length > 0
          ? [`Still set in the environment: ${envStill.join(", ")}.`]
          : []),
      ].join("\n"),
  };
};

export const authCommand = async ({
  sub,
  options,
}: {
  sub: string | undefined;
  options: LoginOptions;
}): Promise<CommandOutput> => {
  if (sub === "login") return login(options);
  if (sub === "logout") return logout();
  if (sub === "status") {
    const status = await authStatus();
    return { data: status, human: () => describeStatus(status) };
  }
  throw new UsageError("usage: corpus auth login|status|logout");
};
