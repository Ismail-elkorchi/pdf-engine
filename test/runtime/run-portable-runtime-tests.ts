import { runPortableRuntimeSuite } from "../shared/portable-runtime-suite.ts";

const reportPath = readArg("--report");

try {
  const report = await runPortableRuntimeSuite();
  await writeTextFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeStdout(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  writeStderr(`${message}\n`);
  exitProcess(1);
}

function readArg(prefix: string): string | undefined {
  const arg = readArgs().find((entry) => entry.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : undefined;
}

function readArgs(): readonly string[] {
  if (typeof Deno !== "undefined") {
    return Deno.args;
  }

  if (typeof Bun !== "undefined") {
    return Bun.argv.slice(2);
  }

  if (typeof process !== "undefined") {
    return process.argv.slice(2);
  }

  return [];
}

async function writeTextFile(path: string | undefined, value: string): Promise<void> {
  if (!path) {
    return;
  }

  if (typeof Deno !== "undefined") {
    await ensureParentDirectory(path);
    await Deno.writeTextFile(path, value);
    return;
  }

  if (typeof Bun !== "undefined") {
    await Bun.write(path, value);
    return;
  }

  if (typeof process !== "undefined") {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, "utf8");
  }
}

async function ensureParentDirectory(path: string): Promise<void> {
  const lastSlashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlashIndex <= 0) {
    return;
  }

  const directory = path.slice(0, lastSlashIndex);
  if (typeof Deno !== "undefined") {
    await Deno.mkdir(directory, { recursive: true });
  }
}

function writeStdout(value: string): void {
  if (typeof Deno !== "undefined") {
    Deno.stdout.writeSync(new TextEncoder().encode(value));
    return;
  }

  if (typeof process !== "undefined") {
    process.stdout.write(value);
  }
}

function writeStderr(value: string): void {
  if (typeof Deno !== "undefined") {
    Deno.stderr.writeSync(new TextEncoder().encode(value));
    return;
  }

  if (typeof process !== "undefined") {
    process.stderr.write(value);
  }
}

function exitProcess(code: number): never {
  if (typeof Deno !== "undefined") {
    Deno.exit(code);
  }

  if (typeof process !== "undefined") {
    process.exit(code);
  }

  throw new Error(`Unable to exit with code ${String(code)} in the current runtime.`);
}
