export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus];

export const Headers = {
  ACCEPT: 'accept',
  AUTHORIZATION: 'authorization',
  CONTENT_TYPE: 'content-type',
  CORRELATION_ID: 'x-correlation-id',
  IDEMPOTENCY_KEY: 'idempotency-key',
} as const;

export const ContentType = {
  JSON: 'application/json',
  FORM: 'application/x-www-form-urlencoded',
} as const;
