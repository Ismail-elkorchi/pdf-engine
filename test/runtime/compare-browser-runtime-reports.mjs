import { readFile } from "node:fs/promises";

const reportPaths = process.argv.slice(2);
if (reportPaths.length < 2) {
  throw new Error(
    "compare-browser-runtime-reports requires at least two report paths.",
  );
}

const reports = await Promise.all(
  reportPaths.map(async (reportPath) => ({
    reportPath,
    report: JSON.parse(await readFile(reportPath, "utf8")),
  })),
);

const baselineOracle = JSON.stringify(reports[0].report.oracle);
for (const { reportPath, report } of reports.slice(1)) {
  const candidateOracle = JSON.stringify(report.oracle);
  if (candidateOracle !== baselineOracle) {
    throw new Error(
      `Browser runtime oracle mismatch for ${reportPath}.\nExpected: ${baselineOracle}\nReceived: ${candidateOracle}`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      suite: "browser-runtime-parity",
      ok: true,
      comparedReports: reportPaths,
    },
    null,
    2,
  )}\n`,
);
