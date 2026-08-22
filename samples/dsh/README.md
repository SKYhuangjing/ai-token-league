# dsh (DeepSeek Harness) samples

Synthetic session data for the `dsh_local` provider. All timestamps are UTC
noon (`2026-06-10T12:00:00.000Z` = epoch ms `1781092800000`) so day
assertions stay stable in most timezones. No real session content is
included; every text field is an explicit "never read" marker.

## Layout

```text
raw/session.jsonl        plain JSONL (persistenceCompression "none" layout)
zstd/session.jsonl.zstd  same 14 lines framed like a real dsh session:
                         header line in its own zstd frame, then one
                         independent frame per event line
bad/version-1.jsonl      header with format version 1 → must parse as Err
generate.mjs             regenerates both raw/ and zstd/ (Node >= 22.19 / 24)
```

Regenerate:

```bash
~/.nvm/versions/node/v24.2.0/bin/node samples/dsh/generate.mjs
```

Node's `zstdCompressSync` does not emit frame checksums; real dsh frames do
(the descriptor checksum bit is set). The Rust frame scanner handles both.

## Scenario coverage

The file models a forked/resumed child session:
`[copied parent history][session/end-seed][this session's own events]`.
Everything at or before the end-seed was already counted in the parent file.

| Line | Type | Expectation |
| --- | --- | --- |
| 1 | `session` header (version 0) | session id / cwd / createdAt source |
| 2 | `text-chunks` seq1 (parent-history packed chunk row) | ignored |
| 3 | `assistant/message` seq2 5000+500 | skipped (inside fork seed region) |
| 4 | `session/end-seed` seq3 | seed boundary (last one wins) |
| 5 | `assistant/message` seq4 model-a 1000+200 | counted, total 1200 |
| 6 | `assistant/message` seq5 model-a 500+100+cacheRead 300+cacheWrite 50 | counted, total 950 (cache nonzero) |
| 7 | `assistant/message` seq6 model-b 800+150, reasoning 60 | counted, total 950 (reasoning diagnostic only) |
| 8 | `compaction/summary` seq7 model-c 2000+300+1000 | counted, total 3300 |
| 9 | `assistant/message` seq8 all-zero usage | skipped |
| 10 | `assistant/message` seq9 `interrupted:true`, 700+90 | counted, total 790 |
| 11 | `user/message` seq10 | ignored |
| 12 | `text-chunks` seq11 (packed chunk row) | ignored |
| 13 | `reasoning-chunks` seq12 (packed chunk row) | ignored |
| 14 | `assistant/message` seq13 model-a 1200+240+600 | counted, total 2040 |
| 15 | `assistant/message` seq14 model-b 900+180 | counted, total 1080 |

Totals: 7 counted events, `totalTokens = 1200+950+950+3300+790+2040+1080 = 10310`.
