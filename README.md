# rotom-watcher

`rotom-watcher` polls a Rotom API, evaluates device state per origin, deletes dead duplicate devices when an origin is still online, and runs a recovery script when an origin appears offline.

## Running

Install dependencies:

```bash
bun install
```

Create a local config:

```bash
cp config.toml.example config.toml
```

Run tests:

```bash
bun test
```

Typecheck:

```bash
bun run typecheck
```

Start the service:

```bash
bun run src/index.ts
```

Use a non-default config path:

```bash
ROTOM_CONFIG_PATH="./deploy/rotom-watcher.toml" bun run src/index.ts
```

## Configuration

`config.toml` is the canonical config source. Environment variables override file values when both are present.

The default config path is `./config.toml`. You can point at a different file with `ROTOM_CONFIG_PATH`.

### TOML Shape

```toml
[rotom_api]
base_url = "https://rotom.example.com"
fetch_timeout_ms = 30000

[polling]
check_interval_ms = 300000
device_timeout_minutes = 10

[retry]
initial_delay_ms = 1000
max_delay_ms = 30000
max_retries = 3

[concurrency]
max_concurrent_jobs = 10

[circuit_breaker]
threshold = 5
reset_ms = 60000

[scripts]
path = "../../oci.sh"
restart_arg = "-rsc"
update_arg = "-usc"
timeout_ms = 300000
restart_threshold = 2

[logging]
format = "json"
level = "info"

[metrics]
host = "127.0.0.1"
port = 9090

[shutdown]
grace_period_ms = 60000
```

### Environment Overrides

Supported overrides:

- `ROTOM_CONFIG_PATH`
- `ROTOM_API_BASE_URL`
- `FETCH_TIMEOUT_MS`
- `CHECK_INTERVAL_MS`
- `DEVICE_TIMEOUT_MINUTES`
- `INITIAL_RETRY_DELAY_MS`
- `MAX_RETRY_DELAY_MS`
- `MAX_RETRIES`
- `MAX_CONCURRENT_JOBS`
- `CIRCUIT_BREAKER_THRESHOLD`
- `CIRCUIT_BREAKER_RESET_MS`
- `SCRIPT_PATH`
- `SCRIPT_RESTART_ARG`
- `SCRIPT_UPDATE_ARG`
- `SCRIPT_TIMEOUT_MS`
- `RESTART_THRESHOLD`
- `LOG_LEVEL`
- `LOG_FORMAT`
- `METRICS_HOST`
- `METRICS_PORT`
- `SHUTDOWN_GRACE_PERIOD_MS`

Invalid values do not silently fall back anymore. Startup fails instead, and invalid reloads are rejected while the service keeps the previous valid config.

## Hot Reload

`rotom-watcher` watches the configured TOML file and reloads it automatically when it changes.

Reload flow:

1. Parse TOML
2. Merge environment variable overrides
3. Validate the full config
4. If valid, atomically swap in the new config
5. If invalid, log the error and keep the last known-good config

### Live-Reloaded Settings

- `polling.check_interval_ms`
- `polling.device_timeout_minutes`
- `rotom_api.base_url`
- `rotom_api.fetch_timeout_ms`
- `retry.*`
- `concurrency.max_concurrent_jobs`
- `circuit_breaker.*`
- `scripts.*`
- `logging.level`
- `shutdown.grace_period_ms`

### Restart-Required Settings

- `logging.format`
- `metrics.host`
- `metrics.port`

These values are still validated on reload, but the running process logs that a restart is required for them to fully apply.

## Observability

The service starts an HTTP server for operational endpoints:

- `/metrics`
  Prometheus metrics
- `/healthz`
  Liveness. Returns `200` while the service is alive and not shutting down.
- `/readyz`
  Readiness. Returns `200` only after at least one successful poll and while the service is not shutting down.

Important metrics:

- `rotom_watcher_poll_duration_seconds`
- `rotom_watcher_api_requests_total`
- `rotom_watcher_api_failures_total`
- `rotom_watcher_api_request_duration_seconds`
- `rotom_watcher_script_attempts_total`
- `rotom_watcher_script_retries_total`
- `rotom_watcher_script_successes_total`
- `rotom_watcher_script_failures_total`
- `rotom_watcher_script_duration_seconds`
- `rotom_watcher_duplicate_deletions_total`
- `rotom_watcher_queue_jobs_queued`
- `rotom_watcher_queue_jobs_running`
- `rotom_watcher_queue_duplicate_rejected_total`
- `rotom_watcher_queue_saturated`
- `rotom_watcher_circuit_breaker_state`
- `rotom_watcher_origins_tracked`
- `rotom_watcher_origins_offline`
- `rotom_watcher_last_successful_poll_timestamp_seconds`

### Grafana Dashboard

An importable Grafana dashboard lives at `grafana/dashboards/rotom-watcher-overview.json`.

Import flow:

1. In Grafana, go to `Dashboards` -> `New` -> `Import`.
2. Upload `grafana/dashboards/rotom-watcher-overview.json`.
3. When Grafana asks for `DS_PROMETHEUS`, choose the Prometheus datasource that already scrapes this service's `/metrics` endpoint.

What the dashboard shows:

- Top-row operator health:
  circuit breaker state, last successful poll age, offline origins, queue saturation, queued jobs, and running jobs.
- API behavior:
  poll duration percentiles, request rate, latency p95, and failure rate by reason.
- Recovery script behavior:
  attempts, successes, failures, retries, and script duration p95.
- Queue and origin pressure:
  queue capacity vs backlog, tracked origins vs offline origins, and duplicate deletion rate.

Example:

- Before:
  you can query `rotom_watcher_*` metrics one at a time, but you have to mentally stitch together whether the problem is the poll loop, the API, or the recovery script.
- After:
  the top row answers "is rotom-watcher healthy right now?" and the lower panels answer "what part is going sideways?"

## Failure Modes

- Invalid startup config:
  Process exits during startup.
- Invalid hot reload:
  The reload is rejected and the service keeps the previous valid config.
- Rotom API timeout or network error:
  Poll fails, the circuit breaker moves toward `OPEN`, and the failure is counted in metrics.
- Rotom API schema drift:
  Poll fails with `invalid_payload` rather than operating on untrusted JSON.
- Script timeout:
  Script is terminated, failure metrics increment, and retry backoff applies until retries are exhausted.
- Duplicate stale device rows:
  The monitor evaluates one origin decision instead of stacking multiple offline attempts in one poll.

## Operational Notes

- Logs default to JSON for easier ingestion.
- Script stdout and stderr are truncated in logs to avoid flooding output.
- The monitor uses one-shot scheduling, so a slow poll does not overlap with the next one.
- On shutdown, the monitor stops scheduling new work, waits for in-flight work up to the configured grace period, then closes the observability server and config watcher.
