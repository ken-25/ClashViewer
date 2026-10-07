// 撮影ポイント（E57 のスキャンの器械点と、そこで撮った画像）の一覧と、画像を 3D に貼るときの向きの計算。
// manifest の pointcloud.sources[].scans[]（姿勢・範囲）と sources[].images[]（converter/cli.py の image_entry）から作る。
// DOM・App に依存しない（tests/scanPoints.test.mjs で確かめる）。
//
// 座標の決めごと（E57 の規格・主要ソフトの書き出しに合わせた想定。画像付きの実データでは未確認）:
// - 姿勢は四元数 [w, x, y, z] と平行移動（ファイルの座標系 = 点群の世界座標）
// - 360 画像（spherical）: 画像の左端から右へ方位角が減る（上から見て時計回り）。中央の列が画像の姿勢の +X。
//   上端から下へ仰角が減り、中央の行が水平
// - 写真（pinhole）: 画像の姿勢の −Z を向き、+X が画像の右、+Y が画像の上
// 向きがずれるデータのために、画面で方位の補正（yawDeg）を掛けられるようにしている

import * as THREE from "three";
import type { Manifest } from "./dataset";

export interface ScanPose {
  rotation: number[]; // w, x, y, z
  translation: number[];
}

/** manifest の sources[].scans[] の 1 件（converter/cli.py の e57_to_las） */
export interface ScanRecord {
  index: number;
  name: string;
  guid?: string;
  points?: number;
  pose?: ScanPose;
  bounds?: { min: number[]; max: number[] } | null;
}

/** manifest の sources[].images[] の 1 件（converter/cli.py の image_entry） */
export interface ScanImage {
  index: number;
  name: string;
  guid?: string;
  scanGuid?: string;
  kind: "spherical" | "pinhole" | "cylindrical";
  format: "jpeg" | "png";
  bytes?: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  pose: ScanPose | null;
  /** データセットのフォルダからの相対パス。書き出せなかった画像は null */
  file: string | null;
  focalLength?: number;
  principalPoint?: number[];
  radius?: number;
  principalY?: number;
}

/** 画像と、それを貼る姿勢（画像に姿勢が無ければスキャンの姿勢） */
export interface StationImage {
  image: ScanImage;
  /** 画像ファイルのデータ相対パス（datasets/<持ち主>/images/...） */
  rel: string;
  rotation: number[];
  /** 画像を撮った位置（世界座標） */
  position: number[];
}

export interface ScanStation {
  /** 版の中で一意（元ファイルの番号:スキャン番号。画像だけの撮影ポイントは 元ファイル:img番号） */
  id: string;
  label: string;
  /** 元の E57 のファイル名 */
  source: string;
  /** 器械点（世界座標）。点群の範囲から外れていて本物でないと見たものは null */
  position: number[] | null;
  rotation: number[];
  points?: number;
  images: StationImage[];
}

const IDENTITY = [1, 0, 0, 0];

/** 範囲に余裕を足して、その中に p があるか */
function inside(p: number[], b: { min: number[]; max: number[] } | null | undefined, margin: number): boolean {
  if (!b) return false;
  return [0, 1, 2].every((i) => p[i] >= b.min[i] - margin && p[i] <= b.max[i] + margin);
}

/**
 * 器械点の位置が本物か。E57 によっては点を世界座標で持ち、姿勢を単位（原点）のままにしている。
 * そのときの器械点は「原点」で、撮影ポイントとしては意味が無い。器械点は自分のスキャンの範囲の中に
 * あるはずなので、範囲（無ければ点群全体の範囲）から外れていれば位置不明とする。
 */
export function stationPositionKnown(pose: ScanPose | undefined, scanBounds: { min: number[]; max: number[] } | null | undefined, cloudBounds: { min: number[]; max: number[] } | null | undefined): boolean {
  if (!pose || !Array.isArray(pose.translation) || pose.translation.length < 3) return false;
  if (!pose.translation.every((v) => Number.isFinite(v))) return false;
  if (scanBounds) return inside(pose.translation, scanBounds, 2);
  return inside(pose.translation, cloudBounds, 5);
}

/** 撮影ポイントの一覧（元ファイル順・スキャン順）。点群が無ければ空 */
export function scanStations(m: Manifest): ScanStation[] {
  const pc = m.pointcloud;
  if (!pc) return [];
  const out: ScanStation[] = [];
  const multi = pc.sources.length > 1;
  pc.sources.forEach((src, si) => {
    const scans = (src.scans ?? []) as ScanRecord[];
    const images = ((src as { images?: ScanImage[] }).images ?? []).filter((img) => img && img.file);
    const used = new Set<ScanImage>();
    const imageOf = (img: ScanImage, fallback: { rotation: number[]; position: number[] | null }): StationImage | null => {
      const position = img.pose?.translation ?? fallback.position;
      if (!position) return null;
      return { image: img, rel: `datasets/${pc.owner}/${img.file}`, rotation: img.pose?.rotation ?? fallback.rotation, position };
    };
    for (const s of scans) {
      const known = stationPositionKnown(s.pose, s.bounds, pc.bounds);
      const rotation = s.pose?.rotation ?? IDENTITY;
      const position = known ? s.pose!.translation : null;
      const mine = images.filter((img) => !used.has(img) && !!s.guid && img.scanGuid === s.guid);
      const st: ScanStation = {
        id: `${si}:${s.index}`,
        label: multi ? `${s.name}（${src.name}）` : s.name,
        source: src.name,
        position,
        rotation,
        points: s.points,
        images: [],
      };
      for (const img of mine) {
        const si2 = imageOf(img, { rotation, position });
        if (si2) {
          st.images.push(si2);
          used.add(img);
        }
      }
      // 器械点が不明でも、画像に姿勢があればその位置を撮影ポイントにする
      if (!st.position && st.images.length) st.position = st.images[0].position;
      out.push(st);
    }
    // スキャンに結び付かない画像（姿勢があるものだけ）は、画像だけの撮影ポイントにする
    for (const img of images) {
      if (used.has(img) || !img.pose) continue;
      const si2 = imageOf(img, { rotation: IDENTITY, position: null })!;
      out.push({ id: `${si}:img${img.index}`, label: multi ? `${img.name}（${src.name}）` : img.name, source: src.name, position: si2.position, rotation: si2.rotation, images: [si2] });
    }
  });
  return out;
}

