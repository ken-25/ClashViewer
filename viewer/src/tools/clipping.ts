import * as THREE from "three";
import type { Viewer3D } from "../scene/viewer3d";

export type ClipMode = "none" | "box" | "section";
export type Axis = "x" | "y" | "z";

export interface ClipState {
  mode: ClipMode;
  box: { min: number[]; max: number[] }; // 世界座標
  section: { axis: Axis; position: number; thickness: number; flip: boolean }; // position は世界座標
}

/**
 * 切断ボックスと断面。renderer.clippingPlanes（全体の切断面）を使うので、
 * 点群（自前シェーダー）とモデル（Fragments）に同じ切断が効く。
 */
export class Clipping {
  mode: ClipMode = "none";
  readonly box = new THREE.Box3(); // シーン座標
  section = { axis: "z" as Axis, position: 0, thickness: 0, flip: false }; // position はシーン座標
  private readonly helper: THREE.Box3Helper;
  private readonly planeHelper: THREE.Mesh;
  onChange: (() => void) | null = null;

  constructor(private readonly viewer: Viewer3D) {
    this.helper = new THREE.Box3Helper(this.box, 0xffa040);
    (this.helper.material as THREE.LineBasicMaterial).depthTest = false;
    this.helper.visible = false;
    viewer.overlay.add(this.helper);
    this.planeHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthTest: false }),
    );
    this.planeHelper.visible = false;
    viewer.overlay.add(this.planeHelper);
  }

  /** シーン全体の範囲（初期値の基準） */
  extent = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));

  /** 箱・断面を動かせる範囲（全体の範囲を各辺 5% 広げたもの） */
  limits(): { lo: THREE.Vector3; hi: THREE.Vector3 } {
    const pad = this.extent.getSize(new THREE.Vector3()).multiplyScalar(0.05);
    return { lo: this.extent.min.clone().sub(pad), hi: this.extent.max.clone().add(pad) };
  }

  setMode(mode: ClipMode) {
    this.mode = mode;
    if (mode === "box" && this.box.isEmpty()) this.box.copy(this.extent);
    this.apply();
  }

  setBox(box: THREE.Box3) {
    this.box.copy(box);
    this.apply();
  }

  /** 点の周りに箱を置く（干渉を見たい所だけを切り出す） */
  boxAround(p: THREE.Vector3, half = 2) {
    this.box.set(p.clone().subScalar(half), p.clone().addScalar(half));
    this.setMode("box");
  }

  setSection(s: Partial<typeof this.section>) {
    Object.assign(this.section, s);
    this.apply();
  }

  planes(): THREE.Plane[] {
    if (this.mode === "box") {
      const { min, max } = this.box;
      return [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -min.x),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -min.y),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -min.z),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z),
      ];
    }
    if (this.mode === "section") {
      const n = new THREE.Vector3(this.section.axis === "x" ? 1 : 0, this.section.axis === "y" ? 1 : 0, this.section.axis === "z" ? 1 : 0);
      const p = this.section.position;
      const t = this.section.thickness;
      // 平面は n·x + c >= 0 の側を残す。
      // 既定は位置より上（正の側）を消す＝水平断面なら平面図のように見える。flip で逆側を消す。
      // 厚み t > 0 なら、残す側をさらに t の幅に絞る（点群の薄切り）
      if (!this.section.flip) {
        const planes = [new THREE.Plane(n.clone().negate(), p)];
        if (t > 0) planes.push(new THREE.Plane(n.clone(), -(p - t)));
        return planes;
      }
      const planes = [new THREE.Plane(n.clone(), -p)];
      if (t > 0) planes.push(new THREE.Plane(n.clone().negate(), p + t));
      return planes;
    }
    return [];
  }

  apply() {
    const planes = this.planes();
    this.viewer.renderer.clippingPlanes = planes;
    this.helper.visible = this.mode === "box";
    this.planeHelper.visible = this.mode === "section";
    if (this.mode === "section") {
      const size = this.extent.getSize(new THREE.Vector3());
      const c = this.extent.getCenter(new THREE.Vector3());
      const s = this.section;
      this.planeHelper.position.copy(c);
      this.planeHelper.rotation.set(0, 0, 0);
      if (s.axis === "z") {
        this.planeHelper.position.z = s.position;
        this.planeHelper.scale.set(size.x * 1.1, size.y * 1.1, 1);
      } else if (s.axis === "x") {
        this.planeHelper.position.x = s.position;
        this.planeHelper.rotation.y = Math.PI / 2;
        this.planeHelper.scale.set(size.z * 1.1, size.y * 1.1, 1);
      } else {
        this.planeHelper.position.y = s.position;
        this.planeHelper.rotation.x = Math.PI / 2;
        this.planeHelper.scale.set(size.x * 1.1, size.z * 1.1, 1);
      }
    }
    this.viewer.requestRender();
    this.onChange?.();
  }

  serialize(origin: number[]): ClipState {
    return {
      mode: this.mode,
      box: {
        min: [this.box.min.x + origin[0], this.box.min.y + origin[1], this.box.min.z + origin[2]],
        max: [this.box.max.x + origin[0], this.box.max.y + origin[1], this.box.max.z + origin[2]],
      },
      section: { ...this.section, position: this.section.position + origin[{ x: 0, y: 1, z: 2 }[this.section.axis]] },
    };
  }

  restore(s: ClipState | undefined, origin: number[]) {
    if (!s) {
      this.mode = "none";
      this.apply();
      return;
    }
    if (s.box?.min?.length === 3)
      this.box.set(
        new THREE.Vector3(s.box.min[0] - origin[0], s.box.min[1] - origin[1], s.box.min[2] - origin[2]),
        new THREE.Vector3(s.box.max[0] - origin[0], s.box.max[1] - origin[1], s.box.max[2] - origin[2]),
      );
    if (s.section) this.section = { ...s.section, position: s.section.position - origin[{ x: 0, y: 1, z: 2 }[s.section.axis]] };
    this.mode = s.mode;
    this.apply();
  }
}
