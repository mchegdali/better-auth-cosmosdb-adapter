import { Result } from "better-result";

import type {
  BulkWrite,
  ContainerGateway,
  Doc,
  GatewayError,
  StoredDoc,
} from "../../src/cosmos.ts";
import { NotFound, PreconditionFailed, type CosmosError } from "../../src/errors.ts";
import type { SqlFragment } from "../../src/sql.ts";

type WriteOperation = "replace" | "delete";

/**
 * In-memory container with real ETag semantics. Tests script concurrency by registering hooks
 * that run just before a write reaches the "server", or by injecting failures.
 */
export class FakeGateway implements ContainerGateway {
  readonly name: string = "fake";
  readonly docs: Map<string, StoredDoc> = new Map();
  readonly writes: WriteOperation[] = [];
  private version = 0;
  private readonly beforeWrite: (() => void)[] = [];
  private readonly failures: GatewayError[] = [];

  put(doc: Doc & { id: string }): StoredDoc {
    this.version += 1;
    const stored: StoredDoc = { ...doc, _etag: `"${this.version}"` };
    this.docs.set(doc.id, stored);
    return stored;
  }

  /** Runs `hook` right before the next write is applied, e.g. to simulate a concurrent writer. */
  onNextWrite(hook: () => void): void {
    this.beforeWrite.push(hook);
  }

  /** Makes the next write fail with `error` without touching the data. */
  failNextWrite(error: GatewayError): void {
    this.failures.push(error);
  }

  async idPartitioned(): Promise<Result<boolean, CosmosError>> {
    return Result.ok(true);
  }

  async query<T>(_fragment: SqlFragment): Promise<Result<T[], CosmosError>> {
    throw new Error("FakeGateway does not evaluate SQL; pass an explicit find function.");
  }

  async read(id: string): Promise<Result<StoredDoc | null, CosmosError>> {
    return Result.ok(this.docs.get(id) ?? null);
  }

  async create(body: Doc): Promise<Result<StoredDoc, CosmosError>> {
    const id = typeof body["id"] === "string" ? body["id"] : String(this.version + 1);
    return Result.ok(this.put({ ...body, id }));
  }

  async replace(doc: StoredDoc, next: Doc): Promise<Result<StoredDoc, GatewayError>> {
    return this.write("replace", doc, () => this.put({ ...next, id: doc.id }));
  }

  async delete(doc: StoredDoc): Promise<Result<void, GatewayError>> {
    return this.write("delete", doc, () => {
      this.docs.delete(doc.id);
    });
  }

  async bulk(writes: readonly BulkWrite[]): Promise<Result<number, GatewayError>> {
    const results = await Promise.all(
      writes.map((write) =>
        write.kind === "replace" ? this.replace(write.doc, write.next) : this.delete(write.doc),
      ),
    );
    let applied = 0;
    for (const result of results) {
      if (result.isOk()) applied++;
      else if (result.error._tag !== "PreconditionFailed" && result.error._tag !== "NotFound") {
        return Result.err(result.error);
      }
    }
    return Result.ok(applied);
  }

  private async write<T>(
    operation: WriteOperation,
    doc: StoredDoc,
    apply: () => T,
  ): Promise<Result<T, GatewayError>> {
    // Yield once so concurrent callers interleave the way they would against a real server.
    await Promise.resolve();
    this.beforeWrite.shift()?.();
    this.writes.push(operation);

    const failure = this.failures.shift();
    if (failure) return Result.err(failure);

    const current = this.docs.get(doc.id);
    if (!current) return Result.err(new NotFound({ message: "gone", cause: undefined }));
    if (current._etag !== doc._etag) {
      return Result.err(new PreconditionFailed({ message: "etag mismatch", cause: undefined }));
    }
    return Result.ok(apply());
  }
}
