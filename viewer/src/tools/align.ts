import * as THREE from "three";

/**
 * 3 点（以上）の対応から、モデル（IFC 座標）→ 点群（世界座標）の剛体変換を求める。
 * levelOnly=true なら Z 軸回りの回転＋平行移動だけ（両方とも水平が出ている前提。クリック誤差で傾かない）。
 * 一般の場合は Horn の四元数法（Kabsch と同じ最小二乗解）。
 */
export function solveRigid(model: THREE.Vector3[], cloud: THREE.Vector3[], levelOnly: boolean): { matrix: THREE.Matrix4; residual: number; errors: number[] } {
  if (model.length !== cloud.length || model.length < (levelOnly ? 2 : 3)) throw new Error("対応点が足りません");
  const n = model.length;
  const cp = model.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(n);
  const cq = cloud.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(n);
  let rot: THREE.Matrix4;
  if (levelOnly) {
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const p = model[i].clone().sub(cp);
      const q = cloud[i].clone().sub(cq);
      sxx += p.x * q.x + p.y * q.y;
      sxy += p.x * q.y - p.y * q.x;
    }
    rot = new THREE.Matrix4().makeRotationZ(Math.atan2(sxy, sxx));
  } else {
    // 相関行列 M = Σ p qᵀ から 4x4 対称行列 N を作り、最大固有値の固有ベクトル＝回転の四元数
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < n; i++) {
      const p = model[i].clone().sub(cp).toArray();
      const q = cloud[i].clone().sub(cq).toArray();
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += p[r] * q[c];
    }
    const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = M;
    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
    ];
    const [w, x, y, z] = largestEigenvector(N);
    rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(x, y, z, w).normalize());
  }
  const t = cq.clone().sub(cp.clone().applyMatrix4(rot));
  const matrix = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(rot);
  const errors = model.map((p, i) => p.clone().applyMatrix4(matrix).distanceTo(cloud[i]));
  const residual = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n);
  return { matrix, residual, errors };
}

/** 対称行列の最大固有値に対する固有ベクトル（ヤコビ法） */
function largestEigenvector(A: number[][]): number[] {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i][i] > a[best][best]) best = i;
  return v.map((row) => row[best]);
}
