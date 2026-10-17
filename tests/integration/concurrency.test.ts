import type { Database } from "@azure/cosmos";
import type { BetterAuthOptions, DBAdapter } from "better-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CosmosAdapterError, cosmosdbAdapter, ensureContainers } from "../../src/index.ts";
import { createTestDatabase } from "./cosmos.ts";

const options = {
  user: { additionalFields: { credits: { type: "number", required: false } } },
} satisfies BetterAuthOptions;

describe("race safety against Cosmos DB", () => {
  let database: Database;
  let adapter: DBAdapter;

  beforeAll(async () => {
    database = await createTestDatabase("concurrency");
    await ensureContainers(database, options);
    adapter = cosmosdbAdapter(database)(options);
  });

  afterAll(async () => {
    await database.delete();
  });

  it("consumeOne hands a single-use token to exactly one of many concurrent callers", async () => {
    await adapter.create({
      model: "verification",
      forceAllowId: true,
      data: {
        id: "otp-1",
        identifier: "user@example.com",
        value: "123456",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.consumeOne<{ id: string }>({
          model: "verification",
          where: [{ field: "identifier", value: "user@example.com" }],
        }),
      ),
    );

    const winners = results.filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe("otp-1");
    expect(await adapter.count({ model: "verification" })).toBe(0);
  });

  it("incrementOne never lets a guarded counter go below zero", async () => {
    const credits = 5;
    await adapter.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: "user-credits",
        name: "Credits",
        email: "credits@example.com",
        emailVerified: false,
        credits,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: credits + 5 }, () =>
        adapter.incrementOne<{ credits: number }>({
          model: "user",
          where: [
            { field: "id", value: "user-credits" },
            { field: "credits", operator: "gt", value: 0 },
          ],
          increment: { credits: -1 },
        }),
      ),
    );

    const stored = await adapter.findOne<{ credits: number }>({
      model: "user",
      where: [{ field: "id", value: "user-credits" }],
    });
    const applied = attempts.filter(
      (attempt) => attempt.status === "fulfilled" && attempt.value !== null,
    );
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(stored?.credits).toBeGreaterThanOrEqual(0);
    // Every successful decrement is reflected in the stored value; nothing was lost or doubled.
    expect(applied).toHaveLength(credits - (stored?.credits ?? 0));
    // Under heavy contention a caller may give up, but only with the documented error.
    for (const attempt of rejected) {
      expect(attempt.reason).toBeInstanceOf(CosmosAdapterError);
      expect(attempt.reason).toMatchObject({ code: "CONTENTION" });
    }
  });

  it("update does not lose concurrent changes to different fields", async () => {
    await adapter.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: "user-update",
        name: "Before",
        email: "update@example.com",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await Promise.all([
      adapter.update({
        model: "user",
        where: [{ field: "id", value: "user-update" }],
        update: { name: "After" },
      }),
      adapter.update({
        model: "user",
        where: [{ field: "id", value: "user-update" }],
        update: { emailVerified: true },
      }),
    ]);

    const stored = await adapter.findOne<{ name: string; emailVerified: boolean }>({
      model: "user",
      where: [{ field: "id", value: "user-update" }],
    });
    expect(stored).toMatchObject({ name: "After", emailVerified: true });
  });
});
