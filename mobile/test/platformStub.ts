// A device layer for tests: settings in memory, nothing else.
const kv = new Map<string, string>();
export const platform = {
  name: 'android',
  keyValue: { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => { kv.set(k, v); return true; }, remove: (k: string) => { kv.delete(k); } },
  documents: { read: async () => null, write: async () => true, remove: async () => {}, append: async () => true, readLog: async () => [], removeLog: async () => {} },
  files: { exportText: async () => {} },
};
export const isNativeApp = true;
