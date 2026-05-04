# Group Recovery Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third recovery tier to `rotom-watcher`. When every device of every member origin sharing a name prefix (e.g., all `x.*`) has `isAlive === false` and the group has ≥2 members, run a sequential pipeline: `bash <script> -new <prefix>` and on success `bash <script> -u <prefix>`. The group pipeline replaces per-device restart/update for those origins.

**Architecture:** Single-pass evaluation in `evaluateDevices` returns both `originDecisions` (with suppression applied for group members) and `groupDecisions`. `ScriptRunner` gets two new `ScriptMode` values (`"new"`, `"update_all"`) and an `executeGroupPipeline` method that runs `-new` then `-u` sequentially with each step using the existing per-step retry budget. `DeviceMonitor` enqueues group pipelines on the existing `JobQueue` with key `group:<prefix>` (namespaced to avoid collision with origin names).

**Tech Stack:** TypeScript, Bun, Bun's built-in test runner (`bun:test`), Zod (config validation), Pino (logging), prom-client (metrics).

**Spec:** [docs/superpowers/specs/2026-05-04-group-recovery-pipeline-design.md](../specs/2026-05-04-group-recovery-pipeline-design.md)

---

## Task 1: Add config keys for `new_arg` and `update_all_arg`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/config.test.ts`
- Modify: `config.toml.example`
- Modify: `config.toml`

- [ ] **Step 1: Write the failing test for default values**

Add this test inside the `describe("createConfig", ...)` block in `src/config/config.test.ts`, after the existing tests:

```ts
test("defaults scriptNew to -new and scriptUpdateAll to -u", () => {
    const config = createConfigFromSources({
        env: {},
        fileConfig: {
            rotom_api: {
                base_url: "https://example.com",
            },
        },
    }) as {
        scriptNew: string;
        scriptUpdateAll: string;
    };

    expect(config.scriptNew).toBe("-new");
    expect(config.scriptUpdateAll).toBe("-u");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/config/config.test.ts`
Expected: the new test fails (TypeScript will narrow `config` to a type without `scriptNew`/`scriptUpdateAll`, returning `undefined` and failing the assertion).

- [ ] **Step 3: Extend the `Config` interface**

In `src/config/schema.ts`, add two fields to the `Config` interface (alphabetical order with the other `script*` fields):

Find:
```ts
export interface Config {
    checkIntervalMs: number;
    circuitBreakerResetMs: number;
    circuitBreakerThreshold: number;
    deviceTimeoutMinutes: number;
    fetchTimeoutMs: number;
    initialRetryDelayMs: number;
    logFormat: "json" | "pretty";
    logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    maxConcurrentJobs: number;
    maxRetries: number;
    maxRetryDelayMs: number;
    metricsHost: string;
    metricsPort: number;
    restartThreshold: number;
    rotomApiBaseUrl: string;
    scriptKillGracePeriodMs: number;
    scriptPath: string;
    scriptRestart: string;
    scriptTimeoutMs: number;
    scriptUpdate: string;
    shutdownGracePeriodMs: number;
}
```

Replace with:
```ts
export interface Config {
    checkIntervalMs: number;
    circuitBreakerResetMs: number;
    circuitBreakerThreshold: number;
    deviceTimeoutMinutes: number;
    fetchTimeoutMs: number;
    initialRetryDelayMs: number;
    logFormat: "json" | "pretty";
    logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    maxConcurrentJobs: number;
    maxRetries: number;
    maxRetryDelayMs: number;
    metricsHost: string;
    metricsPort: number;
    restartThreshold: number;
    rotomApiBaseUrl: string;
    scriptKillGracePeriodMs: number;
    scriptNew: string;
    scriptPath: string;
    scriptRestart: string;
    scriptTimeoutMs: number;
    scriptUpdate: string;
    scriptUpdateAll: string;
    shutdownGracePeriodMs: number;
}
```

- [ ] **Step 4: Add file-config mappings for the two new env keys**

In `src/config/schema.ts`, find the `fileConfigMappings` array. Add the two new entries inside the existing `[scripts]`-section block (after `SCRIPT_UPDATE_ARG`):

Find:
```ts
        {
            envKey: "SCRIPT_UPDATE_ARG",
            path: ["scripts", "update_arg"],
        },
        {
            envKey: "SCRIPT_TIMEOUT_MS",
            path: ["scripts", "timeout_ms"],
        },
```

Replace with:
```ts
        {
            envKey: "SCRIPT_UPDATE_ARG",
            path: ["scripts", "update_arg"],
        },
        {
            envKey: "SCRIPT_NEW_ARG",
            path: ["scripts", "new_arg"],
        },
        {
            envKey: "SCRIPT_UPDATE_ALL_ARG",
            path: ["scripts", "update_all_arg"],
        },
        {
            envKey: "SCRIPT_TIMEOUT_MS",
            path: ["scripts", "timeout_ms"],
        },
```

- [ ] **Step 5: Add the two new fields to the zod schema**

In `src/config/schema.ts`, inside the `configSchema` object literal, add the two new fields. Place them next to `SCRIPT_RESTART_ARG` so the script-arg keys are co-located.

