import { Context } from "effect";
import { HttpRouter } from "effect/http";
import { EvlogLogger } from "evlog/effect";
import { AppLive } from "./http/app";
import { WorkerContext } from "./http/context";
import { initLogging, withRequestEvent } from "./logging";
import { handleOcrQueue, type QueueMessage } from "./queue";
import { startReviewIfPending } from "./review/cron";

export { ReviewWorkflow } from "./review/workflow";

initLogging();

// Built once at module scope (see HttpRouter.toWebHandler): every request
// reuses the router; only the per-request services below are new.
const app = HttpRouter.toWebHandler(AppLive, { disableLogger: true });

// HTTP via Effect HttpApi (http/app.ts); the queue consumer transcribes
// uploaded files. Each request carries its bindings and its wide event (see
// logging.ts).
export default {
  fetch: withRequestEvent(({ request, env, ctx, log }) =>
    app.handler(
      request,
      Context.make(WorkerContext, { env, ctx }).pipe(
        Context.add(EvlogLogger, log),
      ),
    ),
  ),
  queue: handleOcrQueue,
  scheduled: (controller, env) => startReviewIfPending({ controller, env }),
} satisfies ExportedHandler<Env, QueueMessage>;
