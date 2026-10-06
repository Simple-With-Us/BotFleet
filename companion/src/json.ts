export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

export function isJsonString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function isJsonBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

export function isFiniteJsonNumber(value: unknown): value is number {
  return Number.isFinite(value);
}
