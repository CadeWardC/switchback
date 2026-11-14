// Reading signals from React: a component re-renders when a signal it reads changes, and only then.
import { useCallback, useSyncExternalStore } from 'react';
import type { ReadonlySignal } from '@preact/signals-core';

export function useValue<T>(s: ReadonlySignal<T>): T {
  const subscribe = useCallback((cb: () => void) => s.subscribe(() => cb()), [s]);
  return useSyncExternalStore(subscribe, () => s.peek());
}
