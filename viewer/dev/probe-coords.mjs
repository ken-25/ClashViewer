// 開発用: web-ifc の出力座標（Fragments の座標）と IFC 本来の座標の関係を確かめる
import * as WebIFC from "web-ifc";
import { readFileSync } from "node:fs";

const file = process.argv[2];
const api = new WebIFC.IfcAPI();
await api.Init();
const bytes = new Uint8Array(readFileSync(file));
for (const c2o of [false, true]) {
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: c2o });
  let first = null;
  api.StreamAllMeshes(id, (mesh) => {
    if (first) return;
    const g = mesh.geometries.get(0);
    const geom = api.GetGeometry(id, g.geometryExpressID);
    const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    first = { expressID: mesh.expressID, t: Array.from(g.flatTransformation), v0: [verts[0], verts[1], verts[2]] };
  });
  const coord = api.GetCoordinationMatrix(id);
  const t = first.t; const v = first.v0;
  const p = [0, 1, 2].map((r) => t[r] * v[0] + t[4 + r] * v[1] + t[8 + r] * v[2] + t[12 + r]);
  console.log(JSON.stringify({ c2o, expressID: first.expressID, coord: coord.map((x) => +x.toFixed(4)), flatT: t.map((x) => +x.toFixed(4)), localV: v, flatPoint: p }));
  api.CloseModel(id);
}
