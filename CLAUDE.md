# 元素ラボ — Claude Code 用メモ

元素記号を楽しく覚えるための1ページWebアプリ。ビルド不要、ブラウザで index.html を開けば動く。

## ファイル構成
- `elements.js` … **データ**。元素・分類・並びのゴロ。内容の追加/修正はほぼここだけで済む
- `app.js` … ロジック（タブ、学習カード、クイズ生成、採点、成長グラフ、保存）
- `index.html` … 画面構造と見た目（CSS変数はファイル冒頭の `:root`）
- 成績は `localStorage` のキー `genso-lab-v1` に保存（端末ごと）

## よくある編集と触る場所
| やりたいこと | 場所 |
|---|---|
| 元素を追加・ゴロや使い道を直す | `elements.js` の `ELEMENTS` に1行追加/編集 |
| 並びのゴロを追加（37〜54番など） | `elements.js` の `GROUP_GORO` |
| 新しいクイズ形式を追加 | `app.js` の `MODES` に追加し、`buildQuestion()` に case を足す |
| 1回の問題数を変える | `app.js` の `QUESTIONS_PER_ROUND` |
| 得点ルール（連続ボーナス等） | `app.js` の `answer()` |
| 習得の判定基準 | `app.js` の `level()` |
| 色・フォント | `index.html` の `:root` と dark 用の2ブロック（両方そろえる） |

## データの形
```js
{ n: 26, s: "Fe", name: "鉄", en: "Iron", cat: "transition",
  goro: "覚え方", origin: "記号の由来（任意）", uses: ["身近な使い道1", "使い道2"] }
```
`cat` は `CATEGORIES` のキーのどれか。新しい分類を作るときは `CATEGORIES` と index.html の `--c-xxx` 色を両方追加。

## ルール
- 事実（原子番号・記号・使い道）は正確に。不確かなものは入れない
- 使い道は子どもでも分かる身近な例を優先
- `goro` に元素名をそのまま入れるとゴロ問題で ○○ に伏せられる（意図通り）
- 保存データの形（`history`, `mastery`）を変えるときは `STORE_KEY` のバージョンを上げる
- 外部ライブラリは使わない（そのまま開ける状態を保つ）

## 別プロジェクト：aligner/
`aligner/` はアライナー設計ソフト（元素ラボとは独立）。ルールと構成は `aligner/README.md`。three.js を `aligner/vendor/` に同梱しており、上の「外部ライブラリは使わない」は元素ラボ側のルール。
