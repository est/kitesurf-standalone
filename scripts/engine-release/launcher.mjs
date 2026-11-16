// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Generates the workerd config that serves a built engine dist, and optionally runs it.
// A released engine has neither wrangler nor miniflare to build that config from wrangler.jsonc,
// so the release pipeline writes it once with --print-config and the shipped launcher only execs
// workerd. `--dist <dir> --print-config` writes a config to stdout; `--runtime` serves it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

function parseArgs(argv) {
  const opt = {
    dist: join(REPO, ".tmp/engine-dist"),
    workerd: join(REPO, ".tmp/workerd/package/bin/workerd"),
    runtime: join(REPO, ".tmp/runtime"),
    port: Number(process.env.KITESURF_PORT ?? 8787),
    diskPath: null,
    vars: {},
    printConfig: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--dist") opt.dist = resolve(next());
    else if (arg === "--workerd") opt.workerd = resolve(next());
    else if (arg === "--runtime") opt.runtime = resolve(next());
    else if (arg === "--disk-path") opt.diskPath = next();
    else if (arg === "--port") opt.port = Number(next());
    else if (arg === "--print-config") opt.printConfig = true;
    else if (arg === "--verbose") opt.verbose = true;
    else if (arg === "--var") {
      const pair = next();
      const at = pair.indexOf(":");
      if (at < 1) throw new Error(`--var wants KEY:VALUE, got ${pair}`);
      opt.vars[pair.slice(0, at)] = pair.slice(at + 1);
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(opt.port) || opt.port < 1 || opt.port > 65535)
    throw new Error(`bad --port ${opt.port}`);
  return opt;
}

// Must match the module rules the engine's harnesses bundle with, in particular the text rule
// for `*.glue.js`: the engine imports its wasm-bindgen glue as a string.
const RULES = [
  [/\.wasm$/, "wasm"],
  [/\.glue\.js$/, "text"],
  [/\.css$/, "text"],
  [/\.dat$/, "text"],
  [/\.woff2$/, "data"],
  [/\.bin$/, "data"],
];
// The assets tree is read through the FONT_ASSETS disk service at runtime, not as modules.
const ASSET_PREFIXES = ["fonts/", "rbi/"];
const SKIP_FILES = new Set(["engine-mf.json", "_headers", "README.md"]);
// Not a module and not an asset: 5 MB of sourcemap no one debugs a shipped engine with.
const SKIP_SUFFIXES = [".map"];

function classify(name) {
  for (const [pattern, type] of RULES) if (pattern.test(name)) return type;
  return "esModule";
}

function walk(root, dir = "") {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = dir + entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel + "/"));
    else out.push(rel);
  }
  return out;
}

