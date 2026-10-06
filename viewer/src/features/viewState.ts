// 今の見え方（視点・切断・表示・UCS）の保存と再現。指摘の登録時の視点に使う（将来の BCF の視点も同じ形）。

import type { App } from "../app";
import { sceneToWorld, worldToScene } from "../data/dataset";
import type { IssueView } from "../issues/issues";

export function captureView(app: App): IssueView {
  const m = app.current!;
  const pc = app.pc;
  const visibility: any = { pointcloud: pc ? { visible: pc.group.visible, colorMode: pc.material.uniforms.uColorMode.value } : null, models: {} };
  for (const lm of app.models.models.values()) {
    if (lm.role !== "current") continue;
    visibility.models[lm.key] = { visible: lm.visible, opacity: lm.opacity, hidden: [...lm.hiddenKeys], ghost: [...lm.ghostKeys] };
  }
  return {
    camera: {
      position: sceneToWorld(m, app.viewer.camera.position),
      target: sceneToWorld(m, app.viewer.controls.target),
      fov: app.viewer.fov,
      projection: app.viewer.projection,
    },
    clip: app.clipping.serialize(m.origin),
    visibility,
    frame: app.frame.serialize(m.origin),
  };
}

export async function restoreView(app: App, v: IssueView) {
  const m = app.current;
  if (!m || !v) return;
  const { viewer, pc } = app;
  // 投影を先に切り替える（切り替えは位置を引き継ぐので、位置はその後に置く）
  viewer.setProjection(v.camera.projection === "orthographic" ? "orthographic" : "perspective");
  viewer.camera.position.copy(worldToScene(m, v.camera.position));
  viewer.controls.target.copy(worldToScene(m, v.camera.target));
  if (v.camera.fov) viewer.fov = v.camera.fov;
  viewer.cameraMoved();
  app.clipping.restore(v.clip, m.origin);
  if (v.visibility?.pointcloud && pc) {
    pc.group.visible = v.visibility.pointcloud.visible;
    pc.setColorMode(v.visibility.pointcloud.colorMode);
  }
  for (const lm of app.models.models.values()) {
    const s = v.visibility?.models?.[lm.key];
    if (!s || lm.role !== "current") continue;
    // 以前の指摘はクラス名だけ（全階）で保存している。そのまま全階のクラス指定として効く
    lm.hiddenKeys = new Set(s.hidden);
    lm.ghostKeys = new Set(s.ghost);
    await app.models.setModelVisible(lm, s.visible);
    await app.models.setModelOpacity(lm, s.opacity);
  }
  viewer.requestRender();
  app.emit("display");
}
