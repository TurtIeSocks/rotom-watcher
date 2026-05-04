import { describe, expect, test } from "bun:test";
import type { LoggerLike } from "../observability/logger";
import { DiscordTransport } from "./discord-transport";
import type { WebhookEvent } from "./types";

const silentLogger: LoggerLike = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
};

const baseConfig = {
	avatarUrl: "",
	discordUrls: ["https://discord.com/api/webhooks/A/secret"],
	mentionRoleId: "",
	retryAttempts: 0,
	retryInitialDelayMs: 1,
	username: "rotom-watcher",
};

const captureFetch = () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		calls.push({ init, url });
		return new Response("", { status: 204 });
	}) as unknown as typeof fetch;
	return { calls, fakeFetch };
};

const renderSingle = async (event: WebhookEvent) => {
	const { calls, fakeFetch } = captureFetch();
	const transport = new DiscordTransport({
		clock: { now: () => 1_700_000_000_000 },
		config: baseConfig,
		fetchImpl: fakeFetch,
		logger: silentLogger,
		sleepFn: async () => undefined,
	});
	await transport.send([event]);
	expect(calls).toHaveLength(1);
	// biome-ignore lint/style/noNonNullAssertion: length asserted above
	const body = JSON.parse(calls[0]!.init.body as string);
	return body;
};

describe("DiscordTransport.render (single events)", () => {
	test("script.failed renders Critical color, title, fields", async () => {
		const body = await renderSingle({
			fields: {
				attempts: 3,
				durationMs: 252_000,
				exitCode: 1,
				mode: "restart",
				runId: "r-8a3f",
			},
			name: "script.failed",
			subject: "quezon-city",
		});
		expect(body.username).toBe("rotom-watcher");
		expect(body.embeds).toHaveLength(1);
		const embed = body.embeds[0];
		expect(embed.color).toBe(0xed4245);
		expect(embed.title).toContain("CRITICAL");
		expect(embed.title).toContain("script.failed");
		expect(embed.title).toContain("quezon-city");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Mode").value,
		).toBe("`restart`");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Tries").value,
		).toBe("3");
		expect(
			embed.fields.find((f: { name: string }) => f.name === "Took").value,
		).toBe("4m 12s");
	});

	test("origin.offline.restart renders Warning color", async () => {
		const body = await renderSingle({
			fields: { attempt: 1, devices: 8, lastSeenMs: 660_000, mode: "restart" },
			name: "origin.offline.restart",
			subject: "manila",
		});
		const embed = body.embeds[0];
		expect(embed.color).toBe(0xfaa61a);
		expect(embed.title).toContain("WARNING");
	});

	test("origin.recovered renders Success color", async () => {
		const body = await renderSingle({
			fields: {
				devices: 9,
				downForMs: 381_000,
				lastScript: "restart",
				result: "success",
			},
			name: "origin.recovered",
			subject: "cebu",
		});
		expect(body.embeds[0].color).toBe(0x57f287);
	});

	test("service.started renders Info color and rotom-watcher subject", async () => {
		const body = await renderSingle({
			fields: {
				concurrency: 10,
				origins: 14,
				pid: 11_712,
				pollIntervalMs: 300_000,
				version: "0.1.0",
			},
			name: "service.started",
			subject: "rotom-watcher",
		});
		expect(body.embeds[0].color).toBe(0x5865f2);
		expect(body.embeds[0].title).toContain("rotom-watcher");
	});

	test("circuit_breaker.opened renders subject 'rotom-api'", async () => {
		const body = await renderSingle({
			fields: { failures: 5, resetMs: 60_000, threshold: 5 },
			name: "circuit_breaker.opened",
			subject: "rotom-api",
		});
		expect(body.embeds[0].title).toContain("rotom-api");
	});

	test("renders one embed per call (regression check)", async () => {
		const body = await renderSingle({
			fields: { failures: 5, resetMs: 60_000, threshold: 5 },
			name: "circuit_breaker.opened",
			subject: "rotom-api",
		});
		expect(body.embeds).toHaveLength(1);
	});

	test("drops on non-2xx response (no throw)", async () => {
		let calls = 0;
		const fakeFetch = (async () => {
			calls += 1;
			return new Response("oops", { status: 503 });
		}) as unknown as typeof fetch;
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 0 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		// Should NOT throw — retry path logs and drops.
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(1);
	});
});

