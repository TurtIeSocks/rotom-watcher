import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoggerLike } from "./logger";
import { ConfigManager } from "./config";

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
});