Find:
```ts
            SCRIPT_RESTART_ARG: z.preprocess(
                (value) => value ?? "-rsc",
                z.string().min(1, "SCRIPT_RESTART_ARG must not be empty"),
            ),
            SCRIPT_KILL_GRACE_PERIOD_MS: positiveInteger(
                "SCRIPT_KILL_GRACE_PERIOD_MS",
                5_000,
            ),
            SCRIPT_TIMEOUT_MS: positiveInteger("SCRIPT_TIMEOUT_MS", 300_000),
            SCRIPT_UPDATE_ARG: z.preprocess(
                (value) => value ?? "-usc",
                z.string().min(1, "SCRIPT_UPDATE_ARG must not be empty"),
            ),
```

Replace with:
```ts
            SCRIPT_NEW_ARG: z.preprocess(
                (value) => value ?? "-new",
                z.string().min(1, "SCRIPT_NEW_ARG must not be empty"),
            ),
            SCRIPT_RESTART_ARG: z.preprocess(
                (value) => value ?? "-rsc",
                z.string().min(1, "SCRIPT_RESTART_ARG must not be empty"),
            ),
            SCRIPT_KILL_GRACE_PERIOD_MS: positiveInteger(
                "SCRIPT_KILL_GRACE_PERIOD_MS",
                5_000,
            ),
            SCRIPT_TIMEOUT_MS: positiveInteger("SCRIPT_TIMEOUT_MS", 300_000),
            SCRIPT_UPDATE_ALL_ARG: z.preprocess(
                (value) => value ?? "-u",
                z.string().min(1, "SCRIPT_UPDATE_ALL_ARG must not be empty"),
            ),
            SCRIPT_UPDATE_ARG: z.preprocess(
                (value) => value ?? "-usc",
                z.string().min(1, "SCRIPT_UPDATE_ARG must not be empty"),
            ),
```

- [ ] **Step 6: Add the two new fields to the schema's `transform` output**

In `src/config/schema.ts`, find the `.transform((values): Config => ({...}))` block. Add the two new properties (alphabetical with the other `script*` fields).

Find:
```ts
            scriptKillGracePeriodMs: values.SCRIPT_KILL_GRACE_PERIOD_MS,
            scriptPath: path.resolve(values.SCRIPT_PATH),
            scriptRestart: values.SCRIPT_RESTART_ARG,
            scriptTimeoutMs: values.SCRIPT_TIMEOUT_MS,
            scriptUpdate: values.SCRIPT_UPDATE_ARG,
            shutdownGracePeriodMs: values.SHUTDOWN_GRACE_PERIOD_MS,
```

Replace with:
```ts
            scriptKillGracePeriodMs: values.SCRIPT_KILL_GRACE_PERIOD_MS,
            scriptNew: values.SCRIPT_NEW_ARG,
            scriptPath: path.resolve(values.SCRIPT_PATH),
            scriptRestart: values.SCRIPT_RESTART_ARG,
            scriptTimeoutMs: values.SCRIPT_TIMEOUT_MS,
            scriptUpdate: values.SCRIPT_UPDATE_ARG,
            scriptUpdateAll: values.SCRIPT_UPDATE_ALL_ARG,
            shutdownGracePeriodMs: values.SHUTDOWN_GRACE_PERIOD_MS,
```

- [ ] **Step 7: Run the defaults test and verify it passes**

Run: `bun test src/config/config.test.ts`
Expected: all tests pass, including the new "defaults scriptNew to -new and scriptUpdateAll to -u" test.

- [ ] **Step 8: Add a test for env-var override**

In `src/config/config.test.ts`, add this test inside the `describe("createConfig", ...)` block:

```ts
test("env vars override TOML for scriptNew and scriptUpdateAll", () => {
    const config = createConfigFromSources({
        env: {
            ROTOM_API_BASE_URL: "https://example.com",
            SCRIPT_NEW_ARG: "-bootstrap",
            SCRIPT_UPDATE_ALL_ARG: "-update-all",
        },
        fileConfig: {
            scripts: {
                new_arg: "-from-file",
                update_all_arg: "-from-file",
            },
        },
    }) as {
        scriptNew: string;
        scriptUpdateAll: string;
    };

    expect(config.scriptNew).toBe("-bootstrap");
    expect(config.scriptUpdateAll).toBe("-update-all");
});
```

- [ ] **Step 9: Add a test for empty-string validation**

In `src/config/config.test.ts`, add this test inside the same `describe` block:

```ts
test("rejects empty SCRIPT_NEW_ARG and SCRIPT_UPDATE_ALL_ARG", () => {
    expect(() =>
        createConfigFromSources({
            env: { ROTOM_API_BASE_URL: "https://example.com" },
            fileConfig: {
                scripts: {
                    new_arg: "",
                },
            },
        }),
    ).toThrow(/SCRIPT_NEW_ARG/);

    expect(() =>
        createConfigFromSources({
            env: { ROTOM_API_BASE_URL: "https://example.com" },
            fileConfig: {
                scripts: {
                    update_all_arg: "",
                },
            },
        }),
    ).toThrow(/SCRIPT_UPDATE_ALL_ARG/);
});
```

- [ ] **Step 10: Run the full config test file and verify everything passes**

Run: `bun test src/config/config.test.ts`
Expected: all tests pass.

