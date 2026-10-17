import { useEffect, useRef } from "react";

/** Capture before awaiting a mutation, then check before every UI side effect. */
export function useAdminLifetime() {
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, []);
  return () => {
    const token = generation.current;
    return () => token === generation.current;
  };
}
