import {writeFile} from 'node:fs/promises';
import {loadConfig} from './config.js';
import {downloadImage, getScreen, listDevices} from './api.js';
import {prepareImage} from './image.js';
import {Bridge} from './bridge.js';

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes('--force');
const [command = 'run', ...args] = rawArgs.filter(arg => arg !== '--force');
const usage = `Usage: npm start -- [run|once|devices|preview <output.png>] [--force]
  run      Poll continuously (default)
  once     Attempt one sync, respecting persisted refresh timing
  --force  Skip the initial wait for run/once; image deduplication still applies
  devices  List ZecTrix devices; only ZECTRIX_API_KEY is required
  preview  Download and resize without pushing; only TRMNL_API_KEY is required
           Uses TRMNL_MODE, so display mode advances the playlist
Configure .env from .env.example before use.`;

try {
  if (['--help', '-h', 'help'].includes(command)) {
    console.log(usage);
  } else {
    if (!['run', 'once', 'devices', 'preview'].includes(command)
      || (force && !['run', 'once'].includes(command))
      || args.length !== (command === 'preview' ? 1 : 0)) throw new Error(usage);
    const config = loadConfig(process.env, command);
    if (command === 'devices') {
      console.log(JSON.stringify(await listDevices(config), null, 2));
    } else if (command === 'preview') {
      const screen = await getScreen(config);
      await writeFile(args[0], await prepareImage(await downloadImage(config, screen.imageUrl), config.fit));
      console.log('Saved 400×300 preview');
    } else {
      const bridge = new Bridge(config);
      if (command === 'once') console.log(JSON.stringify(await bridge.tick({force})));
      else {
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        process.once('SIGTERM', () => controller.abort());
        await bridge.run(controller.signal, {force});
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
