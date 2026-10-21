/**
 * React binding for the window store.
 *
 * `useWindowStore` mirrors the zustand API (`useWindowStore(selector)` plus
 * `useWindowStore.getState()`), but is implemented with React 18's
 * `useSyncExternalStore` so that no third party state library is required.
 */
import {useMemo, useSyncExternalStore} from 'react';

import {createWindowStore, type StoreState, type WindowStore} from './windowState';

/** The single window store shared by the Electron shim and the UI. */
export const windowStore: WindowStore = createWindowStore();

/** Stable subscribe function (keeps `useSyncExternalStore` from resubscribing). */
const subscribe = (listener: () => void): (() => void) => windowStore.subscribe(() => listener());

/** Stable snapshot getter. */
const getSnapshot = (): StoreState => windowStore.getState();

export interface UseWindowStore {
  <T>(selector: (state: StoreState) => T): T;
  getState(): StoreState;
  setState: WindowStore['setState'];
  subscribe: WindowStore['subscribe'];
}

/**
 * Subscribes to the window store and returns the selected slice.
 */
export function useWindowStore<T>(selector: (state: StoreState) => T): T {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => selector(state), [state, selector]);
}

useWindowStore.getState = windowStore.getState;
useWindowStore.setState = windowStore.setState;
useWindowStore.subscribe = windowStore.subscribe;

export type {StoreState, WindowStore};
export * from './windowState';

export default windowStore;
