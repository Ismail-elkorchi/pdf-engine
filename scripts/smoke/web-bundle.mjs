import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  sourcemap: false,
  logLevel: "silent",
});

if (result.outputFiles.length !== 1) {
  throw new Error(`Expected exactly one browser bundle output, received ${result.outputFiles.length}.`);
}

const code = result.outputFiles[0].text;
const disallowedMarkers = ["node:", "require(", "__dirname", "__filename"];
const matched = disallowedMarkers.filter((marker) => code.includes(marker));

if (matched.length > 0) {
  throw new Error(`Browser bundle contains Node-only markers: ${matched.join(", ")}.`);
}

console.log(
  JSON.stringify(
    {
      platform: "browser",
      bytes: result.outputFiles[0].contents.byteLength,
      nodeOnlyMarkers: matched,
    },
    null,
    2,
  ),
);
