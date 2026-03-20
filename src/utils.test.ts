import { describe, expect, test } from "bun:test";

import { calculateRetryDelay, sanitizeOrigin, truncateOutput } from "./utils";

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
		expect(calculateRetryDelay(0, 1_000, 30_000, 0, () => 0.5)).toBe(1_000);
		expect(calculateRetryDelay(1, 1_000, 30_000, 0, () => 0.5)).toBe(2_000);
		expect(calculateRetryDelay(2, 1_000, 30_000, 0, () => 0.5)).toBe(4_000);
	});

	test("caps the delay at the configured maximum", () => {
		expect(calculateRetryDelay(10, 1_000, 30_000, 0, () => 0.5)).toBe(30_000);
	});
});

describe("truncateOutput", () => {
	test("keeps short output unchanged", () => {
		expect(truncateOutput("hello", 10)).toBe("hello");
	});

	test("annotates truncated output", () => {
		expect(truncateOutput("abcdefghij", 5)).toBe("abcde...[truncated 5 chars]");
	});
});
