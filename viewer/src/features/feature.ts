// 画面の機能（計測・UCS・断面・3点合わせ・指摘・差分など）の状態を持つモジュールの共通の形。
// App は機能の状態を持たず、版を開く・閉じるときに登録順で呼ぶだけにする。
// 新しい機能（搬入検討・干渉チェックなど）も、状態はこの形のクラスに置き、App の constructor で 1 行足す。

import type { Manifest } from "../data/dataset";

export interface AppFeature {
  /** 版を閉じるとき（別の版を開き直す前も）。版に結びついた途中の状態を捨てる */
  onClose?(): void;
  /** 版を開いて点群・モデルを置き、視点を合わせた後 */
  onOpen?(m: Manifest): void | Promise<void>;
}
