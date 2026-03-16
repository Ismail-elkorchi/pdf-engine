import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const runtimeCommands = {
  node: {
    command: process.execPath,
    args: ['--version'],
    required: true
  },
  deno: {
    command: 'deno',
    args: ['--version'],
    required: false
  },
  bun: {
    command: 'bun',
    args: ['--version'],
    required: false
  }
};

async function run() {
  const mode = parseMode(process.argv.slice(2));
  const root = process.cwd();
  const policyPath = path.join(root, 'tools', 'runtime-versions.json');
  const packagePath = path.join(root, 'package.json');

  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const failures = [];

  verifyNodeEngineFloor(policy, packageManifest, failures);

  for (const runtimeName of Object.keys(runtimeCommands)) {
    const policyEntry = policy[runtimeName];
    if (!policyEntry || typeof policyEntry.floor !== 'string' || typeof policyEntry.pinned !== 'string') {
      failures.push(`${runtimeName}: runtime policy is incomplete`);
      continue;
    }

    const installedVersion = detectRuntimeVersion(runtimeName);
    if (!installedVersion) {
      if (runtimeCommands[runtimeName].required) {
        failures.push(`${runtimeName}: runtime is not available on PATH`);
      }
      continue;
    }

    const floorVersion = parseSemver(policyEntry.floor);
    const pinnedVersion = parseSemver(policyEntry.pinned);
    if (!floorVersion || !pinnedVersion) {
      failures.push(`${runtimeName}: runtime policy contains an invalid semver`);
      continue;
    }

    const comparator = mode === 'pinned' ? pinnedVersion : floorVersion;
    const comparison = compareSemver(installedVersion, comparator);
    const satisfiesPolicy = mode === 'pinned' ? comparison === 0 : comparison >= 0;
    if (!satisfiesPolicy) {
      const expectedLabel = mode === 'pinned' ? `pinned ${pinnedVersion.raw}` : `floor ${floorVersion.raw}`;
      failures.push(`${runtimeName}: installed ${installedVersion.raw} does not satisfy ${expectedLabel}`);
      continue;
    }

    const policyLabel = mode === 'pinned' ? `pinned=${pinnedVersion.raw}` : `floor=${floorVersion.raw}`;
    process.stdout.write(`[runtime-policy] ${runtimeName}: installed=${installedVersion.raw} ${policyLabel}\n`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[runtime-policy] ${failure}\n`);
    }
    process.exitCode = 1;
  }
}

function parseMode(argumentsList) {
  for (const argument of argumentsList) {
    if (argument === '--mode=minimum') return 'minimum';
    if (argument === '--mode=pinned') return 'pinned';
  }
  return 'minimum';
}

function verifyNodeEngineFloor(policy, packageManifest, failures) {
  const expectedFloor = policy?.node?.floor;
  const actualEngineFloor = packageManifest?.engines?.node;
  const expectedRange = typeof expectedFloor === 'string' ? `>=${expectedFloor}` : null;
  if (!expectedRange) {
    failures.push('package.json: node floor policy is missing');
    return;
  }
  if (actualEngineFloor !== expectedRange) {
    failures.push(`package.json: engines.node must equal ${expectedRange}, found ${String(actualEngineFloor ?? 'undefined')}`);
  }
}

function detectRuntimeVersion(runtimeName) {
  const runtimeCommand = runtimeCommands[runtimeName];
  const commandResult = spawnSync(runtimeCommand.command, runtimeCommand.args, {
    encoding: 'utf8'
  });

  if (commandResult.error) {
    if (commandResult.error.code === 'ENOENT') {
      return null;
    }
    throw commandResult.error;
  }

  if (commandResult.status !== 0) {
    throw new Error(`${runtimeName} version command failed: ${commandResult.stderr || commandResult.stdout || 'unknown error'}`);
  }

  const output = `${commandResult.stdout || ''}\n${commandResult.stderr || ''}`.trim();
  const parsedVersion = extractSemver(output);
  if (!parsedVersion) {
    throw new Error(`${runtimeName} version output is invalid: ${output || 'empty output'}`);
  }
  return parsedVersion;
}

function extractSemver(output) {
  const normalizedOutput = String(output).replaceAll('\n', ' ');
  let token = '';

  for (let index = 0; index < normalizedOutput.length; index += 1) {
    const character = normalizedOutput[index];
    if (character === ' ' || character === '\t') {
      const parsedVersion = parseSemver(token);
      if (parsedVersion) {
        return parsedVersion;
      }
      token = '';
      continue;
    }
    token += character;
  }

  return parseSemver(token);
}

function parseSemver(value) {
  const rawValue = String(value).trim();
  if (rawValue.length === 0) {
    return null;
  }

  const normalized = rawValue.startsWith('v') ? rawValue.slice(1) : rawValue;
  const parts = normalized.split('.');
  const major = parts[0] ?? '';
  const minor = parts[1] ?? '0';
  const patch = parts[2] ?? '0';

  if (!isDigits(major) || !isDigits(minor) || !isDigits(patch)) {
    return null;
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    raw: `${major}.${minor}.${patch}`
  };
}

function compareSemver(leftVersion, rightVersion) {
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }
  return leftVersion.patch - rightVersion.patch;
}

function isDigits(value) {
  if (value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode < 48 || charCode > 57) {
      return false;
    }
  }

  return true;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
