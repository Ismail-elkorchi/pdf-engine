import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runBrowserSessionSuite } from "../../test/runtime/browser-session-suite.mjs";

const browserName = readArg("--browser") ?? "chromium";
const reportPath = resolve(readArg("--report") ?? "reports/smoke-browser-runtime.json");
const report = await runBrowserSessionSuite(browserName);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readArg(name) {
  return process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
