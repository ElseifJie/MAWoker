// Node >= 22 defines globalThis.localStorage as a stub unless
// --localstorage-file points at a writable path, and vitest cannot replace it
// with jsdom's implementation. Tests that assert persistence need a real one.
function createMemoryStorage() {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

function isUsable(candidate: unknown): boolean {
  return typeof (candidate as Storage | undefined)?.getItem === "function";
}

for (const area of ["localStorage", "sessionStorage"] as const) {
  let ambient: unknown;
  try {
    ambient = (globalThis as Record<string, unknown>)[area];
  } catch {
    ambient = undefined;
  }
  if (!isUsable(ambient)) {
    Object.defineProperty(globalThis, area, {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
