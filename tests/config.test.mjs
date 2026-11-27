/**
 * The settings file is optional and read on every run, so its failure modes are what
 * matter: a missing file must be silent, a broken one must fall back instead of throwing,
 * and `submit: "editor"` must survive as far as the caller.
 *
 * Run via `npm test` (`node --test tests/`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CONFIG_ENV,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	parseConfig,
	readConfig,
	resolveConfigPath,
	splitModelSpec,
} from "../src/config.ts";

function withTempDir(body) {
	const dir = mkdtempSync(join(tmpdir(), "afr-config-"));
	try {
		return body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Every key the defaults fill in, so a test only has to name what it overrides. */
const withDefaults = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });

test("no config file: defaults, no warning", () => {
	withTempDir((dir) => {
		const load = readConfig(dir, {});
		assert.deepEqual(load.config, withDefaults({ submit: "send" }));
		assert.equal(load.warning, undefined);
		assert.deepEqual(load.config, DEFAULT_CONFIG);
	});
});

test("both fields parse", () => {
	const load = parseConfig({ submit: "editor", extractionModel: "openai/gpt-4o-mini" });
	assert.deepEqual(load, {
		config: withDefaults({ submit: "editor", extractionModel: "openai/gpt-4o-mini" }),
	});
});

test("an empty extractionModel means the session model", () => {
	assert.deepEqual(parseConfig({ extractionModel: "" }).config, withDefaults({ submit: "send" }));
	assert.deepEqual(parseConfig({ extractionModel: "   " }).warning?.includes("provider/modelId"), true);
});

test("an unknown submit value falls back to send and says so", () => {
	const load = parseConfig({ submit: "input" });
	assert.equal(load.config.submit, "send");
	assert.match(load.warning, /"submit" must be "send" or "editor", got "input"/);
});

test("a bad extractionModel falls back to the session model and says so", () => {
	for (const value of ["openai", "/gpt-4o-mini", "openai/", 42, null]) {
		const load = parseConfig({ extractionModel: value });
		assert.equal(load.config.extractionModel, undefined, `accepted ${JSON.stringify(value)}`);
		if (value !== null) assert.match(load.warning, /"extractionModel"/);
	}
});

test("a non-object config falls back to the defaults", () => {
	for (const raw of [[], "send", 7]) {
		const load = parseConfig(raw);
		assert.deepEqual(load.config, DEFAULT_CONFIG);
		assert.match(load.warning, /must be a JSON object/);
	}
});

test("model specs split on the first slash only", () => {
	assert.deepEqual(splitModelSpec("openai/gpt-4o-mini"), {
		provider: "openai",
		modelId: "gpt-4o-mini",
	});
	assert.deepEqual(splitModelSpec(" openrouter/meta/llama "), {
		provider: "openrouter",
		modelId: "meta/llama",
	});
	for (const bad of ["", "openai", "/x", "x/", "  /  "]) {
		assert.equal(splitModelSpec(bad), undefined, `accepted ${JSON.stringify(bad)}`);
	}
});

test("a broken file falls back instead of throwing", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, CONFIG_FILE), "{ \"submit\": \"editor\", }");
		const load = readConfig(dir, {});
		assert.equal(load.config.submit, "send");
		assert.match(load.warning, /not valid JSON/);
		assert.ok(load.warning.startsWith(join(dir, CONFIG_FILE)), load.warning);
	});
});

test("a config that cannot be read reports the path", () => {
	withTempDir((dir) => {
		const load = readConfig(dir, { [CONFIG_ENV]: join(dir, "missing-dir", CONFIG_FILE) });
		assert.deepEqual(load.config, DEFAULT_CONFIG);
		assert.equal(load.warning, undefined, "ENOENT is not a problem");
	});
});

test("the env override wins over the agent directory", () => {
	withTempDir((dir) => {
		const override = join(dir, "elsewhere.json");
		writeFileSync(override, JSON.stringify({ submit: "editor", extractionModel: "p/m" }));
		assert.equal(resolveConfigPath("C:/pkg", { [CONFIG_ENV]: override }), override);
		const load = readConfig("C:/pkg", { [CONFIG_ENV]: override });
		assert.deepEqual(load.config, withDefaults({ submit: "editor", extractionModel: "p/m" }));
	});
});

test("the numeric settings parse and land on the config", () => {
	const load = parseConfig({
		extractionTimeoutMs: 5_000,
		maxQuestions: 2,
		maxOptions: 6,
		replyTailChars: 2_000,
	});
	assert.deepEqual(load.config, withDefaults({ extractionTimeoutMs: 5_000, maxQuestions: 2, maxOptions: 6, replyTailChars: 2_000 }));
	assert.equal(load.warning, undefined);
});

test("an unusable number keeps its default and says so", () => {
	const cases = [
		["extractionTimeoutMs", 0],
		["extractionTimeoutMs", 600_001],
		["maxQuestions", 0],
		["maxQuestions", 10],
		["maxOptions", 1],
		["maxOptions", 3.5],
		["replyTailChars", 49],
		["replyTailChars", "1000"],
	];
	for (const [key, value] of cases) {
		const load = parseConfig({ [key]: value });
		assert.equal(load.config[key], DEFAULT_CONFIG[key], `accepted ${key}=${JSON.stringify(value)}`);
		assert.match(load.warning, new RegExp(`"${key}"`), `no warning for ${key}=${JSON.stringify(value)}`);
	}
});

test("several bad numbers are reported together", () => {
	const load = parseConfig({ maxQuestions: -1, maxOptions: 0 });
	assert.deepEqual(load.config, DEFAULT_CONFIG);
	assert.match(load.warning, /"maxQuestions"/);
	assert.match(load.warning, /"maxOptions"/);
});