- [ ] **Step 11: Update `config.toml.example`**

In `config.toml.example`, find the `[scripts]` section:

Find:
```toml
[scripts]
path                 = "../../oci.sh"
restart_arg          = "-rsc"
update_arg           = "-usc"
timeout_ms           = 300000
restart_threshold    = 2
kill_grace_period_ms = 5000
```

Replace with:
```toml
[scripts]
path                 = "../../oci.sh"
restart_arg          = "-rsc"
update_arg           = "-usc"
new_arg              = "-new"
update_all_arg       = "-u"
timeout_ms           = 300000
restart_threshold    = 2
kill_grace_period_ms = 5000
```

- [ ] **Step 12: Update `config.toml`**

In `config.toml`, find the `[scripts]` section:

Find:
```toml
[scripts]
path = "/home/test/ditto2/oci_update/oci.sh"
restart_arg = "-rsc"
update_arg = "-usc"
timeout_ms = 300000
restart_threshold = 2
```

Replace with:
```toml
[scripts]
path = "/home/test/ditto2/oci_update/oci.sh"
restart_arg = "-rsc"
update_arg = "-usc"
new_arg = "-new"
update_all_arg = "-u"
timeout_ms = 300000
restart_threshold = 2
```

- [ ] **Step 13: Run typecheck and full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 14: Commit**

```bash
git add src/config/schema.ts src/config/config.test.ts config.toml.example config.toml
git commit -m "feat: add new_arg and update_all_arg to scripts config"
```

---

## Task 2: Extend `ScriptMode` and add `executeGroupPipeline`

**Files:**
- Modify: `src/monitor/types.ts`
- Modify: `src/runtime/script-runner.ts`
- Modify: `src/runtime/script-runner.test.ts`

- [ ] **Step 1: Write a failing test for the pipeline sequence**

Add this test inside the `describe("ScriptRunner", ...)` block in `src/runtime/script-runner.test.ts`, after the existing tests:

```ts
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
```

You also need to add a `ScriptMode` import at the top of the test file. Find:
```ts
import type { Config, ConfigProvider } from "../config/schema";
import type { LoggerLike } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { ScriptExecutionError, ScriptRunner } from "./script-runner";
```

Replace with:
```ts
import type { Config, ConfigProvider } from "../config/schema";
import type { ScriptMode } from "../monitor/types";
import type { LoggerLike } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { ScriptExecutionError, ScriptRunner } from "./script-runner";
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/runtime/script-runner.test.ts`
Expected: the new test fails (`executeGroupPipeline` does not exist on `ScriptRunner`; TypeScript / runtime error).

- [ ] **Step 3: Widen `ScriptMode` in `src/monitor/types.ts`**

Find:
```ts
export type ScriptMode = "restart" | "update";
```

Replace with:
```ts
export type ScriptMode = "restart" | "update" | "new" | "update_all";
```

- [ ] **Step 4: Update `resolveScriptArg` to handle all four modes**

In `src/runtime/script-runner.ts`, find:
```ts
    private resolveScriptArg(config: Config, scriptMode: ScriptMode): string {
        return scriptMode === "update" ? config.scriptUpdate : config.scriptRestart;
    }
```

Replace with:
```ts
    private resolveScriptArg(config: Config, scriptMode: ScriptMode): string {
        switch (scriptMode) {
            case "restart":
                return config.scriptRestart;
            case "update":
                return config.scriptUpdate;
            case "new":
                return config.scriptNew;
            case "update_all":
                return config.scriptUpdateAll;
        }
    }
```

- [ ] **Step 5: Add `executeGroupPipeline` method to `ScriptRunner`**

In `src/runtime/script-runner.ts`, add this method directly after the existing `execute` method (before `resolveScriptArg`):

Find:
```ts
    async execute(
        origin: string,
        scriptMode: ScriptMode,
        attempt = 0,
    ): Promise<void> {
```

Just before that block, **insert nothing** — we want to add our new method *after* `execute` finishes. So locate the closing brace of `execute` (the one immediately before `private resolveScriptArg`):

Find:
```ts
            await this.sleepFn(delay);
            await this.execute(origin, scriptMode, attempt + 1);
        }
    }

    private resolveScriptArg(config: Config, scriptMode: ScriptMode): string {
```

Replace with:
```ts
            await this.sleepFn(delay);
            await this.execute(origin, scriptMode, attempt + 1);
        }
    }

    async executeGroupPipeline(prefix: string): Promise<void> {
        await this.execute(prefix, "new");
        await this.execute(prefix, "update_all");
    }

    private resolveScriptArg(config: Config, scriptMode: ScriptMode): string {
```

- [ ] **Step 6: Run the pipeline-sequence test and verify it passes**

Run: `bun test src/runtime/script-runner.test.ts`
Expected: the new "runs -new then -u in sequence" test passes; pre-existing tests still pass.

- [ ] **Step 7: Add a failing test: `-new` failure aborts the pipeline**

Add this test inside the `describe("ScriptRunner", ...)` block:

```ts
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
```

- [ ] **Step 8: Add a failing test: `-u` failure surfaces after `-new` succeeded**

Add this test inside the same `describe` block:

```ts
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
```

- [ ] **Step 9: Run all script-runner tests**

