import { describe, expect, test } from "bun:test";

import { calculateRetryDelay, sanitizeOrigin } from "./utils";

describe("sanitizeOrigin", () => {
	test("keeps allowed hostname characters", () => {
		expect(sanitizeOrigin("worker-1.example_com")).toBe("worker-1.example_com");
	});

	test("removes disallowed shell characters", () => {
		expect(sanitizeOrigin('bad"; rm -rf / #')).toBe("badrm-rf");
	});
});

describe("calculateRetryDelay", () => {
	test("grows exponentially from the initial delay", () => {
		expect(calculateRetryDelay(0, 1_000, 30_000)).toBe(1_000);
		expect(calculateRetryDelay(1, 1_000, 30_000)).toBe(2_000);
		expect(calculateRetryDelay(2, 1_000, 30_000)).toBe(4_000);
	});

	test("caps the delay at the configured maximum", () => {
		expect(calculateRetryDelay(10, 1_000, 30_000)).toBe(30_000);
	});
});
