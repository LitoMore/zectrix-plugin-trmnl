import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import sharp from 'sharp';
import {loadConfig} from '../src/config.js';
import {Bridge} from '../src/bridge.js';
import {getScreen, listDevices, pushImage, request} from '../src/api.js';
import {prepareImage} from '../src/image.js';
import {readState, statePath} from '../src/state.js';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'zectrix-trmnl-'));
  const image = await sharp({create: {width: 800, height: 480, channels: 3, background: '#000'}}).png().toBuffer();
  const calls = {screens: 0, downloads: 0, uploads: [], imageHeaders: []};
  const control = {status: 200, code: 0, retryAfter: '900', screenStatus: 0, image,
    uploadData: {pushedPages: 1, pageId: '2'}};
  let base;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/api/display' || req.url === '/api/current_screen') {
        calls.screens++;
        assert.equal(req.headers['access-token'], 'trmnl-test-secret');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({status: control.screenStatus, image_url: `${base}/redirect`, refresh_rate: '600'}));
      } else if (req.url === '/redirect') {
        calls.imageHeaders.push(req.headers);
        res.writeHead(302, {location: `${base}/image`}).end();
      } else if (req.url === '/image') {
        calls.downloads++;
        calls.imageHeaders.push(req.headers);
        res.end(control.image);
      } else if (req.url === '/open/v1/devices') {
        assert.equal(req.headers['x-api-key'], 'zectrix-test-secret');
        res.end(JSON.stringify({code: 0, data: [{deviceId: 'AA:BB'}]}));
      } else if (req.url === '/open/v1/devices/AA%3ABB/display/image') {
        assert.equal(req.headers['x-api-key'], 'zectrix-test-secret');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const form = await new Response(body, {headers: {'Content-Type': req.headers['content-type']}}).formData();
        calls.uploads.push(form);
        res.writeHead(control.status, {'Retry-After': control.retryAfter});
        res.end(JSON.stringify({code: control.code, data: control.uploadData}));
      } else res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end();
      calls.error = error;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, {recursive: true, force: true});
    if (calls.error) throw calls.error;
  });
  const config = loadConfig({TRMNL_BASE_URL: base, ZECTRIX_BASE_URL: base,
    TRMNL_API_KEY: 'trmnl-test-secret', ZECTRIX_API_KEY: 'zectrix-test-secret',
    ZECTRIX_DEVICE_ID: 'AA:BB', ZECTRIX_PAGE_ID: '2', STATE_DIR: stateDir});
  let time = 1_000_000;
  return {config, calls, control, image, advance: seconds => { time += seconds * 1000; },
    bridge: () => new Bridge(config, {now: () => time, log: () => {}})};
}

test('syncs multipart PNG, preserves aspect ratio, and deduplicates across restarts', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listDevices(f.config), [{deviceId: 'AA:BB'}]);
  assert.deepEqual(await f.bridge().tick(), {status: 'pushed', delay: 600});
  const form = f.calls.uploads[0];
  assert.equal(form.get('pageId'), '2');
  assert.equal(form.get('dither'), 'true');
  assert.equal(form.get('images').type, 'image/png');
  const png = Buffer.from(await form.get('images').arrayBuffer());
  const {data, info} = await sharp(png).raw().toBuffer({resolveWithObject: true});
  assert.equal(info.width, 400);
  assert.equal(info.height, 300);
  assert.equal(data[0], 255); // White padding above the 400×240 image.
  assert.equal(data[(150 * 400 + 200) * info.channels], 0);
  for (const headers of f.calls.imageHeaders) {
    assert.equal(headers['access-token'], undefined);
    assert.equal(headers['x-api-key'], undefined);
  }
  assert.deepEqual(await f.bridge().tick(), {status: 'waiting', delay: 600});
  assert.equal(f.calls.screens, 1);
  f.advance(600);
  assert.deepEqual(await f.bridge().tick(), {status: 'unchanged', delay: 600});
  assert.equal(f.calls.uploads.length, 1);
  const state = await readFile(statePath(f.config), 'utf8');
  assert.ok(!state.includes('secret'));
});

test('force bypasses persisted waiting once while preserving deduplication and subsequent pacing', async t => {
  const f = await fixture(t);
  await f.bridge().tick();
  f.advance(100);
  const bridge = f.bridge();
  assert.deepEqual(await bridge.tick(), {status: 'waiting', delay: 500});
  assert.deepEqual(await bridge.tick({force: true}), {status: 'unchanged', delay: 600});
  assert.equal(f.calls.screens, 2);
  assert.equal(f.calls.uploads.length, 1);
  assert.deepEqual(await f.bridge().tick(), {status: 'waiting', delay: 600});
});

