// How the review Workflow's steps fail. Every step's Effect fails with a
// StepError: StorageError (D1, R2 or the queue) or a TransportError from an
// Anthropic call. Transient ones are retried briefly inside the step; what
// is left is retried by the Workflow (a thrown Error) or ends the instance
// (NonRetryableError, see workflow.ts).

import { Duration, Effect } from "effect";
import {
  isTransient,
  retryAfterSeconds,
  type StorageError,
} from "../effect/errors";
import type { TransportError } from "../effect/services";

export type StepError = StorageError | TransportError;

// D1 and R2 report transient trouble only in the message text.
const TRANSIENT_STORAGE =
  /network|timed? ?out|reset|internal error|overloaded|unavailable|try again|too many/i;

export function isRetryable(error: StepError): boolean {
  if (error._tag === "StorageError") {
    return TRANSIENT_STORAGE.test(error.detail);
  }
  // ProviderRejected (a 4xx such as invalid_request) and BadResponse (a body
  // that didn't decode) fail the same way on every try.
  return isTransient(error);
}

const MAX_TRIES = 3;
const MAX_DELAY_MS = 4000;

// Retry `effect` on a retryable failure: up to 3 tries, exponential backoff
// with jitter from `baseMs`, at least the provider's retry-after, at most 4 s
// per wait (about 10 s in all, far inside a step's limits).
export function retryTransient<A, E extends StepError, R>({
  effect,
  baseMs = 500,
  attempt = 1,
}: {
  effect: Effect.Effect<A, E, R>;
  baseMs?: number;
  attempt?: number;
}): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.catch((error: E) => {
      if (attempt >= MAX_TRIES || !isRetryable(error)) {
        return Effect.fail(error);
      }
      const backoff = baseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      const hintMs =
        error._tag === "RateLimited" || error._tag === "ServerError"
          ? (retryAfterSeconds(error) ?? 0) * 1000
          : 0;
      const delay = Math.min(Math.max(backoff, hintMs), MAX_DELAY_MS);
      return Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(
          retryTransient({ effect, baseMs, attempt: attempt + 1 }),
        ),
      );
    }),
  );
}

const STEP_ERROR_TAGS = new Set([
  "StorageError",
  "RateLimited",
  "ServerError",
  "ProviderTimeout",
  "NetworkError",
  "ProviderRejected",
  "BadResponse",
]);

const isStepError = (value: unknown): value is StepError =>
  typeof value === "object" &&
  value !== null &&
  STEP_ERROR_TAGS.has(String((value as { _tag?: unknown })._tag));

// How the Workflow should treat what a step failed with, after the in-step
// retries: retry the step, end the instance, or (anything that isn't a
// StepError) a defect, which is a bug and is rethrown as it is.
export function stepFailureKind(
  failure: unknown,
): "retryable" | "terminal" | "defect" {
  if (!isStepError(failure)) return "defect";
  return isRetryable(failure) ? "retryable" : "terminal";
}
