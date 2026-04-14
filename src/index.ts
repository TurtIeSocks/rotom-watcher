import { resolveConfigPath } from "./config/file";
import { ConfigManager } from "./config/manager";
import { DeviceMonitor } from "./monitor/device-monitor";
import { OriginStateTracker } from "./monitor/origin-state";
import { createLogger } from "./observability/logger";
import { Metrics } from "./observability/metrics";
import { ObservabilityServer } from "./observability/server";
import { RotomApiClient } from "./rotom/client";
import { CircuitBreaker } from "./runtime/circuit-breaker";
import { JobQueue } from "./runtime/job-queue";
import { ScriptRunner } from "./runtime/script-runner";

const configManager = new ConfigManager({
	configPath: resolveConfigPath(),
});
const initialConfig = configManager.getConfig();
const logger = createLogger({
	format: initialConfig.logFormat,
	level: initialConfig.logLevel,
});

configManager.setLogger(logger);

const metrics = new Metrics();
const circuitBreaker = new CircuitBreaker(
	initialConfig.circuitBreakerThreshold,
	initialConfig.circuitBreakerResetMs,
	logger,
);
// Dedicated breaker for device-deletion calls. A flaky delete endpoint
// shouldn't block status fetches and thus freeze the recovery loop; and a
// tripped fetch breaker shouldn't permanently suppress deletions once the
// next successful fetch reveals dead duplicates.
const deletionCircuitBreaker = new CircuitBreaker(
	initialConfig.circuitBreakerThreshold,
	initialConfig.circuitBreakerResetMs,
	logger,
);
const originStateTracker = new OriginStateTracker(
	initialConfig.restartThreshold,
	logger,
	{
		// Drop state entries whose origin we haven't seen offline in a long
		// time (either it recovered silently, was renamed, or was removed
		// upstream). Well above any realistic retry cycle.
		maxEntryAgeMs: Math.max(
			24 * 60 * 60 * 1_000,
			initialConfig.checkIntervalMs * 100,
		),
	},
);
// Hard ceiling on how long a single job may hold an origin slot. Set well
// above the worst-case script execution path (timeout + SIGKILL escalation +
// full retry budget) so that a leaked in-progress entry is still eventually
// released, but legitimate long retries aren't killed.
const stuckJobTimeoutMs =
	initialConfig.scriptTimeoutMs *
		(initialConfig.maxRetries + 1) +
	initialConfig.maxRetryDelayMs * (initialConfig.maxRetries + 1) +
	initialConfig.scriptKillGracePeriodMs * 2 +
	30_000;
const jobQueue = new JobQueue(
	initialConfig.maxConcurrentJobs,
	logger,
	metrics,
	{ stuckJobTimeoutMs },
);
const scriptRunner = new ScriptRunner(configManager, logger, metrics);
const statusApiClient = new RotomApiClient(configManager, metrics);
const observabilityServer = new ObservabilityServer(
	initialConfig.metricsHost,
	initialConfig.metricsPort,
	logger,
	metrics,
);

configManager.subscribe(({ changedKeys, config }) => {
	if (changedKeys.includes("logLevel")) {
		logger.setLevel?.(config.logLevel);
	}

	if (
		changedKeys.includes("circuitBreakerThreshold") ||
		changedKeys.includes("circuitBreakerResetMs")
	) {
		circuitBreaker.updateConfig(
			config.circuitBreakerThreshold,
			config.circuitBreakerResetMs,
		);
		deletionCircuitBreaker.updateConfig(
			config.circuitBreakerThreshold,
			config.circuitBreakerResetMs,
		);
	}

	if (changedKeys.includes("maxConcurrentJobs")) {
		jobQueue.setConcurrency(config.maxConcurrentJobs);
		metrics.updateQueueStatus(jobQueue.getStatus());
	}

	if (changedKeys.includes("restartThreshold")) {
		originStateTracker.setRestartThreshold(config.restartThreshold);
	}
});

const monitor = new DeviceMonitor({
	circuitBreaker,
	deletionCircuitBreaker,
	configProvider: configManager,
	jobQueue,
	logger,
	metrics,
	onShutdown: async () => {
		configManager.close();
		observabilityServer.stop();
	},
	originStateTracker,
	scriptRunner,
	statusApiClient,
});

observabilityServer.start();
configManager.startWatching();
monitor.start();
