export { cosmosdbAdapter, type CosmosDBAdapterConfig } from "./adapter.ts";
export {
  containerNames,
  ensureContainers,
  type ContainerSource,
  type EnsureContainersOptions,
} from "./containers.ts";
export type { Diagnostic as CosmosDiagnostic } from "./cosmos.ts";
export { CosmosAdapterError, type CosmosAdapterErrorCode } from "./errors.ts";
