// The error responses endpoints return. Every one is `{ success: false, error }`
// (plus extra fields for an edit that did not apply), with the status set on
// the class so HttpApi encodes it and documents it in the OpenAPI spec.

import { Schema } from "effect";

const fields = { success: Schema.Literal(false), error: Schema.String };

export class BadRequest extends Schema.Error<BadRequest>("BadRequest")(fields, {
  httpApiStatus: 400,
}) {}

export class Unauthorized extends Schema.Error<Unauthorized>("Unauthorized")(
  fields,
  { httpApiStatus: 401 },
) {}

export class NotFound extends Schema.Error<NotFound>("NotFound")(fields, {
  httpApiStatus: 404,
}) {}

export class Conflict extends Schema.Error<Conflict>("Conflict")(fields, {
  httpApiStatus: 409,
}) {}

export class UnsupportedMediaType extends Schema.Error<UnsupportedMediaType>(
  "UnsupportedMediaType",
)(fields, { httpApiStatus: 415 }) {}

export class EditNotApplied extends Schema.Error<EditNotApplied>(
  "EditNotApplied",
)(
  {
    ...fields,
    failed_edit: Schema.Int,
    reason: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

export class AuthNotConfigured extends Schema.Error<AuthNotConfigured>(
  "AuthNotConfigured",
)(fields, { httpApiStatus: 500 }) {}

// A request that failed schema validation (400). Documented here; the body is
// written by the InputValidation middleware (http/middleware.ts).
export class ValidationFailed extends Schema.Error<ValidationFailed>(
  "ValidationFailed",
)(
  {
    success: Schema.Literal(false),
    errors: Schema.Array(
      Schema.Struct({
        code: Schema.Int,
        message: Schema.String,
        path: Schema.Array(Schema.String),
      }),
    ),
    result: Schema.Struct({}),
  },
  { httpApiStatus: 400 },
) {}

export const badRequest = (error: string) =>
  new BadRequest({ success: false, error });
export const notFound = (error: string) =>
  new NotFound({ success: false, error });
export const conflict = (error: string) =>
  new Conflict({ success: false, error });
