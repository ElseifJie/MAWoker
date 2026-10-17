// @vitest-environment jsdom
import { StrictMode, useCallback } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api.js";
import {
  useAdminCollection,
  type AdminCollectionPage,
} from "./useAdminCollection.js";

type Row = { id: string; name: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(cleanup);

describe("admin collection response ownership", () => {
  it("ignores a late page after the search changes", async () => {
    const oldPage = deferred<AdminCollectionPage<Row>>();
    const onAuthRequired = vi.fn();
    const { result, rerender } = renderHook(
      ({ search }) => {
        const fetchPage = useCallback(
          async (cursor?: string) => {
            if (cursor) return oldPage.promise;
            return search === "old"
              ? { items: [{ id: "old", name: "Old" }], nextCursor: "next" }
              : { items: [{ id: "new", name: "New" }] };
          },
          [search],
        );
        return useAdminCollection(fetchPage, onAuthRequired);
      },
      { initialProps: { search: "old" } },
    );
    await waitFor(() => expect(result.current.items[0]?.name).toBe("Old"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
    });
    rerender({ search: "new" });
    await waitFor(() => expect(result.current.items[0]?.name).toBe("New"));
    await act(async () => {
      oldPage.resolve({ items: [{ id: "late", name: "Late" }] });
      await pending;
    });
    expect(result.current.items).toEqual([{ id: "new", name: "New" }]);
    expect(result.current.nextCursor).toBeUndefined();
  });

  it("locks rapid pagination and deduplicates overlapping records", async () => {
    const nextPage = deferred<AdminCollectionPage<Row>>();
    const fetchPage = vi.fn(async (cursor?: string) =>
      cursor
        ? nextPage.promise
        : { items: [{ id: "a", name: "A" }], nextCursor: "next" },
    );
    const onAuthRequired = vi.fn();
    const { result } = renderHook(() =>
      useAdminCollection(fetchPage, onAuthRequired),
    );
    // A stable auth callback is part of the workspace interface.
    // Use rerender-independent callbacks so this test models production.
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
      void result.current.loadMore();
    });
    await act(async () => {
      nextPage.resolve({
        items: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
          { id: "b", name: "B" },
        ],
      });
      await pending;
    });
    expect(result.current.items.map((row) => row.id)).toEqual(["a", "b"]);
    expect(fetchPage.mock.calls.filter(([cursor]) => cursor)).toHaveLength(1);
  });

  it("suppresses an expired pagination auth callback after unmount", async () => {
    const nextPage = deferred<AdminCollectionPage<Row>>();
    const onAuthRequired = vi.fn();
    const fetchPage = async (cursor?: string) =>
      cursor
        ? nextPage.promise
        : { items: [{ id: "a", name: "A" }], nextCursor: "next" };
    const { result, unmount } = renderHook(() =>
      useAdminCollection(fetchPage, onAuthRequired),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.loadMore();
    });
    unmount();
    await act(async () => {
      nextPage.reject(
        new ApiClientError(
          401,
          "AUTH_REQUIRED",
          "Expired",
          "req-expired",
          false,
        ),
      );
      await pending;
    });
    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  it("survives StrictMode effect replay and retries without dropping rows", async () => {
    const onAuthRequired = vi.fn();
    let failed = false;
    const fetchPage = async (cursor?: string) => {
      if (cursor && !failed) {
        failed = true;
        throw new Error("offline");
      }
      return cursor
        ? { items: [{ id: "b", name: "B" }] }
        : { items: [{ id: "a", name: "A" }], nextCursor: "next" };
    };
    const { result } = renderHook(
      () => useAdminCollection(fetchPage, onAuthRequired),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.moreError).toBe(true);
    expect(result.current.items.map((row) => row.id)).toEqual(["a"]);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.current.moreError).toBe(false);
  });
});
