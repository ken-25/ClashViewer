// web-ifc の wasm と Fragments のワーカーを public/ に写す（外部通信しないため同梱する）
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const files = [
  ["web-ifc/web-ifc.wasm", "public/wasm/web-ifc.wasm"],
  ["web-ifc/web-ifc-mt.wasm", "public/wasm/web-ifc-mt.wasm"],
  ["@thatopen/fragments/dist/Worker/worker.mjs", "public/fragments/worker.mjs"],
];
for (const [src, dst] of files) {
  const to = join(root, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(nm, src), to);
}
console.log("assets copied");
