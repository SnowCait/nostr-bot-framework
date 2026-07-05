# sns-bot-framework

English version: [README.md](./README.md)

[Nostr](https://nostr.com/)(設計上は将来他の SNS も)向けの bot フレームワークです。Cloudflare Workers 上で動作し、ソース(RSS フィード・文言リスト)から取得した項目をイベントにして Cron Triggers でリレーへ送信します。重複投稿防止・リトライ・管理画面・暗号化された鍵管理を最初から備えています。

## パッケージ構成

| パッケージ                      | 説明                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@sns-bot-framework/core`       | SNS 非依存のパイプライン: ソース(RSS / 文言リスト)、重複管理、`Destination` インターフェース、実行エンジン。nostr-tools 非依存 |
| `@sns-bot-framework/nostr`      | Nostr destination: kind 1/0/10002 ビルダー、NIP-10 リプライタグ、署名、リレー / Webhook への送信、NIP-98 検証                  |
| `@sns-bot-framework/cloudflare` | Cloudflare アダプタ: D1 ストア、AES-GCM による鍵の暗号化保存、管理画面(Hono)、`createWorker()`                                 |

## 機能

- **ソース**: RSS 2.0 / Atom / RSS 1.0(ETag キャッシュつき)と文言リスト。コード内定義と D1 管理(管理画面から編集可)の両対応
- **destination 単位の重複管理**: 片方の SNS だけ送信失敗した場合、失敗した先だけ次回リトライ。RSS bot は初回実行時に既存記事を投稿せずスキップ(一斉投稿事故を防止)
- **エスケープハッチ**: `nostrDestination({ build })` で kind 1 を自由に構築(タグ、スレッド、`ctx.env` 経由の R2 画像 URL 添付、項目のスキップ)
- **1 Worker で複数 bot**。bot ごとに cron スケジュールと鍵(共有も可)を持てる
- **管理画面**(`/admin`): フィード・文言(D1)の編集、bot 鍵の登録、kind 0 プロフィールと kind 10002 リレーリストの編集、手動実行。認証は [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) + NIP-07 ブラウザ拡張
- **鍵の暗号化保存**: bot の秘密鍵はマスターキー 1 つで AES-GCM 暗号化して D1 に保存。鍵の追加に設定変更・再デプロイ不要
- **dry-run モード**(`DRY_RUN=1` または管理画面のチェックボックス): 送信せず署名済みイベントをログ出力

## クイックスタート

Node.js 24 以上が必要です。[`examples/worker`](./examples/worker) から始めます:

```sh
git clone https://github.com/SnowCait/nostr-bot-framework.git
cd nostr-bot-framework && npm install && npm run build
cd examples/worker

# 1. データベース作成とフレームワークのマイグレーション適用
npx wrangler d1 create nostr-bot        # 返ってきた id を wrangler.jsonc に記入
npm run migrate:remote                  # 同梱マイグレーションを同期して適用

# 2. 本番マスターキーの登録(先にパスワードマネージャで生成・保存しておく)
npm run setup:master-key:remote         # 生成もさせる場合: npm run setup:master-key:remote -- --generate

# 3. 管理画面を使う自分の pubkey を許可
#    -> wrangler.jsonc の vars.ADMIN_PUBKEYS に npub か hex をカンマ区切りで設定

# 4. デプロイ
npm run deploy
```

スキーマは `@sns-bot-framework/cloudflare` が持ちます。`migrate:*` はまず `sns-bot-migrations` でフレームワークのマイグレーションファイルを `./migrations` へコピー(既存ファイルは上書きしません)し、その後 `wrangler d1 migrations apply` に渡します。`migrations/` は通常の wrangler プロジェクト同様に版管理するため、example は同期された framework 分(`0001_init.sql`)とアプリ独自分(`1001_app.sql`)の両方をコミットしています。マイグレーション番号 `0001–` はフレームワーク予約です。アプリ独自テーブルは `1001` 以降を使ってください(実例: `examples/worker/migrations/1001_app.sql` と、それをクエリする RSS bot の `build` フック)。

デプロイ後、`https://<your-worker>.workers.dev/admin` を開き、NIP-07 拡張(nos2x、Alby など)でサインインして各 bot の鍵(`nsec1...` または hex)を登録します。鍵は write-only で、画面には導出された npub しか表示されません。

## bot の定義

```ts
import { defineBot, rssSource } from '@sns-bot-framework/core';
import { buildTextNote, nostrDestination } from '@sns-bot-framework/nostr';
import { createWorker, d1PhraseSource } from '@sns-bot-framework/cloudflare';

const rssBot = defineBot({
	id: 'rss-news',
	cron: '*/30 * * * *',
	source: rssSource({ feeds: ['https://example.com/feed.xml'] }),
	maxPerRun: 3,
	destinations: [
		nostrDestination({
			relays: ['wss://relay.damus.io', 'wss://nos.lol'],
			build: (item) => {
				const { title, link } = item.data as { title: string; link: string };
				return buildTextNote({ content: `${title}\n${link}`, tags: [['t', 'news']] });
			},
		}),
	],
});

const quoteBot = defineBot({
	id: 'quotes',
	cron: '0 * * * *',
	source: d1PhraseSource(), // 文言は D1 にあり /admin から編集可能
	repeat: true, // 全部投稿し終えたら最初から繰り返す
	selection: 'random',
	destinations: [nostrDestination({ relays: ['wss://relay.damus.io'] })],
});

export default createWorker({ bots: [rssBot, quoteBot] });
```

1 つの bot から複数 destination へ同時送信もできます。重複管理と資格情報は `(bot, destination)` 単位で追跡されます。

## 手動実行

管理画面のボタンに加えて、スクリプト用に Bearer トークンでも実行できます:

```sh
npx wrangler secret put MANUAL_TRIGGER_TOKEN
curl -X POST "https://<your-worker>.workers.dev/admin/api/bots/rss-news/run?dryRun=1" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN"
```

## ローカル開発

```sh
cd examples/worker
npm run setup:master-key:local   # .dev.vars に別のランダムキーを書き込む
npm run migrate:local            # マイグレーションを同期してローカル D1 に適用
npm run dev                      # wrangler dev --test-scheduled

# cron をローカルで発火
curl "http://localhost:8787/__scheduled?cron=*%2F30+*+*+*+*"
```

`setup:master-key:local` は `.dev.vars` のみを変更します(本番に触れません)。`setup:master-key:remote` は `wrangler secret put` で本番シークレットを登録します。開発中は `.dev.vars` に `DRY_RUN=1` を設定すると送信せずログ出力になります。

### ライブラリとして使う場合

example をコピーせず自前の Worker を作る場合も、同じ手順でスキーマを取り込めます:

```sh
npx sns-bot-migrations                                    # ./migrations へコピー
npx wrangler d1 migrations apply <DB_NAME> --remote
npx sns-bot-setup-master-key --remote                     # ローカルは --local
```

## 鍵管理と復旧

- プラットフォーム側に置くシークレットは `MASTER_KEY`(Workers Secret)1 つだけ。値は任意の高エントロピー文字列で、パスワードマネージャで生成すればバックアップが構造的に存在します(Worker 側で SHA-256 により AES-256 鍵へ導出)
- bot の鍵はマスターキーで暗号化して D1 に保存され、pubkey がキーです。同じ鍵を複数 bot に登録しても保存は 1 つ
- **マスターキーを失った場合**: バックアップがあれば `wrangler secret put MASTER_KEY` で再設定するだけです(D1 は無傷)。バックアップがない場合、暗号文は復元できません。新しいマスターキーを設定し、管理画面から各 bot の nsec を再登録してください(対象の bot は管理画面に警告表示されます)。投稿履歴・重複管理・プロフィールは平文または公開情報のため影響を受けません
- kind 0 プロフィールと kind 10002 リレーリストは **D1 が正本**で、リレーへは送信のみ行います。他の Nostr クライアントで直接変更した内容は読み戻されず、次回 publish で上書きされます。bot のプロフィール編集は管理画面からのみ行ってください

## 投稿の挙動

- **リレーリストが投稿先を決めます。** bot は保存済み kind 10002(管理画面で編集)の write リレーへ投稿します。`nostrDestination` に渡す `relays` は、リレーリスト未保存時に使うシード/フォールバックです。
- **リトライは destination 単位。** `(bot, destination)` ごとに重複管理を持つため、片方の destination の失敗は他へ再投稿せずその destination だけで再試行されます。
- **複数イベント build は item 単位でリトライ。** 複数イベントを返す build(または `thread: true`)は、全イベントがリレーに届いたときだけ item を投稿済みにします。部分失敗時は item ごと再試行するため、成功済みイベントが重複配信され得ます。厳密な一度きり配信が必要なら単一イベント build を使ってください。
- **並行実行はベストエフォートで保護。** `(bot, destination)` ごとの短命な D1 ロックで、cron と手動実行が重なったときの二重投稿の窓を狭めます。D1 にはリクエスト跨ぎのトランザクションが無いため、厳密な保証ではなく緩和策です。

## Cloudflare Secrets Store を使う場合

マスターキーのヘルパーは [Secrets Store](https://developers.cloudflare.com/secrets-store/) バインディングも受け付けます(実行時に `get()` メソッドの有無で判別):

```jsonc
// wrangler.jsonc
"secrets_store_secrets": [
	{ "binding": "MASTER_KEY", "store_id": "<STORE_ID>", "secret_name": "bot-master-key" }
]
```

## ライセンス

MIT
