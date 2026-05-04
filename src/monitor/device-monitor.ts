import type { ConfigProvider } from "../config/schema";
import type { LoggerLike } from "../observability/logger";
import type { Metrics } from "../observability/metrics";
import type { RotomApiClient } from "../rotom/client";
import type { CircuitBreaker } from "../runtime/circuit-breaker";
import type { JobQueue } from "../runtime/job-queue";
import type { ScriptRunner } from "../runtime/script-runner";
import { sleep } from "../shared/utils";
import { evaluateDevices } from "./device-evaluation";
import type { OriginStateTracker } from "./origin-state";

export interface DeviceMonitorDependencies {
	circuitBreaker: CircuitBreaker;
	/**
	 * Optional dedicated breaker for delete-device calls. Keeping this
	 * separate from the fetch-status breaker means a flaky deletion endpoint
	 * does not block fetches and, crucially, a tripped fetch-status breaker
	 * opening due to e.g. a transient read timeout does not permanently
	 * suppress deletion attempts: once a poll manages to fetch status, any
	 * dead duplicates observed will be attempted as long as the deletion
	 * breaker allows.
	 */
	deletionCircuitBreaker?: CircuitBreaker;
	configProvider: ConfigProvider;
	jobQueue: JobQueue;
	logger: LoggerLike;
	metrics: Metrics;
	now?: () => number;
	onShutdown?: (signal: string) => Promise<void> | void;
	originStateTracker: OriginStateTracker;
	scriptRunner: ScriptRunner;
	statusApiClient: RotomApiClient;
}

export class DeviceMonitor {
	private handlersRegistered = false;
	private running = false;
	private shutdownRequested = false;
	private startRequested = false;
	private stopPromise?: Promise<void>;
	private timeoutId?: ReturnType<typeof setTimeout>;

	constructor(private readonly dependencies: DeviceMonitorDependencies) {}

	start(): void {
		const { logger, metrics } = this.dependencies;
		const config = this.dependencies.configProvider.getConfig();

		if (this.startRequested) {
			logger.warn("Device monitor has already been started");
			return;
		}

		this.startRequested = true;

		logger.info(
			{
				checkIntervalMs: config.checkIntervalMs,
				deviceTimeoutMinutes: config.deviceTimeoutMinutes,
				metricsHost: config.metricsHost,
				metricsPort: config.metricsPort,
				rotomApiBaseUrl: config.rotomApiBaseUrl,
				scriptPath: config.scriptPath,
			},
			"Device monitor starting",
		);

		this.registerProcessHandlers();
		metrics.setCircuitBreakerState(this.dependencies.circuitBreaker.getState());
		metrics.updateOriginState(this.dependencies.originStateTracker.getStats());
		metrics.updateQueueStatus(this.dependencies.jobQueue.getStatus());

		this.scheduleNextCheck(0);
	}

