// HttpApi middleware every /api endpoint runs through:
//   - Authorization: the single-user master key, sent as `Bearer <key>`.
//   - InputValidation: request decoding failures become the 400 body clients
//     have always received ({ success: false, errors: [...], result: {} }).

import { Effect, Layer, Option, SchemaIssue } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  type HttpApiError,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";
import { WorkerContext } from "./context";
import { AuthNotConfigured, Unauthorized, ValidationFailed } from "./errors";

// Constant-time string comparison. Length difference still short-circuits
// (a minor, accepted leak); the per-byte loop avoids leaking *where* a
// same-length value diverges.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++)
    diff |= (ab[i] as number) ^ (bb[i] as number);
  return diff === 0;
}

export type MasterKeyCheck = "ok" | "unauthorized" | "not-configured";

// Single-user gate: one shared secret, sent as `Authorization: Bearer <key>`.
// No accounts, no sessions — the key IS the account. Compared against
// env.MASTER_KEY (.dev.vars locally, `wrangler secret put` in prod). The
// scheme is matched case-sensitively, exactly as clients send it.
export function checkMasterKey({
  authorization,
  masterKey,
}: {
  authorization: string | undefined;
  masterKey: string | undefined;
}): MasterKeyCheck {
  // Misconfiguration — fail closed rather than allow open access.
  if (!masterKey) return "not-configured";
  const header = authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token && safeEqual(token, masterKey) ? "ok" : "unauthorized";
}

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "app/Authorization",
  {
    security: { bearer: HttpApiSecurity.bearer },
    error: [Unauthorized, AuthNotConfigured],
  },
) {}

// Reads the raw header rather than the decoded credential, so the accepted
// form stays exactly `Bearer <key>`.
export const AuthorizationLive = Layer.succeed(Authorization, {
  bearer: (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // HttpApi middleware may only require request-level services, so the
      // per-request WorkerContext is read optionally; index.ts always sets it.
      const { env } = Option.getOrThrow(
        yield* Effect.serviceOption(WorkerContext),
      );
      const check = checkMasterKey({
        authorization: request.headers.authorization,
        masterKey: env.MASTER_KEY,
      });
      if (check === "not-configured") {
        return yield* new AuthNotConfigured({
          success: false,
          error: "Server auth not configured",
        });
      }
      if (check === "unauthorized") {
        return yield* new Unauthorized({
          success: false,
          error: "Unauthorized",
        });
      }
      return yield* httpEffect;
    }),
});

export class InputValidation extends HttpApiMiddleware.Service<InputValidation>()(
  "app/InputValidation",
  { error: ValidationFailed },
) {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const REQUEST_SLOTS: Partial<
  Record<HttpApiError.HttpApiSchemaError["kind"], string>
> = {
  Params: "params",
  Query: "query",
  Headers: "headers",
  Payload: "body",
};

const pathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) =>
  String(typeof segment === "object" ? segment.key : segment);

export const InputValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
  InputValidation,
  (error) => {
    const slot = REQUEST_SLOTS[error.kind];
    // A response that fails to encode is a bug: let it surface as a 500.
    if (slot === undefined) return Effect.die(error);
    const body = {
      success: false,
      errors: formatIssues(error.cause.issue).issues.map((issue) => ({
        code: 7001,
        message: issue.message,
        path: [slot, ...(issue.path ?? []).map(pathSegment)],
      })),
      result: {},
    };
    return Effect.succeed(
      HttpServerResponse.text(JSON.stringify(body), {
        status: 400,
        contentType: "application/json;charset=UTF-8",
      }),
    );
  },
);
