export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as K;

    if (Object.hasOwn(obj, key)) {
      result[key] = obj[key];
    }
  }

  return result;
}
