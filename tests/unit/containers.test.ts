import type { Container, Database } from "@azure/cosmos";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, it, vi } from "vitest";

import { containerNames, createContainerResolver } from "../../src/containers.ts";

// Structural stand-ins: the resolver duck-types instead of relying on `instanceof`.
function fakeContainer(id: string): Container {
  return { id, item: vi.fn<() => void>(), read: vi.fn<() => void>() } as unknown as Container;
}

describe("createContainerResolver", () => {
  it("resolves containers by model name from a Database", () => {
    const container = vi.fn<(id: string) => Container>((id) => fakeContainer(id));
    const database = { container, read: vi.fn<() => void>() } as unknown as Database;

    const resolved = createContainerResolver(database)("session").unwrap();

    expect(resolved.id).toBe("session");
    expect(container).toHaveBeenCalledWith("session");
  });

  it("resolves containers from an explicit map", () => {
    const user = fakeContainer("users");
    expect(createContainerResolver({ user })("user").unwrap()).toBe(user);
  });

  it("explains a missing container", () => {
    const result = createContainerResolver({ user: fakeContainer("users") })("session");
    expect(result.isErr() && result.error).toMatchObject({
      _tag: "ContainerNotConfigured",
      model: "session",
    });
    expect(result.isErr() && result.error.message).toContain(
      'No container provided for model "session"',
    );
  });

  it("rejects values that are not containers", () => {
    const notAContainer = { id: "user" } as unknown as Container;
    const result = createContainerResolver({ user: notAContainer })("user");
    expect(result.isErr() && result.error.message).toContain("is not a Cosmos DB container");
  });

  it("does not resolve inherited properties of the map", () => {
    expect(createContainerResolver({})("constructor").isErr()).toBe(true);
    expect(createContainerResolver({})("__proto__").isErr()).toBe(true);
  });
});

describe("containerNames", () => {
  it("lists one container per model, plugins included", () => {
    const names = containerNames({ plugins: [organization()] });
    expect(names).toEqual(
      expect.arrayContaining([
        "user",
        "session",
        "account",
        "verification",
        "organization",
        "member",
      ]),
    );
  });

  it("follows usePlural and custom model names", () => {
    const names = containerNames({ user: { modelName: "people" } }, { usePlural: true });
    expect(names).toEqual(expect.arrayContaining(["peoples", "sessions"]));
    expect(names).not.toContain("users");
  });
});
