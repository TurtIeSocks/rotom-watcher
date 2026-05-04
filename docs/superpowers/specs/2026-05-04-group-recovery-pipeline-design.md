# Group recovery pipeline

## Summary

Add a third tier of recovery to `rotom-watcher` that fires when an entire device *group* (origins sharing a common name prefix) is fully dead. The group pipeline runs the recovery script with a new `-new` arg, and on success runs it again with `-u`, replacing the existing per-device `restart`/`update` recovery for affected origins.

## Motivation

Devices follow the naming convention `{prefix}.{number}` (e.g., `x.1`, `x.2`, `y.20`). Today the watcher only reasons about origins individually: `x.3` going offline triggers a `-rsc x.3` restart and eventually a `-usc x.3` update. When the *entire* `x.*` fleet is dead at once — typically the symptom of a bigger problem — running per-device restarts is wasteful and the right action is a fleet-wide reinstall (`-new x`) followed by an update sweep (`-u x`).

## Trigger condition

A group `<prefix>` qualifies for the pipeline in a given poll when **both** hold:

1. At least 2 distinct origins in the API response share that prefix (single-member groups are excluded — they fall back to the existing per-device recovery).
2. Every device row of every member origin has `isAlive === false`. If any device of any member origin has `isAlive === true`, the group does not qualify.

Worker presence is irrelevant for the group rule. (The per-origin path still uses worker presence; only the group rule ignores it.)

The pipeline fires immediately on the first poll where the condition is met — no consecutive-offline counter for groups. The script is expected to be idempotent.

## Group key extraction

Pure helper applied to each origin string:

1. Find the last `.` in the origin.
2. If absent → not groupable.
3. Substring after the last `.` must match `^\d+$` (digits only). If it doesn't (e.g., `foo.bar`, `x.special`) → not groupable.
4. Otherwise the prefix is the substring before the last `.`. Examples: `y.20` → `y`, `cluster-a.3` → `cluster-a`, `foo.bar.7` → `foo.bar`.

Non-groupable origins always go through the existing per-device path.

## Suppression rule

For every member origin of a qualifying group, the per-device evaluation must:

- Set `OriginDecision.shouldProcess = false`.
- Clear `OriginDecision.deadDuplicatesToDelete = []`.

This guarantees the group `-new`/`-u` is the only recovery action queued for those origins in this poll. Per-device restart/update jobs and dead-duplicate deletions for group members are skipped — the reinstall handles them.

In-flight per-device jobs from previous polls are not cancelled. They run to completion in their own time.

## Architecture

### `evaluateDevices` extension (`src/monitor/device-evaluation.ts`)

Single-pass: the function already builds a `devicesByOrigin` map, which is also what group detection needs. Reusing it keeps per-device and per-group decisions consistent (no risk of suppression drifting from detection).

New return shape:

```ts
interface GroupDecision {
  prefix: string;     // e.g. "x"
  members: string[];  // sorted member origins, e.g. ["x.1","x.2","x.5"]
}

interface DeviceEvaluationResult {
  onlineOrigins: string[];          // unchanged
  originDecisions: OriginDecision[]; // unchanged shape; suppressed members carry shouldProcess=false
  groupDecisions: GroupDecision[];   // NEW; sorted by prefix
}
```

`groupDecisions` only contains qualifying groups. Presence in the array means "fire the pipeline."

### Script runner extension (`src/runtime/script-runner.ts`)

`ScriptMode` widens to:

```ts
export type ScriptMode = "restart" | "update" | "new" | "update_all";
```

`resolveScriptArg` becomes an exhaustive switch over the four modes. The third bash arg is the group prefix (sanitized through `sanitizeOrigin`, same trust model as origins).

New method:

```ts
async executeGroupPipeline(prefix: string): Promise<void> {
  await this.execute(prefix, "new");
  await this.execute(prefix, "update_all");
}
```

Each step gets its own retry budget via the existing `execute()` retry loop. If `-new` exhausts retries, the pipeline rejects and `-u` is never invoked. If `-u` exhausts retries after `-new` succeeded, the pipeline rejects; the next poll will re-evaluate and re-fire if devices are still dead.

### Monitor wiring (`src/monitor/device-monitor.ts`)

Inside `checkAndRunScript`, after the existing per-device decisions block:

```ts
if (evaluation.groupDecisions.length > 0) {
  logger.warn(
    {
      count: evaluation.groupDecisions.length,
      prefixes: evaluation.groupDecisions.map((g) => g.prefix),
    },
    "Queueing fully-dead device groups for new+update_all pipeline",
  );

  const groupJobs = evaluation.groupDecisions.map((group) =>
    jobQueue
      .add(
        () => scriptRunner.executeGroupPipeline(group.prefix),
        `group:${group.prefix}`,
      )
      .catch((error: unknown) => {
        logger.error(
          { error, prefix: group.prefix, members: group.members },
          "Group pipeline exhausted retries",
        );
      }),
  );

  await Promise.allSettled(groupJobs);
}
```

The dedupe key `group:<prefix>` is namespaced so it cannot collide with a real origin (e.g., a device literally named `x` and the group pipeline for prefix `x`). Existing `JobQueue.add` dedupe drops a second enqueue while the pipeline is still in flight — the same protection per-origin jobs already get.

The `OriginStateTracker` is not touched by group pipelines. Member origins' counters continue to be managed by the existing `cleanupOnlineOrigins` path: when the script brings them back, the next poll clears their state automatically. If `-new` fails, members stay in their existing per-origin state, which is acceptable.

