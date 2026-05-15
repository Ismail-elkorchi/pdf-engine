import { execFileSync } from "node:child_process";

let commandOutput;

try {
  commandOutput = execFileSync("npm", ["outdated", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
    commandOutput = error.stdout;
  } else {
    throw error;
  }
}

const parsed = commandOutput?.trim() === "" ? {} : JSON.parse(commandOutput);
const staleEntries = [];
const peerCappedEntries = [];

for (const [name, details] of Object.entries(parsed)) {
  if (!details || typeof details !== "object") {
    continue;
  }

  const current = typeof details.current === "string" ? details.current : "";
  const wanted = typeof details.wanted === "string" ? details.wanted : "";
  const latest = typeof details.latest === "string" ? details.latest : "";

  if (current !== wanted) {
    staleEntries.push({ name, current, wanted, latest });
    continue;
  }

  if (latest !== "" && latest !== wanted) {
    peerCappedEntries.push({ name, current, wanted, latest });
  }
}

if (peerCappedEntries.length > 0) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "peer-capped",
        entries: peerCappedEntries,
      },
      null,
      2,
    )}\n`,
  );
}

if (staleEntries.length === 0) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        staleEntries: [],
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `${JSON.stringify(
    {
      status: "stale",
      staleEntries,
    },
    null,
    2,
  )}\n`,
);
process.exit(1);
