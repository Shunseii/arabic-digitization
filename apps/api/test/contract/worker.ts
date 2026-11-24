// Test entry for the HTTP contract tests: the real Worker, run in workerd with
// real local D1/R2/KV/Queue bindings, behind a thin wrapper that
//   - counts every binding operation the Worker makes (and D1 rows read), and
//   - exposes /__test/* routes to seed and inspect storage.
// Never deployed: wrangler.jsonc's main is src/index.ts.

import worker from "../../src/index";

export interface Operation {
  kind:
    | "d1.query"
    | "d1.batch"
    | "r2.get"
    | "r2.put"
    | "r2.list"
    | "r2.delete"
    | "r2.head"
    | "kv.get"
    | "kv.put"
    | "queue.send"
    | "workflow.event";
  detail?: string;
  // D1 statements run (a batch runs several in one round trip).
  statements?: number;
  rowsRead?: number;
}

const operations: Operation[] = [];
const queueMessages: unknown[] = [];

interface D1Result {
  results: unknown[];
  meta: { rows_read?: number; changes?: number };
}

function countingStatement({
  statement,
  sql,
}: {
  statement: D1PreparedStatement;
  sql: string;
}): D1PreparedStatement {
  const record = (result: D1Result) => {
    operations.push({
      kind: "d1.query",
      detail: sql,
      rowsRead: result.meta.rows_read ?? 0,
    });
    return result;
  };
  const wrapped = {
    bind: (...values: unknown[]) =>
      countingStatement({ statement: statement.bind(...values), sql }),
    first: async (column?: string) => {
      const { results } = record(
        (await statement.all()) as unknown as D1Result,
      );
      const row = (results[0] ?? null) as Record<string, unknown> | null;
      return column === undefined || row === null ? row : (row[column] ?? null);
    },
    all: async () => record((await statement.all()) as unknown as D1Result),
    run: async () => record((await statement.run()) as unknown as D1Result),
    raw: async () => {
      operations.push({ kind: "d1.query", detail: sql });
      return statement.raw();
    },
    unwrap: () => statement,
  };
  return wrapped as unknown as D1PreparedStatement;
}

type Unwrappable = D1PreparedStatement & { unwrap?: () => D1PreparedStatement };

function countingDatabase(db: D1Database): D1Database {
  return {
    prepare: (sql: string) =>
      countingStatement({ statement: db.prepare(sql), sql }),
    batch: async (statements: Unwrappable[]) => {
      const results = (await db.batch(
        statements.map((s) => s.unwrap?.() ?? s),
      )) as unknown as D1Result[];
      operations.push({
        kind: "d1.batch",
        detail: `${statements.length} statements`,
        statements: statements.length,
        rowsRead: results.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0),
      });
      return results;
    },
    exec: (sql: string) => db.exec(sql),
    dump: () => db.dump(),
    withSession: () => {
      throw new Error("withSession is not used by the Worker");
    },
  } as unknown as D1Database;
}

function countingBucket(bucket: R2Bucket): R2Bucket {
  return {
    get: (key: string, options?: R2GetOptions) => {
      operations.push({ kind: "r2.get", detail: key });
      return bucket.get(key, options);
    },
    head: (key: string) => {
      operations.push({ kind: "r2.head", detail: key });
      return bucket.head(key);
    },
    put: (
      key: string,
      value: Parameters<R2Bucket["put"]>[1],
      options?: R2PutOptions,
    ) => {
      operations.push({ kind: "r2.put", detail: key });
      return bucket.put(key, value, options);
    },
    list: (options?: R2ListOptions) => {
      operations.push({ kind: "r2.list", detail: options?.prefix });
      return bucket.list(options);
    },
    delete: (keys: string | string[]) => {
      operations.push({
        kind: "r2.delete",
        detail: Array.isArray(keys) ? keys.join(",") : keys,
      });
      return bucket.delete(keys);
    },
  } as unknown as R2Bucket;
}

