import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "./circuit-breaker";

describe("createCircuitBreaker", () => {
  it("starts closed", () => {
    expect(createCircuitBreaker(3).isOpen()).toBe(false);
  });

  it("stays closed below the consecutive-failure threshold", () => {
    const breaker = createCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it("opens once the consecutive-failure threshold is reached", () => {
    const breaker = createCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it("resets the consecutive-failure count on success", () => {
    const breaker = createCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it("stays open once tripped, even after a later success", () => {
    const breaker = createCircuitBreaker(2);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(true);
  });
});
