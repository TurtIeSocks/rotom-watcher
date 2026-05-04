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
});
