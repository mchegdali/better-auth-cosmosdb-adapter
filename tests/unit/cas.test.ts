import { Result } from "better-result";
import { describe, expect, it, vi } from "vitest";

import { mutateOne, type Decision } from "../../src/cas.ts";
import type { StoredDoc } from "../../src/cosmos.ts";
import { InvalidQuery, NotFound, Throttled } from "../../src/errors.ts";
import { FakeGateway } from "../fakes/gateway.ts";

/** A find that behaves like `SELECT TOP 1 * FROM c WHERE c.id = @id AND <guard>`. */
function findById(
  gateway: FakeGateway,
  id: string,
  guard: (doc: StoredDoc) => boolean = () => true,
) {
  return vi.fn<() => Promise<Result<StoredDoc | null, never>>>(async () => {
    const doc = gateway.docs.get(id);
    return Result.ok(doc && guard(doc) ? doc : null);
  });
}

const increment = (doc: StoredDoc): Result<Decision, never> =>
  Result.ok({ kind: "replace", next: { ...doc, count: Number(doc["count"]) + 1 } });

const remove = (): Result<Decision, never> => Result.ok({ kind: "delete" });

describe("mutateOne", () => {
  it("writes once when nobody else touches the document", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });

    const result = await mutateOne({
      gateway,
      find: findById(gateway, "a"),
      decide: increment,
      maxAttempts: 3,
    });

    expect(result.unwrap()?.after).toMatchObject({ id: "a", count: 2 });
    expect(gateway.writes).toEqual(["replace"]);
  });

  it("returns null without writing when nothing matches", async () => {
    const gateway = new FakeGateway();
    const result = await mutateOne({
      gateway,
      find: findById(gateway, "missing"),
      decide: increment,
      maxAttempts: 3,
    });

    expect(result.unwrap()).toBeNull();
    expect(gateway.writes).toEqual([]);
  });

  it("re-reads and recomputes after losing a race, so no update is lost", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });
    // Another writer increments between our read and our write.
    gateway.onNextWrite(() => gateway.put({ id: "a", count: 10 }));
    const decide = vi.fn<typeof increment>(increment);

    const result = await mutateOne({
      gateway,
      find: findById(gateway, "a"),
      decide,
      maxAttempts: 3,
    });

    expect(result.unwrap()?.after).toMatchObject({ count: 11 });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(gateway.writes).toEqual(["replace", "replace"]);
  });

  it("re-checks the guard after a lost race and gives up cleanly when it no longer holds", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", remaining: 1 });
    // A concurrent caller uses the last remaining unit first.
    gateway.onNextWrite(() => gateway.put({ id: "a", remaining: 0 }));

    const result = await mutateOne({
      gateway,
      find: findById(gateway, "a", (doc) => Number(doc["remaining"]) > 0),
      decide: (doc) =>
        Result.ok({ kind: "replace", next: { ...doc, remaining: Number(doc["remaining"]) - 1 } }),
      maxAttempts: 3,
    });

    expect(result.unwrap()).toBeNull();
    expect(gateway.docs.get("a")).toMatchObject({ remaining: 0 });
  });

  it("lets exactly one of several concurrent consumers win", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "token", value: "secret" });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        mutateOne({ gateway, find: findById(gateway, "token"), decide: remove, maxAttempts: 5 }),
      ),
    );

    const winners = results
      .map((result) => result.unwrap())
      .filter((mutation) => mutation !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.before).toMatchObject({ id: "token", value: "secret" });
    expect(gateway.docs.has("token")).toBe(false);
  });

  it("fails with ContentionExhausted when every attempt loses", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });
    for (let i = 0; i < 3; i++) gateway.onNextWrite(() => gateway.put({ id: "a", count: 100 + i }));

    const result = await mutateOne({
      gateway,
      find: findById(gateway, "a"),
      decide: increment,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({ error: { _tag: "ContentionExhausted", attempts: 3 } });
    expect(gateway.writes).toHaveLength(3);
  });

  it("treats a document deleted under it as a lost race", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });
    gateway.failNextWrite(new NotFound({ message: "gone", cause: undefined }));
    const find = findById(gateway, "a");

    const result = await mutateOne({ gateway, find, decide: increment, maxAttempts: 3 });

    expect(result.unwrap()?.after).toMatchObject({ count: 2 });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("does not retry failures that are not races", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });
    gateway.failNextWrite(new Throttled({ message: "429", cause: undefined, retryAfterMs: 1000 }));
    const find = findById(gateway, "a");

    const result = await mutateOne({ gateway, find, decide: increment, maxAttempts: 3 });

    expect(result.isErr() && result.error._tag).toBe("Throttled");
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("propagates find and decide failures without writing", async () => {
    const gateway = new FakeGateway();
    gateway.put({ id: "a", count: 1 });

    const findFailure = await mutateOne({
      gateway,
      find: async () => Result.err(new InvalidQuery({ message: "bad where" })),
      decide: increment,
      maxAttempts: 3,
    });
    const decideFailure = await mutateOne({
      gateway,
      find: findById(gateway, "a"),
      decide: () => Result.err(new InvalidQuery({ message: "bad increment" })),
      maxAttempts: 3,
    });

    expect(findFailure.isErr() && findFailure.error.message).toBe("bad where");
    expect(decideFailure.isErr() && decideFailure.error.message).toBe("bad increment");
    expect(gateway.writes).toEqual([]);
  });
});
