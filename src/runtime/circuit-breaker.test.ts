import { describe, expect, test } from "bun:test";

import { CircuitBreaker } from "./circuit-breaker";
import type { LoggerLike } from "../observability/logger";

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

describe("CircuitBreaker", () => {
	test("opens after the configured threshold and returns to closed on success", () => {
		let now = 1_000;
		const breaker = new CircuitBreaker(2, 500, logger, () => now);

		expect(breaker.canExecute()).toBe(true);
		expect(breaker.getFailureCount()).toBe(0);

		breaker.recordFailure();
		expect(breaker.getFailureCount()).toBe(1);
		expect(breaker.getState()).toBe("CLOSED");

		breaker.recordFailure();
		expect(breaker.getState()).toBe("OPEN");
		expect(breaker.canExecute()).toBe(false);

		now = 1_600;
		expect(breaker.canExecute()).toBe(true);
		expect(breaker.getState()).toBe("HALF_OPEN");

		breaker.recordSuccess();
		expect(breaker.getState()).toBe("CLOSED");
		expect(breaker.getFailureCount()).toBe(0);
	});

	test("applies updated threshold and reset timings", () => {
		let now = 0;
		const breaker = new CircuitBreaker(5, 60_000, logger, () => now);

		breaker.updateConfig(1, 100);
		breaker.recordFailure();
		expect(breaker.getState()).toBe("OPEN");

		now = 99;
		expect(breaker.canExecute()).toBe(false);

		now = 100;
		expect(breaker.canExecute()).toBe(true);
	});
});
