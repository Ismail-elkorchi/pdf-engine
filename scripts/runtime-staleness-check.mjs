import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function run() {
  const root = process.cwd();
  const policyPath = path.join(root, 'tools', 'runtime-versions.json');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));

  const runtimeTargets = [
    { name: 'node', latest: latestNodeLts },
    { name: 'deno', latest: latestDenoStable },
    { name: 'bun', latest: latestBunStable }
  ];

  const failures = [];

  for (const runtimeTarget of runtimeTargets) {
    const runtimePolicy = policy[runtimeTarget.name];
    const stalenessPolicy = policy?.policy?.staleness?.[runtimeTarget.name];
    if (!runtimePolicy || typeof runtimePolicy.pinned !== 'string') {
      failures.push(`${runtimeTarget.name}: pinned runtime policy is missing`);
      continue;
    }

    const pinnedVersion = parseSemver(runtimePolicy.pinned);
    const floorVersion = parseSemver(runtimePolicy.floor);
    const latestVersion = await runtimeTarget.latest();
    if (!pinnedVersion || !latestVersion) {
      failures.push(`${runtimeTarget.name}: pinned or latest version is invalid`);
      continue;
    }

    const maxMajorLag = Number.isInteger(stalenessPolicy?.maxMajorLag) ? stalenessPolicy.maxMajorLag : 0;
    const maxMinorLag = Number.isInteger(stalenessPolicy?.maxMinorLag) ? stalenessPolicy.maxMinorLag : 0;

    process.stdout.write(
      `[runtime-staleness] ${runtimeTarget.name}: floor=${floorVersion ? floorVersion.raw : 'n/a'} pinned=${pinnedVersion.raw} latest=${latestVersion.raw}\n`
    );

    const majorLag = latestVersion.major - pinnedVersion.major;
    const minorLag = latestVersion.major === pinnedVersion.major ? latestVersion.minor - pinnedVersion.minor : 0;
    if (majorLag > maxMajorLag) {
      failures.push(`${runtimeTarget.name}: major lag ${majorLag} exceeds policy ${maxMajorLag}`);
      continue;
    }
    if (majorLag === 0 && minorLag > maxMinorLag) {
      failures.push(`${runtimeTarget.name}: minor lag ${minorLag} exceeds policy ${maxMinorLag}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[runtime-staleness] ${failure}\n`);
    }
    process.exitCode = 1;
  }
}

async function latestNodeLts() {
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) {
    throw new Error(`node index fetch failed: ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return null;
  }

  for (const item of payload) {
    if (!item || typeof item !== 'object' || !item.lts || typeof item.version !== 'string') {
      continue;
    }
    const parsedVersion = parseSemver(item.version);
    if (parsedVersion) {
      return parsedVersion;
    }
  }

  return null;
}

async function latestDenoStable() {
  return latestGitHubRelease('denoland', 'deno');
}

async function latestBunStable() {
  return latestGitHubRelease('oven-sh', 'bun');
}

async function latestGitHubRelease(owner, repository) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/releases/latest`, {
    headers: {
      'User-Agent': 'pdf-engine-runtime-staleness'
    }
  });

  if (!response.ok) {
    throw new Error(`${owner}/${repository} latest release fetch failed: ${response.status}`);
  }

  const payload = await response.json();
  return parseSemver(typeof payload.tag_name === 'string' ? payload.tag_name : '');
}

function parseSemver(value) {
  const rawValue = String(value).trim();
  if (rawValue.length === 0) {
    return null;
  }

  const normalized = normalizeVersionText(rawValue);
  if (!normalized) {
    return null;
  }
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

function normalizeVersionText(rawValue) {
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    const nextCharacter = rawValue[index + 1] ?? '';
    if (character === 'v' && isDigit(nextCharacter)) {
      return rawValue.slice(index + 1);
    }
    if (isDigit(character)) {
      return rawValue.slice(index);
    }
  }

  return null;
}

function isDigit(value) {
  if (value.length === 0) {
    return false;
  }

  const charCode = value.charCodeAt(0);
  return charCode >= 48 && charCode <= 57;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