describe("DiscordTransport.render (coalesced batches)", () => {
	test("renders a single coalesced embed with subject list", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const event = (subject: string): WebhookEvent => ({
			fields: {
				devices: 4,
				lastSeenMs: 600_000,
				mode: "update",
				offlineStreak: 3,
			},
			name: "origin.offline.update",
			subject,
		});
		await transport.send([event("manila"), event("cebu"), event("davao")]);
		expect(calls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.embeds).toHaveLength(1);
		const embed = body.embeds[0];
		expect(embed.title).toContain("(×3)");
		expect(embed.title).toContain("multiple subjects");
		const subjectsField = embed.fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value).toContain("manila");
		expect(subjectsField.value).toContain("cebu");
		expect(subjectsField.value).toContain("davao");
	});

	test("truncates subject list past 20 entries with '+ N more'", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const events: WebhookEvent[] = Array.from({ length: 25 }, (_, i) => ({
			fields: {
				devices: 1,
				lastSeenMs: 60_000,
				mode: "update",
				offlineStreak: 1,
			},
			name: "origin.offline.update",
			subject: `origin-${i.toString().padStart(2, "0")}`,
		}));
		await transport.send(events);
		// biome-ignore lint/style/noNonNullAssertion: send always posts on non-empty
		const body = JSON.parse(calls[0]!.init.body as string);
		const subjectsField = body.embeds[0].fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value).toContain("+ 5 more");
		expect(subjectsField.value).toContain("origin-19");
		expect(subjectsField.value).not.toContain("origin-20");
	});

	test("deduplicates repeated subjects in coalesced batch", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		const event = (subject: string): WebhookEvent => ({
			fields: {
				devices: 1,
				lastSeenMs: 60_000,
				mode: "update",
				offlineStreak: 1,
			},
			name: "origin.offline.update",
			subject,
		});
		await transport.send([event("manila"), event("manila"), event("cebu")]);
		// biome-ignore lint/style/noNonNullAssertion: send posted at least once
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.embeds[0].title).toContain("(×3)");
		const subjectsField = body.embeds[0].fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value.match(/manila/g)).toHaveLength(1);
		expect(subjectsField.value).toContain("cebu");
	});

	test("clamps subjects field to Discord's 1024-char limit", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 1_700_000_000_000 },
			config: baseConfig,
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		// 20 subjects of 100 chars each → ~2000+ char field if unclamped.
		const longSubject = (idx: number) => `${"x".repeat(100)}-${idx}`;
		const events: WebhookEvent[] = Array.from({ length: 20 }, (_, i) => ({
			fields: {
				devices: 1,
				lastSeenMs: 60_000,
				mode: "update",
				offlineStreak: 1,
			},
			name: "origin.offline.update",
			subject: longSubject(i),
		}));
		await transport.send(events);
		// biome-ignore lint/style/noNonNullAssertion: send posted at least once
		const body = JSON.parse(calls[0]!.init.body as string);
		const subjectsField = body.embeds[0].fields.find(
			(f: { name: string }) => f.name === "Subjects",
		);
		expect(subjectsField.value.length).toBeLessThanOrEqual(1024);
		expect(subjectsField.value.endsWith("...")).toBe(true);
	});
});