function quote(text) {
  return '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function collectModules(dist) {
  // index.js is the bundled entry; every other module is one of the rules above. Anything else
  // was already inlined by esbuild, so a second copy would only bloat the config.
  const modules = [{ name: "index.js", path: "index.js", type: "esModule" }];
  for (const rel of walk(dist)) {
    if (rel === "index.js") continue;
    if (ASSET_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    if (SKIP_FILES.has(rel) || SKIP_SUFFIXES.some((s) => rel.endsWith(s))) continue;
    const type = classify(rel);
    if (type === "esModule") continue;
    modules.push({ name: rel, path: rel, type });
  }
  return modules;
}

function engineOptions(dist) {
  // `wrangler deploy --dry-run` writes the local Worker options next to the bundle: the
  // compatibility date and flags, the vars, the worker loader and the assets directory.
  const file = join(dist, "engine-mf.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function buildConfig(opt) {
  if (!existsSync(join(opt.dist, "index.js")))
    throw new Error(`no index.js in ${opt.dist} — build the dist first`);

  const mf = engineOptions(opt.dist);
  const flags = mf.compatibilityFlags ?? ["global_fetch_strictly_public"];
  const modules = collectModules(opt.dist);
  const bindings = collectBindings(opt);
  const assetsDir = mf.assets?.directory
    ? resolve(opt.dist, mf.assets.directory)
    : existsSync(join(opt.dist, "fonts"))
      ? opt.dist
      : null;
  if (assetsDir)
    bindings.push({ name: mf.assets?.binding ?? "FONT_ASSETS", text: null, kind: "disk" });

  // `embed` resolves relative to this file, so every path here must stay relative to it.
  const embed = (target) => quote(relative(resolve(opt.runtime), target));
  const lines = [];
  const emit = (line) => lines.push(line);
  emit(`# Generated by scripts/engine-release/launcher.mjs — do not edit.`);
  emit(`using Workerd = import "/workerd/workerd.capnp";`);
  emit(``);
  emit(`const config :Workerd.Config = (`);
  emit(`  services = [`);
  emit(`    ( name = "main", worker = .engineWorker ),`);
  if (assetsDir)
    emit(`    ( name = "assets", disk = ( path = ${quote(opt.diskPath ?? assetsDir)} ) ),`);
  // Defining "internet" replaces the implicit service, so it must repeat the TLS setup:
  // without tlsOptions every https fetch fails with "this HttpClient doesn't support HTTPS".
  emit(`    ( name = "internet",`);
  emit(`      network = (`);
  emit(`        allow = ["public", "private", "local"],`);
  emit(`        tlsOptions = ( trustBrowserCas = true ),`);
  emit(`      )`);
  emit(`    ),`);
  emit(`  ],`);
  emit(`  sockets = [`);
  emit(`    ( name = "http", address = "127.0.0.1:${opt.port}", http = (), service = "main" ),`);
  emit(`  ],`);
  emit(`);`);
  emit(``);
  emit(`const engineWorker :Workerd.Worker = (`);
  emit(`  modules = [`);
  for (const module of modules)
    emit(
      `    ( name = ${quote(module.name)}, ${module.type} = embed ${embed(join(opt.dist, module.path))} ),`,
    );
  emit(`  ],`);
  emit(`  compatibilityDate = ${quote(mf.compatibilityDate ?? "2026-09-11")},`);
  emit(`  compatibilityFlags = [${flags.map(quote).join(", ")}],`);
  emit(`  bindings = [`);
  for (const binding of bindings) {
    if (binding.kind === "text")
      emit(`    ( name = ${quote(binding.name)}, text = ${quote(binding.text)} ),`);
    else if (binding.kind === "disk")
      emit(`    ( name = ${quote(binding.name)}, service = "assets" ),`);
    else if (binding.kind === "workerLoader")
      emit(`    ( name = ${quote(binding.name)}, workerLoader = () ),`);
  }
  emit(`  ],`);
  emit(`  globalOutbound = "internet",`);
  emit(`);`);
  emit(``);
  return { config: lines.join("\n"), modules, bindings, assetsDir };
}

function collectBindings(opt) {
  const vars = {
    KITESURF_ENV: "local",
    KITESURF_VERSION: "dev",
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS: "5",
    KITESURF_LAG_WATCHDOG: "1",
    // A headless browser on your own machine should reach your own machine.
    KITESURF_ALLOW_PRIVATE_NETWORK: "1",
    KITESURF_INSPECTOR_BASE_URL: "",
    ...opt.vars,
  };
  const bindings = Object.entries(vars).map(([name, text]) => ({ name, text, kind: "text" }));
  // The engine spawns a worker per page through this binding; workerd gates it behind
  // `--experimental`, which the launcher passes on the serve command line.
  bindings.push({ name: "LOADER", kind: "workerLoader" });
  return bindings;
}

function waitForExit(child) {
  return new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
}

const opt = parseArgs(process.argv.slice(2));
const built = buildConfig(opt);
if (opt.printConfig) {
  process.stdout.write(built.config);
  process.exit(0);
}
if (!existsSync(opt.workerd)) throw new Error(`no workerd at ${opt.workerd} (pass --workerd)`);
mkdirSync(opt.runtime, { recursive: true });
const configPath = join(opt.runtime, "config.capnp");
writeFileSync(configPath, built.config);

if (opt.verbose || process.env.KITESURF_VERBOSE === "1") {
  console.error(
    `[launcher] dist=${opt.dist}\n[launcher] assets=${built.assetsDir}\n` +
      `[launcher] modules=${built.modules.length} bindings=${built.bindings.length}\n` +
      `[launcher] config=${configPath}`,
  );
}

const args = ["serve", "--experimental", configPath];
if (opt.verbose) args.push("--verbose");
console.log(
  `[launcher] engine on http://127.0.0.1:${opt.port} (cdp ws://127.0.0.1:${opt.port}/devtools/browser)`,
);
const child = spawn(opt.workerd, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

// A rejected config makes workerd exit almost immediately, with the reason on stderr. Note that
// `workerd compile` cannot pre-validate the config: it rejects `--experimental`, which the
// workerLoader binding requires.
const early = await Promise.race([
  waitForExit(child),
  new Promise((done) => setTimeout(() => done(null), 3000)),
]);
if (early) {
  console.error(`[launcher] workerd exited (code ${early.code}) — see the error above`);
  process.exit(early.code || 1);
}
const { code, signal } = await waitForExit(child);
process.exit(signal ? 1 : (code ?? 0));
