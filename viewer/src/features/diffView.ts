// 前の版との差分（diff.json）の読み込みと、モデルの色分け（追加=緑・変更=黄・削除=前の版を赤の半透明）。
// 一覧の画面は ui/diffPanel.ts。

import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import type { App } from "../app";
import { fileRel, ifcToScene, type Manifest } from "../data/dataset";
import type { DatasetDiff } from "../data/diff";
import { fetchBytes, fetchJson } from "../host";
import type { LoadedModel } from "../model/models";
import type { AppFeature } from "./feature";

const DIFF_COLORS = { added: new THREE.Color(0x3cc85a), changed: new THREE.Color(0xf2c01e), removed: new THREE.Color(0xe5534b) };

export class DiffView implements AppFeature {
  /** 開いている版の差分（第1版・差分なしは null） */
  data: DatasetDiff | null = null;
  /** 色分けして表示しているか */
  shown = false;

  constructor(private readonly app: App) {}

  onClose() {
    this.shown = false;
    this.data = null;
  }

  async onOpen(m: Manifest) {
    this.data = null;
    if (!m.diff) return;
    try {
      this.data = await fetchJson<DatasetDiff>(`datasets/${m.folder}/diff.json`);
    } catch (e) {
      console.warn(e);
    }
  }

  async show(on: boolean) {
    const { app } = this;
    const m = app.current;
    const diff = this.data;
    if (!m || !diff) return;
    this.shown = on;
    // 前の版のモデル（削除された要素を赤の半透明で出す）
    for (const lm of [...app.models.models.values()]) if (lm.role === "previous") await app.models.unload(`${lm.datasetFolder}/${lm.key}`);
    for (const lm of app.models.models.values()) {
      await lm.model.resetColor(undefined);
      await lm.model.resetHighlight(undefined);
      if (on) await this.applyColors(lm);
    }
    if (on && diff.models.removed.length) {
      const prev = app.datasets.find((d) => d.folder === diff.against);
      if (prev) {
        const byModel = new Map<string, string[]>();
        for (const r of diff.models.removed) {
          if (!byModel.has(r.model)) byModel.set(r.model, []);
          byModel.get(r.model)!.push(r.guid);
        }
        for (const [key, guids] of byModel) {
          const entry = prev.models.find((x) => x.key === key);
          if (!entry) continue;
          const buf = await fetchBytes(fileRel(entry.owner, entry.file));
          const lm = await app.models.load(key, prev.folder, buf, "previous");
          // 同じプロジェクトの IFC は同じ座標系なので、表示中の版の座標合わせで置く
          app.models.setPlacement(lm, ifcToScene(m));
          const ids = (await lm.model.getLocalIdsByGuids(guids)).filter((x): x is number => x !== null);
          await lm.model.setVisible(undefined, false);
          await lm.model.setVisible(ids, true);
          await lm.model.highlight(ids, { color: DIFF_COLORS.removed, renderedFaces: FRAGS.RenderedFaces.TWO, opacity: 0.45, transparent: true });
        }
      }
    }
    await app.models.update(true);
    app.emit("diff");
  }

  /** 表示中の版のモデルに追加・変更の色を付ける（選択の強調を外した後にも付け直す） */
  async applyColors(lm: LoadedModel) {
    const diff = this.data;
    if (!diff || !this.shown || lm.role !== "current") return;
    const pick = async (items: { guid: string; model: string }[]) =>
      (await lm.model.getLocalIdsByGuids(items.filter((x) => x.model === lm.key).map((x) => x.guid))).filter((x): x is number => x !== null);
    const added = await pick(diff.models.added);
    const changed = await pick(diff.models.changed);
    if (added.length) await lm.model.setColor(added, DIFF_COLORS.added);
    if (changed.length) await lm.model.setColor(changed, DIFF_COLORS.changed);
  }
}
