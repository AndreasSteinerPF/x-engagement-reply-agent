export type CircuitBreaker = {
  isOpen: () => boolean;
  recordSuccess: () => void;
  recordFailure: () => void;
};

/**
 * A per-run circuit breaker for MCP calls: once `maxConsecutiveFailures`
 * failures happen in a row, the breaker opens and stays open for the rest
 * of that run so a downed dependency can't burn the whole Lambda time
 * budget retrying it for every remaining post. Callers must construct a
 * fresh breaker per run -- this has no persistence and is not meant to be
 * shared across invocations.
 */
export function createCircuitBreaker(maxConsecutiveFailures: number): CircuitBreaker {
  let consecutiveFailures = 0;
  let open = false;

  return {
    isOpen: () => open,
    recordSuccess: () => {
      consecutiveFailures = 0;
    },
    recordFailure: () => {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        open = true;
      }
    },
  };
}
