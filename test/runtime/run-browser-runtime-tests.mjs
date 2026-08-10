import { mkdir, writeFile } from "node:fs/promises";

import { runBrowserSessionSuite } from "./browser-session-suite.mjs";

const browserName = readArg("--browser") ?? "chromium";
const reportPath = readArg("--report") ?? "reports/test-runtime-browser.json";
const report = await runBrowserSessionSuite(browserName);
await mkdir(new URL("../../reports/", import.meta.url), { recursive: true });
await mkdir(new URL(".", new URL(reportPath, new URL("../../", import.meta.url))), { recursive: true }).catch(() => undefined);
await writeFile(new URL(reportPath, new URL("../../", import.meta.url)), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readArg(name) {
  return process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
