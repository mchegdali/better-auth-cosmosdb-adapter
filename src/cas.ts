import { Result } from "better-result";

import type { ContainerGateway, Doc, GatewayError, StoredDoc } from "./cosmos.ts";
import { ContentionExhausted } from "./errors.ts";

export type Decision =
  | { readonly kind: "replace"; readonly next: Doc }
  | { readonly kind: "delete" };

type Mutation = {
  /** The document the decision was made on. */
  readonly before: StoredDoc;
  /** The stored document after a replace, `null` after a delete. */
  readonly after: StoredDoc | null;
};

export type MutateOneParams<FindError, DecideError> = {
  readonly gateway: ContainerGateway;
  /** Finds the target. Re-run after every lost race, so the selector is re-checked each time. */
  readonly find: () => Promise<Result<StoredDoc | null, FindError>>;
  /** Computes the write from the current document. Must be pure: it may run several times. */
  readonly decide: (doc: StoredDoc) => Result<Decision, DecideError>;
  readonly maxAttempts: number;
};

export type MutateOneResult<FindError, DecideError> = Result<
  Mutation | null,
  FindError | DecideError | GatewayError | ContentionExhausted
>;

function lostRace(error: GatewayError): boolean {
  // 412: the document changed after we read it. 404: it was deleted after we read it.
  return error._tag === "PreconditionFailed" || error._tag === "NotFound";
}

/**
 * Optimistic-concurrency single-document write: find → decide → write if the ETag still
 * matches. A lost race starts over from `find`, so a write only ever lands on a document that
 * matched the selector when it was written. `Ok(null)` means nothing matched.
 */
export function mutateOne<FindError, DecideError>(
  params: MutateOneParams<FindError, DecideError>,
): Promise<MutateOneResult<FindError, DecideError>> {
  const { gateway, find, decide, maxAttempts } = params;

  async function attempt(number: number): Promise<MutateOneResult<FindError, DecideError>> {
    if (number > maxAttempts) {
      return Result.err(
        new ContentionExhausted({
          attempts: maxAttempts,
          message: `Gave up writing to "${gateway.name}" after ${maxAttempts} attempts lost to concurrent writers.`,
        }),
      );
    }

    const found = await find();
    if (found.isErr()) return Result.err(found.error);
    const before = found.value;
    if (before === null) return Result.ok(null);

    const decision = decide(before);
    if (decision.isErr()) return Result.err(decision.error);

    const written =
      decision.value.kind === "replace"
        ? await gateway.replace(before, decision.value.next)
        : (await gateway.delete(before)).map(() => null);

    if (written.isOk()) return Result.ok({ before, after: written.value });
    return lostRace(written.error) ? attempt(number + 1) : Result.err(written.error);
  }

  return attempt(1);
}
