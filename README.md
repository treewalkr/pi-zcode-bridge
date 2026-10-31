# pi-zcode-bridge

Use the **ZCode Desktop** app-server as a [pi](https://pi.dev) model provider.
pi is the chat frontend; the ZCode agent (spawned from the Desktop app bundle)
keeps its own session, runs its own tools (bash, edits, plugins), and streams
its reply — reasoning, tool calls and final text, interleaved exactly as
ZCode produced them — back into pi in real time.

Protocol insights informed by
[ZhouXiaolin/zcode-provider](https://github.com/ZhouXiaolin/zcode-provider)
(MIT); this is an independent implementation.

## Models

Every model ZCode Desktop can run on this machine, in ZCode's own naming —
open `/model` and search "zcode":

```
  Start Plan/GLM-5.3-Flash      [zcode]   ← free tier
  Z.ai Coding Plan/GLM-5.3      [zcode]   ← your API-key providers
  …
```

Two provider classes, discovered automatically:

- **Start Plan (free tier)** — account providers for the signed-in Z.ai /
  BigModel login. Per turn, the grant is validated against the billing
  balance endpoint before anything is sent; an expired, exhausted or pending
  grant fails loudly. **No fallback to any other plan, ever.**
- **API-key providers** — anything you configure in ZCode Desktop with an
  API key (e.g. the "Z.ai Coding Plan" key). The app-server materializes
  them itself; the bridge only lists and selects them.

Each pi model pins the exact ZCode provider/model ref at selection time, so a
model can never silently switch plans. Context window, output limit and
thinking levels are discovered live from Desktop's bundled catalog and the
app-server, and converge after the first turn.

## Architecture

```
pi ──spawn──▶ node …/ZCode.app/…/glm/zcode.cjs app-server ──▶ Z.ai
 │                        ▲
 │  JWT relay             │ app-server asks for runtime headers (Start Plan)
 ├────────────────────────┘
 ├──read-only──▶ ~/.zcode/v2/credentials.json   (Desktop's OAuth login)
 └──HTTP──▶ zcode.z.ai/…/billing/balance        (grant check before each turn)
```

- **Auth**: Desktop's shared OAuth login, read-only. Desktop owns sign-in,
  token renewal and CAPTCHA.
- **Sessions**: ZCode sessions persist across pi restarts; a `pi --session`
  restore resumes its own ZCode session via a small sidecar map.
- **Compaction**: ZCode compacts its own context (reported in pi); pi-side
  compaction is cancelled while a zcode model is active.

## Requirements

- **ZCode Desktop** (`/Applications/ZCode.app`), signed in for Start Plan
  models (sign in inside Desktop).
- **node** on PATH (runs the app-server core from the Desktop bundle).
- **pi**.

## Install

```sh
pi install /path/to/pi-zcode-bridge
```

Then `/model` → pick a `zcode` model. Debug with `/zcode-probe` (dumps raw
protocol lines to `/tmp/zcode-probe.jsonl`); set `ZCODE_DEBUG=1` for verbose
logging.

## Configuration (environment variables, set before starting pi)

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `ZCODE_SERVE_CMD` | `node <Desktop bundle>/glm/zcode.cjs app-server` | Command that starts the ZCode stdio app-server |
| `ZCODE_AUTO_ALLOW` | `1` (enabled) | Auto-answer ZCode permission prompts. `0` denies tool permission requests |
| `ZCODE_TURN_TIMEOUT_MS` | `1800000` (30 min) | Per-turn budget; on timeout the bridge interrupts the turn and sends "go on", so long tasks checkpoint instead of failing |
| `ZCODE_V2_CONFIG` | `~/.zcode/v2/config.json` | Shared ZCode state anchor |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Desktop's bundled catalog | Provider catalog passed to the app-server |
| `ZCODE_APP_VERSION` | detected from Desktop's Info.plist | Version for billing headers (non-macOS/custom layouts) |
| `ZCODE_SESSION_MAP` | `~/.zcode/cli/pi-zcode-bridge-sessions.json` | pi↔ZCode session continuity sidecar |
| `ZCODE_CREDENTIAL_SECRET` | Desktop's local secret | Credential store decryption secret (only if Desktop was set up with one) |
| `ZCODE_DEBUG` | unset | Verbose protocol logging to stderr |

## Security

> **This bridge gives pi the full power of your ZCode agent.** ZCode runs its
> own tools (bash, file edits, plugins) with your permissions; permission
> prompts are auto-allowed by default (`ZCODE_AUTO_ALLOW=0` to deny). The
> OAuth token is read from the shared credential store and relayed to the
> local app-server in memory only — never written elsewhere. The bridge
> performs no writes inside `~/.zcode` except its own session sidecar.

Start Plan login refresh and CAPTCHA verification remain in Desktop; if a
turn fails asking for CAPTCHA, complete it in Desktop and retry in pi.

## Development

```sh
node scripts/smoke.mjs        # live end-to-end check (uses Start Plan quota)
SMOKE_MODEL='Z.ai Coding Plan/GLM-5.3' node scripts/smoke.mjs   # or any listed model
```

Module layout under `extensions/`:

| Module | Responsibility |
| :--- | :--- |
| `index.ts` | Entry: provider registration, lifecycle, catalog wiring, probe |
| `server.ts` | App-server process + NDJSON RPC + interaction requests |
| `turn.ts` | Turn engine: sessions, streaming, abort, budget, usage |
| `catalog.ts` | Model discovery (Start Plan + API-key providers) |
| `start-plan.ts` | Start Plan auth: credentials, balance grant, JWT relay |
| `render.ts` | Inline tool call/result rendering |
| `ask.ts` | askUserQuestion dialog |
| `io.ts` | Small shared I/O helpers |

## License

MIT — © pi-zcode-bridge contributors.
