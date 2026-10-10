# hyperframes-traced-edit-cloud

`/traced-edit`, exported so a **Hermes agent on Railway** can run it while your PC is off. You
talk to the agent on **Telegram**. The heavy work (ffmpeg, whisper, HyperFrames Studio, the phone
review page, the render) runs on **one GitHub Codespace**: it starts when needed and stops when
idle. Media lives in **Cloudflare R2**.

```
Telegram ─► Hermes (Railway, small) ── renderbox (gh codespace ssh/cp) ─► Codespace "traced-edit-box"
                 │                                                          traced-edit scripts, Studio :3017,
                 └─ upload-link ─► Cloudflare Worker ◄─► R2 ◄── rclone ──   phone review :3019, render
                                   (phone upload page,      assets/  projects/<p>/  incoming/<p>/  renders/<p>/
                                    signed downloads)
```

| Folder | Runs on | What |
|---|---|---|
| `.claude/skills/traced-edit`, `.claude/skills/music-score`, `tools/` | Codespace | **copies** of the workspace (`node sync.mjs`); never edit them here |
| `.devcontainer/`, `box/` | Codespace | the render box: Node 22, ffmpeg, whisper.cpp, Chrome libs, rclone; the helpers `renderbox` calls |
| `hermes/` | Railway | Hermes image, `config.yaml`, `renderbox`, `upload-link`, the reaper cron, the generated skill |
| `upload-worker/` | Cloudflare | the upload page (multipart, any size) and signed download links |
| `sync.mjs` | your PC | re-export the skill; push assets/projects to R2 |

The source of truth stays `hyperframes-videos/.claude/skills/traced-edit`. The Hermes skill
(`hermes/skills/traced-edit/SKILL.md`) is generated from three pieces: `hermes/PREAMBLE.md`
(how to run things remotely), the workspace invariants, and the original SKILL.md, verbatim.

## One-time setup

You need:
- a Cloudflare account (R2 + Workers, free tier);
- a Railway account (Hobby);
- a Telegram bot;
- a Z.ai Coding Plan key;
- this repo pushed to GitHub as **private**.

### 1. R2 and the asset library
1. Cloudflare dashboard → R2:
   - Create a bucket named `traced-edit`.
   - Go to **Manage API tokens** → create a token with *Object Read & Write* on that bucket.
   - Note the Account ID, Access Key ID and Secret Access Key.
2. On the PC, create `.env` in this folder. It is git-ignored:
   ```
   R2_ACCOUNT_ID=…
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   R2_BUCKET=traced-edit
   ```
3. Install rclone (`winget install Rclone.Rclone`), then:
   ```
   node sync.mjs --assets                    # uploads videos/ASSETS (3.9 GB) once; later runs send only changes
   node sync.mjs --project pintas-narrado    # optional: a finished project to test with
   ```

### 2. The upload Worker
```
cd upload-worker
npx wrangler login
npx wrangler secret put UPLOAD_HMAC_SECRET   # a long random string: openssl rand -hex 32. Same value on Railway.
npx wrangler secret put TELEGRAM_BOT_TOKEN   # optional: an "uploaded" ping in your chat
npx wrangler secret put TELEGRAM_CHAT_ID     # optional: your numeric Telegram id
npx wrangler deploy                          # prints https://traced-edit-upload.<you>.workers.dev
```

### 3. GitHub: secrets for the Codespace, and a token for Railway
1. **Codespaces secrets.** Codespaces gets the R2 keys as env vars:
   ```
   gh secret set R2_ACCOUNT_ID        --user --app codespaces --repos Alonso-pixel/hyperframes-traced-edit-cloud
   gh secret set R2_ACCESS_KEY_ID     --user --app codespaces --repos Alonso-pixel/hyperframes-traced-edit-cloud
   gh secret set R2_SECRET_ACCESS_KEY --user --app codespaces --repos Alonso-pixel/hyperframes-traced-edit-cloud
   gh secret set R2_BUCKET            --user --app codespaces --repos Alonso-pixel/hyperframes-traced-edit-cloud
   ```
2. **A classic personal access token** (github.com → Settings → Developer settings → Tokens
   (classic)).
   - Scopes: **`codespace`** and **`repo`**.
   - `gh codespace ssh` does not work with fine-grained tokens.
   - This becomes `GH_TOKEN` on Railway.
3. **Spending limit.** Settings → Billing → Codespaces: keep the spending limit at **$0**, so you
   never pay beyond the free monthly quota. The quota is 120 core-hours, which is about 30 hours
   on the 4-core box, plus 15 GB-month of storage.
4. **Optional: warm the box now**, instead of on the first Telegram request:
   ```
   gh codespace create -R Alonso-pixel/hyperframes-traced-edit-cloud -b main -m standardLinux32gb -d traced-edit-box --idle-timeout 60m --retention-period 720h
   gh codespace logs -c <name>     # post-create: whisper model, browser, `hyperframes doctor`, asset sync
   gh codespace stop -c <name>
   ```

### 4. Telegram
1. Create a bot with @BotFather: `/newbot`, then copy the token.
2. Get your numeric id from @userinfobot.

