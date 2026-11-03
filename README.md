# BIN Check

A small, password-protected web app for looking up card BIN details through the [BIN IP Checker API](https://rapidapi.com/) on RapidAPI. The layout adapts to phones and desktops, and follows the system light or dark theme.

The server has no third-party dependencies and stores its data in SQLite through Node's built-in module. It keeps your RapidAPI key on the server side, so the browser never sees it.

## Features

- Recognizes the card scheme from the BIN prefix as you type, without calling any API.
- Shows the issuing bank, country, and card attributes after a lookup, with the real card scheme logo.
- Shows the settlement currency's exchange rate with CNY in both directions, and expands to two-way rates against USD, HKD, JPY, EUR, and GBP. Rates are daily reference values that the server caches for 6 hours, and a lookup still succeeds if rates are unavailable.
- Caches successful lookups on the server, showing when each was cached, with a refresh button to query again. Opening a cached BIN uses no RapidAPI requests, on any device.
- Lists the most recent 100 BINs in a query history at the bottom of the page, shared by everyone who signs in.

## Run with Docker Compose

```bash
cp .env.example .env
```

Set `APP_PASSWORD` and `RAPIDAPI_KEY` in `.env`, then start the app:

```bash
docker compose up -d --build
```

Open <http://localhost:8080>.

## Run with Docker

```bash
docker build -t bincheck .
```

```bash
docker run -d --name bincheck -p 8080:8080 -v bincheck-data:/data --env-file .env bincheck
```

## Environment variables

| Variable       | Required | Default | Description                                                        |
| -------------- | -------- | ------- | ------------------------------------------------------------------ |
| `APP_PASSWORD` | Yes      |         | Password required to use the app.                                  |
| `RAPIDAPI_KEY` | Yes      |         | RapidAPI key subscribed to `bin-ip-checker.p.rapidapi.com`.        |
| `PORT`         | No       | `8080`  | Port the server listens on inside the container.                   |
| `HOST_PORT`    | No       | `8080`  | Port published on the host (Docker Compose only).                  |
| `TRUST_PROXY`  | No       | `false` | Set to `true` to rate-limit logins by `X-Forwarded-For`.           |
| `DATA_DIR`     | No       | `/data` | Directory for the SQLite database (`data` when run outside Docker). |

The container exits at startup if a required variable is missing.

## Data storage

The app keeps cached BIN data, query history, the last reported API quota, and login sessions in `/data/bincheck.db`. Both Docker commands above store it in the `bincheck-data` named volume, so it survives restarts and image upgrades.

RapidAPI only reports the quota on BIN API responses, so the page shows the last known value. After the reported reset time, it shows a full quota until the next real lookup updates it.

To use a host directory instead, replace the volume with a bind mount such as `./data:/data`. The directory must be writable by UID 1000, the user the container runs as.

## Security

- Sessions last 12 hours and survive restarts. Changing `APP_PASSWORD` signs everyone out.
- A client is blocked from logging in for 10 minutes after 8 failed attempts.
- The session cookie is `HttpOnly` and `SameSite=Strict`, and gains `Secure` when the request arrives over HTTPS.
- Use a reverse proxy with HTTPS if you expose the app to the internet. Over plain HTTP, the password travels unencrypted.
- Enable `TRUST_PROXY` only behind a proxy that sets `X-Forwarded-For`. Otherwise clients can forge the header to avoid the login limit.
- Only the first 8 digits of a pasted card number are kept and sent to the API.

## Third-party services and assets

- BIN data comes from RapidAPI. Each lookup uses one request from your plan, while typing uses none.
- Exchange rates come from the [ExchangeRate-API](https://www.exchangerate-api.com) open access endpoint, which needs no key. The server must be able to reach `open.er-api.com`.
- Card scheme logos in `public/logos` are based on [svg-credit-card-payment-icons](https://github.com/aaronfagan/svg-credit-card-payment-icons), licensed under Apache-2.0 (see `public/logos/LICENSE`). They are cropped to the artwork, and the `-on-dark` files are recoloured for dark backgrounds. The logos are trademarks of their respective owners.

## Development

Requires Node.js 22.13 or later.

```bash
npm test
```

```bash
APP_PASSWORD=dev RAPIDAPI_KEY=your-key npm start
```
