import type { JSONObject } from "@azure/cosmos";
import type { CleanedWhere, CustomAdapter } from "better-auth/adapters";

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type CreateParams<T extends JSONObject> = {
  model: string;
  data: T;
};

export type FindOneParams = Pick<Parameters<CustomAdapter["findOne"]>[0], "model" | "where">;
export type FindManyParams = Parameters<CustomAdapter["findMany"]>[0];
export type UpdateOneParams<T extends JSONObject> = {
  model: string;
  where: CleanedWhere[];
  update: T;
};
export type SortBy = FindManyParams["sortBy"];