### 5. Railway
1. New project → *Deploy from GitHub repo* → this repo. It uses `railway.toml`, which builds
   `hermes/Dockerfile`.
2. Service → **Volumes** → add one mounted at **`/opt/data`**. It holds Hermes' memory,
   sessions, config and the cron job.
3. Service → **Variables**:

   | Variable | Value |
   |---|---|
   | `GLM_API_KEY` | Z.ai Coding Plan key |
   | `TELEGRAM_BOT_TOKEN` | from BotFather |
   | `TELEGRAM_ALLOWED_USERS` | your numeric Telegram id (only you can talk to the bot) |
   | `TELEGRAM_HOME_CHANNEL` | the same id (where the reaper's "box stopped" note goes) |
   | `GH_TOKEN` | the classic PAT from step 3 |
   | `CODESPACE_REPO` | `Alonso-pixel/hyperframes-traced-edit-cloud` |
   | `UPLOAD_HMAC_SECRET` | same value as the Worker's |
   | `WORKER_BASE_URL` | the Worker URL from step 2 |
   | `COPILOT_GITHUB_TOKEN` | optional fallback model: a `github_pat_…` with *Copilot Requests* (a classic `ghp_` does not work) |
   | `GEMINI_API_KEY` | optional: Antigravity CLI (`agy`) in API-key mode |
   | `CODESPACE_MACHINE` | optional, default `standardLinux32gb` (4 cores); `basicLinux32gb` = 2 cores, double the hours |
   | `RENDERBOX_IDLE_MIN` | optional, default 30 |

4. Deploy. In the logs you should see `seeded /opt/data/config.yaml`, then the gateway connects
   to Telegram.

Do not put keys in `/opt/data/.env`: Hermes loads that file *over* Railway's variables.

### 6. First conversation
Say to the bot:
1. `renderbox status`. Expect "no codespace" or "Stopped".
2. "Haz un video contador con estas pintas". It sends an upload link. Upload from the phone.
3. Then say "listo".

The agent follows the skill: it ingests, runs states 2 and 3, sends you contact sheets, then
sends Studio and phone-review links at state 4, and so on.

## Day to day

| You want | Do |
|---|---|
| change the skill | edit it in `hyperframes-videos`, then `node sync.mjs`, then commit + push. Railway redeploys the agent. Tell the bot "actualicé la skill" (it runs `renderbox update`) |
| add assets | put them in `videos/ASSETS` and reindex as usual on the PC, then `node sync.mjs --assets`. The box picks them up on its next start |
| change the model, etc. | edit `/opt/data/config.yaml` through `railway ssh`, or redeploy with `HERMES_CONFIG_FORCE=1` after editing `hermes/config.yaml` |
| see what the box is doing | `renderbox status` / `renderbox jobs` (ask the bot), or `gh codespace list` |
| stop paying attention to it | nothing: the reaper stops it after 30 idle minutes, and GitHub's own idle timeout (60 min) backs that up |

## Costs and limits
- **Railway:** only the agent runs there, idle most of the time. Expect a few dollars a month
  of RAM, plus a small volume.
- **Codespaces (free quota):** 120 core-hours per month, about 30 h on 4 cores. Storage for the
  box is about 10 GB (assets + model + browser + projects) out of 15 GB-month.
  - **Every hour you spend reviewing in Studio or on the phone counts, because the box must be
    on.**
  - The render takes several minutes per minute of video on 4 cores.
- **R2 (free tier):** 10 GB of storage, and no egress fees. Old `incoming/` uploads and
  `renders/` can be deleted from the dashboard.
- **Telegram:** the agent sends a ≤50 MB copy of the final video. The full quality comes as a
  14-day download link.
- **Not included:** the fact-checker's cabildo sound bites (`enrich`). Those still need the PC.

### Terms of service: read this
GitHub's terms say Codespaces should not be used for anything "unrelated to the development or
testing of the software project associated with the repository", nor "as part of a serverless
application". This repo *is* the traced-edit project, and the box only runs on demand. Even so,
using it as an agent's render backend is a gray area: the penalty GitHub names is losing
Codespaces access. You chose this knowingly. If it ever becomes a problem, the cleanest moves
are:
- run `box/` on a second Railway service instead, since `renderbox` only needs an ssh target;
- or use HyperFrames' own cloud render.

## Not verified yet (do these on the first run)
- The devcontainer image was not built locally (no disk space on the PC). The first
  `gh codespace create` builds it; watch `gh codespace logs`.
- The Hermes image, entrypoint and cron seeding were not run locally. They were written against
  Hermes v0.21.6's source and docs. Check the first Railway deploy log.
- The coding-plan model ids (`glm-5.1`, vision `glm-5.3-flash`): if Z.ai rejects one, change
  `model.default` / `auxiliary.vision.model`.
- Whether GitHub counts a long-running detached render as "activity" for its own idle timeout.
  `renderbox reap` never stops the box while a job runs. The 60-minute GitHub timeout is the
  outer limit, so keep single renders under it, or raise `--idle-timeout`.
