import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Config, ConfigProvider } from "./config";
import type { LoggerLike } from "./logger";
import { Metrics } from "./metrics";
import { ScriptExecutionError, ScriptRunner } from "./script-runner";

interface CapturedLog {
	args: unknown[];
	level: "debug" | "error" | "info" | "warn";
}

const createLogger = (logs: CapturedLog[]): LoggerLike => ({
	debug: (...args: unknown[]) => {
		logs.push({
			args,
			level: "debug",
		});
	},
	error: (...args: unknown[]) => {
		logs.push({
			args,
			level: "error",
		});
	},
	info: (...args: unknown[]) => {
		logs.push({
			args,
			level: "info",
		});
	},
	warn: (...args: unknown[]) => {
		logs.push({
			args,
			level: "warn",
		});
	},
});

const writeExecutable = (
	directory: string,
	name: string,
	contents: string,
): string => {
	const filePath = path.join(directory, name);
	writeFileSync(filePath, contents, "utf8");
	chmodSync(filePath, 0o755);
	return filePath;
};

const createConfig = (scriptPath: string): Config => ({
	checkIntervalMs: 60_000,
	circuitBreakerResetMs: 60_000,
	circuitBreakerThreshold: 5,
	deviceTimeoutMinutes: 10,
	fetchTimeoutMs: 1_000,
	initialRetryDelayMs: 10,
	logFormat: "json",
	logLevel: "info",
	maxConcurrentJobs: 2,
	maxRetries: 1,
	maxRetryDelayMs: 20,
	metricsHost: "127.0.0.1",
	metricsPort: 9_090,
	restartThreshold: 2,
	rotomApiBaseUrl: "https://example.com/",
	scriptPath,
	scriptRestart: "-rsc",
	scriptTimeoutMs: 50,
	scriptUpdate: "-usc",
	shutdownGracePeriodMs: 500,
});

describe("ScriptRunner", () => {
	test("retries a failed script and eventually succeeds", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-script-runner-"));
		const attemptsFile = path.join(directory, "attempts.txt");
		const scriptPath = writeExecutable(
			directory,
			"retry.sh",
			`#!/usr/bin/env bash
count=0
if [ -f "${attemptsFile}" ]; then
  count=$(cat "${attemptsFile}")
fi
count=$((count + 1))
echo "$count" > "${attemptsFile}"
if [ "$count" -lt 2 ]; then
  echo "failing first attempt" >&2
  exit 1
fi
echo "recovered"
`,
		);
		const logs: CapturedLog[] = [];
		const runner = new ScriptRunner(
			createConfigProvider(createConfig(scriptPath)),
			createLogger(logs),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		await runner.execute("alpha", "restart");

		expect(readFileSync(attemptsFile, "utf8").trim()).toBe("2");
		expect(logs.some((entry) => entry.level === "warn")).toBe(true);
	});

	test("classifies script timeouts", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-script-runner-"));
		const scriptPath = writeExecutable(
			directory,
			"timeout.sh",
			`#!/usr/bin/env bash
sleep 1
`,
		);
		const runner = new ScriptRunner(
			createConfigProvider(createConfig(scriptPath)),
			createLogger([]),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		const execution = runner.execute("alpha", "restart");

		await expect(execution).rejects.toBeInstanceOf(ScriptExecutionError);
		await expect(execution).rejects.toMatchObject({
			reason: "timeout",
		});
	});

	test("truncates verbose stderr output in logs", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "rotom-script-runner-"));
		const scriptPath = writeExecutable(
			directory,
			"stderr.sh",
			`#!/usr/bin/env bash
perl -e 'print "x" x 5005' >&2
exit 1
`,
		);
		const logs: CapturedLog[] = [];
		const runner = new ScriptRunner(
			createConfigProvider(createConfig(scriptPath)),
			createLogger(logs),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		await expect(runner.execute("alpha", "restart")).rejects.toMatchObject({
			reason: "exit_code",
		});

		const errorLog = logs.find((entry) => entry.level === "error");
		const details = errorLog?.args[0] as { stderr?: string } | undefined;

		expect(details?.stderr).toContain("[truncated");
	});

	test("classifies child process spawn failures", async () => {
		const logs: CapturedLog[] = [];
		const failingSpawn = (() => {
			const child = new EventEmitter() as EventEmitter & {
				stderr: EventEmitter;
				stdout: EventEmitter;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();

			queueMicrotask(() => {
				child.emit("error", new Error("spawn failed"));
			});

			return child;
		}) as unknown as typeof import("node:child_process").spawn;

		const runner = new ScriptRunner(
			createConfigProvider(createConfig("/tmp/test-script.sh")),
			createLogger(logs),
			new Metrics(),
			async () => undefined,
			() => 0,
			failingSpawn,
		);

		await expect(runner.execute("alpha", "restart")).rejects.toMatchObject({
			reason: "spawn_error",
		});
	});
});

const createConfigProvider = (config: Config): ConfigProvider => ({
	getConfig: () => config,
});
