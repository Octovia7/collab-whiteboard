# Deploying the public demo (Render + Neon, free tiers)

The demo runs on free tiers that need no credit card:

- **Render web service** ([`render.yaml`](../render.yaml), [`deploy/render/Dockerfile`](../deploy/render/Dockerfile)): the server, which also serves the built client (`STATIC_DIR`), because the free plan runs one web service and no nginx.
- **Render Key Value**: Redis.
- **Neon**: Postgres.

The full production setup (nginx with a strict CSP, two server replicas, Postgres and Redis with persistence) is [`docker-compose.prod.yml`](../docker-compose.prod.yml); that is what the tests and benchmarks run against.

## Secrets: who makes them, where they live

| Variable | Made by | Lives in | Notes |
| --- | --- | --- | --- |
| `JWT_SECRET` | Render (`generateValue: true`, 256-bit random) | Render → service → Environment | Never leaves Render. Changing it logs everyone out. |
| `METRICS_TOKEN` | Render (`generateValue: true`) | Render → service → Environment | Read `/metrics` with `Authorization: Bearer <token>`. |
| `REDIS_URL` | Render (from the Key Value instance) | Render, wired by the blueprint | Internal address, reachable only from your Render services. |
| `DATABASE_URL` | Neon | You paste it into Render once | Never into a file, chat or commit. |
| `ALLOWED_ORIGINS` | You | Render | The app's own URL, e.g. `https://collab-whiteboard.onrender.com`. |

Nothing from `.env.prod` is used, and no secret is in the repository.

## Step by step

### 1. Neon (Postgres)

1. Go to **https://neon.tech** and click **Sign up**, then **Continue with GitHub**.
2. Create a project:
   - name `collab-whiteboard`;
   - Postgres version **16**;
   - region **AWS US West 2 (Oregon)**, the same region as Render below, so every query stays nearby.
3. On the project dashboard, click **Connect**.
   - Keep the defaults (branch `main`, database `neondb`, the owner role).
   - **Turn off "Connection pooling".** The pooled address can't hold the session-level lock the server takes while it runs migrations.
4. Copy the connection string. It looks like `postgresql://neondb_owner:…@ep-…us-west-2.aws.neon.tech/neondb?sslmode=require`. Keep it on your clipboard for step 2.5 and don't save it anywhere else.

### 2. Render (server + Key Value)

1. Go to **https://render.com** and click **Get Started**, then **GitHub**.
2. When asked, let Render's GitHub app access the `collab-whiteboard` repository (only that one is fine).
3. In the dashboard, click **New +**, then **Blueprint**, and pick the `collab-whiteboard` repository (branch `main`).
4. Render reads `render.yaml` and shows two free resources: **collab-whiteboard** (web service) and **collab-whiteboard-kv** (Key Value).
5. It asks for the two values that aren't in the file:
   - `DATABASE_URL`: paste the Neon connection string.
   - `ALLOWED_ORIGINS`: `https://collab-whiteboard.onrender.com`
6. Click **Apply** (or **Deploy Blueprint**). The first build takes about 5–10 minutes.
7. When it's live, open the service page and look at its URL at the top. If it isn't exactly `https://collab-whiteboard.onrender.com` (Render adds a suffix when the name is taken):
   1. go to **Environment** and set `ALLOWED_ORIGINS` to that exact URL (with `https://`, no trailing slash);
   2. click **Save, rebuild and deploy**.
   Until it matches, sign-ups work but the board can't connect (the server rejects the WebSocket's origin).
8. Open the URL, sign up, create a board, and open it in a second browser to check that drawing syncs.

To redeploy, push to `main` (`autoDeploy: true`). To look at metrics:

```bash
curl -H "Authorization: Bearer <METRICS_TOKEN from Render>" https://<your-app>.onrender.com/metrics
```

## Limits of the free demo, and what they mean

- **One replica on 0.1 CPU and 512 MB.** The demo is not the benchmarked setup (two replicas, 50 editors). It comfortably handles a few people on a board. Sign-ups take a few seconds, because bcrypt at cost 12 on a tenth of a CPU is slow on purpose.
- **Sleeps after 15 minutes without traffic.**
  - The first visit after that waits about a minute while the service starts. An open board that is in use keeps it awake.
  - The board itself is not lost: everything acked is in Neon.
  - Neon also pauses its compute after 5 minutes idle, and the first query after that takes under a second.
- **Key Value is in memory only.** A restart of Render's Key Value instance (maintenance, a crash) empties Redis:
  - **Logged-out sessions are forgotten until they expire. This is the one with a security cost.** Logout puts the session's token on a revocation list in Redis. After a Redis restart, a token that was logged out works again until its own expiry (at most 7 days after login).
    - It only matters if someone copied a session cookie before you logged out, for example on a shared computer or through malware.
    - Normal use is unaffected: logout also deletes the cookie from the browser.
    - The full stack doesn't have this gap, because its Redis persists to disk (AOF). The fix for the demo would be to keep revocations in Postgres as well, or to shorten the session lifetime.
  - Sign-up and login rate limits start counting again from zero, a brief window for extra guesses. They are still limited per IP per minute.
  - Sequence counters are lost; that is safe. The server never hands out a seq below the highest one it has seen (tested by the chaos test with `FLUSHALL`).
  - The online list and cursors refill within 5 seconds.
  - While Redis is down, the app refuses sessions (503) instead of trusting them, and edits wait (clients keep them and resend).
- **`/healthz` and `/readyz` are public**, because Render's proxy is the only thing in front, and its health check needs `/healthz`. They reveal only whether the process, Postgres and Redis are up. `/metrics` requires the token.
