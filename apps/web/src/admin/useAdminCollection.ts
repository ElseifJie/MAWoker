import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api.js";

export interface AdminCollectionPage<T, C = undefined> {
  items: T[];
  context?: C;
  nextCursor?: string | undefined;
}

/** Each query owns its responses; an older page may never append to a new query. */
export function useAdminCollection<
  T extends { id?: string; userId?: string },
  C = undefined,
>(
  fetchPage: (cursor?: string) => Promise<AdminCollectionPage<T, C>>,
  onAuthRequired: () => void,
  delay = 0,
) {
  const [context, setContext] = useState<C>();
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const currentFetcher = useRef(fetchPage);
  currentFetcher.current = fetchPage;
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const token = ++generation.current;
    busy.current = false;
    setLoading(true);
    setLoadError(false);
    setMoreError(false);
    setLoadingMore(false);
    setItems([]);
    setNextCursor(undefined);
    const timer = setTimeout(() => {
      void fetchPage()
        .then((page) => {
          if (
            generation.current !== token ||
            currentFetcher.current !== fetchPage
          )
            return;
          setContext(page.context);
          setItems(page.items);
          setNextCursor(page.nextCursor);
        })
        .catch((error: unknown) => {
          if (
            generation.current !== token ||
            currentFetcher.current !== fetchPage
          )
            return;
          if (error instanceof ApiClientError && error.isAuthRequired)
            onAuthRequired();
          else setLoadError(true);
        })
        .finally(() => {
          if (
            generation.current === token &&
            currentFetcher.current === fetchPage
          )
            setLoading(false);
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [fetchPage, onAuthRequired, delay, revision]);

  async function loadMore() {
    if (!nextCursor || loading || busy.current) return;
    const token = generation.current;
    busy.current = true;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await fetchPage(nextCursor);
      if (generation.current !== token || currentFetcher.current !== fetchPage)
        return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id ?? item.userId));
        return [
          ...current,
          ...page.items.filter((item) => {
            const key = item.id ?? item.userId;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generation.current !== token || currentFetcher.current !== fetchPage)
        return;
      if (error instanceof ApiClientError && error.isAuthRequired)
        onAuthRequired();
      else setMoreError(true);
    } finally {
      if (
        generation.current === token &&
        currentFetcher.current === fetchPage
      ) {
        busy.current = false;
        setLoadingMore(false);
      }
    }
  }

  return {
    items,
    context,
    nextCursor,
    loading,
    loadError,
    reload,
    loadMore,
    loadingMore,
    moreError,
  };
}
