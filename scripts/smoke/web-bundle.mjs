import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/index.ts", "src/viewer.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: "out",
  write: false,
  sourcemap: false,
  logLevel: "silent",
});

if (result.outputFiles.length !== 2) {
  throw new Error(`Expected exactly two browser bundle outputs, received ${result.outputFiles.length}.`);
}

const disallowedMarkers = ["node:", "require(", "__dirname", "__filename"];
const bundleChecks = result.outputFiles.map((outputFile) => {
  const matched = disallowedMarkers.filter((marker) => outputFile.text.includes(marker));
  if (matched.length > 0) {
    throw new Error(`Browser bundle ${outputFile.path} contains Node-only markers: ${matched.join(", ")}.`);
  }

  return {
    path: outputFile.path,
    bytes: outputFile.contents.byteLength,
    nodeOnlyMarkers: matched,
  };
});

console.log(
  JSON.stringify(
    {
      platform: "browser",
      entryPoints: bundleChecks,
    },
    null,
    2,
  ),
);