Run: `bun test src/runtime/script-runner.test.ts`
Expected: all tests pass (both new failure-mode tests and all pre-existing tests).

- [ ] **Step 10: Run typecheck and full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/monitor/types.ts src/runtime/script-runner.ts src/runtime/script-runner.test.ts
git commit -m "feat: add new and update_all script modes with group pipeline helper"
```

---

## Task 3: Add group evaluation logic in `evaluateDevices`

**Files:**
- Modify: `src/monitor/types.ts`
- Modify: `src/monitor/device-evaluation.ts`
- Modify: `src/monitor/device-evaluation.test.ts`

- [ ] **Step 1: Add `GroupDecision` type and extend `DeviceEvaluationResult`**

In `src/monitor/types.ts`, find:
```ts
export interface DeviceEvaluationResult {
    onlineOrigins: string[];
    originDecisions: OriginDecision[];
}
```

Replace with:
```ts
export interface GroupDecision {
    members: string[];
    prefix: string;
}

export interface DeviceEvaluationResult {
    groupDecisions: GroupDecision[];
    onlineOrigins: string[];
    originDecisions: OriginDecision[];
}
```

- [ ] **Step 2: Run the existing tests to verify they still type-check (they will fail at runtime)**

Run: `bun run typecheck`
Expected: typecheck passes (existing test assertions don't include `groupDecisions`, but `expect(result.originDecisions).toEqual(...)` checks a single property and is unaffected).

Run: `bun test src/monitor/device-evaluation.test.ts`
Expected: existing tests still pass (the `evaluateDevices` function does not yet return `groupDecisions`, so accessing `result.groupDecisions` would be `undefined`, but no existing test reads it).

- [ ] **Step 3: Make the existing implementation return an empty `groupDecisions` array**

In `src/monitor/device-evaluation.ts`, find:
```ts
    return {
        onlineOrigins,
        originDecisions,
    };
};
```

Replace with:
```ts
    return {
        groupDecisions: [],
        onlineOrigins,
        originDecisions,
    };
};
```

- [ ] **Step 4: Run typecheck and the eval test file**

Run: `bun run typecheck && bun test src/monitor/device-evaluation.test.ts`
Expected: both pass.

- [ ] **Step 5: Write a failing test for a qualifying group of two dead origins**

Add this test inside the `describe("evaluateDevices", ...)` block in `src/monitor/device-evaluation.test.ts`:

```ts
test("emits a groupDecision when every member of a prefix group is dead", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "x.1-device",
                isAlive: false,
                origin: "x.1",
            }),
            buildDevice({
                deviceId: "x.2-device",
                isAlive: false,
                origin: "x.2",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([
        {
            members: ["x.1", "x.2"],
            prefix: "x",
        },
    ]);
});
```

- [ ] **Step 6: Run the test and verify it fails**

Run: `bun test src/monitor/device-evaluation.test.ts`
Expected: the new test fails (`groupDecisions` is `[]`).

- [ ] **Step 7: Implement the `extractGroupKey` helper and group evaluation**

In `src/monitor/device-evaluation.ts`, replace the entire file contents with:

```ts
import type { Device, Worker } from "../rotom/types";
import type {
    DeviceEvaluationResult,
    GroupDecision,
    OriginDecision,
} from "./types";

export interface EvaluateDevicesOptions {
    currentTimeMs: number;
    deviceTimeoutMinutes: number;
    devices: Device[];
    workers: Worker[];
}

const extractGroupPrefix = (origin: string): string | undefined => {
    const lastDotIndex = origin.lastIndexOf(".");
    if (lastDotIndex === -1) {
        return undefined;
    }
    const suffix = origin.slice(lastDotIndex + 1);
    if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
        return undefined;
    }
    return origin.slice(0, lastDotIndex);
};

