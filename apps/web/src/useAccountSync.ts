import { useEffect, useRef } from "react";
import {
  apiClient,
  type SyncChange,
  type SyncChanges,
  type SyncSnapshot,
} from "./api.js";

export interface AccountSyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SyncInput {
  cursor: number | null;
  fetchSnapshot: () => Promise<SyncSnapshot>;
  fetchChanges: (cursor: number) => Promise<SyncChanges>;
  onChange: (changes: SyncChange[]) => void;
}

export async function syncAccountChanges(
  input: SyncInput,
): Promise<{ cursor: number; changes: SyncChange[] }> {
  if (input.cursor === null) {
    const snapshot = await input.fetchSnapshot();
    return { cursor: snapshot.cursor, changes: [] };
  }
  let cursor = input.cursor;
  const changes: SyncChange[] = [];
  for (let page = 0; page < 5; page += 1) {
    const result = await input.fetchChanges(cursor);
    cursor = result.cursor;
    changes.push(...result.changes);
    if (!result.hasMore) break;
  }
  if (changes.length > 0) input.onChange(changes);
  return { cursor, changes };
}

function storageKey(userId: string): string {
  return `maworker.sync.${userId}`;
}

export function useAccountSync(input: {
  userId: string;
  enabled?: boolean;
  onChange: (changes: SyncChange[]) => void;
  intervalMs?: number;
  storage?: AccountSyncStorage;
}): void {
  const onChangeRef = useRef(input.onChange);
  onChangeRef.current = input.onChange;
  const enabled = input.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const storage =
      input.storage ??
      (typeof window === "undefined" ? undefined : window.localStorage);
    if (!storage) return;
    const key = storageKey(input.userId);
    let cursor: number | null = null;
    const stored = storage.getItem(key);
    if (stored !== null && /^\d+$/.test(stored)) cursor = Number(stored);
    let active = true;
    let loading = false;

    const tick = async () => {
      if (!active || loading || document.hidden) return;
      loading = true;
      try {
        const result = await syncAccountChanges({
          cursor,
          fetchSnapshot: () => apiClient.getSyncSnapshot(),
          fetchChanges: (value) => apiClient.getSyncChanges(value),
          onChange: (changes) => onChangeRef.current(changes),
        });
        if (!active) return;
        cursor = result.cursor;
        storage.setItem(key, String(cursor));
      } catch {
        // Transient failures retry on the next tick.
      } finally {
        loading = false;
      }
    };

    void tick();
    const timer = window.setInterval(
      () => void tick(),
      input.intervalMs ?? 15_000,
    );
    const onForeground = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, [enabled, input.intervalMs, input.storage, input.userId]);
}
