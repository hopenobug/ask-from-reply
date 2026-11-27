/**
 * e2e only: register a local `fake` provider so the scenarios never touch a real model.
 *
 * Loaded with a second `-e` by the harness (`harness.mjs`), never by the extension under
 * test. The provider itself is a plain OpenAI-compatible HTTP endpoint (`fake-model.mjs`)
 * started by the test process, so the request shapes and SSE handling are the real ones —
 * this file only points pi at it, which is the one thing the CLI cannot be told on the
 * command line.
 *
 * Why an extension instead of a `models.json`: a temp `PI_CODING_AGENT_DIR` is what that
 * would cost (pi installs packages and writes state there), and this keeps the user's own
 * config untouched and the provider scoped to the run.
 */
const BASE_URL_ENV = "AFR_FAKE_BASE_URL";
const PROVIDER = "fake";
const MODEL = "fake-mini";

export default function (pi) {
	const baseUrl = process.env[BASE_URL_ENV];
	if (!baseUrl) {
		throw new Error(`${BASE_URL_ENV} is not set; the e2e harness must start the fake model first`);
	}
	pi.registerProvider(PROVIDER, {
		name: "Fake provider (e2e)",
		baseUrl,
		apiKey: "fake-key",
		api: "openai-completions",
		models: [
			{
				id: MODEL,
				name: "Fake Mini",
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 8_192,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			},
		],
	});
}
