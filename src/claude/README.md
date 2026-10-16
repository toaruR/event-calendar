# event-calendar

地域イベントカレンダー自動収集システム。Node v24(TypeScript 型ストリップ)+ `node:sqlite` + `node:test`。
設計書: [`../../docs/design-event-calendar.md`](../../docs/design-event-calendar.md)、計画: [`../../docs/plans/plan-event-calendar.json`](../../docs/plans/plan-event-calendar.json)。

## インストールと実行

```
npm install            # 依存: ajv, cheerio, ical.js / devDependencies: typescript, eslint 一式 (要ネットワーク)
node bin/ec.ts <command> [--key value ...]    # CLI (package.json bin: ec)
node src/daemon.ts [--port N] [--db PATH] [--data-dir DIR] [--host H] [--stdin-shutdown]   # デーモン (bin: ecd)
```

## テスト・検査

```
npm test               # node --test "test/**/*.test.ts"
node --test test/acceptance/modules-load.test.ts
npm run typecheck      # tsc --noEmit -p tsconfig.json
npm run lint           # eslint .
npm run check          # = typecheck && lint && modules-load テスト
```

- `node --test test/`(ディレクトリ指定)は Node v24 で失敗する。glob 形式を使うこと。glob が 0 件一致でも exit 0 になる点に注意。
- 型チェックは TypeScript(`tsc`、devDependency。typescript-eslint が TS 7 を未サポートのため `typescript` は ^6.0.x に固定)。`tsconfig.json` は noEmit / strict:true / noUnusedLocals / noFallthroughCasesInSwitch / erasableSyntaxOnly / verbatimModuleSyntax、対象は `bin` `src` `test`(`gui/*.js` は allowJs だが checkJs なし)。
- lint は ESLint 10 の flat config(`eslint.config.js`)。ルールは `@eslint/js` recommended + `typescript-eslint` recommended。`node_modules` は ignore、`bin` `src` `test` は Node グローバル、`gui/*.js` はブラウザグローバル(ES module)。`@typescript-eslint/no-unused-vars` は先頭 `_` の名前と rest 兄弟を許容し、`@typescript-eslint/no-explicit-any` は `test/**` でのみ無効(未型付け JSON 応答・エラー検査用)。`npm run lint` は `eslint .`。
- `npm run check` は typecheck(tsc 型検査)と lint に続き、`src/**/*.ts`(`src/daemon.ts` を除く)の全モジュールが型ストリップで構文解析でき、import 解決を含め評価時にエラーなくロードできること(件数 > 0 も検証)を確認する。lint 自体は `npm run lint` が担当する。`src/daemon.ts` はインポートで起動するエントリのため modules-load から除外(別途 e2e テストで起動を検証)。

## CLI

`ec <command>`。コマンド名は tool / HTTP 操作名と同じ(`_` は空白に置換可: `source add` = `source_add`)。
`--key value` / `--key=value` は入力フィールドになり、`-` は `_` に変換される。`id` または `*_id` は常に文字列。残りの位置引数が 1 つなら `id` として扱う。

| コマンド | HTTP |
|---|---|
| `region_upsert` (別名 `region add` / `region set`) | `PUT /regions/{id}` |
| `source_discover` | `POST /regions/{id}/discover` |
| `source_test` | `POST /sources:test` |
| `source_add` | `POST /sources` |
| `source_list` | `GET /sources` |
| `source_update` | `PATCH /sources/{id}` |
| `source_remove` (別名 `source rm` / `source delete`) | `DELETE /sources/{id}` |
| `run_now` (別名 `run`) | `POST /sources/{id}/run` |
| `source_approve` | `POST /candidates/{id}/approve` |
| `approval_issue` (別名 `approval issue`) | `POST /approvals` |
| `events_search` (別名 `events`) | `GET /events` |
| `calendar_export` (別名 `export`) | `GET /calendar/{region_id}.ics` |
| `health` | `GET /health` |
| `daemon` | デーモンをフォアグラウンド起動 (`--port --db --data-dir --host`) |

引数なしで実行すると usage を stderr に出し exit 2。コマンド名なしの `--help` は usage を出して exit 0(コマンド名付きの `--help` はコマンドを通常実行する)。

グローバルオプション: `--embedded`, `--base-url URL`, `--data-dir DIR`, `--db PATH`, `--config FILE`(embedded 専用), `--help`。

### 終了コード

| code | 意味 |
|---|---|
| 0 | 成功 |
| 2 | INVALID_ARGUMENT |
| 3 | ZERO_ITEMS |
| 4 | DAEMON_UNAVAILABLE(デーモン未起動。`ec daemon` または `--embedded` を使う) |
| 1 | その他のエラー (FETCH_FAILED, NOT_FOUND, SSRF_BLOCKED, ROBOTS_DISALLOWED, APPROVAL_REQUIRED, CONFLICT) |

エラー時は stdout に `{"error":{"code","message","details"}}` を出力する。HTTP ステータス: INVALID_ARGUMENT 400 / FETCH_FAILED 502 / NOT_FOUND 404 / ZERO_ITEMS 422 / SSRF_BLOCKED, ROBOTS_DISALLOWED, APPROVAL_REQUIRED 403 / CONFLICT 409。想定外の内部例外は FETCH_FAILED で 500。

### `--embedded` と `--config <file>`

