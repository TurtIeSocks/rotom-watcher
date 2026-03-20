import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoggerLike } from "../observability/logger";
import { createConfigWatchHandler, resolveConfigPath } from "./file";
import { ConfigManager } from "./manager";

interface WatcherLike {
	close(): void;
}

type WatchCallback = () => void;

const logger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const baseToml = `
[rotom_api]
base_url = "https://file.example.com"

[logging]
level = "info"
`;

describe("ConfigManager", () => {
	test("loads initial config from TOML and applies environment overrides", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");

		const manager = new ConfigManager({
			configPath,
			env: {
				LOG_LEVEL: "debug",
			},
			logger,
		});

		expect(manager.getConfig()).toMatchObject({
			logLevel: "debug",
			rotomApiBaseUrl: "https://file.example.com/",
		});
	});

	test("reloads config when the watched file changes", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");

		let watchCallback: WatchCallback | undefined;
		const manager = new ConfigManager({
			configPath,
			env: {},
			logger,
			scheduleReload: (reload) => {
				reload();
				return 1;
			},
			watchImplementation: (_path, callback) => {
				watchCallback = callback;
				return {
					close: () => undefined,
				} satisfies WatcherLike;
			},
		});

		manager.startWatching();

		writeFileSync(
			configPath,
			`
[rotom_api]
base_url = "https://updated.example.com"

[logging]
level = "trace"
`,
			"utf8",
		);

		watchCallback?.();

		expect(manager.getConfig()).toMatchObject({
			logLevel: "trace",
			rotomApiBaseUrl: "https://updated.example.com/",
		});
	});

	test("does not notify listeners when a reload changes nothing", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");
		let notifications = 0;

		const manager = new ConfigManager({
			configPath,
			env: {},
			logger,
		});

		manager.subscribe(() => {
			notifications++;
		});

		expect(manager.reloadFromDisk()).toBe(true);
		expect(notifications).toBe(0);
	});

	test("keeps the last known good config when a reload is invalid", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");

		let watchCallback: WatchCallback | undefined;
		const manager = new ConfigManager({
			configPath,
			env: {},
			logger,
			scheduleReload: (reload) => {
				reload();
				return 1;
			},
			watchImplementation: (_path, callback) => {
				watchCallback = callback;
				return {
					close: () => undefined,
				} satisfies WatcherLike;
			},
		});

		manager.startWatching();

		const initialConfig = manager.getConfig();

		writeFileSync(
			configPath,
			`
[logging]
level = "trace"
`,
			"utf8",
		);

		watchCallback?.();

		expect(manager.getConfig()).toEqual(initialConfig);
	});

	test("close cancels pending reloads and closes the watcher", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");

		let cancelled = false;
		let closeCalls = 0;
		let watchCallback: WatchCallback | undefined;
		const manager = new ConfigManager({
			cancelScheduledReload: () => {
				cancelled = true;
			},
			configPath,
			env: {},
			logger,
			scheduleReload: () => 123,
			watchImplementation: (_path, callback) => {
				watchCallback = callback;
				return {
					close: () => {
						closeCalls++;
					},
				} satisfies WatcherLike;
			},
		});

		manager.startWatching();
		watchCallback?.();
		manager.close();

		expect(cancelled).toBe(true);
		expect(closeCalls).toBe(1);
	});

	test("supports updating the logger and unsubscribing listeners", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");
		let notifications = 0;
		const manager = new ConfigManager({
			configPath,
			env: {},
			logger,
		});

		manager.setLogger(logger);
		const unsubscribe = manager.subscribe(() => {
			notifications++;
		});

		unsubscribe();
		manager.reloadFromDisk();

		expect(notifications).toBe(0);
	});

	test("filters watch events to the config file and unnamed events", () => {
		let reloads = 0;
		const handleWatchEvent = createConfigWatchHandler(
			"/tmp/rotom/config.toml",
			() => {
				reloads++;
			},
		);

		handleWatchEvent("change", "other.toml");
		expect(reloads).toBe(0);

		handleWatchEvent("change", "config.toml");
		handleWatchEvent("rename", null);

		expect(reloads).toBe(2);
	});

	test("can start and stop watching with the default watcher", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-config-manager-"));
		const configPath = path.join(directory, "config.toml");
		writeFileSync(configPath, baseToml, "utf8");

		const manager = new ConfigManager({
			configPath,
			env: {},
			logger,
		});

		manager.startWatching();
		manager.close();

		expect(manager.getConfig().rotomApiBaseUrl).toBe(
			"https://file.example.com/",
		);
	});

	test("resolves the default and overridden config path", () => {
		expect(resolveConfigPath({})).toBe(path.resolve(process.cwd(), "config.toml"));
		expect(
			resolveConfigPath({
				ROTOM_CONFIG_PATH: "./deploy/rotom.toml",
			}),
		).toBe(path.resolve("./deploy/rotom.toml"));
	});
});