export const evaluateDevices = ({
    currentTimeMs,
    deviceTimeoutMinutes,
    devices,
    workers,
}: EvaluateDevicesOptions): DeviceEvaluationResult => {
    const devicesByOrigin = devices.reduce<Map<string, Device[]>>(
        (accumulator, device) => {
            const originDevices = accumulator.get(device.origin) ?? [];
            originDevices.push(device);
            accumulator.set(device.origin, originDevices);
            return accumulator;
        },
        new Map(),
    );
    const workerOrigins = new Set(workers.map((worker) => worker.worker.origin));

    const onlineOrigins: string[] = [];
    const originDecisions: OriginDecision[] = [];

    const originsByPrefix = new Map<string, string[]>();
    const originHasAliveDevice = new Map<string, boolean>();

    for (const [origin, originDevices] of devicesByOrigin.entries()) {
        const hasWorkers = workerOrigins.has(origin);
        const hasAliveDevice = originDevices.some((device) => device.isAlive);
        const latestMessageReceived = originDevices.reduce(
            (latest, device) => Math.max(latest, device.dateLastMessageReceived),
            Number.NEGATIVE_INFINITY,
        );
        const lastSeenMinutes =
            (currentTimeMs - latestMessageReceived) / (1000 * 60);
        const originIsOnline = hasWorkers && hasAliveDevice;
        const deadDuplicatesToDelete = originIsOnline
            ? originDevices
                    .filter((device) => !device.isAlive)
                    .map((device) => ({
                        deviceId: device.deviceId,
                        origin,
                    }))
            : [];
        const shouldProcess =
            !originIsOnline &&
            (!hasWorkers || lastSeenMinutes > deviceTimeoutMinutes);

        if (originIsOnline) {
            onlineOrigins.push(origin);
        }

        originDecisions.push({
            deadDuplicatesToDelete,
            hasAliveDevice,
            hasWorkers,
            lastSeenMinutes,
            origin,
            shouldProcess,
        });

        originHasAliveDevice.set(origin, hasAliveDevice);

        const prefix = extractGroupPrefix(origin);
        if (prefix !== undefined) {
            const members = originsByPrefix.get(prefix) ?? [];
            members.push(origin);
            originsByPrefix.set(prefix, members);
        }
    }

    const groupDecisions: GroupDecision[] = [];
    const suppressedOrigins = new Set<string>();

    for (const [prefix, members] of originsByPrefix.entries()) {
        if (members.length < 2) {
            continue;
        }
        const everyMemberDead = members.every(
            (origin) => originHasAliveDevice.get(origin) === false,
        );
        if (!everyMemberDead) {
            continue;
        }
        const sortedMembers = [...members].sort((left, right) =>
            left.localeCompare(right),
        );
        groupDecisions.push({
            members: sortedMembers,
            prefix,
        });
        for (const member of members) {
            suppressedOrigins.add(member);
        }
    }

    if (suppressedOrigins.size > 0) {
        for (const decision of originDecisions) {
            if (suppressedOrigins.has(decision.origin)) {
                decision.shouldProcess = false;
                decision.deadDuplicatesToDelete = [];
            }
        }
    }

    originDecisions.sort((left, right) =>
        left.origin.localeCompare(right.origin),
    );
    onlineOrigins.sort((left, right) => left.localeCompare(right));
    groupDecisions.sort((left, right) => left.prefix.localeCompare(right.prefix));

    return {
        groupDecisions,
        onlineOrigins,
        originDecisions,
    };
};
```

- [ ] **Step 8: Run the new test and verify it passes**

Run: `bun test src/monitor/device-evaluation.test.ts`
Expected: all tests pass, including "emits a groupDecision when every member of a prefix group is dead".

- [ ] **Step 9: Add a test: alive member disqualifies the group**

Add this test inside the same `describe` block:

```ts
test("does not emit a groupDecision when at least one member has an alive device", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "x.1-device",
                isAlive: false,
                origin: "x.1",
            }),
            buildDevice({
                deviceId: "x.2-device-a",
                isAlive: false,
                origin: "x.2",
            }),
            buildDevice({
                deviceId: "x.2-device-b",
                isAlive: true,
                origin: "x.2",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([]);
});
```

- [ ] **Step 10: Add a test: single-member group does not qualify**

Add this test inside the same `describe` block:

```ts
test("does not emit a groupDecision for a single-member group", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "z.1-device",
                isAlive: false,
                origin: "z.1",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([]);
});
```

- [ ] **Step 11: Add a test: non-numeric suffix is not groupable**

Add this test inside the same `describe` block:

```ts
test("does not group origins whose suffix after the last dot is not numeric", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "foo.bar-device",
                isAlive: false,
                origin: "foo.bar",
            }),
            buildDevice({
                deviceId: "foo.baz-device",
                isAlive: false,
                origin: "foo.baz",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([]);
});
```

- [ ] **Step 12: Add a test: origins with no dot are not groupable**

Add this test inside the same `describe` block:

```ts
test("does not group origins that have no dot in their name", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "solo-device-a",
                isAlive: false,
                origin: "solo",
            }),
            buildDevice({
                deviceId: "solo-device-b",
                isAlive: false,
                origin: "single",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([]);
});
```

- [ ] **Step 13: Add a test: suppression clears `shouldProcess` and `deadDuplicatesToDelete` for group members**

Add this test inside the same `describe` block:

```ts
test("clears shouldProcess and deadDuplicatesToDelete for members of a triggered group", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                dateLastMessageReceived: 0,
                deviceId: "x.1-device",
                isAlive: false,
                origin: "x.1",
            }),
            buildDevice({
                dateLastMessageReceived: 0,
                deviceId: "x.2-device",
                isAlive: false,
                origin: "x.2",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([
        { members: ["x.1", "x.2"], prefix: "x" },
    ]);
    for (const decision of result.originDecisions) {
        expect(decision.shouldProcess).toBe(false);
        expect(decision.deadDuplicatesToDelete).toEqual([]);
    }
});
```

- [ ] **Step 14: Add a test: groupDecisions sorted by prefix and members sorted within each**

Add this test inside the same `describe` block:

```ts
test("sorts groupDecisions by prefix and members within each group", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "y.10-device",
                isAlive: false,
                origin: "y.10",
            }),
            buildDevice({
                deviceId: "y.2-device",
                isAlive: false,
                origin: "y.2",
            }),
            buildDevice({
                deviceId: "x.2-device",
                isAlive: false,
                origin: "x.2",
            }),
            buildDevice({
                deviceId: "x.1-device",
                isAlive: false,
                origin: "x.1",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([
        { members: ["x.1", "x.2"], prefix: "x" },
        { members: ["y.10", "y.2"], prefix: "y" },
    ]);
});
```

- [ ] **Step 15: Add a test: mixed groups (one qualifies, one doesn't)**

Add this test inside the same `describe` block:

```ts
test("processes mixed groups: one qualifies, the other does not", () => {
    const result = evaluateDevices({
        currentTimeMs: 60_000,
        deviceTimeoutMinutes: 10,
        devices: [
            buildDevice({
                deviceId: "x.1-device",
                isAlive: false,
                origin: "x.1",
            }),
            buildDevice({
                deviceId: "x.2-device",
                isAlive: false,
                origin: "x.2",
            }),
            buildDevice({
                deviceId: "y.1-device",
                isAlive: false,
                origin: "y.1",
            }),
            buildDevice({
                deviceId: "y.2-device",
                isAlive: true,
                origin: "y.2",
            }),
        ],
        workers: [],
    });

    expect(result.groupDecisions).toEqual([
        { members: ["x.1", "x.2"], prefix: "x" },
    ]);
    const xMembers = result.originDecisions.filter((decision) =>
        decision.origin.startsWith("x."),
    );
    expect(xMembers.every((decision) => decision.shouldProcess === false)).toBe(
        true,
    );
    const yOnePerOrigin = result.originDecisions.find(
        (decision) => decision.origin === "y.1",
    );
    // y.1 is not part of a triggered group, so it goes through the existing
    // per-device path: no workers + no alive device -> shouldProcess = true.
    expect(yOnePerOrigin?.shouldProcess).toBe(true);
});
```

- [ ] **Step 16: Run the entire device-evaluation test file**

Run: `bun test src/monitor/device-evaluation.test.ts`
Expected: all tests pass.

- [ ] **Step 17: Run typecheck and the full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 18: Commit**

```bash
git add src/monitor/types.ts src/monitor/device-evaluation.ts src/monitor/device-evaluation.test.ts
git commit -m "feat: detect dead device groups in evaluateDevices"
```

---

## Task 4: Add `recordGroupPipelineTriggered` metric

**Files:**
- Modify: `src/observability/metrics.ts`
- Create: `src/observability/metrics.group.test.ts`

- [ ] **Step 1: Write a failing test for the new counter**

Create the file `src/observability/metrics.group.test.ts` with these contents:

```ts
import { describe, expect, test } from "bun:test";
import { Metrics } from "./metrics";

