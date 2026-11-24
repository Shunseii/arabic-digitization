// Typed failures of the AI-call code. Each message keeps the shape the old
// Error classes used ("Inkling 429: <body>"), since it lands in files.error.
//
// Transient failures (rate limit, 5xx, timeout, network) are not the page's
// fault: they trigger the fallback engine and, if that fails too, a re-queue
// with backoff. Everything else is terminal.

import { Data } from "effect";
import type { OcrEngine } from "../types";

export type Provider = OcrEngine;

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

const PROVIDER_NAME: Record<Provider, string> = {
  inkling: "Inkling",
  claude: "Claude",
};

export class RateLimited extends Data.TaggedError("RateLimited")<{
  provider: Provider;
  detail: string;
  retryAfterSeconds: number | null;
}> {
  override get message(): string {
    return `${PROVIDER_NAME[this.provider]} 429: ${this.detail}`;
  }
}

export class ServerError extends Data.TaggedError("ServerError")<{
  provider: Provider;
  status: number;
  detail: string;
  retryAfterSeconds: number | null;
}> {
  override get message(): string {
    return `${PROVIDER_NAME[this.provider]} ${this.status}: ${this.detail}`;
  }
}

export class ProviderTimeout extends Data.TaggedError("ProviderTimeout")<{
  provider: Provider;
  timeoutMs: number;
}> {
  override get message(): string {
    return `${PROVIDER_NAME[this.provider]} timed out after ${this.timeoutMs} ms`;
  }
}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  provider: Provider;
  detail: string;
}> {
  override get message(): string {
    return `${PROVIDER_NAME[this.provider]} network error: ${this.detail}`;
  }
}

// A 4xx other than 429: our request is wrong, so retrying can't help.
export class ProviderRejected extends Data.TaggedError("ProviderRejected")<{
  provider: Provider;
  status: number;
  detail: string;
}> {
  override get message(): string {
    return `${PROVIDER_NAME[this.provider]} ${this.status}: ${this.detail}`;
  }
}

// Inkling stopped at its output cap (done_reason "length"), so the page is
// incomplete. Retrying Inkling gives the same result; Claude takes it instead.
export class InklingCutOff extends Data.TaggedError("InklingCutOff")<{
  maxTokens: number;
  usage: Usage;
}> {
  override get message(): string {
    return `Inkling output cut off at the ${this.maxTokens}-token cap (${this.usage.outputTokens ?? "?"} tokens)`;
  }
}

// A 2xx whose body has no usable output (no text, unparseable JSON).
export class BadResponse extends Data.TaggedError("BadResponse")<{
  provider: Provider;
  detail: string;
  usage: Usage;
}> {
  override get message(): string {
    return `no text in ${PROVIDER_NAME[this.provider]} response: ${this.detail}`;
  }
}

export class NotAnImage extends Data.TaggedError("NotAnImage")<{
  contentType: string;
}> {
  override get message(): string {
    return `OCR needs an image, got '${this.contentType}'`;
  }
}

export class FileNotFound extends Data.TaggedError("FileNotFound")<{
  fileId: string;
}> {
  override get message(): string {
    return `file '${this.fileId}' not found`;
  }
}

export class ObjectMissing extends Data.TaggedError("ObjectMissing")<{
  key: string;
}> {
  override get message(): string {
    return `R2 object '${this.key}' missing`;
  }
}

// D1 or R2 itself failed.
export class StorageError extends Data.TaggedError("StorageError")<{
  operation: string;
  detail: string;
}> {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

export type TransientError =
  | RateLimited
  | ServerError
  | ProviderTimeout
  | NetworkError;

export type ProviderError =
  | TransientError
  | ProviderRejected
  | BadResponse
  | InklingCutOff;

export type OcrError =
  | ProviderError
  | NotAnImage
  | FileNotFound
  | ObjectMissing
  | StorageError;

export function isTransient(error: OcrError): error is TransientError {
  return (
    error._tag === "RateLimited" ||
    error._tag === "ServerError" ||
    error._tag === "ProviderTimeout" ||
    error._tag === "NetworkError"
  );
}

export function retryAfterSeconds(error: TransientError): number | null {
  return error._tag === "RateLimited" || error._tag === "ServerError"
    ? error.retryAfterSeconds
    : null;
}

export type FallbackReason =
  | "cut_off"
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network";

const FALLBACK_REASON: Record<
  TransientError["_tag"] | InklingCutOff["_tag"],
  FallbackReason
> = {
  InklingCutOff: "cut_off",
  RateLimited: "rate_limit",
  ServerError: "server_error",
  ProviderTimeout: "timeout",
  NetworkError: "network",
};

export function fallbackReason(
  error: TransientError | InklingCutOff,
): FallbackReason {
  return FALLBACK_REASON[error._tag];
}

// The reason recorded for an error tag, or null for a tag that never triggers
// a fallback.
export function fallbackReasonForTag(tag: string): FallbackReason | null {
  return Object.hasOwn(FALLBACK_REASON, tag)
    ? FALLBACK_REASON[tag as keyof typeof FALLBACK_REASON]
    : null;
}

// Tokens a failed call still billed (a cut-off or empty answer was generated).
export function usageOf(error: OcrError): Usage | null {
  return error._tag === "InklingCutOff" || error._tag === "BadResponse"
    ? error.usage
    : null;
}
