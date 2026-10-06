# kasane-converter

Kasane の変換エンジン。ビューア exe から `tools/converter/converter.exe` として呼ばれる。

```
converter.exe e57 --input a.e57 [--input b.e57] --out <出力先> --potree <PotreeConverter.exe> [--work <作業用>]
converter.exe info --input a.e57
```

進捗は標準出力に JSON 行で出す（`event` = `stage` / `progress` / `log` / `result` / `error`）。

公開済みの版に対する処理（ジョブ）は `jobs/` に置く。引数は全ジョブ共通で、ビューア exe の `JobService` が呼ぶ。

```
converter.exe <ジョブ名> --manifest <版>/manifest.json --datasets <datasets/> [--params p.json] --out <出力先> [--work <作業用>]
```

- 入力の点群は `potree_reader.PotreeReader` で保存済みの版から全点を読む（元の E57 は使わない）
- 出力は `--out` の下だけ。ビューア exe が `datasets/<版>/derived/<ID>/` へ写し、manifest の `derived` に追記する
- 新しいジョブ: `jobs/<名前>.py` に `@job("名前")` の関数を書き、`jobs/__init__.py` の `_MODULES` と `JobService.Kinds` に足す
- `selftest` は基盤の疎通確認用（開発モードのみ）

開発: `uv run kasane-converter ...`、テスト: `uv run pytest`、exe 化: `scripts/build.ps1`。
