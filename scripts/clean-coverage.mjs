import { rm } from 'node:fs/promises';

const coverageDirectory = new URL('../coverage/node-lower/', import.meta.url);

await rm(coverageDirectory, { recursive: true, force: true });