function countingKv(kv: KVNamespace): KVNamespace {
  return {
    get: (key: string, type?: unknown) => {
      operations.push({ kind: "kv.get", detail: key });
      return (kv.get as (k: string, t?: unknown) => Promise<unknown>)(
        key,
        type,
      );
    },
    put: (key: string, value: string, options?: KVNamespacePutOptions) => {
      operations.push({ kind: "kv.put", detail: key });
      return kv.put(key, value, options);
    },
  } as unknown as KVNamespace;
}

function countingQueue(queue: Queue): Queue {
  return {
    send: (body: unknown, options?: QueueSendOptions) => {
      operations.push({ kind: "queue.send", detail: "1 message" });
      queueMessages.push(body);
      return queue.send(body, options);
    },
    sendBatch: (
      messages: Iterable<MessageSendRequest>,
      options?: QueueSendBatchOptions,
    ) => {
      const list = [...messages];
      operations.push({
        kind: "queue.send",
        detail: `${list.length} messages`,
      });
      for (const m of list) queueMessages.push(m.body);
      return queue.sendBatch(list, options);
    },
  } as unknown as Queue;
}

// Stands in for the review Workflow binding (no Workflow runs here): records
// each event sent to an instance. An instance id starting with "gone" behaves
// like one that no longer exists.
const fakeReviewWorkflow = {
  get: async (id: string) => {
    if (id.startsWith("gone")) throw new Error(`instance ${id} not found`);
    return {
      id,
      status: async () => ({ status: "waiting" }),
      sendEvent: async (event: { type: string }) => {
        operations.push({
          kind: "workflow.event",
          detail: `${id} ${event.type}`,
        });
      },
    };
  },
} as unknown as Workflow;

async function handleTestRoute({
  request,
  env,
  url,
}: {
  request: Request;
  env: Env;
  url: URL;
}): Promise<Response> {
  const [, , route, ...rest] = url.pathname.split("/");
  const key = decodeURIComponent(rest.join("/"));
  switch (`${request.method} ${route}`) {
    case "POST sql": {
      const statements = (await request.json()) as {
        sql: string;
        params?: unknown[];
      }[];
      if (statements.length > 0) {
        await env.DB.batch(
          statements.map(({ sql, params = [] }) =>
            env.DB.prepare(sql).bind(...params),
          ),
        );
      }
      return Response.json({ ok: true });
    }
    case "POST query": {
      const { sql, params = [] } = (await request.json()) as {
        sql: string;
        params?: unknown[];
      };
      const { results } = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      return Response.json(results);
    }
    case "PUT r2":
      await env.BUCKET.put(key, await request.arrayBuffer(), {
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? undefined,
        },
      });
      return Response.json({ ok: true });
    case "GET r2": {
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType ?? "",
        },
      });
    }
    case "GET r2-list": {
      const listed = await env.BUCKET.list({
        prefix: url.searchParams.get("prefix") ?? undefined,
      });
      return Response.json(listed.objects.map((o) => o.key));
    }
    case "PUT kv":
      await env.HIGHLIGHT_CACHE.put(key, await request.text());
      return Response.json({ ok: true });
    case "GET ops": {
      const body = {
        operations: [...operations],
        messages: [...queueMessages],
      };
      operations.length = 0;
      queueMessages.length = 0;
      return Response.json(body);
    }
    default:
      return new Response("unknown test route", { status: 400 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      return handleTestRoute({ request, env, url });
    }
    const counted: Env = {
      ...env,
      DB: countingDatabase(env.DB),
      BUCKET: countingBucket(env.BUCKET),
      HIGHLIGHT_CACHE: countingKv(env.HIGHLIGHT_CACHE),
      OCR_Q: countingQueue(env.OCR_Q),
      REVIEW_WORKFLOW: fakeReviewWorkflow,
    };
    return worker.fetch(request, counted, ctx);
  },
} satisfies ExportedHandler<Env>;
