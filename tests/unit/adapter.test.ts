import { describe, expect, it } from "vitest";

import { CosmosAdapterError, cosmosdbAdapter } from "../../src/index.ts";

const createWithJoins = () => cosmosdbAdapter({})({ advanced: { database: { joins: true } } });

describe("cosmosdbAdapter", () => {
  it("refuses Better Auth's native joins, which Cosmos DB cannot perform", () => {
    expect(createWithJoins).toThrow(CosmosAdapterError);
    expect(createWithJoins).toThrow(expect.objectContaining({ code: "UNSUPPORTED_FEATURE" }));
  });

  it("reports a missing container with a typed error", async () => {
    const adapter = cosmosdbAdapter({})({});
    await expect(
      adapter.findOne({ model: "user", where: [{ field: "id", value: "1" }] }),
    ).rejects.toMatchObject({ name: "CosmosAdapterError", code: "CONTAINER_NOT_CONFIGURED" });
  });
});
