import { readFile } from "node:fs/promises";

const reportPaths = process.argv.slice(2);
if (reportPaths.length < 2) {
  throw new Error("compare-runtime-reports requires at least two report paths.");
}

const reports = await Promise.all(
  reportPaths.map(async (reportPath) => ({
    reportPath,
    report: JSON.parse(await readFile(reportPath, "utf8")),
  })),
);

const baseline = JSON.stringify(reports[0].report.oracle);
for (const { reportPath, report } of reports.slice(1)) {
  const candidate = JSON.stringify(report.oracle);
  if (candidate !== baseline) {
    throw new Error(
      `Runtime oracle mismatch for ${reportPath}.\nExpected: ${baseline}\nReceived: ${candidate}`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      suite: "runtime-parity",
      ok: true,
      comparedReports: reportPaths,
    },
    null,
    2,
  )}\n`,
);
