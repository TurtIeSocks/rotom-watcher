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