	async checkAndRunScript(): Promise<void> {
		const {
			circuitBreaker,
			deletionCircuitBreaker,
			configProvider,
			jobQueue,
			logger,
			metrics,
			now = Date.now,
			originStateTracker,
			scriptRunner,
			statusApiClient,
		} = this.dependencies;
		const config = configProvider.getConfig();

		if (this.running) {
			logger.debug("Skipping poll because a previous poll is still running");
			return;
		}

		if (!circuitBreaker.canExecute()) {
			metrics.setCircuitBreakerState(circuitBreaker.getState());
			logger.warn("Circuit breaker is OPEN, skipping device poll");
			return;
		}

		this.running = true;
		const pollStartedAt = now();

		try {
			logger.info("Starting device poll");

			const { devices, workers } = await statusApiClient.fetchStatus();
			circuitBreaker.recordSuccess();
			metrics.setCircuitBreakerState(circuitBreaker.getState());

			const evaluation = evaluateDevices({
				currentTimeMs: now(),
				deviceTimeoutMinutes: config.deviceTimeoutMinutes,
				devices,
				workers,
			});

			originStateTracker.cleanupOnlineOrigins(evaluation.onlineOrigins);
			originStateTracker.sweepStale(now());
			metrics.updateOriginState(originStateTracker.getStats());

			const duplicateDeletions = evaluation.originDecisions.flatMap(
				(decision) => decision.deadDuplicatesToDelete,
			);

			if (duplicateDeletions.length > 0) {
				if (
					deletionCircuitBreaker &&
					!deletionCircuitBreaker.canExecute()
				) {
					logger.warn(
						{
							count: duplicateDeletions.length,
							state: deletionCircuitBreaker.getState(),
						},
						"Deletion circuit breaker OPEN; deferring dead duplicate deletions",
					);
				} else {
					logger.info(
						{
							count: duplicateDeletions.length,
						},
						"Deleting dead duplicate devices",
					);

					const deletions = duplicateDeletions.map(async (device) => {
						try {
							const deleted = await statusApiClient.deleteDevice(
								device.deviceId,
							);

							if (!deleted) {
								metrics.recordDuplicateDeletion("failure");
								deletionCircuitBreaker?.recordFailure();
								logger.warn(
									{
										deviceId: device.deviceId,
										origin: device.origin,
									},
									"Failed to delete dead duplicate device",
								);
								return;
							}

							metrics.recordDuplicateDeletion("success");
							deletionCircuitBreaker?.recordSuccess();
							logger.info(
								{
									deviceId: device.deviceId,
									origin: device.origin,
								},
								"Deleted dead duplicate device",
							);
						} catch (error: unknown) {
							metrics.recordDuplicateDeletion("failure");
							deletionCircuitBreaker?.recordFailure();
							logger.error(
								{
									deviceId: device.deviceId,
									error,
									origin: device.origin,
								},
								"Error deleting dead duplicate device",
							);
						}
					});

					await Promise.allSettled(deletions);
				}
			}

			const decisionsToProcess = evaluation.originDecisions.filter(
				(decision) => decision.shouldProcess,
			);

			if (decisionsToProcess.length === 0) {
				logger.info("No origins require script execution");
			} else {
				logger.info(
					{
						count: decisionsToProcess.length,
					},
					"Queueing offline origins for script execution",
				);

				const jobs = decisionsToProcess.map(async (decision) => {
					const offlineAttempt = originStateTracker.recordOfflineAttempt(
						decision.origin,
						now(),
					);
					metrics.updateOriginState(originStateTracker.getStats());

					logger.warn(
						{
							hasAliveDevice: decision.hasAliveDevice,
							hasWorkers: decision.hasWorkers,
							lastSeenMinutes: decision.lastSeenMinutes,
							offlineCount: offlineAttempt.state.successiveOfflineCount,
							origin: decision.origin,
							scriptMode: offlineAttempt.scriptMode,
						},
						"Scheduling recovery script for offline origin",
					);

					return jobQueue
						.add(
							() => {
								// Re-read the script mode at execution time. If the
								// job sat in the queue while subsequent polls
								// incremented the offline counter past the restart
								// threshold, we want to run the updated mode
								// (typically `update`) instead of the stale one
								// captured at queue time.
								const currentMode = originStateTracker.getScriptMode(
									decision.origin,
								);
								return scriptRunner.execute(decision.origin, currentMode);
							},
							decision.origin,
						)
						.catch((error: unknown) => {
							logger.error(
								{
									error,
									origin: decision.origin,
								},
								"Recovery script exhausted all retries",
							);
						});
				});

				await Promise.allSettled(jobs);
			}

			if (evaluation.groupDecisions.length > 0) {
				logger.warn(
					{
						count: evaluation.groupDecisions.length,
						prefixes: evaluation.groupDecisions.map((group) => group.prefix),
					},
					"Queueing fully-dead device groups for new+update_all pipeline",
				);

				const groupJobs = evaluation.groupDecisions.map((group) => {
					metrics.recordGroupPipelineTriggered(group.prefix);
					return jobQueue
						.add(
							() => scriptRunner.executeGroupPipeline(group.prefix),
							`group:${group.prefix}`,
						)
						.catch((error: unknown) => {
							logger.error(
								{
									error,
									members: group.members,
									prefix: group.prefix,
								},
								"Group pipeline exhausted retries",
							);
						});
				});

				await Promise.allSettled(groupJobs);
			}

			metrics.recordPollSuccess(now());
			logger.info(
				{
					durationMs: now() - pollStartedAt,
					originCount: evaluation.originDecisions.length,
				},
				"Device poll completed",
			);
		} catch (error) {
			circuitBreaker.recordFailure();
			metrics.setCircuitBreakerState(circuitBreaker.getState());
			logger.error(
				{
					error,
				},
				"Device poll failed",
			);
		} finally {
			metrics.recordPollDuration(now() - pollStartedAt);
			metrics.updateOriginState(originStateTracker.getStats());
			metrics.updateQueueStatus(jobQueue.getStatus());
			this.running = false;
		}
	}

