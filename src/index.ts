/** biome-ignore-all lint/suspicious/noExplicitAny: Temporary until we have a better type for CosmosDB */
import {
  BulkOperationType,
  Container,
  type DeleteOperation,
  ErrorResponse,
  type FeedOptions,
  type ReplaceOperation,
  RestError,
  type SqlQuerySpec,
  TimeoutError,
} from "@azure/cosmos";
import { BetterAuthError } from "better-auth";
import { type AdapterDebugLogs, createAdapter } from "better-auth/adapters";
import type { Where } from "better-auth/types";
import type { SortBy } from "./types.js";

type SqlOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

const sqlOperators: Readonly<Record<SqlOperator, string>> = Object.freeze({
  eq: "=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
});

export interface CosmosDBAdapterConfig {
  /**
   * Helps you debug issues with the adapter.
   */
  debugLogs?: AdapterDebugLogs;

  /**
   * If the container names are plural, set this to true.
   */
  usePlural?: boolean;
}

export function cosmosdbAdapter(
  containers: Record<string, Container>,
  config: CosmosDBAdapterConfig,
) {
  return createAdapter({
    config: {
      adapterId: "cosmosdb-adapter",
      adapterName: "CosmosDB Adapter",
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      supportsNumericIds: false,
      usePlural: config.usePlural ?? false,
      debugLogs: config.debugLogs,
    },
    adapter: ({ getFieldName }) => {
      function getContainer(model: string) {
        const container = containers[model];
        if (!container) {
          throw new BetterAuthError(
            `[CosmosDB Adapter] Container "${model}" not found. Please provide a container for the model in the adapter options object.`,
          );
        }

        const isValidContainer = container instanceof Container;

        if (!isValidContainer) {
          throw new BetterAuthError(
            `[CosmosDB Adapter] Container "${model}" is not a valid CosmosDB container. Please provide a valid container for the model in the adapter options object.`,
          );
        }
        return container;
      }

      function convertWhereClause(model: string, where: Where[] = []): Required<SqlQuerySpec> {
        const querySpec: Required<SqlQuerySpec> = { query: "", parameters: [] };

        if (!where.length) {
          return querySpec;
        }

        querySpec.query += "WHERE 1=1";

        const valueNameMap: Record<string, string> = {};
        let valueNameCounter = 0;

        for (let index = 0; index < where.length; index++) {
          const condition = where[index];
          if (!condition) continue;

          const fieldName = getFieldName({ model, field: condition.field });
          let paramName: string;
          const paramValue = condition.value;
          const stringifiedValue = JSON.stringify(paramValue);
          const cachedParamValue = valueNameMap[stringifiedValue];

          if (cachedParamValue) {
            paramName = cachedParamValue;
          } else {
            paramName = `@param${valueNameCounter}`;
            valueNameMap[stringifiedValue] = paramName;
            valueNameCounter++;
          }

          const operator = condition.operator ?? "eq";
          const connector = condition.connector ?? "AND";

          let conditionStr: string;
          if (operator === "starts_with") {
            conditionStr = `STARTSWITH(c.${fieldName}, ${paramName})`;
          } else if (operator === "ends_with") {
            conditionStr = `ENDSWITH(c.${fieldName}, ${paramName})`;
          } else if (operator === "contains") {
            conditionStr = `CONTAINS(c.${fieldName}, ${paramName})`;
          } else if (operator === "in") {
            conditionStr = `ARRAY_CONTAINS(${paramName}, c.${fieldName})`;
          } else {
            conditionStr = `c.${fieldName} ${sqlOperators[operator]} ${paramName}`;
          }

          querySpec.query += ` ${connector} ${conditionStr}`;
          querySpec.parameters.push({ name: paramName, value: paramValue });
        }

        return querySpec;
      }

      function convertOrderByClause(
        model: string,
        sortBy: NonNullable<SortBy>,
      ): Required<SqlQuerySpec> {
        const fieldName = getFieldName({ model, field: sortBy.field });
        const direction = sortBy.direction.toUpperCase();

        return {
          query: ` ORDER BY c.${fieldName} ${direction}`,
          parameters: [],
        };
      }

      return {
        async create({ data, model }) {
          const container = getContainer(model);

          const dataToSave: Record<string, any> = {};
          const entries = Object.entries(data);

          for (const [field, value] of entries) {
            const fieldName = getFieldName({ model, field });
            dataToSave[fieldName] = value;
          }

          try {
            const itemResponse = await container.items.create(dataToSave);
            const responseBody = itemResponse.resource;
            if (!responseBody) {
              throw new BetterAuthError("Unexpected response body");
            }
            return responseBody as typeof data;
          } catch (error) {
            if (error instanceof ErrorResponse) {
              throw new BetterAuthError("Error creating item in the database.", error.message);
            } else if (error instanceof TimeoutError) {
              throw new BetterAuthError("Timeout creating item in the database.", error.message);
            } else if (error instanceof RestError) {
              throw new BetterAuthError("Error creating item in the database.", error.message);
            } else {
              throw error;
            }
          }
        },
        async findOne({ model, where }) {
          const container = getContainer(model);

          const querySpec: Required<SqlQuerySpec> = { query: "SELECT * FROM c", parameters: [] };
          const whereConditions = convertWhereClause(model, where);

          querySpec.query += ` ${whereConditions.query}`;
          querySpec.parameters.push(...whereConditions.parameters);

          const { resources } = await container.items.query(querySpec).fetchAll();

          const res = resources[0] ?? null;

          return res;
        },
        async findMany({ model, where, limit, sortBy, offset }) {
          const container = getContainer(model);
          const querySpec: Required<SqlQuerySpec> = { query: "SELECT * FROM c", parameters: [] };
          const limitValue = limit || 100;
          const offsetValue = offset ? offset : 0;

          const feedOptions: FeedOptions = { maxItemCount: limitValue };

          if (where?.length) {
            const whereConditions = convertWhereClause(model, where);
            querySpec.query += ` ${whereConditions.query}`;
            querySpec.parameters.push(...whereConditions.parameters);
          }

          if (sortBy) {
            const orderByClause = convertOrderByClause(model, sortBy);
            querySpec.query += ` ${orderByClause.query}`;
            querySpec.parameters.push(...orderByClause.parameters);
          }

          querySpec.query += ` OFFSET @offset LIMIT @limit`;
          querySpec.parameters.push(
            { name: "@offset", value: offsetValue },
            { name: "@limit", value: limit },
          );

          const queryIterator = container.items.query(querySpec, feedOptions);

          const resources = [];

          for await (const response of queryIterator.getAsyncIterator()) {
            resources.push(...response.resources);
          }

          return resources;
        },
        async count({ model, where }) {
          const container = getContainer(model);
          const querySpec: Required<SqlQuerySpec> = {
            query: "SELECT VALUE COUNT(1) FROM c",
            parameters: [],
          };

          if (where?.length) {
            const whereConditions = convertWhereClause(model, where);
            querySpec.query += ` ${whereConditions.query}`;
            querySpec.parameters.push(...whereConditions.parameters);
          }

          const { resources } = await container.items.query<number>(querySpec).fetchAll();

          return resources[0] || 0;
        },
        async update({ model, where, update }) {
          const container = getContainer(model);

          const querySpec: Required<SqlQuerySpec> = { query: "SELECT * FROM c", parameters: [] };
          const whereConditions = convertWhereClause(model, where);
          querySpec.query += ` ${whereConditions.query}`;
          querySpec.parameters.push(...whereConditions.parameters);

          const { resources } = await container.items.query(querySpec).fetchAll();

          const item = resources[0];

          if (!item) {
            return null;
          }

          const updateData = { ...item };

          const entries = Object.entries(update as any);

          for (const [key, value] of entries) {
            const fieldName = getFieldName({ model, field: key });
            updateData[fieldName] = value;
          }

          try {
            const replaceResponse = await container.item(item.id, item.id).replace(updateData);

            if (!replaceResponse.resource) {
              return null;
            }
            return replaceResponse.resource;
          } catch (error) {
            if (error instanceof ErrorResponse) {
              throw new BetterAuthError("Error updating item in the database.", error.message);
            } else if (error instanceof TimeoutError) {
              throw new BetterAuthError("Timeout updating item in the database.", error.message);
            } else if (error instanceof RestError) {
              throw new BetterAuthError("Error updating item in the database.", error.message);
            } else {
              throw error;
            }
          }
        },
        async updateMany({ model, where, update }) {
          const container = getContainer(model);

          // Find all items to update
          const querySpec: Required<SqlQuerySpec> = { query: "SELECT * FROM c", parameters: [] };
          const whereConditions = convertWhereClause(model, where);
          querySpec.query += ` ${whereConditions.query}`;
          querySpec.parameters.push(...whereConditions.parameters);

          const response = await container.items.query<Record<string, any>>(querySpec).fetchAll();
          const resources = response.resources;

          if (!resources.length) {
            return 0;
          }

          const updatedItems = [];

          for (const res of resources) {
            for (const [key, value] of Object.entries(update)) {
              const fieldName = getFieldName({ model, field: key });
              if (res[fieldName] !== value) {
                res[fieldName] = value;
                updatedItems.push(res);
              }
            }
          }

          // Prepare bulk update operations
          const replaceOperations: ReplaceOperation[] = updatedItems.map((item) => ({
            operationType: BulkOperationType.Replace,
            partitionKey: item.id, // Using id as partition key
            id: item.id,
            resourceBody: item,
          }));

          // Execute bulk delete
          const bulkResponse = await container.items.executeBulkOperations(replaceOperations);
          const updatedCount = bulkResponse.filter(
            (operationResult) => operationResult.response?.statusCode === 200,
          ).length;

          return updatedCount;
        },
        async delete({ model, where }) {
          const container = getContainer(model);

          const querySpec: Required<SqlQuerySpec> = { query: "SELECT c.id FROM c", parameters: [] };
          const whereConditions = convertWhereClause(model, where);
          querySpec.query += ` ${whereConditions.query}`;
          querySpec.parameters.push(...whereConditions.parameters);

          const response = await container.items.query(querySpec, { maxItemCount: 1 }).fetchAll();

          const resource = response.resources[0];

          if (!resource) {
            return;
          }

          await container.item(resource.id, resource.id).delete();
        },
        async deleteMany({ model, where }) {
          const container = getContainer(model);

          const querySpec: Required<SqlQuerySpec> = { query: "SELECT c.id FROM c", parameters: [] };
          const whereConditions = convertWhereClause(model, where);
          querySpec.query += ` ${whereConditions.query}`;
          querySpec.parameters.push(...whereConditions.parameters);

          const response = await container.items.query(querySpec).fetchAll();

          const resources = response.resources;

          if (resources.length === 0) {
            return 0;
          }

          // Prepare bulk delete operations - only requires id for both id and partitionKey in CosmosDB
          const deleteOperations: DeleteOperation[] = resources.map((res) => ({
            operationType: BulkOperationType.Delete,
            partitionKey: res.id, // Using id as partition key
            id: res.id,
          }));

          // Not using executeBulkOperations because the performance is much worse
          const bulkResponse = await container.items.bulk(deleteOperations);

          let successCount = 0;
          for (let i = 0; i < bulkResponse.length; i++) {
            const operationResult = bulkResponse[i];
            if (operationResult?.statusCode === 204) {
              successCount++;
            }
          }
          return successCount;
        },
      };
    },
  });
}
