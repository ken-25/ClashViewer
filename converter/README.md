# clash-converter

干渉ビューアの変換エンジン。ビューア exe から `tools/converter/converter.exe` として呼ばれる。

```
converter.exe e57 --input a.e57 [--input b.e57] --out <出力先> --potree <PotreeConverter.exe> [--work <作業用>]
converter.exe info --input a.e57
```

進捗は標準出力に JSON 行で出す（`event` = `stage` / `progress` / `log` / `result` / `error`）。

開発: `uv run clash-converter ...`、テスト: `uv run pytest`、exe 化: `scripts/build.ps1`。
