# Archify × LM Studio

**[LM Studio](https://lmstudio.ai/) で動かすローカルモデル**で Archify の図(アーキテクチャ図・ワークフロー・シーケンス図など)を生成します。クラウドのエージェントは不要です。[English README](README.md)

通常の Archify は、コーディングエージェント(Claude Code、Cursor、Codex など)が JSON 仕様を書き、Archify CLI を実行する仕組みです。この連携では、その役割をローカルモデルが担います。使い方は 2 通りあります。

| | 仕組み | 向いている用途 |
|---|---|---|
| **CLI** `archify-lmstudio` | LM Studio の OpenAI 互換 API を呼び出し、本物の Archify のツールで「生成 → 検証 → 出力 → ブラウザ確認 → 修正」のループを自動で回します。 | ローカルモデルで安定した結果を得たいとき、スクリプトから使うとき |
| **MCP サーバー** `archify-mcp` | LM Studio のチャット画面に Archify のツールを追加します。モデル自身がガイドを読んで JSON を書き、検証に通るまで `archify_render` を呼び出します。 | LM Studio アプリ上で対話的に作りたいとき(ツール呼び出しが得意なモデルが必要です) |

どちらも [`../../archify`](../../archify) にある Archify Skill を改変せずに使い、検証と HTML 出力を行います。通信先はローカルの LM Studio サーバーだけです。

## 必要なもの

- Node.js 18.17 以上
- LM Studio 0.3.17 以上と、ダウンロード済みのチャットモデル
- モデルのコンテキスト長 **16k トークン以上**(指示プロンプトだけで約 4〜5k トークンあります)

JSON Schema に従うのが得意なモデルほど良い結果になります。例: `qwen3-coder-30b-a3b-instruct`、`openai/gpt-oss-20b` / `gpt-oss-120b`、`google/gemma-4-31b`。1〜4B 程度の小さなモデルでは、スキーマを満たせないことがほとんどです。

## CLI の使い方

1. LM Studio でモデルをロードし、サーバーを起動します(**Developer** タブ → **Start Server**、または `lms server start`)。既定のアドレスは `http://localhost:1234` です。
2. リポジトリのルートで次を実行します。

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs "Webリクエストの構成図: ブラウザがAPIを呼び、APIはRedisを確認し、キャッシュミス時はPostgreSQLに問い合わせてキャッシュを埋める"
```

図の種類は自動で判定されます(Mermaid のヘッダー → `archify guide` → モデル自身の順)。出力先は `./archify-out/<種類>-<日時>.html` で、仕様の JSON が同じ名前の `.json` として隣に保存されます。

既存の図を修正するときは、その仕様 JSON を渡します。

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs --edit archify-out/architecture-20260927-120000.json "APIの前に認証サービスを追加して"
```

その他の例:

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs --list-models
node integrations/lmstudio/bin/archify-lmstudio.mjs -t sequence -m openai/gpt-oss-20b -o docs/checkout.html "決済: クライアント → API → 決済代行、Webhook で結果通知"
node integrations/lmstudio/bin/archify-lmstudio.mjs --input flow.mmd --open
```

| オプション | 既定値 | 説明 |
|---|---|---|
| `-t, --type` | 自動 | `architecture` / `workflow` / `sequence` / `dataflow` / `lifecycle` |
| `-o, --out` | `./archify-out/<種類>-<日時>.html` | 出力 HTML。仕様は同じ名前の `.json` として隣に保存 |
| `--edit <spec.json>` | | 既存の仕様を修正します(検証に通った場合だけ上書き) |
| `-i, --input <file>` | | 依頼文をファイルから読みます(`-` で標準入力)。Mermaid も可 |
| `-m, --model` | `$LMSTUDIO_MODEL`、なければロード中のモデル | LM Studio のモデル ID |
| `--base-url` | `$LMSTUDIO_BASE_URL` または `http://localhost:1234/v1` | LAN 上の別マシンの LM Studio なども指定できます |
| `--api-key` | `$LMSTUDIO_API_KEY` | LM Studio で認証を有効にしている場合のみ |
| `--quality` | `showcase` | `showcase` または `standard` |
| `--strict` | オフ | showcase から standard への切り替えをしません |
| `--max-repairs` | `4` | 最初の回答のあとに行う修正ラウンドの上限 |
| `--temperature` | `0.2` | サンプリング温度 |
| `--max-tokens` | LM Studio の設定 | 出力トークンの上限 |
| `--no-visual-check` | オフ | 画面に収まるかどうかのヘッドレス Chrome での確認を省略します |
| `--open` | オフ | 出力後にブラウザで開きます |
| `--archify-root` | `$ARCHIFY_ROOT` または `../../archify` | インストール済みの Archify Skill を使う場合に指定 |
| `--json` | オフ | 結果を JSON で表示します |

### 内部の流れ

1. 図の種類ごとの JSON Schema、`common.schema.json`、例を 1 つ、そして Skill の作図ルールの要約からシステムプロンプトを作ります。アーキテクチャ図では、座標を使わないグリッド配置の例([`examples/architecture.grid.json`](examples/architecture.grid.json))を使います。ピクセル座標よりもローカルモデルがはるかに扱いやすいためです。
2. モデルの回答をストリーミングで受け取り、JSON を取り出します。`<think>` ブロック、Markdown のコードブロック、末尾カンマがあっても処理できます。
3. `archify validate --quality showcase --json` で検証します。失敗したら、バリデーターの診断結果(修正案を含む)をモデルに返し、修正版を書かせます。
4. 検証に通った候補は `archify deliver` で出力し、`archify visual-check` でヘッドレス Chrome を使って 1440×900 〜 2048×1320 の画面で確認します(約 3 秒)。画面からはみ出す場合は、計測結果と具体的な `meta.viewBox` の提案をモデルに返します。Chrome がない環境ではこの確認は省略されます(`ARCHIFY_CHROME` で Chrome/Chromium の場所を指定できます)。
5. それまでで最も良い候補を常に保持します。Skill の修正ルールに従い、2 ラウンド続けて改善しなければ打ち切ります。
6. 最も良い候補をあらためて出力し、ブラウザ確認もやり直すので、HTML・JSON・スクリーンショットはすべて同じ成果物を指します。showcase には通らないものの `standard` には通る場合は、standard 品質で出力し、**showcase で残った問題を表示します**(図の見た目に現れることがあります)。この切り替えを避けたい場合は `--strict` を付けてください。どちらにも通らなければ、最も良い候補を `<名前>.rejected.json` に保存して終了コード 1 で終わります。`--edit` で指定した既存の仕様は、失敗したときには上書きされません。

ローカルでの生成は時間がかかります。30B クラスのモデルでは 1 回答に数分かかることがあり、修正ラウンドのたびにもう 1 回答分かかります。

## MCP サーバー(LM Studio のチャットで使う)

LM Studio で **Program → Install → Edit mcp.json** を開き、次のように追加します。パスは絶対パスで書いてください。

```json
{
  "mcpServers": {
    "archify": {
      "command": "node",
      "args": ["C:/path/to/archify/integrations/lmstudio/bin/archify-mcp.mjs"],
      "env": {
        "ARCHIFY_OUT_DIR": "C:/Users/you/archify-out",
        "ARCHIFY_OPEN": "1"
      }
    }
  }
}
```

チャットでは、たとえば次のように依頼します。

```text
archify のツールを使って構成図を作って: ブラウザがAPIを呼び、APIはRedisを確認し、キャッシュミス時はPostgreSQLに問い合わせてキャッシュを埋める
```

| ツール | 役割 |
|---|---|
| `archify_authoring_guide` | 図の種類ごとのルール・スキーマ・例を返します(依頼文から種類を選ぶこともできます) |
| `archify_render` | 仕様を検証し、`ARCHIFY_OUT_DIR` に `<name>.html` と `<name>.json` を書き出して、ブラウザ確認を行います。失敗した場合は修正すべき診断結果を返します |

`ARCHIFY_OUT_DIR` の既定値は `~/archify-out` です。出力ファイル名は整形され、このディレクトリの外には書き込まれません。`ARCHIFY_OPEN=1` にすると、出力後に HTML がブラウザで開きます。

## 注意点と制限

- **言語。** 図の中の文字は依頼文と同じ言語で書かれます。ただし Viewer 自体の UI は英語と簡体字中国語にしか対応していないため、日本語の図ではボタンやメニューが英語のまま表示されます(図の内容はすべて日本語になります)。
- **未対応の機能。** リポジトリのソースコードに紐づけるモードと、ブランドロゴの取得には、引き続き本格的なコーディングエージェントが必要です。
- **見た目の確認。** ブラウザ確認で分かるのはレイアウトと画面への収まり具合だけで、見た目の良し悪しまでは判断しません。最終的にはご自身で確認してください。スクリーンショットは HTML の隣に `<名前>.visual-check.*.png` として保存されます。

## テスト

```bash
cd integrations/lmstudio
npm test
```

テストでは、モックの LM Studio サーバーと本物の Archify CLI を使います。モデルは不要です。
