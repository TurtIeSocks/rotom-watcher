import { describe, expect, test } from "bun:test";

import { createConfig } from "./config";

type ConfigFactory = (options?: {
	env?: Record<string, string | undefined>;
	fileConfig?: unknown;
}) => unknown;

const createConfigFromSources = createConfig as unknown as ConfigFactory;

describe("createConfig", () => {
	test("requires rotom_api.base_url when it is missing from both file config and env", () => {
		expect(() =>
			createConfigFromSources({
				env: {},
				fileConfig: {},
			}),
		).toThrow(/ROTOM_API_BASE_URL|rotom_api/i);
	});

	test("rejects malformed URLs from file config", () => {
		expect(() =>
			createConfigFromSources({
				env: {},
				fileConfig: {
					rotom_api: {
						base_url: "definitely-not-a-url",
					},
				},
			}),
		).toThrow(/URL/);
	});

	test("rejects invalid numeric settings instead of silently falling back", () => {
		expect(() =>
			createConfigFromSources({
				env: {},
				fileConfig: {
					concurrency: {
						max_concurrent_jobs: 0,
					},
					rotom_api: {
						base_url: "https://example.com",
					},
				},
			}),
		).toThrow(/MAX_CONCURRENT_JOBS|max_concurrent_jobs/i);
	});

	test("parses validated values from file config", () => {
		const config = createConfigFromSources({
			env: {},
			fileConfig: {
				logging: {
					format: "pretty",
					level: "debug",
				},
				metrics: {
					host: "0.0.0.0",
					port: 9_100,
				},
				rotom_api: {
					base_url: "https://example.com",
				},
			},
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

	test("prefers environment variables over TOML values", () => {
		const config = createConfigFromSources({
			env: {
				LOG_LEVEL: "trace",
				ROTOM_API_BASE_URL: "https://env.example.com",
			},
			fileConfig: {
				logging: {
					level: "debug",
				},
				rotom_api: {
					base_url: "https://file.example.com",
				},
			},
		}) as {
			logLevel: string;
			rotomApiBaseUrl: string;
		};

		expect(config).toMatchObject({
			logLevel: "trace",
			rotomApiBaseUrl: "https://env.example.com/",
		});
	});
});
