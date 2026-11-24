import { Context } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";

// The Worker's bindings and execution context for the current request,
// provided per request by the fetch handler (index.ts).
export class WorkerContext extends Context.Service<
  WorkerContext,
  { readonly env: Env; readonly ctx: ExecutionContext }
>()("app/WorkerContext") {}

// An endpoint's handler, typed from its definition alone. It doesn't see the
// endpoint and group objects, so it type-checks before the endpoint joins a
// group with middleware (http/app.ts).
type Input<Request> = Omit<Request, "endpoint" | "group">;

export type EndpointHandler<
  Endpoint extends HttpApiEndpoint.Constraint,
  R = WorkerContext,
> = (
  request: Input<Parameters<HttpApiEndpoint.Handler<Endpoint, never, R>>[0]>,
) => ReturnType<HttpApiEndpoint.Handler<Endpoint, never, R>>;

// For a handler that reads the request body itself (handleRaw).
export type RawEndpointHandler<
  Endpoint extends HttpApiEndpoint.Constraint,
  R = WorkerContext,
> = (
  request: Input<Parameters<HttpApiEndpoint.HandlerRaw<Endpoint, never, R>>[0]>,
) => ReturnType<HttpApiEndpoint.HandlerRaw<Endpoint, never, R>>;
