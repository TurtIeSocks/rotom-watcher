import { CircuitBreaker } from "./circuit-breaker";
import { createConfig } from "./config";
import { DeviceMonitor } from "./device-monitor";
import { JobQueue } from "./job-queue";
import { Logger } from "./logger";
import { Metrics } from "./metrics";
import { OriginStateTracker } from "./origin-state";
import { ScriptRunner } from "./script-runner";
import { StatusApiClient } from "./status-api";

const config = createConfig();
const logger = new Logger(process.env.LOG_LEVEL || "INFO");
const metrics = new Metrics();
const circuitBreaker = new CircuitBreaker(
	config.circuitBreakerThreshold,
	config.circuitBreakerResetMs,
	logger,
);
const originStateTracker = new OriginStateTracker(
	config.restartThreshold,
	config.scriptRestart,
	config.scriptUpdate,
	logger,
);
const jobQueue = new JobQueue(config.maxConcurrentJobs, logger);
const scriptRunner = new ScriptRunner(config, logger, metrics);
const statusApiClient = new StatusApiClient(
	config.endpoint,
	config.fetchTimeoutMs,
);

const monitor = new DeviceMonitor({
	circuitBreaker,
	config,
	jobQueue,
	logger,
	metrics,
	originStateTracker,
	scriptRunner,
	statusApiClient,
});

monitor.start();
