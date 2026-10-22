// Keep the dashboard's viewer identical to a committed RollupX revision.
// Copying a fixed asset list excludes local artifacts and operator files.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/sync-quote-trace-viewer.mjs /path/to/rollupX");
const revision = execFileSync("git", ["-C", source, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
const assets = ["index.html", "model.js", "viewer.js", "style.css", "examples/nested-revert.json"];
const snapshots = assets.map(file => [file, execFileSync("git", [
  "-C", source, "show", `${revision}:tools/quote-trace-viewer/${file}`,
])]);
const destination = resolve(dirname(fileURLToPath(import.meta.url)), "../public/quote-trace");
for (const [file, contents] of snapshots) {
  const path = resolve(destination, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
await writeFile(resolve(destination, "SOURCE.md"), `# Quote trace viewer source

Verbatim assets from [eez-association/eez-rollupX at ${revision}](https://github.com/eez-association/eez-rollupX/tree/${revision}/tools/quote-trace-viewer).
The example contains public fixture accounts and synthetic local state.

Update through \`node scripts/sync-quote-trace-viewer.mjs /path/to/rollupX\`;
the script copies the source checkout's committed HEAD. Change the upstream
viewer first instead of maintaining a second implementation here.
Then run \`npm run test:debug\` before committing the updated assets.
`);
console.log(`Synced ${assets.length} quote viewer assets from ${revision}`);
