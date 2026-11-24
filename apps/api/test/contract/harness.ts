// Runs test/contract/worker.ts (the real Worker plus counting wrappers) in
// workerd via wrangler's test harness, with local D1/R2/KV/Queue bindings and
// every migration applied. No consumer is configured for the queue, so nothing
// enqueued here is ever OCR'd. Meilisearch is a local fake that records calls.

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createTestHarness,
  type TestHarness,
  unstable_splitSqlQuery,
} from "wrangler";
import type { Operation } from "./worker";

export const MASTER_KEY = "contract-test-master-key";
export const PUBLIC_API_URL = "http://contract.test";

const API_DIR = join(import.meta.dirname, "../..");

// Stands in for Meilisearch so routes that index or reindex run their real
// code without a network dependency. Records every call; `failing` makes
// every call answer 500.
export interface FakeMeili {
  url: string;
  calls: { method: string; path: string; body: unknown }[];
  failing: boolean;
}

export interface Harness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  sql: (statements: { sql: string; params?: unknown[] }[]) => Promise<void>;
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  putObject: (object: {
    key: string;
    body: BodyInit;
    contentType?: string;
  }) => Promise<void>;
  getObject: (key: string) => Promise<Response>;
  listObjects: (prefix: string) => Promise<string[]>;
  putKv: (entry: { key: string; value: string }) => Promise<void>;
  ops: () => Promise<{ operations: Operation[]; messages: unknown[] }>;
  // Lines the Worker logged since the last call (evlog wide events are JSON).
  logs: () => string[];
  meili: FakeMeili;
  close: () => Promise<void>;
}

async function startFakeMeili(): Promise<{
  meili: FakeMeili;
  server: Server;
}> {
  const meili: FakeMeili = { url: "", calls: [], failing: false };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      meili.calls.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(meili.failing ? 500 : 202, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(meili.failing ? { message: "down" } : { taskUid: 1 }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  meili.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { meili, server };
}

function migrationStatements(): { sql: string }[] {
  const dir = join(API_DIR, "migrations");
  return readdirSync(dir)
    .sort()
    .flatMap((file) =>
      unstable_splitSqlQuery(readFileSync(join(dir, file), "utf8")),
    )
    .map((sql) => ({ sql }));
}

export async function startHarness(): Promise<Harness> {
  const { meili, server: meiliServer } = await startFakeMeili();
  const server: TestHarness = createTestHarness({
    // Its own root, so no .dev.vars (real secrets) is ever loaded.
    root: join(API_DIR, "test/contract"),
    workers: [
      {
        config: {
          name: "contract",
          main: "./worker.ts",
          compatibility_date: "2026-06-14",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "contract",
              database_id: "00000000-0000-0000-0000-000000000000",
            },
          ],
          r2_buckets: [{ binding: "BUCKET", bucket_name: "contract" }],
          kv_namespaces: [{ binding: "HIGHLIGHT_CACHE", id: "contract-kv" }],
          queues: { producers: [{ binding: "OCR_Q", queue: "contract-q" }] },
          vars: {
            MASTER_KEY,
            PUBLIC_API_URL,
            CF_AIG_ACCOUNT_ID: "contract",
            CF_AIG_GATEWAY: "contract",
            MEILI_URL: meili.url,
            MEILI_KEY: "contract-meili-key",
          },
        },
      },
    ],
  });
  const { url } = await server.listen();

  // Real HTTP to the local server (not the in-process dispatch), so request
  // bodies arrive as they do in production, with a known length.
  const fetch = (path: string, init?: RequestInit) =>
    globalThis.fetch(new URL(path, url), init);
  const api = (path: string, init: RequestInit = {}) =>
    fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${MASTER_KEY}`, ...init.headers },
    });
  const json = async (response: Response) => {
    if (!response.ok) {
      throw new Error(
        `test route ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  };
  const sql: Harness["sql"] = async (statements) => {
    await json(
      await fetch("/__test/sql", {
        method: "POST",
        body: JSON.stringify(statements),
      }),
    );
  };
  await sql(migrationStatements());

  return {
    fetch,
    api,
    sql,
    query: async <T>(text: string, params: unknown[] = []) =>
      (await json(
        await fetch("/__test/query", {
          method: "POST",
          body: JSON.stringify({ sql: text, params }),
        }),
      )) as T[],
    putObject: async ({ key, body, contentType }) => {
      await json(
        await fetch(`/__test/r2/${encodeURIComponent(key)}`, {
          method: "PUT",
          body,
          headers: contentType ? { "content-type": contentType } : {},
        }),
      );
    },
    getObject: (key) => fetch(`/__test/r2/${encodeURIComponent(key)}`),
    listObjects: async (prefix) =>
      (await json(
        await fetch(`/__test/r2-list?prefix=${encodeURIComponent(prefix)}`),
      )) as string[],
    putKv: async ({ key, value }) => {
      await json(
        await fetch(`/__test/kv/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: value,
        }),
      );
    },
    ops: async () =>
      (await json(await fetch("/__test/ops"))) as {
        operations: Operation[];
        messages: unknown[];
      },
    logs: () => {
      const lines = server.getLogs().map((log) => log.message);
      server.clearLogs();
      return lines;
    },
    meili,
    close: async () => {
      await server.close();
      meiliServer.close();
    },
  };
}
