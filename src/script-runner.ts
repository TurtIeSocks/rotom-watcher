import { spawn } from "node:child_process";

import type { Config } from "./config";
import type { LoggerLike } from "./logger";
import type { Metrics, ScriptFailureReason } from "./metrics";
import type { ScriptMode } from "./types";
import {
	calculateRetryDelay,
	sanitizeOrigin,
	sleep,
	truncateOutput,
} from "./utils";

export class ScriptExecutionError extends Error {
	constructor(
		message: string,
		public readonly reason: ScriptFailureReason,
	) {
		super(message);
		this.name = "ScriptExecutionError";
	}
}

export class ScriptRunner {
	constructor(
		private readonly config: Config,
		private readonly logger: LoggerLike,
		private readonly metrics: Metrics,
		private readonly sleepFn: typeof sleep = sleep,
		private readonly random: () => number = Math.random,
	) {}

	async execute(
		origin: string,
		scriptMode: ScriptMode,
		attempt = 0,
	): Promise<void> {
		const sanitizedOrigin = sanitizeOrigin(origin);
		const scriptArg = this.resolveScriptArg(scriptMode);
		const commandArgs = [this.config.scriptPath, scriptArg, sanitizedOrigin];
		const startTime = Date.now();

		this.metrics.recordScriptAttempt(scriptMode);

		if (sanitizedOrigin !== origin) {
			this.logger.warn(
				{
					origin,
					sanitizedOrigin,
				},
				"Sanitized unsafe origin before script execution",
			);
		}

		this.logger.info(
			{
				attempt: attempt + 1,
				maxAttempts: this.config.maxRetries + 1,
				origin: sanitizedOrigin,
				scriptMode,
			},
			"Executing recovery script",
		);

		try {
			await this.runCommand(
				commandArgs,
				sanitizedOrigin,
				scriptMode,
				startTime,
			);
		} catch (error) {
			if (attempt >= this.config.maxRetries) {
				throw error;
			}

			const delay = calculateRetryDelay(
				attempt,
				this.config.initialRetryDelayMs,
				this.config.maxRetryDelayMs,
				0.2,
				this.random,
			);

			this.metrics.recordScriptRetry(scriptMode);
			this.logger.warn(
				{
					attempt: attempt + 1,
					delay,
					origin: sanitizedOrigin,
					scriptMode,
				},
				"Retrying failed recovery script",
			);

			await this.sleepFn(delay);
			await this.execute(origin, scriptMode, attempt + 1);
		}
	}

	private resolveScriptArg(scriptMode: ScriptMode): string {
		return scriptMode === "update"
			? this.config.scriptUpdate
			: this.config.scriptRestart;
	}

	private runCommand(
		commandArgs: string[],
		origin: string,
		scriptMode: ScriptMode,
		startTime: number,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let completed = false;
			let stdout = "";
			let stderr = "";
			let spawnFailed = false;
			let timeoutTriggered = false;

			const child = spawn("bash", commandArgs, {
				stdio: ["ignore", "pipe", "pipe"],
			});

			const timeoutId = setTimeout(() => {
				timeoutTriggered = true;
				child.kill("SIGTERM");
			}, this.config.scriptTimeoutMs);

			child.stdout.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});

			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});

			child.on("error", (error) => {
				spawnFailed = true;
				if (completed) {
					return;
				}

				completed = true;
				clearTimeout(timeoutId);
				reject(
					this.handleFailure(origin, scriptMode, startTime, "spawn_error", {
						error,
						stderr,
						stdout,
					}),
				);
			});

			child.on("close", (code, signal) => {
				if (completed) {
					return;
				}

				completed = true;
				clearTimeout(timeoutId);

				if (timeoutTriggered) {
					reject(
						this.handleFailure(origin, scriptMode, startTime, "timeout", {
							code,
							signal,
							stderr,
							stdout,
						}),
					);
					return;
				}

				if (spawnFailed) {
					return;
				}

				if (signal) {
					reject(
						this.handleFailure(origin, scriptMode, startTime, "signal", {
							code,
							signal,
							stderr,
							stdout,
						}),
					);
					return;
				}

				if (code !== 0) {
					reject(
						this.handleFailure(origin, scriptMode, startTime, "exit_code", {
							code,
							signal,
							stderr,
							stdout,
						}),
					);
					return;
				}

				const durationMs = Date.now() - startTime;
				const trimmedStdout = truncateOutput(stdout.trim());
				const trimmedStderr = truncateOutput(stderr.trim());

				if (trimmedStdout.length > 0) {
					this.logger.debug(
						{
							origin,
							stdout: trimmedStdout,
						},
						"Recovery script stdout",
					);
				}

				if (trimmedStderr.length > 0) {
					this.logger.debug(
						{
							origin,
							stderr: trimmedStderr,
						},
						"Recovery script stderr",
					);
				}

				this.metrics.recordScriptSuccess(scriptMode, durationMs);
				this.logger.info(
					{
						durationMs,
						origin,
						scriptMode,
					},
					"Recovery script completed",
				);
				resolve();
			});
		});
	}

	private handleFailure(
		origin: string,
		scriptMode: ScriptMode,
		startTime: number,
		reason: ScriptFailureReason,
		details: {
			code?: number | null;
			error?: Error;
			signal?: NodeJS.Signals | null;
			stderr: string;
			stdout: string;
		},
	): ScriptExecutionError {
		const durationMs = Date.now() - startTime;
		const stdout = truncateOutput(details.stdout.trim());
		const stderr = truncateOutput(details.stderr.trim());

		this.metrics.recordScriptFailure(scriptMode, durationMs, reason);
		this.logger.error(
			{
				code: details.code ?? null,
				durationMs,
				error: details.error?.message,
				origin,
				reason,
				scriptMode,
				signal: details.signal ?? null,
				stderr: stderr || undefined,
				stdout: stdout || undefined,
			},
			"Recovery script failed",
		);

		const message =
			reason === "timeout"
				? `Recovery script timed out after ${this.config.scriptTimeoutMs}ms`
				: (details.error?.message ??
					`Recovery script failed with reason ${reason}`);

		return new ScriptExecutionError(message, reason);
	}
}
