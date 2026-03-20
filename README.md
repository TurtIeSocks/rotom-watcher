# rotom-watcher

`rotom-watcher` polls a Rotom API, evaluates device state per origin, deletes dead duplicate devices when an origin is still online, and runs a recovery script when an origin appears offline.

## What Changed

This service now behaves like a production process instead of a best-effort script wrapper:

- Config is validated at startup and invalid values fail fast.
- Rotom API responses are schema-validated before the monitor trusts them.
- Script execution uses `spawn()` with argv instead of a shell command string.
- Logs are structured JSON by default.
- Prometheus metrics plus `/healthz` and `/readyz` are exposed over HTTP.
- Offline recovery decisions happen once per origin per poll, even when duplicate stale device rows exist.

Example:

- Before: two stale rows for `alpha` could increment the offline counter twice in one poll.
- After: `alpha` is evaluated once, queued once, and only advances one recovery step.

## Running

Install dependencies:

```bash
bun install
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
ROTOM_API_BASE_URL="https://rotom.example.com" bun run src/index.ts
```

## Configuration

Required:

- `ROTOM_API_BASE_URL`
  Must be a valid `http://` or `https://` base URL.

Optional:

- `CHECK_INTERVAL_MS`
  Default `300000`
- `DEVICE_TIMEOUT_MINUTES`
  Default `10`
- `FETCH_TIMEOUT_MS`
  Default `30000`
- `CIRCUIT_BREAKER_THRESHOLD`
  Default `5`
- `CIRCUIT_BREAKER_RESET_MS`
  Default `60000`
- `MAX_CONCURRENT_JOBS`
  Default `10`
- `MAX_RETRIES`
  Default `3`
- `INITIAL_RETRY_DELAY_MS`
  Default `1000`
- `MAX_RETRY_DELAY_MS`
  Default `30000`
- `RESTART_THRESHOLD`
  Default `2`
- `SCRIPT_PATH`
  Default `../../oci.sh` resolved from [`src/config.ts`](/Users/rin/GitHub/rotom-watcher/src/config.ts)
- `SCRIPT_RESTART_ARG`
  Default `-rsc`
- `SCRIPT_UPDATE_ARG`
  Default `-usc`
- `SCRIPT_TIMEOUT_MS`
  Default `300000`
- `SHUTDOWN_GRACE_PERIOD_MS`
  Default `60000`
- `LOG_LEVEL`
  One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Default `info`
- `LOG_FORMAT`
  `json` or `pretty`. Default `json`
- `METRICS_HOST`
  Default `127.0.0.1`
- `METRICS_PORT`
  Default `9090`

Invalid numeric values do not silently fall back anymore. Startup fails instead.

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

## Failure Modes

- Invalid config:
  Process exits during startup.
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
- On shutdown, the monitor stops scheduling new work, waits for in-flight work up to the configured grace period, then closes the observability server.
