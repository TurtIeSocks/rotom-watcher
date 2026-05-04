import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Config, ConfigProvider } from "../config/schema";
import type { ScriptMode } from "../monitor/types";
import type { LoggerLike } from "../observability/logger";
import { Metrics } from "../observability/metrics";
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
	scriptKillGracePeriodMs: 1_000,
	scriptNew: "-new",
	scriptPath,
	scriptRestart: "-rsc",
	scriptTimeoutMs: 50,
	scriptUpdate: "-usc",
	scriptUpdateAll: "-u",
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

	test("escalates to SIGKILL and abandons the child when SIGTERM and SIGKILL are ignored", async () => {
		const killCalls: Array<string | number | undefined> = [];
		const warnLogs: CapturedLog[] = [];
		const errorLogs: CapturedLog[] = [];

		const fakeSpawn = (() => {
			const child = new EventEmitter() as EventEmitter & {
				stderr: EventEmitter;
				stdout: EventEmitter;
				kill: (signal?: string | number) => boolean;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			// Intentionally do nothing on kill — simulates a child that
			// ignores both SIGTERM and SIGKILL.
			child.kill = (signal?: string | number) => {
				killCalls.push(signal);
				return true;
			};
			return child;
		}) as unknown as typeof import("node:child_process").spawn;

		const logs: CapturedLog[] = [];
		const logger: LoggerLike = {
			debug: (...args: unknown[]) => logs.push({ args, level: "debug" }),
			error: (...args: unknown[]) => {
				const entry: CapturedLog = { args, level: "error" };
				logs.push(entry);
				errorLogs.push(entry);
			},
			info: (...args: unknown[]) => logs.push({ args, level: "info" }),
			warn: (...args: unknown[]) => {
				const entry: CapturedLog = { args, level: "warn" };
				logs.push(entry);
				warnLogs.push(entry);
			},
		};

		const config: Config = {
			...createConfig("/tmp/ignored.sh"),
			maxRetries: 0,
			scriptTimeoutMs: 20,
			scriptKillGracePeriodMs: 1_000, // clamped floor in runner
		};
		// Override the min-floor by keeping it at 1000ms via config; the
		// runner uses Math.max(1000, config). We rely on the built-in floor.

		const runner = new ScriptRunner(
			createConfigProvider(config),
			logger,
			new Metrics(),
			async () => undefined,
			() => 0,
			fakeSpawn,
		);

		await expect(runner.execute("alpha", "restart")).rejects.toMatchObject({
			reason: "timeout",
		});

		expect(killCalls).toContain("SIGTERM");
		expect(killCalls).toContain("SIGKILL");
		expect(
			warnLogs.some((entry) => {
				const details = entry.args[1] as string | undefined;
				return typeof details === "string" && details.includes("SIGKILL");
			}),
		).toBe(true);
		expect(
			errorLogs.some((entry) => {
				const msg = entry.args[1] as string | undefined;
				return typeof msg === "string" && msg.includes("abandoning child");
			}),
		).toBe(true);
	}, 10_000);

	test("settles the promise when the child exits naturally after SIGTERM", async () => {
		const killCalls: string[] = [];
		let closeHandler:
			| ((code: number | null, signal: NodeJS.Signals | null) => void)
			| undefined;

		const fakeSpawn = (() => {
			const child = new EventEmitter() as EventEmitter & {
				stderr: EventEmitter;
				stdout: EventEmitter;
				kill: (signal?: string) => boolean;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = (signal?: string) => {
				killCalls.push(signal ?? "unknown");
				// Simulate the child exiting promptly on SIGTERM by firing
				// `close` on the next tick.
				if (signal === "SIGTERM") {
					queueMicrotask(() => {
						closeHandler?.(null, "SIGTERM" as NodeJS.Signals);
					});
				}
				return true;
			};

			const origOn = child.on.bind(child);
			child.on = ((event: string, handler: (...args: unknown[]) => void) => {
				if (event === "close") {
					closeHandler = handler as typeof closeHandler;
				}
				return origOn(event, handler);
			}) as typeof child.on;

			return child;
		}) as unknown as typeof import("node:child_process").spawn;

		const runner = new ScriptRunner(
			createConfigProvider({
				...createConfig("/tmp/ignored.sh"),
				maxRetries: 0,
				scriptTimeoutMs: 10,
			}),
			createLogger([]),
			new Metrics(),
			async () => undefined,
			() => 0,
			fakeSpawn,
		);

		// Child exits due to SIGTERM -> `close` fires with a signal,
		// handled as a "signal" failure.
		await expect(runner.execute("alpha", "restart")).rejects.toMatchObject({
			reason: "timeout",
		});

		expect(killCalls[0]).toBe("SIGTERM");
		// SIGKILL should never be sent because the child exited first.
		expect(killCalls).not.toContain("SIGKILL");
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

	test("executeGroupPipeline runs -new then -u in sequence", async () => {
		const calls: Array<{ origin: string; scriptMode: ScriptMode }> = [];
		const runner = new ScriptRunner(
			createConfigProvider(createConfig("/tmp/ignored.sh")),
			createLogger([]),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		(
			runner as unknown as {
				execute: (origin: string, scriptMode: ScriptMode) => Promise<void>;
			}
		).execute = async (origin: string, scriptMode: ScriptMode) => {
			calls.push({ origin, scriptMode });
		};

		await runner.executeGroupPipeline("x");

		expect(calls).toEqual([
			{ origin: "x", scriptMode: "new" },
			{ origin: "x", scriptMode: "update_all" },
		]);
	});

	test("executeGroupPipeline aborts and rejects when -new fails", async () => {
		const calls: Array<{ origin: string; scriptMode: ScriptMode }> = [];
		const runner = new ScriptRunner(
			createConfigProvider(createConfig("/tmp/ignored.sh")),
			createLogger([]),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		(
			runner as unknown as {
				execute: (origin: string, scriptMode: ScriptMode) => Promise<void>;
			}
		).execute = async (origin: string, scriptMode: ScriptMode) => {
			calls.push({ origin, scriptMode });
			if (scriptMode === "new") {
				throw new ScriptExecutionError("boom", "exit_code");
			}
		};

		await expect(runner.executeGroupPipeline("x")).rejects.toBeInstanceOf(
			ScriptExecutionError,
		);

		expect(calls).toEqual([{ origin: "x", scriptMode: "new" }]);
	});

	test("executeGroupPipeline rejects when -new succeeds but -u fails", async () => {
		const calls: Array<{ origin: string; scriptMode: ScriptMode }> = [];
		const runner = new ScriptRunner(
			createConfigProvider(createConfig("/tmp/ignored.sh")),
			createLogger([]),
			new Metrics(),
			async () => undefined,
			() => 0,
		);

		(
			runner as unknown as {
				execute: (origin: string, scriptMode: ScriptMode) => Promise<void>;
			}
		).execute = async (origin: string, scriptMode: ScriptMode) => {
			calls.push({ origin, scriptMode });
			if (scriptMode === "update_all") {
				throw new ScriptExecutionError("update failed", "timeout");
			}
		};

		await expect(runner.executeGroupPipeline("x")).rejects.toMatchObject({
			reason: "timeout",
		});

		expect(calls).toEqual([
			{ origin: "x", scriptMode: "new" },
			{ origin: "x", scriptMode: "update_all" },
		]);
	});
});

const createConfigProvider = (config: Config): ConfigProvider => ({
	getConfig: () => config,
});
