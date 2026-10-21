# event-calendar

地域イベントカレンダー自動収集システム。Node v24(TypeScript 型ストリップ)+ `node:sqlite` + `node:test`。
設計書: [`../docs/design-event-calendar.md`](../docs/design-event-calendar.md)、計画: [`../docs/plans/plan-event-calendar.json`](../docs/plans/plan-event-calendar.json)。

## インストールと実行

リポジトリルートから `cd src` で移動してから実行する。

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
- デーモン(`node src/daemon.ts` / `ecd` / `ec daemon`)も `--config <file>` を受け付ける。検証規則は同じで、不正なら起動せず終了コード 1。

## デーモン

```
node src/daemon.ts --port 18787 --data-dir .event-calendar [--config config.json] [--stdin-shutdown]
```

- 起動後 stdout に `{"event":"listening","port":N}` を 1 行出力。ポート未指定時は config の `listen`、`--port 0` で空きポート。
- ホスト既定は `127.0.0.1`。
- SIGINT / SIGTERM で停止。Windows では SIGTERM を正常に受けられないため `--stdin-shutdown` を付けると、stdin に `shutdown` を含む行を送るか stdin が EOF になると停止する(`node src/daemon.ts` / `ecd` のみ有効。`ec daemon` では未対応)。
- `gui_token` は起動ごとに生成する 64 桁 hex(ディスクには書かない)。

### 常駐起動

設定ファイルは `config.sample.json` を `config.json` にコピーして編集する(`config.json` は git 管理外。`brave_api_key` などを書く)。

`scripts/run-daemon.ps1` はデーモンを `--data-dir .event-calendar --config config.json` で起動し、終了したら 10 秒後に再起動する。出力は `.event-calendar/daemon.log`(UTF-8)に追記。stdin を持たない起動形態のため `--stdin-shutdown` は付けない(付けると stdin EOF で即停止)。

```
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\run-daemon.ps1
```

ログオン時に自動起動するにはタスクスケジューラに登録する。停止はタスクの終了(`Stop-ScheduledTask`)後、残った node プロセスを終了する(ラッパーだけ止めると node が残り、node だけ止めるとラッパーが再起動する)。

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
| GET | `/candidates` (query: `region_id`, `status` 既定 `proposed`) |
| POST | `/candidates/{id}/reject` |
| POST | `/approvals` |
| GET | `/events` (query: `region_id`, `from`, `to`, `q`, `source`) |
| GET | `/calendar/{file}` (ルータ上のパターンは `{file}`。末尾が `.ics` のときだけ有効で、`{file}` から `.ics` を除いた部分が region id。`.ics` で終わらないと NOT_FOUND 404。例: `/calendar/r1.ics`。query: `from`, `to`(ISO 日時、`from` > `to` や不正値は INVALID_ARGUMENT)。既定は now-90日〜now+365日。`Content-Type: text/calendar; charset=utf-8` と `ETag`、`If-None-Match`(`*` 可)一致で 304) |
| GET | `/health` |

上記 15 ルートに加え静的配信 `GET /` と `GET /gui/*`(`gui/` 配下のファイルのみ。パストラバーサルは INVALID_ARGUMENT)。ルートはこれ以外に無い。リクエスト body は最大 1 MiB の JSON。

### 認証 (X-GUI-Token)

- `X-GUI-Token` ヘッダを付けたリクエスト(GUI)のみ検証され、値が違うと INVALID_ARGUMENT (400)。ヘッダなし(CLI)は検査されない。
- 検証免除(すべて GET): `/`, `/gui/*`, `/calendar/{file}` のうち `.ics` で終わるもの(コード上は `/static/*`, `/assets/*` も免除だが、そのパスを配信するルートは無い)。
- `GET /` が返す `index.html` の `<meta name="gui-token" content="">` に、そのときのトークンが埋め込まれる。

## GUI

`gui/` の静的ファイル(`index.html`, `app.js`, `render.js`)。ブラウザで `http://127.0.0.1:18787/` を開く。週の開始曜日は設定 `week_start`(`"sunday"` / `"monday"`)で切り替え、デーモンが `index.html` の `<meta name="week-start">` に埋め込む。例: `{"week_start": "monday"}` を `--config` で渡す。`app.js` が meta から token を読み、`X-GUI-Token` 付きで `GET /sources`, `/events`, `/health` を呼び、ヘルス・ソース一覧・月表示のイベントを描画する。ソース更新用に `PATCH /sources/{id}` (`spec` + `expected_version`) 呼び出し関数も持つ。

「ソース状態」の各行のチェックボックス「有効」で `PATCH /sources/{id}` (`enabled` + `expected_version`) を送り、ソースを有効/無効に切り替える(無効は `disabled`、取得済みイベントは残る)。その下の「候補」には `GET /candidates` の提案中候補を並べ、チェックで `POST /candidates/{id}/approve`(`terms_note: "GUIで承認"`, `allow_redistribute: false` = ICS 出力対象外)、「却下」で `POST /candidates/{id}/reject`。承認時は試し取得し、0 件なら ZERO_ITEMS で追加されない。robots.txt で禁止の候補はチェック不可。

