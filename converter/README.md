# kasane-converter

Kasane の変換エンジン。ビューア exe から `tools/converter/converter.exe` として呼ばれる。

```
converter.exe e57 --input a.e57 [--input b.e57] --out <出力先> --potree <PotreeConverter.exe> [--work <作業用>]
converter.exe info --input a.e57
```

進捗は標準出力に JSON 行で出す（`event` = `stage` / `progress` / `log` / `result` / `error`）。

公開済みの版に対する処理（ジョブ）は `jobs/` に置く。引数は全ジョブ共通で、ビューア exe の `JobService` が呼ぶ。

```
converter.exe <ジョブ名> --manifest <版>/manifest.json --datasets <datasets/> [--params p.json] --out <出力先> [--work <作業用>] [--potree <PotreeConverter.exe>]
```

- 入力の点群は `ctx.reader()`（`potree_reader.PotreeReader`）で保存済みの版から全点を読む（元の E57 は使わない）
- 出力は `--out` の下だけ。受け取り方はビューア exe の `JobService.Kinds` の `Target` で決まる
  - `Derived`: `--out` の中身を `datasets/<版>/derived/<ID>/` へ写し、manifest の `derived` に追記する
  - `NewVersion`: `with ctx.new_pointcloud(extra={...}) as w: w.write(block)` で点群を書く（`pointcloud_writer.py`。LAS 1.4 → PotreeConverter → `--out/pointcloud/`）。ビューア exe がそれを点群にした新しい版を `parent` 付きで公開する
- 設定値は `ctx.param("名前", 既定値, int)`（変換できなければ利用者向けのエラー）
- 新しいジョブ: `jobs/<名前>.py` に `@job("名前")` の関数を書き、`jobs/__init__.py` の `_MODULES` と `JobService.Kinds` に足す
- `selftest`（derived）と `selftest-version`（新しい版）は基盤の疎通確認用（開発モードのみ）

開発: `uv run kasane-converter ...`、テスト: `uv run pytest`、exe 化: `scripts/build.ps1`。
