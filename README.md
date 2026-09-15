# zectrix-plugin-trmnl

Sync TRMNL screens to ZecTrix devices running compatible official firmware. The bridge runs on a computer, NAS, or server and updates a selected page through the ZecTrix Cloud Open API.

The initial release outputs **400×300 grayscale PNGs**, with dithering or binary thresholding handled by ZecTrix Cloud. Local network output for NOTE4C devices running custom four-color firmware is not yet implemented.

## Running locally

Requires Node.js **22.16+**. Node.js 24 LTS is recommended.

```sh
npm ci
cp .env.example .env
```

Edit `.env` and set `TRMNL_API_KEY`, `ZECTRIX_API_KEY`, and `ZECTRIX_DEVICE_ID`. TRMNL uses a device API key; ZecTrix uses a ZecTrix Cloud Open API key.

```sh
# Only ZECTRIX_API_KEY is needed to list device IDs
npm start -- devices

# Only TRMNL_API_KEY is needed to preview the resized image without uploading it to ZecTrix Cloud
npm start -- preview /tmp/trmnl-preview.png

# Sync once
npm start -- once

# Skip the current wait and try immediately (image deduplication still applies)
npm start -- once --force

# Run continuously; press Ctrl+C to stop
npm start

# Try immediately at startup, then resume the normal refresh interval
npm start -- --force
```

`.env` and `data/` are excluded from version control. Process environment variables take precedence over `.env`.

## TRMNL modes

| `TRMNL_MODE`        | Behavior                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `display` (default) | Calls `/api/display` and **advances the playlist**, allowing ZecTrix to act as an independent display |
| `current_screen`    | Calls `/api/current_screen` to mirror the current screen of an existing TRMNL device                  |

`preview` uses the selected mode, so previewing in `display` mode also advances the playlist. Preview is a manual diagnostic command and does not use sync state or refresh throttling.

## Configuration

| Variable            | Default                     | Description                                                                                  |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `TRMNL_BASE_URL`    | `https://trmnl.com`         | Also supports self-hosted services with a compatible API                                     |
| `TRMNL_API_KEY`     | Required                    | Device API key, sent in the `access-token` request header                                    |
| `TRMNL_MODE`        | `display`                   | See the modes above                                                                          |
| `ZECTRIX_BASE_URL`  | `https://cloud.zectrix.com` | ZecTrix Cloud URL                                                                            |
| `ZECTRIX_API_KEY`   | Required                    | Sent in the `X-API-Key` request header                                                       |
| `ZECTRIX_DEVICE_ID` | Required                    | Device ID, usually a MAC address                                                             |
| `ZECTRIX_PAGE_ID`   | `1`                         | Target page (1–5); updates overwrite its existing content                                    |
| `ZECTRIX_DITHER`    | `true`                      | Enable ZecTrix Cloud dithering; `false` uses binary thresholding                             |
| `REFRESH_INTERVAL`  | `300`                       | Minimum refresh interval in seconds; range: 30–86400                                         |
| `REQUEST_TIMEOUT`   | `30`                        | Timeout for each HTTP request, in seconds                                                    |
| `RETRY_MAX_DELAY`   | `3600`                      | Maximum exponential backoff delay in seconds; server-requested waits still take precedence   |
| `IMAGE_FIT`         | `contain`                   | `contain` preserves aspect ratio with white padding; `cover` crops to fill; `fill` stretches |
| `STATE_DIR`         | `./data`                    | Stores the hash of the last successfully uploaded image and the next request time            |

## Sync and error handling

- Uses the larger of `REFRESH_INTERVAL` and the TRMNL `refresh_rate` as the interval. Refresh rates supplied as strings are supported.
- Deduplicates images by their content after resizing. The successful image hash is recorded only after the server confirms `code: 0` and `pushedPages: 1` (the string `"1"` is also accepted). Requests always specify the target `pageId`; if the response includes this field, it must match the target page.
- Saves state atomically by replacing it with a temporary file. After a restart, the bridge continues to respect the refresh schedule and skip duplicate screens. Each combination of cloud URL, device, page, and dithering setting has separate state.
- Automatically retries network errors, timeouts, and HTTP 408/425/429/5xx responses with backoff, honoring `Retry-After`. While the process is running, it reuses the pending image so retries do not repeatedly advance the playlist.
- Exits with a nonzero status on authentication errors, API application errors, malformed responses, corrupt images, or state file errors. Fix the cause before restarting. Failures do not explicitly clear the device screen.
- `once` attempts a single sync cycle, returns `waiting` when throttled, and exits with code 1 on failure. Add `--force` to `run` or `once` to skip the initial wait (including error backoff and `Retry-After`). Normal intervals resume afterward, and image deduplication still applies. An immediate request in `display` mode also advances the playlist.
- Only API requests carry their respective keys; image downloads and CDN redirects do not include them. Downloads are limited to 10 MiB, and decoded images are limited to 20 million pixels.

Run only one bridge instance per target page to prevent processes from overwriting each other's state and competing for refresh intervals. Deduplication uses locally recorded successful uploads and cannot detect page changes made through other clients. To restore content, stop the instance, move the corresponding state file out of the state directory, and restart.

A successful cloud response means the API accepted the push. Confirming that the physical screen refreshed still requires verification with an online device. A network interruption can occur after the server has accepted an upload, so retries may push the same screen more than once. Restarting the process restores only the hash and throttle timing, not images that have yet to upload successfully.

## Docker / NAS

After configuring `.env`:

```sh
docker compose up -d --build
docker compose logs -f
docker compose down
```

The image runs as a non-root user, and the named volume `bridge-state` preserves sync state. Do not run a local instance and a container instance against the same page at the same time. The container restarts automatically; if it repeatedly reports authentication or configuration errors, stop it and fix the configuration.

## Development and validation

```sh
npm test
npm run check
```

Tests simulate both APIs with local HTTP servers and cover multipart uploads, image dimensions and padding, API key isolation, deduplication, persistent throttling, failure states, and retries. Tests do not access real cloud accounts.

As of 2026-09-15, the public API documentation has been checked. Verification with real accounts, physical displays, and a Docker build is still pending.

## API references

- [TRMNL Display API](https://docs.trmnl.com/go/private-api/screens): Both screen endpoints, authentication, and refresh rates.
- [ZecTrix Cloud API documentation](https://cloud.zectrix.com/home/api-docs): Device listing, image multipart fields, and successful responses. Verified against the public scripts used by the online documentation page on 2026-09-15.
- [ZecTrix Wiki API documentation](https://wiki.zectrix.com/zh/software/api-docs): Community integration guide.

## License

MIT
