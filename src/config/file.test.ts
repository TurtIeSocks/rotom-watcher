import { describe, expect, test } from "bun:test";

import {
	createConfigWatchHandler,
	loadTomlConfig,
	resolveConfigPath,
} from "./file";

describe("resolveConfigPath", () => {
	test("uses ROTOM_CONFIG_PATH when provided", () => {
		const resolved = resolveConfigPath({
			ROTOM_CONFIG_PATH: "/tmp/custom.toml",
		});

		expect(resolved).toBe("/tmp/custom.toml");
	});

	test("falls back to cwd-relative config.toml when unset", () => {
		const resolved = resolveConfigPath({});

		expect(resolved.endsWith("config.toml")).toBe(true);
	});
});

describe("createConfigWatchHandler", () => {
	test("invokes the callback when the emitted filename matches", () => {
		let called = 0;
		const handler = createConfigWatchHandler("/etc/rotom/config.toml", () => {
			called++;
		});

		handler("change", "config.toml");
		expect(called).toBe(1);
	});

	test("invokes the callback when no filename is provided (rename on some platforms)", () => {
		let called = 0;
		const handler = createConfigWatchHandler("/etc/rotom/config.toml", () => {
			called++;
		});

		handler("rename", null);
		expect(called).toBe(1);
	});

	test("ignores events for unrelated files", () => {
		let called = 0;
		const handler = createConfigWatchHandler("/etc/rotom/config.toml", () => {
			called++;
		});

		handler("change", "other.toml");
		expect(called).toBe(0);
	});
});

describe("loadTomlConfig", () => {
	test("parses TOML from the provided reader", () => {
		const result = loadTomlConfig("/irrelevant.toml", () => 'a = "b"\n');

		expect(result).toEqual({ a: "b" });
	});

	test("wraps reader errors with context", () => {
		expect(() =>
			loadTomlConfig("/missing.toml", () => {
				throw new Error("ENOENT: not found");
			}),
		).toThrow(
			/Failed to load TOML config at \/missing\.toml: ENOENT: not found/,
		);
	});

	test("wraps non-Error throwables from the reader", () => {
		expect(() =>
			loadTomlConfig("/missing.toml", () => {
				// biome-ignore lint/suspicious/noExplicitAny: intentional non-Error throw for coverage
				throw "disk offline" as any;
			}),
		).toThrow(/Failed to load TOML config at \/missing\.toml: disk offline/);
	});

	test("wraps parser errors from malformed TOML", () => {
		expect(() =>
			loadTomlConfig("/bad.toml", () => "not = toml = at all"),
		).toThrow(/Failed to load TOML config at \/bad\.toml/);
	});
});
