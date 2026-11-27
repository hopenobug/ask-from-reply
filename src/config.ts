/**
 * Optional settings, read from `ask-from-reply.config.json` in pi's agent directory — the
 * one that holds `settings.json` — or from the path in `$ASK_FROM_REPLY_CONFIG`.
 *
 * The file is read on every run, so editing it does not require a restart. Anything
 * unusable (bad JSON, an unknown `submit`, a number out of range) falls back to the
 * default for that key and reports one warning; a missing file is not a problem and stays
 * silent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "ask-from-reply.config.json";
/** Full-path override of the settings file, so tests can stay off the real one. */
export const CONFIG_ENV = "ASK_FROM_REPLY_CONFIG";

/** `send` hands the answers to the conversation; `editor` only fills the input box. */
export type SubmitMode = "send" | "editor";

/**
 * Allowed range for one numeric setting. Values outside it are a config error (default is
 * used, one warning) rather than silently clamped: a typo such as `600` seconds should not
 * quietly become something else.
 */
export interface Range {
	min: number;
	max: number;
}

/** Digit keys answer options 1-9, so both caps stop at 9 (arrows still reach further). */
export const MAX_QUESTIONS_RANGE: Range = { min: 1, max: 9 };
export const MAX_OPTIONS_RANGE: Range = { min: 2, max: 9 };
/** Extraction may legitimately take a while on a slow model, but not forever. */
export const EXTRACTION_TIMEOUT_RANGE: Range = { min: 1_000, max: 600_000 };
/** Long replies are cut down to their tail, so a huge number would defeat the point. */
export const REPLY_TAIL_RANGE: Range = { min: 50, max: 100_000 };

export interface ExtensionConfig {
	submit: SubmitMode;
	/** `"provider/modelId"` of the extraction model; omitted means the session model. */
	extractionModel?: string;
	/** How long the extraction request may take before it is aborted. */
	extractionTimeoutMs: number;
	/** Question cap: also the number of questions the extractor is told to emit. */
	maxQuestions: number;
	/** Option cap per question, sent to the extractor and enforced after parsing. */
	maxOptions: number;
	/** Only the last N characters of the reply are shown to the extractor. */
	replyTailChars: number;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
	submit: "send",
	extractionTimeoutMs: 60_000,
	maxQuestions: 4,
	maxOptions: 4,
	replyTailChars: 1000,
};

export interface ConfigLoad {
	config: ExtensionConfig;
	/** What was wrong with the file, when the defaults had to be used. */
	warning?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Split `"provider/modelId"`; the id may itself contain slashes. */
export function splitModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/** Turn parsed JSON into settings, collecting every problem into one warning. */
export function parseConfig(raw: unknown): ConfigLoad {
	if (!isObject(raw)) return { config: { ...DEFAULT_CONFIG }, warning: "the config must be a JSON object" };
	const problems: string[] = [];

	let submit = DEFAULT_CONFIG.submit;
	const rawSubmit = raw.submit;
	if (rawSubmit !== undefined) {
		if (rawSubmit === "send" || rawSubmit === "editor") submit = rawSubmit;
		else problems.push(`"submit" must be "send" or "editor", got ${JSON.stringify(rawSubmit)}`);
	}

	let extractionModel: string | undefined;
	const rawModel = raw.extractionModel;
	if (rawModel !== undefined && rawModel !== null && rawModel !== "") {
		if (typeof rawModel !== "string") problems.push(`"extractionModel" must be a string`);
		else if (splitModelSpec(rawModel) === undefined) {
			problems.push(`"extractionModel" must look like "provider/modelId", got ${JSON.stringify(rawModel)}`);
		} else extractionModel = rawModel.trim();
	}

	const config: ExtensionConfig = {
		submit,
		extractionTimeoutMs: readNumber(
			raw,
			"extractionTimeoutMs",
			EXTRACTION_TIMEOUT_RANGE,
			DEFAULT_CONFIG.extractionTimeoutMs,
			problems,
		),
		maxQuestions: readNumber(raw, "maxQuestions", MAX_QUESTIONS_RANGE, DEFAULT_CONFIG.maxQuestions, problems),
		maxOptions: readNumber(raw, "maxOptions", MAX_OPTIONS_RANGE, DEFAULT_CONFIG.maxOptions, problems),
		replyTailChars: readNumber(raw, "replyTailChars", REPLY_TAIL_RANGE, DEFAULT_CONFIG.replyTailChars, problems),
	};
	if (extractionModel !== undefined) config.extractionModel = extractionModel;

	return {
		config,
		...(problems.length > 0 ? { warning: problems.join("; ") } : {}),
	};
}

/**
 * Read one numeric setting. Anything that is not an integer inside `range` keeps the
 * default and files a problem, so one bad key does not throw away the rest of the file.
 */
function readNumber(
	raw: Record<string, unknown>,
	key: string,
	range: Range,
	fallback: number,
	problems: string[],
): number {
	const value = raw[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		problems.push(`"${key}" must be an integer, got ${JSON.stringify(value)}`);
		return fallback;
	}
	if (value < range.min || value > range.max) {
		problems.push(`"${key}" must be between ${range.min} and ${range.max}, got ${value}`);
		return fallback;
	}
	return value;
}

/**
 * Where the settings file lives: `$ASK_FROM_REPLY_CONFIG` wins over `<dir>/ask-from-reply.config.json`.
 *
 * `dir` is pi's agent directory, passed in by the caller rather than imported here: that keeps
 * this module free of pi imports, so `node --test` can exercise it without the host package.
 */
export function resolveConfigPath(dir: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CONFIG_ENV];
	return override && override.length > 0 ? override : join(dir, CONFIG_FILE);
}

/** Read the settings file; never throws. `dir` is pi's agent directory. */
export function readConfig(dir: string, env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	const path = resolveConfigPath(dir, env);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { config: { ...DEFAULT_CONFIG } };
		return {
			config: { ...DEFAULT_CONFIG },
			warning: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { config: { ...DEFAULT_CONFIG }, warning: `${path} is not valid JSON; using defaults` };
	}
	const load = parseConfig(parsed);
	return load.warning === undefined ? load : { ...load, warning: `${path}: ${load.warning}; using defaults` };
}
