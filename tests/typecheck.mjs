/**
 * Typecheck this extension against whichever pi release is currently installed.
 *
 * The extension itself resolves `@earendil-works/*` through pi's own jiti aliases at
 * runtime, so nothing here is version-pinned. `tsc` needs concrete paths though, and
 * hardcoding a release directory would silently rot on the next `pi update` — so this
 * script reads `install/current-version` and hands tsc a throwaway config.
 *
 * Usage: node tests/typecheck.mjs  (or: npm run typecheck)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `here` is the tests/ directory; sources and the generated tsconfig live one level up.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const installRoot = resolve(root, "../../install");
const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
const releaseModules = join(installRoot, "releases", version, "node_modules");
if (!existsSync(releaseModules)) {
	console.error(`No installed pi release at ${releaseModules}`);
	process.exit(1);
}

const npmModules = resolve(root, "../../npm/node_modules");
const map = (specifier, ...candidates) => {
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Cannot resolve ${specifier}; tried:\n  ${candidates.join("\n  ")}`);
	return found;
};

const paths = {
	"@earendil-works/pi-coding-agent": [
		map("@earendil-works/pi-coding-agent", join(releaseModules, "@earendil-works/pi-coding-agent/dist/index.d.ts")),
	],
	"@earendil-works/pi-tui": [
		map("@earendil-works/pi-tui", join(releaseModules, "@earendil-works/pi-tui/dist/index.d.ts")),
	],
	"@earendil-works/pi-ai": [
		map("@earendil-works/pi-ai", join(releaseModules, "@earendil-works/pi-ai/dist/index.d.ts")),
	],
	typebox: [map("typebox", join(releaseModules, "typebox/build/index.d.mts"))],
	// `@juicesharp/rpiv-config` (pulled in by the vendored dialog) imports this subpath; without
	// the mapping its own sources fail to typecheck from here.
	"typebox/value": [map("typebox/value", join(releaseModules, "typebox/build/value/index.d.mts"))],
	// Optional: only present when rpiv-i18n is installed; the vendored bridge falls back
	// to English when it is missing, so a miss here is not an error.
	"@juicesharp/rpiv-i18n": [join(npmModules, "@juicesharp/rpiv-i18n/index.ts")],
};

/** Entry points typechecked from here; every module reachable from them is checked too. */
const SOURCES = [
	"src/index.ts",
	"src/questionnaire.ts",
	"src/extract.ts",
	"src/format.ts",
	"src/config.ts",
];

const config = {
	compilerOptions: {
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "bundler",
		allowImportingTsExtensions: true,
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		types: [],
		baseUrl: root,
		paths,
	},
	include: SOURCES,
};

// Written at the package root so `include` and relative paths resolve identically to a
// hand-run `tsc -p .`; removed again below.
const configPath = join(root, "tsconfig.generated.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));
let output = "";
try {
	output = execFileSync(`npx -y -p typescript@5.7 tsc --noEmit -p "${configPath}"`, {
		encoding: "utf8",
		// One command string rather than argv + shell: on Windows `npx` is a `.cmd` shim, and
		// passing argv alongside `shell: true` makes Node emit a security deprecation warning.
		shell: true,
		// Without this, `npm exec` re-resolves `typescript@5.7` against the registry on every
		// run: ~30s of the ~35s the typecheck used to take, for a package that was already in
		// the npx cache. Preferring the cache keeps it at ~1s and still downloads on a cold cache.
		env: { ...process.env, npm_config_prefer_offline: "true" },
	});
} catch (error) {
	output = String(error.stdout ?? "") + String(error.stderr ?? "");
} finally {
	rmSync(configPath, { force: true });
}

// No baseline anymore: the vendored dialog is part of this package, so its old upstream
// strictness complaints were fixed rather than tolerated. Any error now fails the run.
const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
if (errors.length > 0) {
	console.error(`\nType errors (${errors.length}):`);
	for (const line of errors) console.error(`  ${line}`);
	process.exit(1);
}
console.log(`Typecheck passed for ${SOURCES.join(", ")}`);
