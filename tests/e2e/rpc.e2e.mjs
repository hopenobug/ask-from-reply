/**
 * RPC end-to-end suite: `npm run e2e`.
 *
 * Every scenario runs in a fresh empty directory against a real pi process and a fake
 * model (`fake-model.mjs` + `fake-provider.ts`), a few pi processes at a time. The model
 * being fake is what makes this a gate rather than a smoke test: replies, extraction
 * output, delays and failures are all scripted, so the assertions describe our own code.
 *
 * The parallelism comes from `concurrency` on the parent test: node:test runs subtests one
 * at a time otherwise, whatever `Promise.all` says. Each scenario is a whole pi process, so
 * the cap is real CPU, not politeness — `AFR_E2E_CONCURRENCY` overrides it.
 */
import test from "node:test";
import { runScenario, SCENARIOS, SCENARIO_TIMEOUT } from "./scenarios.mjs";

const CONCURRENCY = Math.max(1, Number(process.env.AFR_E2E_CONCURRENCY ?? 8) || 8);

test("ask-from-reply e2e over RPC", { concurrency: CONCURRENCY, timeout: 900_000 }, async (t) => {
	await Promise.all(
		SCENARIOS.map((scenario) =>
			t.test(scenario.name, { timeout: SCENARIO_TIMEOUT }, async () => {
				await runScenario(scenario);
			}),
		),
	);
});
