import { describe, expect, test } from "bun:test";
import {
	EVENT_NAMES,
	SEVERITY,
	SEVERITY_COLOR,
	SEVERITY_LABEL,
} from "./events";
import type { Severity } from "./types";

describe("event catalog", () => {
	test("EVENT_NAMES has no duplicates", () => {
		const set = new Set<string>(EVENT_NAMES);
		expect(set.size).toBe(EVENT_NAMES.length);
	});

	test("SEVERITY has an entry for every EVENT_NAME", () => {
		for (const name of EVENT_NAMES) {
			expect(SEVERITY[name]).toBeDefined();
		}
		expect(Object.keys(SEVERITY).length).toBe(EVENT_NAMES.length);
	});

	test("every severity has a color and a label", () => {
		const severities: Severity[] = ["critical", "info", "success", "warning"];
		for (const severity of severities) {
			expect(SEVERITY_COLOR[severity]).toBeDefined();
			expect(SEVERITY_LABEL[severity]).toBeDefined();
		}
	});

	test("EVENT_NAMES has the expected count (update when adding events)", () => {
		expect(EVENT_NAMES.length).toBe(15);
	});
});