/** 位置が分かる撮影ポイントだけ（移動・目印に使える） */
export function placedStations(list: ScanStation[]): ScanStation[] {
  return list.filter((s) => s.position);
}

/**
 * 前・次の撮影ポイント（位置が分かるものだけを順に巡り、端まで行ったら反対の端へ戻る）。
 * current が null・見つからなければ、次は先頭・前は末尾。巡る先が無ければ null。
 */
export function stepStation(list: ScanStation[], current: string | null, dir: 1 | -1): ScanStation | null {
  const placed = placedStations(list);
  if (!placed.length) return null;
  const i = placed.findIndex((s) => s.id === current);
  if (i < 0) return dir > 0 ? placed[0] : placed[placed.length - 1];
  return placed[(i + dir + placed.length) % placed.length];
}

/** 位置が分かる撮影ポイントのうち、p（世界座標）にいちばん近いもの */
export function nearestStation(list: ScanStation[], p: ArrayLike<number>): ScanStation | null {
  let best: ScanStation | null = null;
  let bestD = Infinity;
  for (const s of placedStations(list)) {
    const d = (s.position![0] - p[0]) ** 2 + (s.position![1] - p[1]) ** 2 + (s.position![2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// ---- 画像を貼る向き ----

/** E57 の四元数 [w, x, y, z] を three.js の四元数に */
export function poseQuaternion(rotation: number[]): THREE.Quaternion {
  const [w, x, y, z] = rotation.length >= 4 ? rotation : IDENTITY;
  const q = new THREE.Quaternion(x, y, z, w);
  return q.lengthSq() > 1e-12 ? q.normalize() : new THREE.Quaternion();
}

/** 画像の向き: 画像の姿勢に、鉛直（世界の Z）まわりの方位の補正を先に掛ける */
export function imageQuaternion(rotation: number[], yawDeg = 0): THREE.Quaternion {
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(yawDeg));
  return yaw.multiply(poseQuaternion(rotation));
}

/**
 * 360 画像・円筒画像の画素位置（u, v は 0〜1。左上が 0,0）の、画像の姿勢での向き（単位ベクトル）。
 * spherical: 中央の列が +X、右へ行くほど時計回り（方位角が減る）。中央の行が水平、上へ行くほど上向き
 * cylindrical: 方位は同じ。縦は円筒（半径 radius）の上の高さ
 */
export function panoramaDirection(img: ScanImage, u: number, v: number): THREE.Vector3 {
  const az = (img.width / 2 - u * img.width) * img.pixelWidth;
  if (img.kind === "cylindrical") {
    const r = img.radius && img.radius > 0 ? img.radius : 1;
    const py = img.principalY ?? img.height / 2;
    const z = ((py - v * img.height) * img.pixelHeight) / r;
    return new THREE.Vector3(Math.cos(az), Math.sin(az), z).normalize();
  }
  const el = (img.height / 2 - v * img.height) * img.pixelHeight;
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

/**
 * 写真（pinhole）の四隅を、画像の姿勢で距離 d（焦点距離の d 倍ではなく、光軸方向の奥行き d m）の面に置いた位置。
 * 順は 左上・右上・右下・左下。
 */
export function pinholeCorners(img: ScanImage, d: number): THREE.Vector3[] {
  const f = img.focalLength && img.focalLength > 0 ? img.focalLength : img.pixelWidth * img.width;
  const [ppx, ppy] = img.principalPoint ?? [img.width / 2, img.height / 2];
  const k = d / f;
  const at = (px: number, py: number) => new THREE.Vector3((px - ppx) * img.pixelWidth * k, (ppy - py) * img.pixelHeight * k, -d);
  return [at(0, 0), at(img.width, 0), at(img.width, img.height), at(0, img.height)];
}

/** 写真の光軸（画像の姿勢での向き） */
export const PINHOLE_FORWARD = new THREE.Vector3(0, 0, -1);

/** 撮影ポイントに着いたときに最初に向く方向（世界座標の単位ベクトル。水平）。器械の +X を水平にしたもの */
export function stationForward(st: ScanStation, yawDeg = 0): THREE.Vector3 {
  const img = st.images[0];
  const q = imageQuaternion(img?.rotation ?? st.rotation, yawDeg);
  const v = (img?.image.kind === "pinhole" ? PINHOLE_FORWARD.clone() : new THREE.Vector3(1, 0, 0)).applyQuaternion(q);
  v.z = 0;
  return v.lengthSq() > 1e-9 ? v.normalize() : new THREE.Vector3(1, 0, 0);
}
