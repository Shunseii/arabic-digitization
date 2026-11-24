import { HttpServerResponse } from "effect/http";
import type { HttpApiEndpoint } from "effect/http-api";

// Sends an endpoint's success body as plain JSON. The endpoint's success
// schema types the body at compile time and documents it, but isn't run over
// it: encoding a large body (a 1,000-page status list) through Schema costs
// more CPU than the Workers Free plan's 10 ms allows on a fresh isolate, and
// the handlers build these bodies from typed values anyway. `status` must
// match the one the success schema declares (HttpApiSchema.status).
export function respond<Endpoint extends HttpApiEndpoint.Constraint>({
  body,
  status = 200,
}: {
  endpoint: Endpoint;
  body: HttpApiEndpoint.Success<Endpoint>["Type"];
  status?: 200 | 201 | 202;
}): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(body, { status });
}
