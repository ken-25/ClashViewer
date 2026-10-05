// 指摘。events/<ユーザー>.jsonl の追記イベントを全員分読み、指摘ごとに畳み込む。

export const STATUSES = ["未対応", "対応中", "完了", "対象外"] as const;
export type IssueStatus = (typeof STATUSES)[number];

export interface IssueView {
  // 世界座標。projection が無い（この項目を足す前に登録した）指摘は透視
  camera: { position: number[]; target: number[]; fov: number; projection?: "perspective" | "orthographic" };
  clip: any;
  visibility: any;
  frame: any;
}

export interface IssueComment {
  by: string;
  at: string;
  text: string;
  screenshot?: string;
}

export interface Issue {
  id: string;
  site: string;
  dataset: string; // 登録したデータセットのフォルダ
  datasetVersion: number;
  title: string;
  comment: string;
  status: IssueStatus;
  assignee: string;
  position: number[]; // 世界座標
  view: IssueView;
  screenshots: string[];
  comments: IssueComment[];
  history: { by: string; at: string; text: string }[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueEvent {
  type: "issue.create" | "issue.update" | "issue.comment";
  id: string;
  by: string;
  at: string;
  eid?: string;
  [k: string]: any;
}

export function newIssueId(user: string): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${ymd}-${user.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "u"}-${rnd}`;
}

/** イベントを時刻順に畳み込む。同じイベント（eid）は 1 回だけ数える */
export function foldIssues(events: IssueEvent[]): Map<string, Issue> {
  const seen = new Set<string>();
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const out = new Map<string, Issue>();
  for (const e of sorted) {
    if (e.eid) {
      if (seen.has(e.eid)) continue;
      seen.add(e.eid);
    }
    if (e.type === "issue.create") {
      out.set(e.id, {
        id: e.id,
        site: e.site,
        dataset: e.dataset,
        datasetVersion: e.datasetVersion ?? 1,
        title: e.title ?? "",
        comment: e.comment ?? "",
        status: e.status ?? "未対応",
        assignee: e.assignee ?? "",
        position: e.position,
        view: e.view,
        screenshots: e.screenshot ? [e.screenshot] : [],
        comments: [],
        history: [{ by: e.by, at: e.at, text: "登録" }],
        createdBy: e.by,
        createdAt: e.at,
        updatedAt: e.at,
      });
      continue;
    }
    const issue = out.get(e.id);
    if (!issue) continue; // 登録イベントがまだ同期されていない
    if (e.type === "issue.update") {
      const changes: string[] = [];
      if (e.status && e.status !== issue.status) {
        changes.push(`状態 ${issue.status} → ${e.status}`);
        issue.status = e.status;
      }
      if (e.assignee !== undefined && e.assignee !== issue.assignee) {
        changes.push(`担当 ${issue.assignee || "なし"} → ${e.assignee || "なし"}`);
        issue.assignee = e.assignee;
      }
      if (e.title !== undefined && e.title !== issue.title) {
        changes.push("件名を変更");
        issue.title = e.title;
      }
      if (changes.length) issue.history.push({ by: e.by, at: e.at, text: changes.join("、") });
    } else if (e.type === "issue.comment") {
      issue.comments.push({ by: e.by, at: e.at, text: e.text ?? "", screenshot: e.screenshot });
      if (e.screenshot) issue.screenshots.push(e.screenshot);
    }
    issue.updatedAt = e.at;
  }
  return out;
}
