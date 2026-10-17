import { BetterAuthError } from "better-auth";
import { TaggedError, type Result, type TaggedErrorClass } from "better-result";

// `isolatedDeclarations` cannot infer a class heritage expression, so each tagged base is
// declared with an explicit type first.

const ContainerNotConfiguredBase: TaggedErrorClass<"ContainerNotConfigured"> =
  TaggedError("ContainerNotConfigured");
/** No container was supplied, or could be resolved, for a model. */
export class ContainerNotConfigured extends ContainerNotConfiguredBase<{
  model: string;
  message: string;
}> {}

const UnsupportedFeatureBase: TaggedErrorClass<"UnsupportedFeature"> =
  TaggedError("UnsupportedFeature");
/** A Better Auth feature Cosmos DB cannot provide, e.g. native joins. */
export class UnsupportedFeature extends UnsupportedFeatureBase<{
  feature: string;
  message: string;
}> {}

const InvalidQueryBase: TaggedErrorClass<"InvalidQuery"> = TaggedError("InvalidQuery");
/** A where clause, sort or page that cannot be expressed safely in Cosmos SQL. */
export class InvalidQuery extends InvalidQueryBase<{ message: string }> {}

const MissingPartitionKeyBase: TaggedErrorClass<"MissingPartitionKey"> =
  TaggedError("MissingPartitionKey");
/** A document has no usable value for one of the container's partition key paths. */
export class MissingPartitionKey extends MissingPartitionKeyBase<{
  path: string;
  message: string;
}> {}

const NotFoundBase: TaggedErrorClass<"NotFound"> = TaggedError("NotFound");
/** HTTP 404 from Cosmos DB. */
export class NotFound extends NotFoundBase<{ message: string; cause: unknown }> {}

const PreconditionFailedBase: TaggedErrorClass<"PreconditionFailed"> =
  TaggedError("PreconditionFailed");
/** HTTP 412: the document changed since it was read (ETag mismatch). */
export class PreconditionFailed extends PreconditionFailedBase<{
  message: string;
  cause: unknown;
}> {}

const ConflictBase: TaggedErrorClass<"Conflict"> = TaggedError("Conflict");
/** HTTP 409: a document with the same id already exists in the partition. */
class Conflict extends ConflictBase<{ message: string; cause: unknown }> {}

const ThrottledBase: TaggedErrorClass<"Throttled"> = TaggedError("Throttled");
/** HTTP 429 that survived the SDK's own retries. */
export class Throttled extends ThrottledBase<{
  message: string;
  cause: unknown;
  retryAfterMs: number | undefined;
}> {}

const RequestTimeoutBase: TaggedErrorClass<"RequestTimeout"> = TaggedError("RequestTimeout");
/** HTTP 408, or a client-side timeout raised by the SDK. */
class RequestTimeout extends RequestTimeoutBase<{ message: string; cause: unknown }> {}

const CosmosRequestFailedBase: TaggedErrorClass<"CosmosRequestFailed"> =
  TaggedError("CosmosRequestFailed");
/** Any other failed Cosmos DB request. */
export class CosmosRequestFailed extends CosmosRequestFailedBase<{
  statusCode: number | undefined;
  message: string;
  cause: unknown;
}> {}

const ContentionExhaustedBase: TaggedErrorClass<"ContentionExhausted"> =
  TaggedError("ContentionExhausted");
/** An optimistic-concurrency write kept losing to concurrent writers. */
export class ContentionExhausted extends ContentionExhaustedBase<{
  attempts: number;
  message: string;
}> {}

/** Failures of a single Cosmos DB request. */
export type CosmosError =
  | NotFound
  | PreconditionFailed
  | Conflict
  | Throttled
  | RequestTimeout
  | CosmosRequestFailed;

/** Every failure the adapter can produce before it reaches the Better Auth boundary. */
export type AdapterError =
  | CosmosError
  | ContainerNotConfigured
  | UnsupportedFeature
  | InvalidQuery
  | MissingPartitionKey
  | ContentionExhausted;

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Maps anything the Cosmos SDK throws to a {@link CosmosError}, using the HTTP status code. */
export function classifyCosmosError(cause: unknown): CosmosError {
  const code = readProperty(cause, "code");
  const statusCode = typeof code === "number" ? code : readProperty(cause, "statusCode");
  const status = typeof statusCode === "number" ? statusCode : undefined;
  const message = messageOf(cause);

  if (status === 404) return new NotFound({ message, cause });
  if (status === 408) return new RequestTimeout({ message, cause });
  if (status === 409) return new Conflict({ message, cause });
  if (status === 412) return new PreconditionFailed({ message, cause });
  if (status === 429) {
    const retryAfter = readProperty(cause, "retryAfterInMs");
    return new Throttled({
      message,
      cause,
      retryAfterMs: typeof retryAfter === "number" ? retryAfter : undefined,
    });
  }
  if (code === "TimeoutError" || (cause instanceof Error && cause.name === "TimeoutError")) {
    return new RequestTimeout({ message, cause });
  }
  return new CosmosRequestFailed({ statusCode: status, message, cause });
}

/** Stable, documented codes carried by {@link CosmosAdapterError}. */
export type CosmosAdapterErrorCode =
  | "CONTAINER_NOT_CONFIGURED"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_QUERY"
  | "MISSING_PARTITION_KEY"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "THROTTLED"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "CONTENTION";

/**
 * The only error type the adapter throws. `code` identifies the failure and `cause` keeps the
 * underlying tagged error (and, through it, the original Cosmos SDK error).
 */
export class CosmosAdapterError extends BetterAuthError {
  readonly code: CosmosAdapterErrorCode;

  constructor(code: CosmosAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[CosmosDB Adapter] ${message}`, options);
    this.name = "CosmosAdapterError";
    this.code = code;
    // BetterAuthError clears the stack; keep it so adapter failures stay debuggable.
    Error.captureStackTrace(this, CosmosAdapterError);
  }
}

function codeOf(error: AdapterError): CosmosAdapterErrorCode {
  return error.match({
    ContainerNotConfigured: () => "CONTAINER_NOT_CONFIGURED" as const,
    UnsupportedFeature: () => "UNSUPPORTED_FEATURE" as const,
    InvalidQuery: () => "INVALID_QUERY" as const,
    MissingPartitionKey: () => "MISSING_PARTITION_KEY" as const,
    NotFound: () => "NOT_FOUND" as const,
    PreconditionFailed: () => "PRECONDITION_FAILED" as const,
    Conflict: () => "CONFLICT" as const,
    Throttled: () => "THROTTLED" as const,
    RequestTimeout: () => "TIMEOUT" as const,
    CosmosRequestFailed: () => "REQUEST_FAILED" as const,
    ContentionExhausted: () => "CONTENTION" as const,
  });
}

export function toAdapterError(error: AdapterError): CosmosAdapterError {
  return new CosmosAdapterError(codeOf(error), error.message, { cause: error });
}

/** The single place where the railway ends and Better Auth's throwing contract begins. */
export function unwrapOrThrow<T>(result: Result<T, AdapterError>): T {
  if (result.isErr()) throw toAdapterError(result.error);
  return result.value;
}
