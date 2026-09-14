// Native DOM/Error properties are often inherited accessors. Never enumerate a
// browser object: it loses those properties and can invoke unrelated user getters.
export function readNativeField(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

export function readNativeFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, readNativeField(value, key)]));
}

export function hasErrorDetails(value: unknown): boolean {
  return typeof readNativeField(value, "message") === "string" || typeof readNativeField(value, "stack") === "string";
}

export function readStructuralTarget(value: unknown): Record<string, unknown> {
  return readNativeFields(value, ["tagName", "id", "role", "type"]);
}

export function countFormFields(target: unknown): number {
  const elements = readNativeField(target, "elements");
  const length = readNativeField(elements, "length");
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return 0;
  let count = 0;
  // HTMLFormControlsCollection is array-like, not an Array. Bound inspection and
  // retain only a count; never serialize names, values or the surrounding DOM.
  for (let index = 0; index < Math.min(Math.floor(length), 1_000); index += 1) {
    const name = readNativeField(readNativeField(elements, String(index)), "name");
    if (typeof name === "string" && name.length > 0) count += 1;
  }
  return count;
}
