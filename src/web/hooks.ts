import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Page, withQuery } from "./api";

export type Loadable<T> = { status: "loading" } | { status: "error"; error: ApiError } | { status: "ready"; data: T };

export const toApiError = (error: unknown): ApiError =>
  error instanceof ApiError ? error : new ApiError(0, "UNEXPECTED", error instanceof Error ? error.message : "Unexpected error");

/**
 * Fetch a resource (GET). A null path loads nothing. `pollMs` receives the latest data and returns the delay
 * before the next refresh, or null to stop: runs are polled while queued or running and left alone afterwards.
 */
export function useResource<T>(path: string | null, pollMs?: (data: T) => number | null): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poll = useRef(pollMs);
  poll.current = pollMs;

  const load = useCallback(
    (first: boolean) => {
      if (path === null) return;
      const mine = ++generation.current;
      if (timer.current) clearTimeout(timer.current);
      if (first) setState({ status: "loading" });
      api<T>("GET", path).then(
        (data) => {
          if (mine !== generation.current) return;
          setState({ status: "ready", data });
          const next = poll.current?.(data) ?? null;
          if (next !== null) timer.current = setTimeout(() => load(false), next);
        },
        (error: unknown) => {
          if (mine !== generation.current) return;
          setState({ status: "error", error: toApiError(error) });
        },
      );
    },
    [path],
  );

  useEffect(() => {
    load(true);
    return () => {
      generation.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return [state, useCallback(() => load(true), [load])];
}

export interface PagedState<T> {
  status: "loading" | "ready" | "error";
  items: T[];
  error: ApiError | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** Error from loading a further page; the pages already loaded stay visible. */
  moreError: ApiError | null;
  loadMore(): void;
  reload(): void;
}

/** Cursor-paginated list (`{items, next_cursor}`): the first page loads at once, further pages on request. */
export function usePaged<T>(path: string | null, params: Record<string, string | number | null | undefined> = {}, limit = 50): PagedState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<PagedState<T>["status"]>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  // A ref, not the state: two clicks in the same tick must not both fetch the same page and append it twice.
  const fetchingMore = useRef(false);
  const paramKey = JSON.stringify(params);

  const first = useCallback(() => {
    if (path === null) return;
    const mine = ++generation.current;
    fetchingMore.current = false;
    setStatus("loading");
    setItems([]);
    setCursor(null);
    setMoreError(null);
    api<Page<T>>("GET", withQuery(path, { ...(JSON.parse(paramKey) as Record<string, string | number>), limit })).then(
      (page) => {
        if (mine !== generation.current) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setStatus("ready");
      },
      (e: unknown) => {
        if (mine !== generation.current) return;
        setError(toApiError(e));
        setStatus("error");
      },
    );
  }, [path, paramKey, limit]);

  useEffect(() => {
    first();
    return () => {
      generation.current += 1;
    };
  }, [first]);

  const loadMore = useCallback(() => {
    if (path === null || cursor === null || fetchingMore.current) return;
    const mine = generation.current;
    fetchingMore.current = true;
    setLoadingMore(true);
    setMoreError(null);
    api<Page<T>>("GET", withQuery(path, { ...(JSON.parse(paramKey) as Record<string, string | number>), limit, cursor })).then(
      (page) => {
        if (mine !== generation.current) return;
        setItems((current) => [...current, ...page.items]);
        setCursor(page.next_cursor);
        fetchingMore.current = false;
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (mine !== generation.current) return;
        setMoreError(toApiError(e));
        fetchingMore.current = false;
        setLoadingMore(false);
      },
    );
  }, [path, paramKey, limit, cursor]);

  return { status, items, error, hasMore: cursor !== null, loadingMore, moreError, loadMore, reload: first };
}
