import type { Container, Database } from "@azure/cosmos";
import type { BetterAuthOptions } from "better-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { containerNames, cosmosdbAdapter, ensureContainers } from "../../src/index.ts";
import { createTestDatabase } from "./cosmos.ts";

const options = {} satisfies BetterAuthOptions;

describe("containers map with plural names and a non-id partition key", () => {
  let database: Database;
  let containers: Record<string, Container>;

  beforeAll(async () => {
    database = await createTestDatabase("containers-map");
    await ensureContainers(database, options, { usePlural: true });
    containers = Object.fromEntries(
      containerNames(options, { usePlural: true }).map((name) => [name, database.container(name)]),
    );
    // Sessions partitioned by user: point operations must use the document's own partition key.
    await database.container("sessions").delete();
    await database.containers.create({ id: "sessions", partitionKey: { paths: ["/userId"] } });
  });

  afterAll(async () => {
    await database.delete();
  });

  it("creates, updates, consumes and deletes across partition key layouts", async () => {
    const adapter = cosmosdbAdapter(containers, { usePlural: true })(options);
    const now = new Date();

    await adapter.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: "u1",
        name: "U",
        email: "u@example.com",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "session",
      forceAllowId: true,
      data: {
        id: "s1",
        userId: "u1",
        token: "token-1",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      },
    });

    const updated = await adapter.update<{ ipAddress: string; expiresAt: Date }>({
      model: "session",
      where: [{ field: "token", value: "token-1" }],
      update: { ipAddress: "127.0.0.1" },
    });
    expect(updated?.ipAddress).toBe("127.0.0.1");
    expect(updated?.expiresAt).toBeInstanceOf(Date);

    const consumed = await adapter.consumeOne<{ id: string }>({
      model: "session",
      where: [{ field: "token", value: "token-1" }],
    });
    expect(consumed?.id).toBe("s1");
    expect(await adapter.count({ model: "session" })).toBe(0);

    await adapter.delete({ model: "user", where: [{ field: "id", value: "u1" }] });
    expect(
      await adapter.findOne({ model: "user", where: [{ field: "id", value: "u1" }] }),
    ).toBeNull();
  });
});
