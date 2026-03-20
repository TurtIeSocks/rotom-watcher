import { afterEach, describe, expect, test } from "bun:test";

import type { ConfigProvider } from "./config";
import { RotomApiClient } from "./rotom-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("RotomApiClient", () => {
	test("returns validated status payloads on success", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				devices: [],
				workers: [],
			})) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.fetchStatus()).resolves.toEqual({
			devices: [],
			workers: [],
		});
	});

	test("classifies non-2xx responses", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", {
				status: 503,
			})) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.fetchStatus()).rejects.toMatchObject({
			code: "http_error",
			statusCode: 503,
		});
	});

	test("rejects payloads that do not match the expected schema", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				devices: "wrong",
				workers: [],
			})) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.fetchStatus()).rejects.toMatchObject({
			code: "invalid_payload",
		});
	});

	test("classifies invalid JSON responses", async () => {
		globalThis.fetch = (async () =>
			new Response("{", {
				headers: {
					"content-type": "application/json",
				},
				status: 200,
			})) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.fetchStatus()).rejects.toMatchObject({
			code: "invalid_json",
		});
	});

	test("returns false when device deletion gets a non-2xx response", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", {
				status: 404,
			})) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.deleteDevice("device-1")).resolves.toBe(false);
	});

	test("classifies timeout failures during device deletion", async () => {
		globalThis.fetch = (async () => {
			throw new DOMException("Timed out", "AbortError");
		}) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.deleteDevice("device-1")).rejects.toMatchObject({
			code: "timeout",
		});
	});

	test("classifies unknown fetch failures as network errors", async () => {
		globalThis.fetch = (async () => {
			throw "boom";
		}) as unknown as typeof fetch;

		const client = new RotomApiClient(
			createConfigProvider("https://example.com", 1_000),
		);

		await expect(client.fetchStatus()).rejects.toMatchObject({
			code: "network_error",
			message: "boom",
		});
	});
});

const createConfigProvider = (
	rotomApiBaseUrl: string,
	fetchTimeoutMs: number,
): ConfigProvider => ({
	getConfig: () => ({
		checkIntervalMs: 60_000,
		circuitBreakerResetMs: 60_000,
		circuitBreakerThreshold: 5,
		deviceTimeoutMinutes: 10,
		fetchTimeoutMs,
		initialRetryDelayMs: 100,
		logFormat: "json",
		logLevel: "info",
		maxConcurrentJobs: 2,
		maxRetries: 1,
		maxRetryDelayMs: 1_000,
		metricsHost: "127.0.0.1",
		metricsPort: 9_090,
		restartThreshold: 2,
		rotomApiBaseUrl,
		scriptPath: "/tmp/test-script.sh",
		scriptRestart: "-rsc",
		scriptTimeoutMs: 1_000,
		scriptUpdate: "-usc",
		shutdownGracePeriodMs: 1_000,
	}),
});
