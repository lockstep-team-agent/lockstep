# Marketing / README assets

Drop the visual assets the README references here. Until a file exists, its embed in the
main README is left commented out (so the README never shows a broken image).

## Needed

| File              | What it is                    | Notes                                                                                  |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `demo.gif`        | The 20–30s hero loop          | Agent A renames a contract → Lockstep captures it → Agent B is warned → PR gate fails. |
| `demo.mp4`        | MP4 fallback of the same clip | Better quality than GIF for links/social.                                              |
| `dashboard.png`   | Screenshot of the dashboard   | Decisions or activity view with seeded demo data.                                      |
| `logo.svg`        | Wordmark / logo               | Used in README header and social card.                                                 |
| `social-card.png` | 1280×640 social preview       | Set in repo Settings → Social preview.                                                 |

## Recording the hero loop

- Terminal portion: `asciinema rec` or `terminalizer` → export to GIF.
- Dashboard portion: any screen recorder against the hosted playground.
- Keep it under 30s, no dead air, end on the failing PR gate (the "aha").
- Optimize the GIF (`gifsicle -O3 --lossy=80`) so it stays under ~5 MB for fast loading.

Once `demo.gif` exists, uncomment the hero block at the top of `/README.md`.