### Configuration (`config.toml`, `src/config/schema.ts`, README)

New TOML keys under `[scripts]`:

```toml
[scripts]
new_arg        = "-new"
update_all_arg = "-u"
```

New env overrides:

- `SCRIPT_NEW_ARG`
- `SCRIPT_UPDATE_ALL_ARG`

Mapped via `fileConfigMappings` (`scripts.new_arg` and `scripts.update_all_arg`).

Zod schema additions mirror the existing `SCRIPT_RESTART_ARG` shape: default `-new`/`-u`, must be non-empty string. Empty values rejected at validation.

`Config` interface gains:

```ts
scriptNew: string;       // resolved value of new_arg
scriptUpdateAll: string; // resolved value of update_all_arg
```

Both keys live under `scripts.*` so they are picked up by the existing hot-reload path.

README updates:

- Add the two new TOML keys to the shape example.
- Add the two new env var names to the overrides list.
- One new line in the "Important metrics" list (see Observability).

## Observability

### Metrics

Existing `rotom_watcher_script_*` counters (`script_attempts_total`, `script_retries_total`, `script_successes_total`, `script_failures_total`, `script_duration_seconds`) are labeled by `scriptMode`. They keep working unchanged — `"new"` and `"update_all"` become two new label values once the type widens. Metric helper signatures change from `"restart" | "update"` to the broader `ScriptMode`.

One new counter:

- `rotom_watcher_groups_pipeline_triggered_total` — incremented once per group whose pipeline is queued in a poll. Useful for "is this firing more than I expect?" without having to derive it from script-mode counters.

### Logs (Pino, JSON)

- `info`/`warn` at queue time: drafted in the monitor wiring snippet above. Includes `prefixes` array.
- `evaluateDevices` stays pure and silent — consistent with how it handles per-origin offline detection today.
- The existing `ScriptRunner` log lines already include `scriptMode`, so `"new"` / `"update_all"` show up in the log stream without code changes.

### Grafana

No new panels for v1. The existing per-mode breakdown of attempts/successes/failures will surface the new modes via the `scriptMode` label.

## Testing

### `device-evaluation.test.ts`

- `y.1`+`y.2` both `isAlive=false` → group `y` qualifies; both `OriginDecision`s have `shouldProcess=false`.
- `y.1`+`y.2` both `isAlive=false` but `y.2` has a second device row that's alive → group does **not** qualify.
- Single-member group (`z.1` only, dead) → no group decision.
- Mixed groups: `x.*` all dead, `y.*` mixed → `x` fires, `y` decisions go through per-device path unaffected.
- Non-numeric suffix (`foo.bar`, `x.special`) → never grouped; per-device path unaffected.
- No suffix at all (`solo`) → never grouped.
- Suppressed members' `deadDuplicatesToDelete` is `[]` even if they had dead duplicates pre-suppression.
- `groupDecisions` sorted by prefix; `members` sorted within each.

### `script-runner.test.ts`

- `executeGroupPipeline("x")` calls `execute("x", "new")` then `execute("x", "update_all")` in order.
- If `-new` rejects after retries → `-u` is never invoked; pipeline rejects with the `-new` error.
- If `-new` resolves and `-u` rejects → pipeline rejects with the `-u` error after `-u`'s own retries.
- Sanitization applies to the prefix (same as origins).
- Existing per-mode tests for `restart`/`update` keep passing — switch is exhaustive.

### `device-monitor.test.ts`

- Group decisions are enqueued with key `group:<prefix>` (verify via fake `JobQueue.add` spy).
- A second poll while a pipeline is in-flight → second enqueue dropped (existing dedupe behavior).
- Empty `groupDecisions` → no group jobs enqueued; behavior identical to today.

### Config tests (`config/config.test.ts`, `config/manager.test.ts`)

- Defaults: `scriptNew === "-new"`, `scriptUpdateAll === "-u"`.
- TOML override and env override both work for both keys.
- Empty string rejected at validation.
- Hot-reload picks up changed values (covered by existing reload tests once schema is extended).

No new integration tests — existing live-spawn tests already exercise the bash path; new modes use the same path.

## Failure modes

- **`-new` script timeout / non-zero exit / signal:** existing `ScriptRunner` retry path applies. After `maxRetries` exhausted, pipeline rejects, `-u` not invoked, error logged with prefix and members. Next poll re-evaluates.
- **`-new` succeeds, `-u` fails:** pipeline rejects after `-u`'s own retry budget. Next poll re-evaluates and likely re-fires the full pipeline (script must be idempotent).
- **Pipeline still in flight on next poll:** `JobQueue.add` dedupe on `group:<prefix>` drops the duplicate enqueue.
- **Group qualifies but `-new`/`-u` config args misconfigured:** validation rejects empty strings at startup / hot-reload, so this surfaces before any poll runs.
- **Pre-existing in-flight per-device job for a now-suppressed member:** runs to completion; we do not cancel.

## Out of scope

- No group-level offline counter or `restart_threshold`-equivalent gate (fire immediately).
- No new dashboard panels.
- No runtime opt-in flag — feature is implicit; if no group ever qualifies, behavior is identical to today.
- No cancellation of in-flight per-device jobs when a group becomes triggered mid-flight.
- No retry coordination across the two pipeline steps beyond what the existing `ScriptRunner` provides per-step.
