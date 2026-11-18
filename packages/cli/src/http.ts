import { loadSecrets, type Secrets } from "./secrets.ts";

export type Service = "api" | "meili";

export class HttpError extends Error {
  readonly status: number;
  constructor({ status, message }: { status: number; message: string }) {
    super(message);
    this.status = status;
  }
}

interface RequestOptions {
  service: Service;
  path: string;
  method?: string;
  body?: unknown;
}

const send = async ({
  secrets,
  service,
  path,
  method,
  body,
}: Required<Omit<RequestOptions, "body">> & {
  secrets: Secrets;
  body?: unknown;
}): Promise<Response> => {
  const base = service === "api" ? secrets.apiUrl : secrets.meiliUrl;
  const key = service === "api" ? secrets.apiKey : secrets.meiliKey;
  const attempt = () =>
    fetch(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    return await attempt();
  } catch (err) {
    // One retry for a dropped connection, reads only: repeating a POST could
    // queue (and bill) an OCR run twice.
    if (method !== "GET") throw err;
    await new Promise((r) => setTimeout(r, 1_000));
    return attempt();
  }
};

// A 401/403 usually means a rotated key: re-read from 1Password once, retry,
// then fail. Error text never includes the key or URL.
export const requestText = async ({
  service,
  path,
  method = "GET",
  body,
}: RequestOptions): Promise<string> => {
  let { secrets, source } = await loadSecrets();
  let res = await send({ secrets, service, path, method, body });
  if ((res.status === 401 || res.status === 403) && source === "cache") {
    ({ secrets, source } = await loadSecrets({ refresh: true }));
    res = await send({ secrets, service, path, method, body });
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = String(parsed.error ?? parsed.message ?? detail);
    } catch {}
    throw new HttpError({
      status: res.status,
      message: `${method} ${path} → ${res.status}: ${detail}`,
    });
  }
  return text;
};

export const request = async <T>(options: RequestOptions): Promise<T> => {
  const text = await requestText(options);
  return (text ? JSON.parse(text) : null) as T;
};
