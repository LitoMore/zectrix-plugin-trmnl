import {setTimeout as sleep} from 'node:timers/promises';
import {ApiError, downloadImage, getScreen, pushImage} from './api.js';
import {prepareImage} from './image.js';
import {hash, readState, statePath, writeState} from './state.js';

export class Bridge {
  constructor(config, {now = Date.now, log = console.log} = {}) {
    this.config = config;
    this.now = now;
    this.log = log;
    this.path = statePath(config);
    this.pending = null;
    this.failures = 0;
  }

  async tick({force = false} = {}) {
    const config = this.config;
    this.state ??= await readState(this.path);
    const wait = (this.state.nextPollAt - this.now()) / 1000;
    if (!force && wait > 0) return {status: 'waiting', delay: Math.ceil(wait)};
    let delay = this.pending?.delay ?? config.interval;
    try {
      if (!this.pending) {
        const screen = await getScreen(config);
        this.pending = screen;
        delay = screen.delay;
        // Persist pacing before downloading: /api/display advances the playlist.
        this.state.nextPollAt = this.now() + delay * 1000;
        await writeState(config, this.path, this.state);
      }
      this.pending.png ??= await prepareImage(await downloadImage(config, this.pending.imageUrl), config.fit);
      const digest = hash(this.pending.png);
      let status = 'unchanged';
      if (digest !== this.state.lastHash) {
        await pushImage(config, this.pending.png);
        this.state.lastHash = digest;
        status = 'pushed';
      }
      this.state.nextPollAt = this.now() + delay * 1000;
      await writeState(config, this.path, this.state);
      this.pending = null;
      this.failures = 0;
      return {status, delay};
    } catch (error) {
      this.failures++;
      delay = Math.max(delay, error.retryAfter ?? 0,
        Math.min(config.retryMaxDelay, config.interval * 2 ** Math.min(this.failures - 1, 16)));
      this.state.nextPollAt = this.now() + delay * 1000;
      await writeState(config, this.path, this.state);
      if (error instanceof ApiError && !error.retryable) this.pending = null;
      // Keep a pending image for transient failures so retrying does not advance the playlist.
      throw error;
    }
  }

  async run(signal, {force = false} = {}) {
    while (!signal.aborted) {
      let delay;
      const forceAttempt = force;
      force = false;
      try {
        const result = await this.tick({force: forceAttempt});
        delay = result.delay;
        this.log(`${result.status}; next attempt in ${delay}s`);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        this.log(error.message);
        if (!error.retryable) throw error;
        delay = Math.max(1, Math.ceil((this.state.nextPollAt - this.now()) / 1000));
        this.log(`retry in ${delay}s`);
      }
      // Timer limit is ~24 days. Long server delays are honored in multiple sleeps.
      try { await sleep(Math.min(delay * 1000, 2_147_483_647), undefined, {signal}); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  }
}
