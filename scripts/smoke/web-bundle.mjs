import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  write: false,
  sourcemap: false,
  logLevel: "silent",
});

if (result.outputFiles.length !== 1) {
  throw new Error(`Expected one browser bundle, received ${String(result.outputFiles.length)}.`);
}
const output = result.outputFiles[0];
if (output === undefined) {
  throw new Error("Browser bundle output is missing.");
}
const disallowedMarkers = ["node:", "__dirname", "__filename"];
const matched = disallowedMarkers.filter((marker) => output.text.includes(marker));
if (matched.length > 0) {
  throw new Error(`Browser bundle contains Node-only markers: ${matched.join(", ")}.`);
}
process.stdout.write(`${JSON.stringify({
  platform: "browser",
  entryPoint: output.path,
  bytes: output.contents.byteLength,
  nodeOnlyMarkers: matched,
}, null, 2)}\n`);
