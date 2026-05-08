import { describe, expect, test } from "bun:test";

import type { Config } from "./schema";
import { createConfig } from "./schema";

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

	test("defaults scriptNew to -new and scriptUpdateAll to -u", () => {
		const config = createConfigFromSources({
			env: {},
			fileConfig: {
				rotom_api: {
					base_url: "https://example.com",
				},
			},
		}) as {
			scriptNew: string;
			scriptUpdateAll: string;
		};

		expect(config.scriptNew).toBe("-new");
		expect(config.scriptUpdateAll).toBe("-u");
	});

	test("env vars override TOML for scriptNew and scriptUpdateAll", () => {
		const config = createConfigFromSources({
			env: {
				ROTOM_API_BASE_URL: "https://example.com",
				SCRIPT_NEW_ARG: "-bootstrap",
				SCRIPT_UPDATE_ALL_ARG: "-update-all",
			},
			fileConfig: {
				scripts: {
					new_arg: "-from-file",
					update_all_arg: "-from-file",
				},
			},
		}) as {
			scriptNew: string;
			scriptUpdateAll: string;
		};

		expect(config.scriptNew).toBe("-bootstrap");
		expect(config.scriptUpdateAll).toBe("-update-all");
	});

	test("rejects empty SCRIPT_NEW_ARG and SCRIPT_UPDATE_ALL_ARG", () => {
		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://example.com" },
				fileConfig: {
					scripts: {
						new_arg: "",
					},
				},
			}),
		).toThrow(/SCRIPT_NEW_ARG/);

		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://example.com" },
				fileConfig: {
					scripts: {
						update_all_arg: "",
					},
				},
			}),
		).toThrow(/SCRIPT_UPDATE_ALL_ARG/);
	});

	test("defaults webhooks block to disabled", () => {
		const config = createConfigFromSources({
			env: {
				ROTOM_API_BASE_URL: "https://rotom.example.com",
			},
		}) as unknown as Config;
		expect(config.webhooks.discordUrls).toEqual([]);
		expect(config.webhooks.events.size).toBe(0);
		expect(config.webhooks.coalesceWindowMs).toBe(10_000);
		expect(config.webhooks.retryAttempts).toBe(3);
		expect(config.webhooks.username).toBe("rotom-watcher");
	});

	test("parses webhook config from TOML file shape", () => {
		const config = createConfigFromSources({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: {
					avatar_url: "https://cdn.example.com/avatar.png",
					coalesce_window_ms: 5000,
					discord: ["https://discord.com/api/webhooks/A/secret"],
					events: ["origin.offline.update", "script.failed"],
					mention_role_id: "1234567890",
					retry_attempts: 5,
					retry_initial_delay_ms: 250,
					username: "rotom",
				},
			},
		}) as unknown as Config;
		expect(config.webhooks.discordUrls).toEqual([
			"https://discord.com/api/webhooks/A/secret",
		]);
		expect(config.webhooks.events.has("origin.offline.update")).toBe(true);
		expect(config.webhooks.events.has("script.failed")).toBe(true);
		expect(config.webhooks.events.size).toBe(2);
		expect(config.webhooks.mentionRoleId).toBe("1234567890");
		expect(config.webhooks.coalesceWindowMs).toBe(5000);
		expect(config.webhooks.retryAttempts).toBe(5);
		expect(config.webhooks.retryInitialDelayMs).toBe(250);
		expect(config.webhooks.username).toBe("rotom");
		expect(config.webhooks.avatarUrl).toBe(
			"https://cdn.example.com/avatar.png",
		);
	});

	test("splits comma-separated WEBHOOKS_DISCORD env into array", () => {
		const config = createConfigFromSources({
			env: {
				ROTOM_API_BASE_URL: "https://rotom.example.com",
				WEBHOOKS_DISCORD:
					"https://discord.com/api/webhooks/A,https://discord.com/api/webhooks/B",
			},
		}) as unknown as Config;
		expect(config.webhooks.discordUrls).toEqual([
			"https://discord.com/api/webhooks/A",
			"https://discord.com/api/webhooks/B",
		]);
	});

	test("splits comma-separated WEBHOOKS_EVENTS env into Set", () => {
		const config = createConfigFromSources({
			env: {
				ROTOM_API_BASE_URL: "https://rotom.example.com",
				WEBHOOKS_EVENTS: "origin.recovered,script.succeeded",
			},
		}) as unknown as Config;
		expect(config.webhooks.events.has("origin.recovered")).toBe(true);
		expect(config.webhooks.events.has("script.succeeded")).toBe(true);
	});

	test("rejects unknown event name", () => {
		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
				fileConfig: {
					webhooks: { events: ["origin.exploded"] },
				},
			}),
		).toThrow();
	});

	test("rejects non-HTTPS Discord URL", () => {
		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
				fileConfig: {
					webhooks: { discord: ["http://discord.com/api/webhooks/X"] },
				},
			}),
		).toThrow();
	});

	test("rejects non-snowflake mention_role_id", () => {
		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
				fileConfig: {
					webhooks: { mention_role_id: "not-a-snowflake" },
				},
			}),
		).toThrow();
	});

	test("accepts coalesce_window_ms = 0 (disabled)", () => {
		const config = createConfigFromSources({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { coalesce_window_ms: 0 },
			},
		}) as unknown as Config;
		expect(config.webhooks.coalesceWindowMs).toBe(0);
	});

	test("rejects non-HTTPS Discord URL in comma-split env var", () => {
		expect(() =>
			createConfigFromSources({
				env: {
					ROTOM_API_BASE_URL: "https://rotom.example.com",
					WEBHOOKS_DISCORD: "http://discord.com/api/webhooks/X",
				},
			}),
		).toThrow();
	});

	test("accepts WEBHOOKS_USERNAME at the 80-character boundary", () => {
		const config = createConfigFromSources({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { username: "x".repeat(80) },
			},
		}) as unknown as Config;
		expect(config.webhooks.username.length).toBe(80);
	});

	test("rejects WEBHOOKS_USERNAME at 81 characters", () => {
		expect(() =>
			createConfigFromSources({
				env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
				fileConfig: {
					webhooks: { username: "x".repeat(81) },
				},
			}),
		).toThrow();
	});

	test("accepts empty mention_role_id from file config", () => {
		const config = createConfigFromSources({
			env: { ROTOM_API_BASE_URL: "https://rotom.example.com" },
			fileConfig: {
				webhooks: { mention_role_id: "" },
			},
		}) as unknown as Config;
		expect(config.webhooks.mentionRoleId).toBe("");
	});
});
