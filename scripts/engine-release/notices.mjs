// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Assembles THIRD_PARTY_NOTICES.md for a released engine, which distributes more than the
// repository's own code: the Wasm core crates, the npm packages esbuild inlined, the workerd
// binary and the bundled fonts. The npm and font attributions come from the checkout; the Rust
// inventory comes from cargo-about, which needs a vendor tree and so stays in the workflow.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
// The workspace packages whose runtime dependencies end up inside the shipped bundles.
const ENTRY_PACKAGES = [
  "packages/engine",
  "packages/page-script",
  "packages/dom-shim",
  "packages/script-gate",
  "packages/page-renderer",
  "packages/worker-script",
];
const LICENSE_FILES = /^(LICEN[SC]E|COPYING|NOTICE|UNLICENSE)(\.|$)/i;

function parseArgs(argv) {
  const opt = {
    root: DEFAULT_ROOT,
    out: null,
    rustNotices: null,
    workerdNotice: null,
    requireRust: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--root") opt.root = resolve(next());
    else if (arg === "--out") opt.out = resolve(next());
    else if (arg === "--rust-notices") opt.rustNotices = resolve(next());
    else if (arg === "--workerd-notice") opt.workerdNotice = resolve(next());
    else if (arg === "--require-rust") opt.requireRust = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!opt.out) throw new Error("--out is required");
  return opt;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function licenseTexts(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => LICENSE_FILES.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trim() }));
}

// pnpm links each package's own dependencies into <package>/node_modules, so the graph can be
// walked by directory without a resolver or the network.
function collectNpm(root) {
  const seen = new Map();
  const queue = ENTRY_PACKAGES.map((p) => join(root, p));
  while (queue.length > 0) {
    const dir = queue.shift();
    const manifest = readJson(join(dir, "package.json"));
    if (!manifest) continue;
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (manifest.dependencies[name].startsWith("workspace:")) continue;
      const linked = join(dir, "node_modules", name);
      if (!existsSync(join(linked, "package.json"))) continue;
      let real;
      try {
        real = realpathSync(linked);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      const dep = readJson(join(real, "package.json"));
      if (!dep) continue;
      seen.set(real, {
        key: `${dep.name}@${dep.version}`,
        license: dep.license ?? (dep.licenses ?? []).map((l) => l.type).join(" OR ") ?? "",
        dir: real,
      });
      queue.push(real);
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function fontAttributions(root) {
  const dir = join(root, "packages/engine/public/fonts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(txt|md)$/i.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trim() }));
}

function section(title, body) {
  return `## ${title}\n\n${body.trim()}\n`;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const parts = [];
  parts.push(
    "# Third-party notices\n\n" +
      "This release bundles the Kitesurf engine — its Rust crates compiled to WebAssembly and the\n" +
      "npm packages inlined into the Worker bundle — together with the workerd runtime and the\n" +
      "bundled fonts. The attributions below cover them; Kitesurf itself is Apache-2.0 (see\n" +
      "LICENSE and NOTICE).\n",
  );

  if (opt.rustNotices && existsSync(opt.rustNotices)) {
    parts.push(
      section("Rust crates in the WebAssembly core", readFileSync(opt.rustNotices, "utf8")),
    );
  } else if (opt.requireRust) {
    // A release must not ship without the Rust inventory: the Wasm core is most of the code.
    throw new Error(
      "cargo-about produced no inventory (--require-rust); pass --rust-notices with its output",
    );
  } else {
    parts.push(
      section(
        "Rust crates in the WebAssembly core",
        "MISSING: cargo-about produced no inventory for this build. The release is not compliant\n" +
          "until it does — see .github/workflows/release-engine.yml.",
      ),
    );
  }

  const packages = collectNpm(opt.root).map((pkg) => ({ ...pkg, texts: licenseTexts(pkg.dir) }));
  const rows = packages
    .map(
      (p) =>
        `| ${p.key} | ${p.license || "see text"} | ${p.texts.length > 0 ? "included" : "declared only"} |`,
    )
    .join("\n");
  parts.push(
    section(
      "npm packages in the Worker bundle",
      `${packages.length} packages, resolved from the workspace's runtime dependencies. This is a\n` +
        `superset of what esbuild inlined, so it lists more than the bundle contains.\n\n` +
        `| Package | License | License text |\n| --- | --- | --- |\n${rows}\n`,
    ),
  );

  let text = parts.join("\n");
  for (const pkg of packages) {
    for (const entry of pkg.texts) {
      text += `\n### ${pkg.key} — ${entry.name}\n\n\`\`\`\n${entry.text}\n\`\`\`\n`;
    }
  }

  for (const font of fontAttributions(opt.root)) {
    text += `\n### bundled font — ${font.name}\n\n\`\`\`\n${font.text}\n\`\`\`\n`;
  }

  const workerdNotice = opt.workerdNotice ?? join(DEFAULT_ROOT, ".tmp/WORKERD-LICENSE");
  if (existsSync(workerdNotice)) {
    text += `\n### workerd — Apache-2.0\n\n\`\`\`\n${readFileSync(workerdNotice, "utf8").trim()}\n\`\`\`\n`;
  }

  // A few packages ship no license file of their own; say so rather than dropping them.
  const declaredOnly = packages.filter((pkg) => pkg.texts.length === 0);
  if (declaredOnly.length > 0) {
    const body = declaredOnly
      .map((pkg) => `- ${pkg.key} — declares ${pkg.license || "no SPDX license"}`)
      .join("\n");
    text += `\n## Packages that ship no license file\n\n${body}\n`;
  }

  writeFileSync(opt.out, text);
  const missing = declaredOnly;
  console.log(
    `[notices] ${packages.length} npm packages, ${missing.length} without a license file, ` +
      `rust notices ${opt.rustNotices ? "included" : "MISSING"}`,
  );
  if (missing.length > 0) {
    console.log(`[notices] no license file found in: ${missing.map((p) => p.key).join(", ")}`);
  }
}

main();
