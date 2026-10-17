import { readFileSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const scratch = join(root, ".pi/fixtures/core-sol/native-port");
const app = join(root, ".pi/fixtures/core-sol/executable/node_modules/bb-app");
const generated = join(scratch, "apps/server/src/native-executable-support");
const esbuild = join(scratch, "node_modules/.pnpm/@esbuild+linux-x64@0.25.12/node_modules/@esbuild/linux-x64/bin/esbuild");
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const rows = [
  { name: "server", path: join(app, "server/dist/native-registration-support.mjs"), before: "517dedeac6ee41de7aa3e416493481be42efcc0b02c7cf030d4acdeebdb5df3f" },
  { name: "daemon", path: join(app, "host-daemon/dist/native-registration-support.mjs"), before: "a7e74edf415fb150f2912427f3a201b7b4cc854832ff74b0baddb86eca81192c" },
];
for (const row of rows) {
  if (sha(row.path) !== row.before || existsSync(row.path + ".before-interop")) throw new Error("Unexpected artifact state; do not silently rerun or overwrite history");
}
for (const row of rows) {
  copyFileSync(row.path, row.path + ".before-interop");
  execFileSync(esbuild, [join(generated, `${row.name}.ts`), "--bundle", "--platform=node", "--format=esm", "--conditions=source", '--banner:js=import {createRequire as __nativeCreateRequire} from "node:module"; const require=__nativeCreateRequire(import.meta.url);', `--outfile=${row.path}`], { cwd: scratch, stdio: "inherit" });
  row.after = sha(row.path);
}
writeFileSync(join(root, "evidence/BB1/core-port-sol/executable/interop-artifacts.json"), JSON.stringify({ fix: "module-local Node createRequire at esbuild ESM output boundary", mainBundlesUnchanged: true, rows }, null, 2) + "\n");
console.log(JSON.stringify(rows, null, 2));
