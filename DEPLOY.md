# Put Halftone online

Halftone is one small Node server. Any host that runs Node 22 or a Docker image and keeps
connections open will do. The repository is set up for Render because it deploys straight
from GitHub with no commands. None of this has been run by the author of this file: the
steps follow Render's documented behaviour, so check the first deploy carefully.

## Render, step by step (about ten minutes)

1. Go to https://render.com and sign in with the GitHub account that owns this repository.
2. Choose **New**, then **Blueprint**, and pick `news-terminal`. Render reads `render.yaml`.
3. It asks for the values marked as secrets:
   - `SEC_USER_AGENT`: required for company reports. Your site name and a contact email,
     for example `Halftone you@yourdomain.com`. The SEC blocks callers that do not say who
     they are.
   - `X_BEARER_TOKEN`, `FRED_KEY`, `FINNHUB_KEY`, `TWELVEDATA_KEY`: optional. Leave blank.
4. Press **Apply**. When the deploy finishes, open the address Render gives you, then open
   `/#status` on it and read every line. Fix or remove anything marked failing before
   sharing the link.
5. For your own domain: in the service's **Settings**, **Custom Domains**, add it and
   create the DNS record Render shows.

The blueprint uses the paid "starter" size (a few dollars a month) because free instances
sleep when idle, which drops live connections and makes the first visitor wait a minute.
It runs in Frankfurt because Binance and Bybit refuse servers in the United States.

## What the public will and will not get

- **Chat is switched off** (`CHAT=off`). It has no accounts or moderation; an open,
  anonymous chat on a public site will be abused. Turn it on only once that is built.
- **One server.** Fine for thousands of visitors. Past that, read SCALING.md: put a CDN in
  front, add Redis, and split web from ingest.
- **Data rights.** Headlines link to their publishers and are shown as title and link only.
  Before charging money or running ads, check each publisher's and exchange's terms
  (READINESS.md lists them).
- **Not advice.** The footer says so. Keep it.

## Other hosts

- Docker: `docker build -t halftone . && docker run -p 3000:3000 -e SEC_USER_AGENT="..." halftone`
- Fly.io, Railway, a VPS: run `npm ci --omit=dev` then `node src/server.js` with the same
  environment variables. Put it behind HTTPS with HTTP/2 and set `TRUST_PROXY=1`.

Settings are listed at the end of SCALING.md.