test('forced continuous mode only forces its first attempt', async () => {
  const bridge = new Bridge({stateDir: tmpdir()});
  const controller = new AbortController();
  const forces = [];
  bridge.log = () => {};
  bridge.tick = async ({force}) => {
    forces.push(force);
    if (forces.length === 2) controller.abort();
    return {status: 'unchanged', delay: 0};
  };
  await bridge.run(controller.signal, {force: true});
  assert.deepEqual(forces, [true, false]);
});

test('retry honors Retry-After and reuses the image without advancing the playlist', async t => {
  const f = await fixture(t);
  const bridge = f.bridge();
  f.control.status = 429;
  await assert.rejects(bridge.tick(), {retryable: true, retryAfter: 900});
  assert.equal((await readState(statePath(f.config))).lastHash, null);
  assert.deepEqual(await bridge.tick(), {status: 'waiting', delay: 900});
  f.advance(900);
  f.control.status = 200;
  assert.equal((await bridge.tick()).status, 'pushed');
  assert.equal(f.calls.screens, 1);
  assert.equal(f.calls.downloads, 1);
  assert.equal(f.calls.uploads.length, 2);
});

test('failed business response preserves the previously successful hash', async t => {
  const f = await fixture(t);
  const bridge = f.bridge();
  await bridge.tick();
  const previous = (await readState(statePath(f.config))).lastHash;
  f.advance(600);
  f.control.image = await sharp({create: {
    width: 400, height: 300, channels: 3, background: '#fff',
  }}).png().toBuffer();
  f.control.code = 123;
  await assert.rejects(bridge.tick(), /unsuccessful or missing code/);
  assert.equal((await readState(statePath(f.config))).lastHash, previous);
});

test('current_screen accepts status 200; unconfigured TRMNL responses are rejected', async t => {
  const f = await fixture(t);
  f.config.mode = 'current_screen';
  f.control.screenStatus = 200;
  assert.equal((await getScreen(f.config)).delay, 600);
  f.control.screenStatus = 202;
  await assert.rejects(getScreen(f.config), /unsuccessful or missing status/);
});

test('download size limit is enforced', async t => {
  const f = await fixture(t);
  await assert.rejects(request(`${f.config.trmnlBaseUrl}/image`, {limit: 10}), /size limit/);
});

test('accepts a confirmed upload without page echo and a numeric string count', async t => {
  const f = await fixture(t);
  for (const data of [{pushedPages: 1}, {pushedPages: '1', pageId: 2}]) {
    f.control.uploadData = data;
    await assert.doesNotReject(pushImage(f.config, f.image));
  }
});

test('unconfirmed or wrong-page uploads do not persist a successful image hash', async t => {
  const f = await fixture(t);
  for (const [data, pattern] of [
    [{pushedPages: 0, pageId: '2'}, /pushedPages=0/],
    [{pageId: '2'}, /pushedPages=missing/],
    [{pushedPages: 1, pageId: '3'}, /expected=2, pageId="3"/],
    [{pushedPages: true}, /pushedPages=invalid/],
  ]) {
    f.control.uploadData = data;
    await assert.rejects(f.bridge().tick(), pattern);
    assert.equal((await readState(statePath(f.config))).lastHash, null);
    f.advance(600);
  }
});

test('invalid images are rejected; transparent images flatten to white', async () => {
  await assert.rejects(prepareImage(Buffer.from('not an image')), /could not be decoded/);
  const transparent = await sharp({create: {
    width: 10, height: 10, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0},
  }}).png().toBuffer();
  const pixels = await sharp(await prepareImage(transparent)).raw().toBuffer();
  assert.ok(pixels.every(value => value === 255));
});

test('configuration validates values without exposing secrets', () => {
  const env = {TRMNL_API_KEY: 'secret', ZECTRIX_API_KEY: 'secret', ZECTRIX_DEVICE_ID: 'AA:BB'};
  assert.throws(() => loadConfig({...env, ZECTRIX_PAGE_ID: '6'}), /ZECTRIX_PAGE_ID/);
  assert.throws(() => loadConfig({...env, REFRESH_INTERVAL: '0'}), /REFRESH_INTERVAL/);
  assert.throws(() => loadConfig({...env, ZECTRIX_DITHER: 'yes'}), /ZECTRIX_DITHER/);
  assert.throws(() => loadConfig({...env, TRMNL_BASE_URL: 'https://secret@example.com'}), error => !error.message.includes('secret'));
  assert.doesNotThrow(() => loadConfig({TRMNL_API_KEY: 'secret'}, 'preview'));
  assert.doesNotThrow(() => loadConfig({ZECTRIX_API_KEY: 'secret'}, 'devices'));
});
