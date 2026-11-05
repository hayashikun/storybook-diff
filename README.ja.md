# storybook-diff

[English](./README.md) | 日本語

[![CI](https://github.com/hayashikun/storybook-diff/actions/workflows/ci.yml/badge.svg)](https://github.com/hayashikun/storybook-diff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Storybook story diff visualizer。base / head それぞれの `storybook build` 出力（静的 HTML）を入力に、各 story をブラウザでレンダリングして比較し、以下を生成する GitHub Action / CLI。

- `index.html` — 差分のある story の画像ギャラリー（横並べ / スライダー / 差分ハイライト表示、確認済みフラグ付き）
- `summary.md` — PR コメント用の差分サマリ（65,536 字の GitHub コメント上限内に自動で収める）
- `result.json` — 機械処理用の結果
- `shots/` — 差分のあった story のスクリーンショット

## 差分検出の仕組み

1. **スコープ判定** — 変更ファイル一覧と turbosnap の依存グラフ（`preview-stats.json`）から、変更を transitive に import している story だけをレンダリング対象に絞る
2. **HTML 比較とピクセル比較（1 段目）** — 対象 story の DOM を base / head で比較し、差分のある story だけその場でスクリーンショットを撮ってピクセル diff を取る（生成 id など見た目に出ない DOM 差分はここで除外）。描画は同じ story ファイル内では読み込み済みの `iframe.html` 上で story を切り替えて行い、ファイルが変わるたびに読み込み直す
3. **再確認（2 段目）** — 1 段目で画像差分のあった story だけ `iframe.html` から読み込み直して撮り直し、差分を確定する（ページの使い回しで前の story から持ち越した状態による差分を除く）。1 段目で差分が出なかった story は再確認しないため、持ち越した状態が base / head の両方で同じように見た目を覆うと見逃しうる

story の追加・削除はスコープと独立に全件検出する。

## GitHub Action として使う

Storybook のビルドと成果物の置き場所（S3 等）は利用側リポジトリの責務。この action は「ビルド済み static 2 つ → 差分レポート」だけを担当する。

```yaml
# base / head それぞれの storybook をビルドしておく
- name: Build storybook (head)
  run: pnpm run build-storybook --output-dir /tmp/sb-head --stats-json

- name: Build storybook (base)
  run: |
    git worktree add /tmp/sb-base-tree ${{ github.event.pull_request.base.sha }}
    pnpm --dir /tmp/sb-base-tree install --frozen-lockfile
    pnpm --dir /tmp/sb-base-tree run build-storybook --output-dir /tmp/sb-base

- name: Collect changed files
  run: git diff --name-only ${{ github.event.pull_request.base.sha }}...HEAD > /tmp/sb-changed.txt

- name: Generate story diff
  uses: hayashikun/storybook-diff@<SHA> # v1.0.0
  with:
    base-static: /tmp/sb-base
    head-static: /tmp/sb-head
    changed-files: /tmp/sb-changed.txt
    out: /tmp/sb-report
    concurrency: 14
    dist-boundary-packages: packages/my-ui-library,packages/my-shared-components
    pr-title: ${{ github.event.pull_request.title }}
    pr-url: ${{ github.event.pull_request.html_url }}
```

生成後は `/tmp/sb-report` を S3 等にアップロードし、`summary.md` を PR コメントに投稿する。アップロード先やコメントの方法は利用側の環境に合わせて書く。例:

```yaml
- name: Upload report
  run: |
    # ギャラリーから story 本体に飛べるよう、storybook-static も同じ場所に置く
    cp -r /tmp/sb-base /tmp/sb-report/storybook-base
    cp -r /tmp/sb-head /tmp/sb-report/storybook-head
    aws s3 sync /tmp/sb-report "s3://<bucket>/pr-${{ github.event.pull_request.number }}/"

- name: Comment summary
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    {
      echo "[差分ギャラリーを開く](https://<host>/pr-${{ github.event.pull_request.number }}/index.html)"
      echo
      cat /tmp/sb-report/summary.md
    } > /tmp/sb-comment.md
    gh pr comment ${{ github.event.pull_request.number }} --body-file /tmp/sb-comment.md
```

### Inputs

| name | 既定値 | 説明 |
|---|---|---|
| `base-static` | (必須) | base の storybook-static ディレクトリ |
| `head-static` | (必須) | head の storybook-static ディレクトリ |
| `out` | (必須) | 出力先ディレクトリ |
| `changed-files` | なし | 変更ファイル一覧（1 行 1 パス）のファイル。未指定時はレンダリングをスキップして空レポートを生成 |
| `head-stats` | `<head-static>/preview-stats.json` | turbosnap の依存グラフ。無い場合はパッケージ単位の粗い判定にフォールバック |
| `concurrency` | `6` | レンダリング並列数 |
| `workspace-dir` | `packages` | モノレポのワークスペースディレクトリ名（`apps` 等のレイアウトなら変更） |
| `global-paths` | `.storybook/` | 配下の変更で全 story を差分対象にするパスプレフィックス（カンマ区切り） |
| `dist-boundary-packages` | なし | ビルド済み dist 経由で参照される共有パッケージのプレフィックス（カンマ区切り）。配下の story・テスト以外の変更で全 story を差分対象にする（依存グラフがライブラリ境界で途切れて取りこぼすのを防ぐ） |
| `reuse-page` | `true` | 同じ story ファイル内では読み込み済みの `iframe.html` 上で story を切り替えて描画する。`'false'` で story ごとに読み込み直す（`'false'` 以外の値はすべて `true` として扱う）（遅いが前の story の状態を持ち越さない。切り替えで問題が出る Storybook 向け） |
| `pr-title` / `pr-url` | なし | ギャラリーヘッダに表示する PR タイトル / URL。`pr-url` はギャラリーの確認済みフラグを PR ごとに分けて保存するキーにも使う（未指定ならギャラリーの置き場所のパスで分ける） |
| `node-version` | `24` | cli.ts の実行に使う Node.js（>= 24 必須）。`''` で setup-node をスキップ |
| `install-browser` | `true` | Playwright Chromium のインストール（キャッシュ済みならほぼ no-op） |

### Storybook 本体へのリンクについて

ギャラリー内の各 story には `./storybook-base/` / `./storybook-head/` への相対リンクが張られる。ギャラリーと合わせて base / head の storybook-static を同名のサブディレクトリとしてアップロードすると、差分画像から実際の story に飛べる。

## CLI として使う

```bash
node src/cli.ts \
  --base-static <baseの storybook-static dir> \
  --head-static <headの storybook-static dir> \
  --out <出力先 dir> \
  [--changed-files <変更ファイル一覧のファイル>] \
  [--head-stats <preview-stats.json のパス>] \
  [--concurrency 6] \
  [--workspace-dir packages] \
  [--global-paths .storybook/] \
  [--dist-boundary-packages packages/a,packages/b] \
  [--reuse-page true] \
  [--pr-title <PR タイトル>] \
  [--pr-url <PR の URL>]
```

Node.js >= 24（TypeScript の型ストリップ実行）と Playwright Chromium が必要。

描画時は URL の globals で addon-a11y の axe 自動実行を止める（結果を使わず CPU を消費するだけのため）。

## 開発

```bash
pnpm install
pnpm exec playwright install chromium  # 結合テスト用
pnpm test              # vitest (pipeline.test.ts は Chromium で描画する)
pnpm run typecheck     # tsc --noEmit
pnpm run check         # biome
pnpm run dev:gallery   # ダミーデータのギャラリーをホットリロードで開く
```

### ソースの構成

| ファイル | 役割 |
|---|---|
| `src/cli.ts` | 引数の解析と実行 (action の入口) |
| `src/pipeline.ts` | 全体の流れ (スコープ判定 → 1 段目 → 2 段目 → 追加 / 削除の撮影 → レポート) |
| `src/scope.ts` | 変更ファイルと依存グラフから描画対象の story を決める |
| `src/workspace.ts` | モノレポのパスの正規化とパッケージ判定 |
| `src/storybook.ts` | `index.json` の読み込み |
| `src/render.ts` | ページの管理、story の切り替え、描画完了の待機、撮影 |
| `src/diff.ts` | HTML の正規化とピクセル比較 |
| `src/static-server.ts` | storybook-static と撮影画像の配信 |
| `src/report/` | ギャラリー (`gallery.ts` / `gallery.css` / `gallery-client.js`)、サマリ、`result.json` の書き出し |

## リリース

利用側は commit SHA で pin する（サプライチェーン攻撃の防止）。

```yaml
uses: hayashikun/storybook-diff@<SHA> # v1.0.0
```

変更を入れたらセマンティックバージョニングでタグを打ち、利用側は新しい SHA とコメントを更新する。

```bash
# 例
git tag v1.2.0
git push origin v1.2.0
```

## License

[MIT](./LICENSE)
