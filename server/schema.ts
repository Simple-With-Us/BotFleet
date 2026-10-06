import type { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

export function isFiniteJsonNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

/** JSON.parse without a reviver can only produce JSON-compatible values. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function schemaIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