	stop(signal = "manual", exitCode = 0): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}

		this.stopPromise = this.gracefulShutdown(signal, exitCode);
		return this.stopPromise;
	}

	private async gracefulShutdown(
		signal: string,
		exitCode: number,
	): Promise<void> {
		const { jobQueue, logger, metrics, onShutdown } = this.dependencies;
		const config = this.dependencies.configProvider.getConfig();

		logger.info(
			{
				exitCode,
				signal,
			},
			"Initiating graceful shutdown",
		);

		this.shutdownRequested = true;
		metrics.markShutdownRequested();
		process.exitCode = exitCode;

		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}

		const shutdownDeadline = Date.now() + config.shutdownGracePeriodMs;

		while (this.running && Date.now() < shutdownDeadline) {
			await sleep(250);
		}

		while (jobQueue.getStatus().running > 0 && Date.now() < shutdownDeadline) {
			await sleep(250);
		}

		if (onShutdown) {
			try {
				await onShutdown(signal);
			} catch (error) {
				logger.error(
					{
						error,
						signal,
					},
					"Shutdown hook failed",
				);
			}
		}

		logger.info(
			{
				queueStatus: jobQueue.getStatus(),
			},
			"Graceful shutdown completed",
		);
	}

	private registerProcessHandlers(): void {
		const { logger } = this.dependencies;

		if (this.handlersRegistered) {
			return;
		}

		this.handlersRegistered = true;

		process.once("SIGINT", () => {
			void this.stop("SIGINT", 0);
		});

		process.once("SIGTERM", () => {
			void this.stop("SIGTERM", 0);
		});

		// Stray unhandled rejections / uncaught exceptions used to trigger a
		// full shutdown here, which permanently disabled the polling loop
		// (`shutdownRequested` was sticky). A single unrelated rejection
		// anywhere in the process could therefore stop all device resets and
		// dead-device deletions. We now log loudly and keep the monitor
		// running; genuine fatal errors will still surface via logs/metrics.
		process.on("uncaughtException", (error) => {
			logger.error(
				{
					error,
				},
				"Uncaught exception (monitor continuing)",
			);
		});

		process.on("unhandledRejection", (reason) => {
			logger.error(
				{
					reason,
				},
				"Unhandled promise rejection (monitor continuing)",
			);
		});
	}

	private scheduleNextCheck(delayMs: number): void {
		if (this.shutdownRequested) {
			return;
		}

		this.timeoutId = setTimeout(() => {
			this.timeoutId = undefined;
			void this.runScheduledCheck();
		}, delayMs);
	}

	private async runScheduledCheck(): Promise<void> {
		await this.checkAndRunScript();

		if (!this.shutdownRequested) {
			this.scheduleNextCheck(
				this.dependencies.configProvider.getConfig().checkIntervalMs,
			);
		}
	}
}
