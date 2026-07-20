# tennis-match-app

テニス練習会向けの「試合進行表」アプリです。ペア数を入力すると総当たりの対戦表が自動生成され、完了チェックと進捗バーで進行状況を確認できます。

練習会当日の試合進行を管理する Web アプリで、コートごとに次の試合を割り当てながら、誰が何試合こなしたか・どのペアがまだ対戦していないかを一目で把握できます。複数の端末から同じ進行状況をリアルタイムに共有できるため、コート脇でスマートフォンから操作する使い方を想定しています。

## 技術構成

| 領域 | 使用技術 |
|---|---|
| フロントエンド | React / TypeScript |
| ビルドツール | Vite |
| バックエンド（DB・リアルタイム同期） | Supabase |
| ホスティング | Vercel |

## 環境変数

ローカルで動かすには、プロジェクト直下に `.env` を作成し、Supabase の接続情報を設定します。

```
VITE_SUPABASE_URL=<your-supabase-project-url>
VITE_SUPABASE_ANON_KEY=<your-supabase-anon-key>
```

## 起動手順

```bash
npm install
npm run dev
```

## ビルド & プレビュー

```bash
npm run build
npm run preview
```
