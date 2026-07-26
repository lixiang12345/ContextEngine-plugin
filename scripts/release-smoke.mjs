#!/usr/bin/env node
// Release acceptance smoke: installs a packed tarball into an empty
// directory and proves the CLI, MCP stdio, and HTTP entry points start and
// report one consistent version. Runs locally and in the release workflow:
//
//   node scripts/release-smoke.mjs <tarball> [--tag vX.Y.Z]
//
// Requires CONTEXTENGINE_DATABASE_URL to point at a reachable
// PostgreSQL+pgvector database (entry points connect on demand).
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [tarballArg, ...rest] = process.argv.slice(2);
if (!tarballArg) {
  console.error("usage: release-smoke.mjs <tarball> [--tag vX.Y.Z]");
  process.exit(2);
}
const tagIndex = rest.indexOf("--tag");
const tag = tagIndex >= 0 ? rest[tagIndex + 1] : null;
const tarball = path.resolve(tarballArg);
const databaseUrl = process.env.CONTEXTENGINE_DATABASE_URL;
if (!databaseUrl) {
  console.error("CONTEXTENGINE_DATABASE_URL is required for the HTTP/MCP smoke");
  process.exit(2);
}
const httpPort = Number(process.env.SMOKE_HTTP_PORT ?? 8899);

let failures = 0;
const ok = (label, detail = "") => console.log(`OK  ${label}${detail ? ` — ${detail}` : ""}`);
const fail = (label, detail = "") => {
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. Tarball digest — the auditable build evidence.
const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
console.log(`tarball ${path.basename(tarball)}`);
console.log(`sha256  ${sha256}`);

// 2. Clean install into an empty directory.
const installDir = await mkdtemp(path.join(os.tmpdir(), "ce-release-smoke-"));
try {
  await execFile("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: installDir,
  });
  const manifest = JSON.parse(
    await readFile(
      path.join(installDir, "node_modules/contextengine-plugin/package.json"),
      "utf8",
    ),
  );
  const version = manifest.version;
  ok("clean install", `contextengine-plugin@${version}`);

  // 3. Version consistency: tag and CHANGELOG must match the manifest.
  if (tag && tag !== `v${version}`) {
    fail("tag matches package version", `tag ${tag} vs version ${version}`);
  } else if (tag) {
    ok("tag matches package version", tag);
  }
  const changelog = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  if (new RegExp(`^## ${version.replaceAll(".", "\\.")}( |$)`, "m").test(changelog)) {
    ok("CHANGELOG has a release section", `## ${version}`);
  } else {
    fail("CHANGELOG has a release section", `missing "## ${version}"`);
  }

  const bin = (name) => path.join(installDir, "node_modules/.bin", name);
  const env = { ...process.env, CONTEXTENGINE_DATABASE_URL: databaseUrl };

  // 4. CLI entry point.
  const { stdout: cliVersion } = await execFile(bin("contextengine"), ["--version"], {
    cwd: installDir,
    env,
  });
  if (cliVersion.trim() === version) ok("CLI --version", cliVersion.trim());
  else fail("CLI --version", `${cliVersion.trim()} != ${version}`);

  // 5. MCP stdio entry point: initialize handshake reports the same version.
  await new Promise((resolve) => {
    const child = spawn(bin("contextengine-mcp"), [], {
      cwd: installDir,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      fail("MCP initialize", `no serverInfo within 15s: ${output.slice(0, 120)}`);
      resolve();
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      child.kill();
      try {
        const response = JSON.parse(output.slice(0, output.indexOf("\n")));
        const serverInfo = response.result?.serverInfo;
        if (serverInfo?.name === "contextengine" && serverInfo?.version === version) {
          ok("MCP initialize", `serverInfo ${serverInfo.version}`);
        } else {
          fail("MCP initialize", JSON.stringify(serverInfo));
        }
      } catch (error) {
        fail("MCP initialize", `unparsable response: ${String(error)}`);
      }
      resolve();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail("MCP initialize", String(error));
      resolve();
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "release-smoke", version: "1.0" },
        },
      })}\n`,
    );
  });

  // 6. HTTP entry point: health and an authenticated capability read.
  const http = spawn(bin("contextengine-http"), [], {
    cwd: installDir,
    env: {
      ...env,
      CONTEXTENGINE_HTTP_HOST: "127.0.0.1",
      CONTEXTENGINE_HTTP_PORT: String(httpPort),
      CONTEXTENGINE_HTTP_API_KEY: "release-smoke-key",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 30 && !healthy; attempt += 1) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${httpPort}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (healthy) ok("HTTP /health");
    else fail("HTTP /health", "not reachable within 30s");
    if (healthy) {
      const capabilities = await fetch(`http://127.0.0.1:${httpPort}/v1/capabilities`, {
        headers: { authorization: "Bearer release-smoke-key" },
      });
      if (capabilities.ok) {
        const body = await capabilities.json();
        if (body.storage === "postgresql+pgvector") ok("HTTP /v1/capabilities");
        else fail("HTTP /v1/capabilities", "unexpected payload");
      } else {
        fail("HTTP /v1/capabilities", String(capabilities.status));
      }
    }
  } finally {
    http.kill("SIGTERM");
    await new Promise((resolve) => {
      http.on("exit", resolve);
      setTimeout(() => {
        http.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
  }
} finally {
  await rm(installDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nRELEASE SMOKE FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nRELEASE SMOKE PASSED");
