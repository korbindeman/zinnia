import { Store } from "@tauri-apps/plugin-store";

// Application state (not user preferences)
// This includes things like last opened note, last app version, etc.
export interface AppState {
  lastOpenedNote?: string;
  lastAppVersion?: string;
  brTagsMigrationCompleted?: boolean;
}

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load("app-state.json");
  }
  return store;
}

export async function getAppState<K extends keyof AppState>(
  key: K,
): Promise<AppState[K] | null> {
  const store = await getStore();
  return (await store.get(key)) as AppState[K] | null;
}

export async function setAppState<K extends keyof AppState>(
  key: K,
  value: AppState[K],
): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
}

export async function clearAppState(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
}
