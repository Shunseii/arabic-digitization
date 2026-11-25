import { loadServiceSecrets } from "./secrets.ts";

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
  credentials: { url: base, key },
  path,
  method,
  body,
}: Required<Omit<RequestOptions, "body" | "service">> & {
  credentials: { url: string; key: string };
  body?: unknown;
}): Promise<Response> => {
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

// Error text never includes the key or URL.
export const requestText = async ({
  service,
  path,
  method = "GET",
  body,
}: RequestOptions): Promise<string> => {
  const credentials = await loadServiceSecrets(service);
  const res = await send({ credentials, path, method, body });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = String(parsed.error ?? parsed.message ?? detail);
    } catch {}
    const hint =
      res.status === 401 || res.status === 403
        ? " (key rejected: if it was rotated, run `corpus auth login` again)"
        : "";
    throw new HttpError({
      status: res.status,
      message: `${method} ${path} → ${res.status}: ${detail}${hint}`,
    });
  }
  return text;
};

export const request = async <T>(options: RequestOptions): Promise<T> => {
  const text = await requestText(options);
  return (text ? JSON.parse(text) : null) as T;
};