候補のチェックは「追加」で、試し取得中の表示と失敗理由を各行に表示する。失敗時は未チェックへ戻して再操作を可能にし、成功時は候補からソースへ移動する。通信エラーの場合は保存済みの可能性もあるため、再読み込みして状態を確認する。

抽出設定が未指定のとき、ちょこたび埼玉の `/event/` はイベントカード用CSS、埼玉県公式の `/cgi-bin/event_cal/cal_month.cgi` は月別カレンダー用 `parser: "saitama_calendar"` を自動設定し、成功した設定をソースに保存する（明示指定した設定を優先）。公式カレンダーはページの年月とイベントセルの日付を使い、同じURLでも開催日が異なる場合は別の項目として扱う。通常の公開ページにある背景のreCAPTCHAスクリプトだけではログイン・CAPTCHA画面と判定しない。実際の認証フォーム・チャレンジは引き続き取得を拒否する。

## クロール先の自動探索

`search_providers` を設定するとデーモンが地域ごとに `discover_interval_sec`(既定 1 日)おきに検索し、見つかった URL を候補(`proposed`)として記録する。クロールは GUI で承認したものだけ。最終探索時刻は `discover_run` テーブルにあり、再起動で再検索しない。登録済み URL と却下済み候補は再提案しない。

| 検索先 | 設定 | 備考 |
|---|---|---|
| Brave Search API | `"brave"` + `brave_api_key` | キー未設定ならスキップ |
| DuckDuckGo | `"duckduckgo"` | `html.duckduckgo.com`。ボット確認画面が出たら 6 時間休止(突破はしない) |
| Yahoo! リアルタイム検索(X 投稿) | `"x_search": true` | 地域ごとに 1 件の候補 `kind:"html", parser:"yahoo_realtime", date_from:"content"`。投稿本文の日付を開催日にし、日付なしは捨てる。タイムラインから消えても取消扱いにしない |

Bing は robots.txt が `/search` を禁止しているため非対応。

`"jina_fallback": true` で、`html` / `jsonld` ソースの取得が通信エラー・5xx のとき、または取得できたが 0 件のとき(JS 描画ページなど)に `jina_base`(既定 `https://r.jina.ai/`)+ URL を `X-Return-Format: html` で取り直す。robots.txt 禁止・ログイン/CAPTCHA・4xx・429 では使わない。対象 URL は外部サービス(jina)に送られる。

## ソース spec: 記事日付と開催日 (`date_from`)

ニュース系 RSS の pubDate は記事の公開日で、開催日ではない。spec に `"date_from": "content"` を指定すると、タイトル→概要→本文(`content:encoded`)の順に最初の和文日付(`令和8年11月14日(土)`, `2026年11月14日`, `10月18日開催`, `11月14日 10:30`, `10月18日〜19日` など)を開催日として使う。年なしの日付は公開日を基準に年を推定する。開催日が見つからない記事は取り込まない(warning に件数)。既定は `"published"`(従来どおり)。

完全な `M月D日` がどこにも無いときは、新聞式の月なし表記(`24、25日は…`, `18日午前5時半`)を公開日(JST)の年月で読む。`D、D+1日` は2日間の範囲になる。`3日間`・`1日現在`・`7日以内` などは日付として扱わない。

ニュース全般のフィードは `"include_keywords": ["開催", "実施", ...]` で、タイトル/概要/本文にいずれかの語を含む記事だけに絞れる(落とした件数は warning に出る)。例: 埼玉新聞(Yahoo!ニュース配信)

```
ec source add --url https://news.yahoo.co.jp/rss/media/saitama/all.xml --spec '{"kind":"rss","date_from":"content","include_keywords":["開催","実施","催し","イベント","フェスティバル","まつり","祭り","展示","公演","コンサート","参加者を募集","入場無料"],"region_policy":{"mode":"trust_source"}}'
```

```
ec source update --id <id> --expected_version <v> --spec '{"kind":"rss","date_from":"content","region_policy":{"mode":"trust_source"}}'
```

spec を更新すると ETag / Last-Modified はクリアされ、次回実行は 304 にならず再抽出される。

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
| search_providers | [] |
| brave_api_key | "" |
| x_search | false |
| x_search_base | https://search.yahoo.co.jp/realtime/search |
| discover_interval_sec | 86400 |
| discover_limit | 10 |
| jina_fallback | false |
| jina_base | https://r.jina.ai/ |
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
| week_start | `"sunday"`(GUI カレンダーの週の開始曜日。`"monday"` で月曜始まり) |

オーバーライドは浅いマージ(`host_rate` / `retry_backoff` は 1 階層マージ)。

## 範囲外

設計書の範囲外: チケット購入、ログイン必須サイト、SNS 非公開投稿、多ユーザー化、イベント推薦、MCP サーバ。
