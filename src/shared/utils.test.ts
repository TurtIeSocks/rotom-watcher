import { describe, expect, test } from "bun:test";

import {
	calculateRetryDelay,
	fetchWithTimeout,
	sanitizeOrigin,
	sleep,
	truncateOutput,
} from "./utils";

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

describe("sleep", () => {
	test("resolves after waiting", async () => {
		await expect(sleep(0)).resolves.toBeUndefined();
	});
});

describe("fetchWithTimeout", () => {
	test("passes an abort signal to the fetch implementation", async () => {
		let receivedAbortSignal = false;

		await fetchWithTimeout("https://example.com", 1_000, (async (
			_url,
			init,
		) => {
			receivedAbortSignal = init?.signal instanceof AbortSignal;
			return new Response("ok", {
				status: 200,
			});
		}) as typeof fetch);

		expect(receivedAbortSignal).toBe(true);
	});

	test("aborts the request when the timeout elapses", async () => {
		await expect(
			fetchWithTimeout(
				"https://example.com",
				0,
				((_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("Aborted", "AbortError"));
						});
					})) as typeof fetch,
			),
		).rejects.toThrow("Aborted");
	});
});
