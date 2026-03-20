import { CircuitBreaker } from "./circuit-breaker";
import { createConfig } from "./config";
import { DeviceMonitor } from "./device-monitor";
import { JobQueue } from "./job-queue";
import { createLogger } from "./logger";
import { Metrics } from "./metrics";
import { ObservabilityServer } from "./observability-server";
import { OriginStateTracker } from "./origin-state";
import { RotomApiClient } from "./rotom-api";
import { ScriptRunner } from "./script-runner";

const config = createConfig();
const logger = createLogger({
	format: config.logFormat,
	level: config.logLevel,
});
const metrics = new Metrics();
const circuitBreaker = new CircuitBreaker(
	config.circuitBreakerThreshold,
	config.circuitBreakerResetMs,
	logger,
);
const originStateTracker = new OriginStateTracker(
	config.restartThreshold,
	logger,
);
const jobQueue = new JobQueue(config.maxConcurrentJobs, logger, metrics);
const scriptRunner = new ScriptRunner(config, logger, metrics);
const statusApiClient = new RotomApiClient(
	config.rotomApiBaseUrl,
	config.fetchTimeoutMs,
	metrics,
);
const observabilityServer = new ObservabilityServer(
	config.metricsHost,
	config.metricsPort,
	logger,
	metrics,
);

const monitor = new DeviceMonitor({
	circuitBreaker,
	config,
	jobQueue,
	logger,
	metrics,
	onShutdown: async () => {
		observabilityServer.stop();
	},
	originStateTracker,
	scriptRunner,
	statusApiClient,
});

observabilityServer.start();
monitor.start();
