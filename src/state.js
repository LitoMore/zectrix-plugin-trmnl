import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const hash = data => createHash('sha256').update(data).digest('hex');

export function statePath(config) {
  // State is scoped to the destination and rendering settings. No keys are persisted.
  const target = hash(JSON.stringify([config.zectrixBaseUrl, config.deviceId, config.pageId, config.dither]));
  return join(config.stateDir, `${target}.json`);
}

export async function readState(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.version !== 1 || !Number.isFinite(data.nextPollAt) || data.nextPollAt < 0
      || (data.lastHash !== null && !/^[a-f0-9]{64}$/.test(data.lastHash))) throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {version: 1, lastHash: null, nextPollAt: 0};
    throw new Error('Cannot read bridge state; inspect the state file before restarting');
  }
}

export async function writeState(config, path, state) {
  await mkdir(config.stateDir, {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, {mode: 0o600});
  await rename(temporary, path);
}