- 既定ではデーモンの HTTP API (`http://<listen>`、`--base-url` で変更)に接続する。
- `--embedded` はデーモンなしでプロセス内の DB(既定 `<data-dir>/event-calendar.db`、data-dir 既定 `.event-calendar`)に直接実行する。バックグラウンドワーカーは起動しない。
- `--config <file>` は **`--embedded` と併用時のみ**有効(単独だと INVALID_ARGUMENT, exit 2)。設定のオーバーライドを JSON オブジェクトで渡す。未知のキー、JSON 不正、ファイル読込不可、`ssrf_allowlist` の不正値(ホスト名/IP のみ、スキーム・ポート・パス不可)は INVALID_ARGUMENT。設定の指定手段はこのファイルのみで、環境変数の許可リスト機構は存在しない。
- `daemon` サブコマンド/`ecd` には `--config` は無い(`startDaemon` はプログラムからの `config` 引数のみ)。

## デーモン

```
node src/daemon.ts --port 18787 --data-dir .event-calendar [--stdin-shutdown]
```

- 起動後 stdout に `{"event":"listening","port":N}` を 1 行出力。ポート未指定時は config の `listen`、`--port 0` で空きポート。
- ホスト既定は `127.0.0.1`。
- SIGINT / SIGTERM で停止。Windows では SIGTERM を正常に受けられないため `--stdin-shutdown` を付けると、stdin に `shutdown` を含む行を送るか stdin が EOF になると停止する(`node src/daemon.ts` / `ecd` のみ有効。`ec daemon` では未対応)。
- `gui_token` は起動ごとに生成する 64 桁 hex(ディスクには書かない)。

## HTTP API

| メソッド | パス |
|---|---|
| PUT | `/regions/{id}` |
| POST | `/regions/{id}/discover` |
| POST | `/sources:test` |
| POST | `/sources` |
| GET | `/sources` (query: `region_id`, `state`) |
| PATCH | `/sources/{id}` |
| DELETE | `/sources/{id}` (`dry_run` / `approval_token` は JSON body または query) |
| POST | `/sources/{id}/run` |
| POST | `/candidates/{id}/approve` |
| POST | `/approvals` |
| GET | `/events` (query: `region_id`, `from`, `to`, `q`, `source`) |
| GET | `/calendar/{file}` (ルータ上のパターンは `{file}`。末尾が `.ics` のときだけ有効で、`{file}` から `.ics` を除いた部分が region id。`.ics` で終わらないと NOT_FOUND 404。例: `/calendar/r1.ics`。query: `from`, `to`(ISO 日時、`from` > `to` や不正値は INVALID_ARGUMENT)。既定は now-90日〜now+365日。`Content-Type: text/calendar; charset=utf-8` と `ETag`、`If-None-Match`(`*` 可)一致で 304) |
| GET | `/health` |

上記 13 ルートに加え静的配信 `GET /` と `GET /gui/*`(`gui/` 配下のファイルのみ。パストラバーサルは INVALID_ARGUMENT)。ルートはこれ以外に無い。リクエスト body は最大 1 MiB の JSON。

### 認証 (X-GUI-Token)

- `X-GUI-Token` ヘッダを付けたリクエスト(GUI)のみ検証され、値が違うと INVALID_ARGUMENT (400)。ヘッダなし(CLI)は検査されない。
- 検証免除(すべて GET): `/`, `/gui/*`, `/calendar/{file}` のうち `.ics` で終わるもの(コード上は `/static/*`, `/assets/*` も免除だが、そのパスを配信するルートは無い)。
- `GET /` が返す `index.html` の `<meta name="gui-token" content="">` に、そのときのトークンが埋め込まれる。

## GUI

`gui/` の静的ファイル(`index.html`, `app.js`, `render.js`)。ブラウザで `http://127.0.0.1:18787/` を開く。`app.js` が meta から token を読み、`X-GUI-Token` 付きで `GET /sources`, `/events`, `/health` を呼び、ヘルス・ソース一覧・月表示のイベントを描画する。ソース更新用に `PATCH /sources/{id}` (`spec` + `expected_version`) 呼び出し関数も持つ。

## 既定設定 (`src/config.ts`)

| キー | 既定値 |
|---|---|
| interval_sec | 21600 |
| interval_min | 900 |
| tick | 60 |
| job_timeout | 120 |
| lease | 600 |
| connect_timeout | 10 |
| total_timeout | 30 |
| body_max | 5242880 |
| global_concurrency | 4 |
| redirect_max | 5 |
| max_pages | 5 |
| max_pages_limit | 20 |
| degraded_after | 3 |
| quarantine_after | 10 |
| drift_ratio | 0.8 |
| drift_min_prev | 5 |
| disappear_runs | 3 |
| cancelled_retention | 30 |
| recurrence_horizon | 90 |
| year_past_window | 30 |
| year_future_window | 183 |
| interval_jitter | 0.1 |
| dedup_time_window | 60 |
| dedup_jaccard | 0.8 |
| keyword_full_hits | 2 |
| min_confidence | 0.5 |
| trust | 0.5 |
| listen | `127.0.0.1:18787` |
| busy_timeout | 5000 |
| search_provider | `none` |
| geocoder | `none` |
| redact_contact | true |
| ssrf_allowlist | `[]` |
| contact_url | `http://127.0.0.1:18787/about` |
| host_rate | `{requests: 1, per_sec: 5}` |
| retry_backoff | `{base_sec: 60, cap_sec: 600, jitter: 0.2, max_attempts: 5}` |
| failure_stretch_cap_sec | 86400 |
| robots_cache | 86400 |
| require_approval | `["source_remove", "enable_browser"]` |
| approval_token_ttl | 600 |

オーバーライドは浅いマージ(`host_rate` / `retry_backoff` は 1 階層マージ)。

## 範囲外

設計書の範囲外: チケット購入、ログイン必須サイト、SNS 非公開投稿、多ユーザー化、イベント推薦、MCP サーバ。
