import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

const bins = ["dist/cli.js", "dist/mcp-server.js"];
const shebang = "#!/usr/bin/env node\n";

for (const rel of bins) {
  const p = path.resolve(rel);
  let text = readFileSync(p, "utf8");
  if (!text.startsWith("#!")) {
    text = shebang + text;
    writeFileSync(p, text);
  }
  try {
    chmodSync(p, 0o755);
  } catch {
    // Windows may ignore mode
  }
}
