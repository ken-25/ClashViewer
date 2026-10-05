import * as THREE from "three";

export interface PlaneFit {
  centroid: THREE.Vector3;
  /** 単位ベクトル（向きは不定） */
  normal: THREE.Vector3;
  /** 面からのずれの RMS（m） */
  rms: number;
  /** 面内の広がり（2 番目に大きい主成分の標準偏差, m）。線状の点の集まりを除くのに使う */
  spread: number;
  count: number;
}

/** 点の集まりに平面を当てはめる（主成分分析。いちばん分散の小さい向きが法線） */
export function fitPlane(points: THREE.Vector3[]): PlaneFit | null {
  const n = points.length;
  if (n < 3) return null;
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(n);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    const z = p.z - c.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const { values, vectors } = eigenSym3([
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ]);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  return {
    centroid: c,
    normal: vectors[order[0]].normalize(),
    rms: Math.sqrt(Math.max(0, values[order[0]])),
    spread: Math.sqrt(Math.max(0, values[order[1]])),
    count: n,
  };
}

/** 3x3 対称行列の固有値・固有ベクトル（ヤコビ法） */
export function eigenSym3(m: number[][]): { values: number[]; vectors: THREE.Vector3[] } {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    const scale = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2;
    if (off <= 1e-24 * Math.max(scale, 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1);
      const sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = cs * akp - sn * akq;
        a[k][q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = cs * apk - sn * aqk;
        a[q][k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = cs * vkp - sn * vkq;
        v[k][q] = sn * vkp + cs * vkq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [0, 1, 2].map((i) => new THREE.Vector3(v[0][i], v[1][i], v[2][i])),
  };
}

/**
 * クリック位置の周りの点群が平らなら、その面を返す（平らでなければ null）。
 * 角・縁・まばらな所では外れるので、ずれ（rms）と面内の広がりで弾く。
 * radius: 当てはめに使う範囲（クリックした点からの距離, m）
 */
export function fitCloudPlane(center: THREE.Vector3, points: THREE.Vector3[], radius: number): PlaneFit | null {
  const near = points.filter((p) => p.distanceTo(center) <= radius);
  if (near.length < 15) return null;
  const fit = fitPlane(near);
  if (!fit) return null;
  // 面内に十分広がっている（線状でない）こと。円盤に一様なら spread ≈ radius / 2
  if (fit.spread < radius * 0.2) return null;
  // スキャンのばらつき（数 mm）は許し、角（2 面の点が混じる）は弾く
  if (fit.rms > Math.max(0.004, radius * 0.05) || fit.rms > fit.spread * 0.15) return null;
  return fit;
}

/** 3点の向き。ほぼ一直線なら null */
export function planeFrom3(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 | null {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const n = ab.clone().cross(ac);
  const len = ab.length() * ac.length();
  // 角度 sin < 0.02（約 1°）は一直線とみなす
  if (len < 1e-9 || n.length() / len < 0.02) return null;
  return n.normalize();
}

/** 3点指定の途中の点と、それを結ぶ線（3D 画面の重ね描き） */
export class PickMarks {
  readonly object = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly line: THREE.Line;

  constructor(color = 0x60c0ff) {
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }));
    this.points.frustumCulled = this.line.frustumCulled = false;
    this.points.renderOrder = this.line.renderOrder = 6;
    this.object.add(this.points, this.line);
    this.object.visible = false;
  }

  set(list: THREE.Vector3[]) {
    this.points.geometry.dispose();
    this.line.geometry.dispose();
    this.points.geometry = new THREE.BufferGeometry().setFromPoints(list);
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(list.length >= 2 ? list : []);
    this.object.visible = list.length > 0;
  }
}
