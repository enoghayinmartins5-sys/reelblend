# Deploying ReelBlend

The app is dependency-free: **Node 18+ and nothing else**. No `npm install` of anything real,
no build step, no database.

---

## Path A — give me a write credential (fastest, ~1 minute)

The repo has to exist **and** I need permission to push to it.

1. Create the repo on GitHub (private is fine): **github.com/new** → name `reelblend` → Create.
2. Create a token with the prefilled settings:
   **https://github.com/settings/tokens/new?scopes=repo&description=reelblend+deploy**
3. Paste the `ghp_…` token into the chat. I create/use the repo, push 21 files, then **revoke it**.

Alternatively, skip GitHub entirely: hand me a **Render API key** or a **Railway token** and I
deploy straight from this folder.

---

## Path B — zero credentials shared with me (~3 minutes, you do the two clicks)

1. Download **`reelblend-deploy.zip`** from the workspace and unzip it.
2. Create a repo: **github.com/new** → name `reelblend` → **Public** (nothing sensitive is in
   here — verified) → Create.
3. On the new repo page click **uploading an existing file**, then drag the *contents* of the
   unzipped folder in (GitHub preserves folder structure on folder drags). Commit.
4. Deploy it — pick one:
   * **Render (blueprint, easiest):** open
     `https://render.com/deploy?repo=https://github.com/<YOUR-USERNAME>/reelblend`
     Render reads `render.yaml` and configures the service, health check and start command.
   * **Render (manual):** New → Web Service → Public Git repository → paste the repo URL →
     Build `npm install --omit=dev`, Start `node server/index.js`.
   * **Railway:** New Project → Deploy from GitHub repo.
   * **Fly.io:** `fly launch --now` in the unzipped folder.
   * **Docker anywhere:** `docker build -t reelblend . && docker run -p 8080:8080 reelblend`
   * **Your own box:** `PORT=80 node server/index.js`

---

## Why a real host fixes what the sandbox tunnel could not

A Cloudflare quick tunnel points at a process **inside an ephemeral sandbox**. When that sandbox
idles or recycles, the origin vanishes and visitors get `Error 1033` — and a visitor cannot wake
it. A normal host (even a free tier that sleeps) **wakes on the incoming request**, so the URL
always answers.

## After it is live

```bash
curl -s https://<your-url>/api/health        # {"ok":true,...,"videos":239}
node tools/smoke.js https://<your-url>        # 29 end-to-end assertions
```

## Hosting notes

* **Free tiers sleep** (Render ~15 min idle) and wake on request. Expect a ~30s cold start.
* **Ephemeral disks:** `data/store.json` (your telemetry) resets on restart. The 239-video
  catalog re-seeds from `data/seed.json` automatically, so the app always comes back complete.
  Add a Render disk, or swap in a Postgres adapter behind the existing `Store` class, for
  persistence.
* **Writes are rate-limited** per client IP (120 credits/min; ingest costs 6). Reads are never
  throttled.
* Set `REELBLEND_RESET=1` to rebuild the catalog from `seed.json` on boot.
