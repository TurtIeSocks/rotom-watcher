import { describe, expect, test } from "bun:test";

import { createConfig } from "./config";

type ConfigFactory = (env: Record<string, string | undefined>) => unknown;

const createConfigFromEnv = createConfig as unknown as ConfigFactory;

describe("createConfig", () => {
	test("requires ROTOM_API_BASE_URL", () => {
		expect(() => createConfigFromEnv({})).toThrow(/ROTOM_API_BASE_URL/);
	});

	test("rejects malformed URLs", () => {
		expect(() =>
			createConfigFromEnv({
				ROTOM_API_BASE_URL: "definitely-not-a-url",
			}),
		).toThrow(/URL/);
	});

	test("rejects invalid numeric settings instead of silently falling back", () => {
		expect(() =>
			createConfigFromEnv({
				MAX_CONCURRENT_JOBS: "0",
				ROTOM_API_BASE_URL: "https://example.com",
			}),
		).toThrow(/MAX_CONCURRENT_JOBS/);
	});

	test("parses observability settings and validated API config", () => {
		const config = createConfigFromEnv({
			LOG_FORMAT: "pretty",
			LOG_LEVEL: "debug",
			METRICS_HOST: "0.0.0.0",
			METRICS_PORT: "9100",
			ROTOM_API_BASE_URL: "https://example.com",
		}) as {
			logFormat: string;
			logLevel: string;
			metricsHost: string;
			metricsPort: number;
			rotomApiBaseUrl: string;
		};

		expect(config).toMatchObject({
			logFormat: "pretty",
			logLevel: "debug",
			metricsHost: "0.0.0.0",
			metricsPort: 9_100,
			rotomApiBaseUrl: "https://example.com/",
		});
	});
});