describe("DiscordTransport.send (retry)", () => {
	test("retries on 5xx up to retryAttempts then gives up", async () => {
		let calls = 0;
		const fakeFetch = (async () => {
			calls += 1;
			return new Response("oops", { status: 503 });
		}) as unknown as typeof fetch;
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 2, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(3);
		expect(sleeps).toEqual([10, 20]);
	});

	test("4xx (non-429) does not retry", async () => {
		let calls = 0;
		const fakeFetch = (async () => {
			calls += 1;
			return new Response("bad", { status: 400 });
		}) as unknown as typeof fetch;
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 5, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(1);
	});

	test("429 with Retry-After header honors header instead of backoff", async () => {
		let calls = 0;
		const responses = [
			new Response("rate limited", {
				headers: { "retry-after": "0.5" },
				status: 429,
			}),
			new Response("", { status: 204 }),
		];
		const fakeFetch = (async () => {
			// biome-ignore lint/style/noNonNullAssertion: indexed by call count
			const response = responses[calls]!;
			calls += 1;
			return response;
		}) as unknown as typeof fetch;
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 10 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(2);
		expect(sleeps).toEqual([500]);
	});

	test("network error retries", async () => {
		let calls = 0;
		const fakeFetch = (async () => {
			calls += 1;
			if (calls < 3) {
				throw new Error("network down");
			}
			return new Response("", { status: 204 });
		}) as unknown as typeof fetch;
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 5 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(3);
	});

	test("posts to all discordUrls in parallel", async () => {
		const inFlight = new Set<string>();
		const seenInFlight: number[] = [];
		const fakeFetch = (async (url: string) => {
			inFlight.add(url);
			seenInFlight.push(inFlight.size);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight.delete(url);
			return new Response("", { status: 204 });
		}) as unknown as typeof fetch;
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: {
				...baseConfig,
				discordUrls: [
					"https://discord.com/api/webhooks/A",
					"https://discord.com/api/webhooks/B",
				],
			},
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(Math.max(...seenInFlight)).toBe(2);
	});

	test("ignores non-numeric Retry-After header (HTTP-date or garbage)", async () => {
		let calls = 0;
		const responses = [
			new Response("rate limited", {
				headers: { "retry-after": "Thu, 01 Jan 2026 00:00:00 GMT" },
				status: 429,
			}),
			new Response("", { status: 204 }),
		];
		const fakeFetch = (async () => {
			// biome-ignore lint/style/noNonNullAssertion: indexed by call count
			const response = responses[calls]!;
			calls += 1;
			return response;
		}) as unknown as typeof fetch;
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 25 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		// Falls back to exponential backoff: 25ms (initial * 2^0).
		expect(sleeps).toEqual([25]);
	});

	test("caps exponential backoff at MAX_RETRY_DELAY_MS", async () => {
		let calls = 0;
		const fakeFetch = (async () => {
			calls += 1;
			return new Response("oops", { status: 503 });
		}) as unknown as typeof fetch;
		const sleeps: number[] = [];
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			// Initial delay 20s. 2^0=20s, 2^1=40s (would exceed cap), 2^2=80s.
			// All clamped to 30_000ms ceiling.
			config: { ...baseConfig, retryAttempts: 3, retryInitialDelayMs: 20_000 },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		await transport.send([
			{
				fields: {
					attempts: 1,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "x",
			},
		]);
		expect(calls).toBe(4);
		expect(sleeps).toEqual([20_000, 30_000, 30_000]);
	});
});

describe("DiscordTransport.send (identity & mentions)", () => {
	test("includes content + allowed_mentions for critical events when mentionRoleId set", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, mentionRoleId: "1234567890" },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					attempts: 3,
					durationMs: 1,
					exitCode: 1,
					mode: "restart",
					runId: "r-1",
				},
				name: "script.failed",
				subject: "manila",
			},
		]);
		// biome-ignore lint/style/noNonNullAssertion: send posted
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.content).toBe("<@&1234567890>");
		expect(body.allowed_mentions).toEqual({ roles: ["1234567890"] });
	});

	test("does not mention on non-critical events even with mentionRoleId set", async () => {
		const { calls, fakeFetch } = captureFetch();
		const transport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, mentionRoleId: "1234567890" },
			fetchImpl: fakeFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await transport.send([
			{
				fields: {
					devices: 4,
					downForMs: 100,
					lastScript: "restart",
					result: "success",
				},
				name: "origin.recovered",
				subject: "cebu",
			},
		]);
		// biome-ignore lint/style/noNonNullAssertion: send posted
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.content).toBeUndefined();
		expect(body.allowed_mentions).toBeUndefined();
	});

	test("omits avatar_url when empty, includes when set", async () => {
		const { calls: emptyCalls, fakeFetch: emptyFetch } = captureFetch();
		const emptyTransport = new DiscordTransport({
			clock: { now: () => 0 },
			config: baseConfig,
			fetchImpl: emptyFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await emptyTransport.send([
			{
				fields: { failures: 5, resetMs: 60_000, threshold: 5 },
				name: "circuit_breaker.opened",
				subject: "rotom-api",
			},
		]);
		// biome-ignore lint/style/noNonNullAssertion: send posted
		const emptyBody = JSON.parse(emptyCalls[0]!.init.body as string);
		expect(emptyBody.avatar_url).toBeUndefined();

		const { calls: setCalls, fakeFetch: setFetch } = captureFetch();
		const setTransport = new DiscordTransport({
			clock: { now: () => 0 },
			config: { ...baseConfig, avatarUrl: "https://cdn.example/x.png" },
			fetchImpl: setFetch,
			logger: silentLogger,
			sleepFn: async () => undefined,
		});
		await setTransport.send([
			{
				fields: { failures: 5, resetMs: 60_000, threshold: 5 },
				name: "circuit_breaker.opened",
				subject: "rotom-api",
			},
		]);
		// biome-ignore lint/style/noNonNullAssertion: send posted
		const setBody = JSON.parse(setCalls[0]!.init.body as string);
		expect(setBody.avatar_url).toBe("https://cdn.example/x.png");
	});
});
