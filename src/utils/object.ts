export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { -readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep-merges `overrides` into a clone of `base`. Arrays are replaced, not merged. */
export function deepMerge<T>(base: T, overrides?: DeepPartial<T>): T {
  const clone = structuredClone(base);
  if (overrides === undefined) return clone;
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const current = target[key];
      if (isPlainObject(current) && isPlainObject(value)) {
        merge(current, value);
      } else {
        target[key] = structuredClone(value);
      }
    }
  };
  merge(clone as Record<string, unknown>, overrides as Record<string, unknown>);
  return clone;
}

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
  typeof value === 'object' && value !== null;

function child(container: Container, key: string): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[key];
}

/**
 * Returns a clone with the value at a dotted path removed (for "missing field" tests).
 * Numeric segments address array items, e.g. `purchase.products.0.name`.
 */
export function omitPath(source: object, path: string): Record<string, unknown> {
  const clone = structuredClone(source) as Record<string, unknown>;
  const keys = path.split('.');
  const last = keys.pop();
  let cursor: unknown = clone;
  for (const key of keys) {
    if (!isContainer(cursor)) return clone;
    cursor = child(cursor, key);
  }
  if (last === undefined || !isContainer(cursor)) return clone;
  if (Array.isArray(cursor)) {
    cursor.splice(Number(last), 1);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional for test data
    delete cursor[last];
  }
  return clone;
}

/**
 * Returns a clone with the value at a dotted path replaced (for "invalid value" tests).
 * Missing intermediate objects are created. Numeric segments address array items.
 */
export function setPath(source: object, path: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(source) as Record<string, unknown>;
  const keys = path.split('.');
  const last = keys.pop();
  let cursor: Container = clone;
  for (const key of keys) {
    let next = child(cursor, key);
    if (!isContainer(next)) {
      next = {};
      if (Array.isArray(cursor)) cursor[Number(key)] = next;
      else cursor[key] = next;
    }
    cursor = next as Container;
  }
  if (last !== undefined) {
    if (Array.isArray(cursor)) cursor[Number(last)] = value;
    else cursor[last] = value;
  }
  return clone;
}
