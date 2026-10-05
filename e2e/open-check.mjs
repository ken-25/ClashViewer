// 指定したデータセットが開けるか（点群が表示され、モデルが読めるか）を確かめる
//   node open-check.mjs <フォルダ>
import { launch, assert } from "./lib.mjs";

const [folder] = process.argv.slice(2);
const app = await launch();
const { page } = app;
try {
  const r = await page.evaluate(async (f) => {
    const a = window.__kasane.app;
    await a.refreshDatasets();
    const m = a.datasets.find((d) => d.folder === f);
    if (!m) return { error: "一覧にありません", list: a.datasets.map((d) => d.folder) };
    await a.openDataset(m);
    for (let i = 0; i < 100 && (a.pc?.visiblePoints ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    return { versions: a.versionsOf(m.site).map((d) => d.version), points: a.pc?.visiblePoints ?? 0, models: [...a.models.models.values()].map((x) => x.key) };
  }, folder);
  console.log(JSON.stringify(r));
  assert(!r.error && r.points > 0 && r.models.length > 0, `${folder} を開けた（点群 ${r.points} 点表示・モデル ${r.models?.length}）`);
} finally {
  await app.close();
}
