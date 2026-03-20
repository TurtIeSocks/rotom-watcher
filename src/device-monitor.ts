import type { CircuitBreaker } from "./circuit-breaker";
import type { Config } from "./config";
import { evaluateDevices } from "./device-evaluation";
import type { JobQueue } from "./job-queue";
import type { LoggerLike } from "./logger";
import type { Metrics } from "./metrics";
import type { OriginStateTracker } from "./origin-state";
import type { RotomApiClient } from "./rotom-api";
import type { ScriptRunner } from "./script-runner";
import { sleep } from "./utils";

export interface DeviceMonitorDependencies {
	circuitBreaker: CircuitBreaker;
	config: Config;
	jobQueue: JobQueue;
	logger: LoggerLike;
	metrics: Metrics;
	now?: () => number;
	originStateTracker: OriginStateTracker;
	scriptRunner: ScriptRunner;
	statusApiClient: RotomApiClient;
}

export class DeviceMonitor {
	private intervalId?: ReturnType<typeof setInterval>;
	private running = false;
	private shutdownRequested = false;

	constructor(private readonly dependencies: DeviceMonitorDependencies) {}

	start(): void {
		const { config, logger } = this.dependencies;

		logger.info("=".repeat(80));
		logger.info("Device Monitor Starting");
		logger.info("=".repeat(80));
		logger.info("Configuration:", JSON.stringify(config, null, 2));
		logger.info("Endpoint:", config.endpoint);
		logger.info("Script path:", config.scriptPath);
		logger.info("=".repeat(80));

		this.registerProcessHandlers();

		void this.checkAndRunScript().then(() => {
			if (!this.shutdownRequested) {
				this.intervalId = setInterval(
					() => void this.checkAndRunScript(),
					config.checkIntervalMs,
				);
				logger.info(
					`Scheduled checks every ${config.checkIntervalMs / 1000} seconds`,
				);
			}
		});
	}

	async checkAndRunScript(): Promise<void> {
		const {
			circuitBreaker,
			config,
			jobQueue,
			logger,
			metrics,
			now = Date.now,
			originStateTracker,
			scriptRunner,
			statusApiClient,
		} = this.dependencies;

		if (this.running) {
			logger.debug("Check already running, skipping...");
			return;
		}

		if (!circuitBreaker.canExecute()) {
			logger.warn("Circuit breaker is OPEN, skipping check");
			return;
		}

		this.running = true;
		const checkStartTime = now();

		try {
			logger.info("Starting device check...");

			const { devices, workers } = await statusApiClient.fetchStatus();

			metrics.recordApiSuccess();
			circuitBreaker.recordSuccess();

			logger.info(`Found ${devices.length} devices`);

			const { devicesToProcess, onlineOrigins } = evaluateDevices({
				currentTimeMs: now(),
				deviceTimeoutMinutes: config.deviceTimeoutMinutes,
				devices,
				workers,
			});

			originStateTracker.cleanupOnlineOrigins(onlineOrigins);

			if (devicesToProcess.length > 0) {
				logger.info(
					`Queuing ${devicesToProcess.length} device(s) for script execution`,
				);

				const jobs = devicesToProcess.map(async (device) => {
					const state = originStateTracker.recordOfflineAttempt(device.origin);
					const args = originStateTracker.getScriptArgs(device.origin);

					logger.info(
						`[${device.origin}] Last seen ${device.timeDifference} minutes ago, offline count: ${state.successiveOfflineCount}, using: ${args}`,
					);

					return jobQueue
						.add(() => scriptRunner.execute(device.origin, args), device.origin)
						.catch((error: unknown) => {
							const message =
								error instanceof Error ? error.message : String(error);
							logger.error(
								`[${device.origin}] Final failure after all retries:`,
								message,
							);
						});
				});

				await Promise.allSettled(jobs);

				logger.info(
					`All scripts completed. Queue status: ${JSON.stringify(jobQueue.getStatus())}`,
				);
			} else {
				logger.info("No devices require script execution");
			}

			logger.info(`Check completed in ${now() - checkStartTime}ms`);
			this.logStats();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Check failed: ${message}`);
			metrics.recordApiFailure();
			circuitBreaker.recordFailure();
		} finally {
			this.running = false;
		}
	}

	private logStats(): void {
		const { logger, metrics, originStateTracker } = this.dependencies;

		logger.info("Metrics:", JSON.stringify(metrics.getStats(), null, 2));
		logger.info(
			"Origin State:",
			JSON.stringify(originStateTracker.getStats(), null, 2),
		);
	}

	private registerProcessHandlers(): void {
		const { logger } = this.dependencies;

		process.on("SIGINT", () => {
			void this.gracefulShutdown("SIGINT");
		});

		process.on("SIGTERM", () => {
			void this.gracefulShutdown("SIGTERM");
		});

		process.on("uncaughtException", (error) => {
			logger.error("Uncaught exception:", error);
			void this.gracefulShutdown("uncaughtException");
		});

		process.on("unhandledRejection", (reason, promise) => {
			logger.error("Unhandled rejection at:", promise, "reason:", reason);
		});
	}

	private async gracefulShutdown(signal: string): Promise<void> {
		const { jobQueue, logger } = this.dependencies;

		logger.info(`Received ${signal}, initiating graceful shutdown...`);
		this.shutdownRequested = true;

		if (this.intervalId) {
			clearInterval(this.intervalId);
		}

		let waitCount = 0;
		while (this.running && waitCount < 60) {
			logger.info("Waiting for current check to complete...");
			await sleep(1_000);
			waitCount++;
		}

		waitCount = 0;
		while (jobQueue.getStatus().running > 0 && waitCount < 60) {
			const status = jobQueue.getStatus();
			logger.info(
				`Waiting for ${status.running} running job(s) to complete...`,
			);
			await sleep(1_000);
			waitCount++;
		}

		logger.info("Final metrics:");
		this.logStats();

		logger.info("Shutdown complete");
		process.exit(0);
	}
}