describe("Metrics.recordGroupPipelineTriggered", () => {
    test("increments the rotom_watcher_groups_pipeline_triggered_total counter", async () => {
        const metrics = new Metrics();

        metrics.recordGroupPipelineTriggered("x");
        metrics.recordGroupPipelineTriggered("x");
        metrics.recordGroupPipelineTriggered("y");

        const rendered = await metrics.render();

        expect(rendered).toContain("rotom_watcher_groups_pipeline_triggered_total");
        expect(rendered).toMatch(
            /rotom_watcher_groups_pipeline_triggered_total\{prefix="x"\}\s+2/,
        );
        expect(rendered).toMatch(
            /rotom_watcher_groups_pipeline_triggered_total\{prefix="y"\}\s+1/,
        );
    });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/observability/metrics.group.test.ts`
Expected: fails (`recordGroupPipelineTriggered` does not exist).

- [ ] **Step 3: Add the counter and method to `Metrics`**

In `src/observability/metrics.ts`, find the `scriptDuration` declaration (the last `private readonly` field before the `constructor`):

```ts
    private readonly scriptDuration = new Histogram({
        buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300],
        help: "Script execution duration in seconds",
        labelNames: ["mode", "result"] as const,
        name: "rotom_watcher_script_duration_seconds",
        registers: [this.registry],
    });

    constructor() {
```

Replace with:

```ts
    private readonly scriptDuration = new Histogram({
        buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300],
        help: "Script execution duration in seconds",
        labelNames: ["mode", "result"] as const,
        name: "rotom_watcher_script_duration_seconds",
        registers: [this.registry],
    });

    private readonly groupPipelineTriggered = new Counter({
        help: "Group recovery pipelines queued, labeled by prefix",
        labelNames: ["prefix"] as const,
        name: "rotom_watcher_groups_pipeline_triggered_total",
        registers: [this.registry],
    });

    constructor() {
```

Then add the new method just after `recordScriptSuccess` (alphabetical-by-method order is not strictly enforced in this file; place near the other `recordScript*` methods for cohesion):

Find:
```ts
    recordScriptSuccess(mode: ScriptMode, durationMs: number): void {
        this.scriptSuccesses.inc({
            mode,
        });
        this.scriptDuration.observe(
            {
                mode,
                result: "success",
            },
            durationMs / 1000,
        );
    }

    setCircuitBreakerState(state: CircuitBreakerState): void {
```

Replace with:
```ts
    recordScriptSuccess(mode: ScriptMode, durationMs: number): void {
        this.scriptSuccesses.inc({
            mode,
        });
        this.scriptDuration.observe(
            {
                mode,
                result: "success",
            },
            durationMs / 1000,
        );
    }

    recordGroupPipelineTriggered(prefix: string): void {
        this.groupPipelineTriggered.inc({
            prefix,
        });
    }

    setCircuitBreakerState(state: CircuitBreakerState): void {
```

- [ ] **Step 4: Run the new test and verify it passes**

Run: `bun test src/observability/metrics.group.test.ts`
Expected: passes.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/observability/metrics.ts src/observability/metrics.group.test.ts
git commit -m "feat: add rotom_watcher_groups_pipeline_triggered_total counter"
```

---

## Task 5: Wire group decisions into `DeviceMonitor`

**Files:**
- Modify: `src/monitor/device-monitor.ts`
- Modify: `src/monitor/device-monitor.test.ts`

- [ ] **Step 1: Extend `TestScriptRunner` to capture group pipeline calls**

In `src/monitor/device-monitor.test.ts`, find the existing `TestScriptRunner` class:

```ts
class TestScriptRunner extends ScriptRunner {
    readonly executed: Array<{ origin: string; scriptMode: ScriptMode }> = [];

    constructor() {
        super(createConfigProvider(config), logger, new Metrics());
    }

    override async execute(
        origin: string,
        scriptMode: ScriptMode,
    ): Promise<void> {
        this.executed.push({
            origin,
            scriptMode,
        });
    }
}
```

Replace with:

```ts
class TestScriptRunner extends ScriptRunner {
    readonly executed: Array<{ origin: string; scriptMode: ScriptMode }> = [];
    readonly groupPipelinesExecuted: string[] = [];

    constructor() {
        super(createConfigProvider(config), logger, new Metrics());
    }

    override async execute(
        origin: string,
        scriptMode: ScriptMode,
    ): Promise<void> {
        this.executed.push({
            origin,
            scriptMode,
        });
    }

    override async executeGroupPipeline(prefix: string): Promise<void> {
        this.groupPipelinesExecuted.push(prefix);
    }
}
```

- [ ] **Step 2: Write a failing test for group pipeline execution**

Add this test inside the `describe("DeviceMonitor", ...)` block in `src/monitor/device-monitor.test.ts`:

```ts
test("runs the group pipeline when every member of a prefix is dead", async () => {
    const deletedDeviceIds: string[] = [];
    const scriptRunner = new TestScriptRunner();
    const monitor = new DeviceMonitor({
        circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 60_000),
        configProvider: createConfigProvider(config),
        jobQueue: new JobQueue(2, logger),
        logger,
        metrics: new Metrics(),
        now: () => 60_000,
        originStateTracker: new OriginStateTracker(2, logger),
        scriptRunner,
        statusApiClient: new TestStatusApiClient(
            {
                devices: [
                    buildDevice({
                        deviceId: "x.1-device",
                        isAlive: false,
                        origin: "x.1",
                    }),
                    buildDevice({
                        deviceId: "x.2-device",
                        isAlive: false,
                        origin: "x.2",
                    }),
                ],
                workers: [],
            },
            deletedDeviceIds,
        ),
    });

    await monitor.checkAndRunScript();

    expect(scriptRunner.groupPipelinesExecuted).toEqual(["x"]);
    expect(scriptRunner.executed).toEqual([]);
    expect(deletedDeviceIds).toEqual([]);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `bun test src/monitor/device-monitor.test.ts`
Expected: the new test fails (`groupPipelinesExecuted` is empty).

- [ ] **Step 4: Wire group decisions into `checkAndRunScript`**

In `src/monitor/device-monitor.ts`, find the closing of the per-device decisions block — the line that comes after the per-device `await Promise.allSettled(jobs);` and before `metrics.recordPollSuccess(now());`:

Find:
```ts
                    await Promise.allSettled(jobs);
                }

                metrics.recordPollSuccess(now());
```

Replace with:
```ts
                    await Promise.allSettled(jobs);
                }

                if (evaluation.groupDecisions.length > 0) {
                    logger.warn(
                        {
                            count: evaluation.groupDecisions.length,
                            prefixes: evaluation.groupDecisions.map(
                                (group) => group.prefix,
                            ),
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
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `bun test src/monitor/device-monitor.test.ts`
Expected: the new "runs the group pipeline" test passes; pre-existing tests still pass.

- [ ] **Step 6: Add a test: empty group decisions = no group calls (regression guard)**

Add this test inside the same `describe` block:

```ts
test("does not execute the group pipeline when no group qualifies", async () => {
    const scriptRunner = new TestScriptRunner();
    const monitor = new DeviceMonitor({
        circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 60_000),
        configProvider: createConfigProvider(config),
        jobQueue: new JobQueue(2, logger),
        logger,
        metrics: new Metrics(),
        now: () => 60_000,
        originStateTracker: new OriginStateTracker(2, logger),
        scriptRunner,
        statusApiClient: new TestStatusApiClient(
            {
                devices: [
                    buildDevice({
                        dateLastMessageReceived: 59_000,
                        deviceId: "alpha-device",
                        isAlive: true,
                        origin: "alpha",
                    }),
                ],
                workers: [buildWorker("alpha")],
            },
            [],
        ),
    });

    await monitor.checkAndRunScript();

    expect(scriptRunner.groupPipelinesExecuted).toEqual([]);
    expect(scriptRunner.executed).toEqual([]);
});
```

- [ ] **Step 7: Add a test: group is enqueued with key `group:<prefix>`**

The actual dedupe behavior is owned by `JobQueue.add` and is already covered by the queue's own tests. What `DeviceMonitor` is responsible for is passing the correctly-namespaced key. Verify that by spying on `jobQueue.add`.

Add this test inside the same `describe` block:

```ts
test("enqueues group pipelines with key 'group:<prefix>'", async () => {
    const enqueuedKeys: string[] = [];
    const realQueue = new JobQueue(2, logger);
    const spyQueue = {
        add: async (task: () => Promise<void>, key: string) => {
            enqueuedKeys.push(key);
            return realQueue.add(task, key);
        },
        getStatus: () => realQueue.getStatus(),
    } as unknown as JobQueue;

    const scriptRunner = new TestScriptRunner();
    const monitor = new DeviceMonitor({
        circuitBreaker: new CircuitBreaker(5, 60_000, logger, () => 60_000),
        configProvider: createConfigProvider(config),
        jobQueue: spyQueue,
        logger,
        metrics: new Metrics(),
        now: () => 60_000,
        originStateTracker: new OriginStateTracker(2, logger),
        scriptRunner,
        statusApiClient: new TestStatusApiClient(
            {
                devices: [
                    buildDevice({
                        deviceId: "x.1-device",
                        isAlive: false,
                        origin: "x.1",
                    }),
                    buildDevice({
                        deviceId: "x.2-device",
                        isAlive: false,
                        origin: "x.2",
                    }),
                ],
                workers: [],
            },
            [],
        ),
    });

    await monitor.checkAndRunScript();

    expect(enqueuedKeys).toEqual(["group:x"]);
    expect(scriptRunner.groupPipelinesExecuted).toEqual(["x"]);
});
```

- [ ] **Step 8: Run all device-monitor tests**

Run: `bun test src/monitor/device-monitor.test.ts`
Expected: all tests pass.

- [ ] **Step 9: Run typecheck and the full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/monitor/device-monitor.ts src/monitor/device-monitor.test.ts
git commit -m "feat: enqueue group recovery pipelines for fully-dead device groups"
```

---

## Task 6: Update README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add new TOML keys to the example shape**

In `README.md`, find:
```toml
[scripts]
path = "../../oci.sh"
restart_arg = "-rsc"
update_arg = "-usc"
timeout_ms = 300000
restart_threshold = 2
```

Replace with:
```toml
[scripts]
path = "../../oci.sh"
restart_arg = "-rsc"
update_arg = "-usc"
new_arg = "-new"
update_all_arg = "-u"
timeout_ms = 300000
restart_threshold = 2
```

- [ ] **Step 2: Add the two env-var overrides to the supported list**

In `README.md`, find:
```
- `SCRIPT_RESTART_ARG`
- `SCRIPT_UPDATE_ARG`
```

Replace with:
```
- `SCRIPT_RESTART_ARG`
- `SCRIPT_UPDATE_ARG`
- `SCRIPT_NEW_ARG`
- `SCRIPT_UPDATE_ALL_ARG`
```

- [ ] **Step 3: Add the new metric to the "Important metrics" list**

In `README.md`, find:
```
- `rotom_watcher_duplicate_deletions_total`
```

Replace with:
```
- `rotom_watcher_duplicate_deletions_total`
- `rotom_watcher_groups_pipeline_triggered_total`
```

- [ ] **Step 4: Add a short "Group recovery" subsection under "Failure Modes"**

In `README.md`, find the closing of the "Failure Modes" section and the start of "Operational Notes":

```
- Duplicate stale device rows:
  The monitor evaluates one origin decision instead of stacking multiple offline attempts in one poll.

## Operational Notes
```

Replace with:
```
- Duplicate stale device rows:
  The monitor evaluates one origin decision instead of stacking multiple offline attempts in one poll.
- Whole-group failure (every `<prefix>.<n>` device reports `isAlive=false`):
  Per-device restart/update is suppressed for that prefix and a group pipeline runs `<script> -new <prefix>` followed (on success) by `<script> -u <prefix>`. Requires ≥2 members in the group; single-member prefixes use the per-device path.

## Operational Notes
```

- [ ] **Step 5: Run typecheck and the full test suite as a final sanity check**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document group recovery pipeline config and metric"
```

---

## Verification (post-implementation)

- [ ] **Step 1: Run the full test suite one final time**

Run: `bun test`
Expected: all tests pass, no failures.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run the linter**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 4: Confirm spec coverage**

Cross-check the spec sections against committed work:

- Trigger condition (every device of every member origin `isAlive=false`, ≥2 members) → Task 3.
- Group key extraction (last dot, numeric suffix) → Task 3.
- Suppression rule (`shouldProcess=false`, `deadDuplicatesToDelete=[]`) → Task 3.
- `evaluateDevices` returns `groupDecisions` → Task 3.
- `ScriptMode` widening + `executeGroupPipeline` (`-new` then `-u`, abort on `-new` failure) → Task 2.
- Config keys (`new_arg`, `update_all_arg`) + env overrides + zod validation → Task 1.
- Monitor wiring (`group:<prefix>` queue key, group pipeline enqueue) → Task 5.
- Metrics counter `rotom_watcher_groups_pipeline_triggered_total` → Task 4.
- README updates (TOML keys, env vars, metric, failure mode) → Task 6.
