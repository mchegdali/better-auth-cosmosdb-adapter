import { ErrorResponse, TimeoutError } from "@azure/cosmos";
import { BetterAuthError } from "better-auth";
import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import {
  classifyCosmosError,
  ContainerNotConfigured,
  ContentionExhausted,
  CosmosAdapterError,
  toAdapterError,
  unwrapOrThrow,
} from "../../src/errors.ts";

function cosmosError(code: number, extra: Record<string, unknown> = {}): ErrorResponse {
  return Object.assign(new ErrorResponse(`status ${code}`), { code, ...extra });
}

describe("classifyCosmosError", () => {
  it.each([
    [404, "NotFound"],
    [408, "RequestTimeout"],
    [409, "Conflict"],
    [412, "PreconditionFailed"],
    [429, "Throttled"],
    [500, "CosmosRequestFailed"],
    [503, "CosmosRequestFailed"],
  ])("maps HTTP %s to %s", (code, tag) => {
    const error = classifyCosmosError(cosmosError(code));
    expect(error._tag).toBe(tag);
    expect(error.message).toBe(`status ${code}`);
  });

  it("keeps the throttling hint", () => {
    expect(classifyCosmosError(cosmosError(429, { retryAfterInMs: 250 }))).toMatchObject({
      retryAfterMs: 250,
    });
  });

  it("reads statusCode when code is absent (bulk responses, RestError)", () => {
    expect(classifyCosmosError({ statusCode: 412 })._tag).toBe("PreconditionFailed");
  });

  it("recognizes SDK client timeouts", () => {
    expect(classifyCosmosError(new TimeoutError("timed out"))._tag).toBe("RequestTimeout");
  });

  it("keeps the original error as the cause", () => {
    const original = cosmosError(500);
    expect(classifyCosmosError(original).cause).toBe(original);
    expect(classifyCosmosError("boom")).toMatchObject({
      _tag: "CosmosRequestFailed",
      statusCode: undefined,
      message: "boom",
    });
  });
});

describe("CosmosAdapterError", () => {
  it("is a BetterAuthError with a code, a prefixed message and a stack", () => {
    const error = toAdapterError(
      new ContainerNotConfigured({ model: "user", message: "No container for user" }),
    );
    expect(error).toBeInstanceOf(CosmosAdapterError);
    expect(error).toBeInstanceOf(BetterAuthError);
    expect(error.name).toBe("CosmosAdapterError");
    expect(error.code).toBe("CONTAINER_NOT_CONFIGURED");
    expect(error.message).toBe("[CosmosDB Adapter] No container for user");
    expect(error.stack).toContain("CosmosAdapterError");
  });

  it("chains the tagged error and the SDK error as causes", () => {
    const sdkError = cosmosError(409);
    const error = toAdapterError(classifyCosmosError(sdkError));
    expect(error.code).toBe("CONFLICT");
    expect(error.cause).toMatchObject({ _tag: "Conflict", cause: sdkError });
  });

  it("is what unwrapOrThrow throws at the Better Auth boundary", () => {
    expect(unwrapOrThrow(Result.ok(1))).toBe(1);
    expect(() =>
      unwrapOrThrow(Result.err(new ContentionExhausted({ attempts: 5, message: "busy" }))),
    ).toThrow(expect.objectContaining({ code: "CONTENTION" }));
  });
});
