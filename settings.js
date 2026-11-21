/*
 * 設定画面の動き
 *
 * 出題分野と1日の問題数は、GitHub のリポジトリにある config.json に保存する。
 * 毎朝のカード作成（scripts/generate.py）がそのファイルを読むので、翌朝から反映される。
 *
 * スマホから GitHub のファイルを書き換えるには、GitHub API（REST API）を使う:
 *   GET  /repos/{owner}/{repo}/contents/config.json  … 今の中身と、版の番号（sha）を取得
 *   PUT  /repos/{owner}/{repo}/contents/config.json  … 新しい中身を保存（コミットになる）
 * 書き込みにはアクセストークン（GitHub 用の合言葉）が必要。トークンはこの端末の localStorage にだけ置く。
 */

const CONN_KEY = "asa-it:github"; // 接続情報の保存に使う名前
const MAX_CARDS = 5; // generate.py の MAX_CARDS と合わせる

// 費用の目安（1回の生成）: 入力（記事候補など）が約0.03ドル、カード1枚の出力が約0.027ドル
const USD_BASE = 0.03;
const USD_PER_CARD = 0.027;
const YEN_PER_USD = 150;

const $ = (id) => document.getElementById(id);
let categoryNames = []; // 全分野の名前（categories.json の順）

// ===== 接続情報（owner / repo / token）の読み書き =====
function loadConn() {
  try {
    return JSON.parse(localStorage.getItem(CONN_KEY)) || {};
  } catch {
    return {};
  }
}

function saveConn(conn) {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify(conn));
    return true;
  } catch {
    return false;
  }
}

// GitHub Pages で開いているときは、URL（owner.github.io/repo/）から owner と repo がわかる
function guessFromLocation() {
  const host = location.hostname;
  if (!host.endsWith(".github.io")) return {};
  return { owner: host.replace(".github.io", ""), repo: location.pathname.split("/")[1] || "" };
}

// ===== 日本語を含む文字列と Base64 の変換 =====
// GitHub API はファイルの中身を Base64 でやり取りする。日本語は一度 UTF-8 のバイト列にしてから変換する
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// ===== GitHub API =====
async function github(method, conn, body) {
  const url = `https://api.github.com/repos/${conn.owner}/${conn.repo}/contents/config.json`;
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${conn.token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("トークンが正しくないか、期限が切れています。");
  if (res.status === 403) throw new Error("トークンに書き込みの権限がありません（Contents: Read and write が必要）。");
  if (res.status === 404) throw new Error("リポジトリが見つかりません。ユーザー名・リポジトリ名と、トークンの対象リポジトリを確認してください。");
  if (res.status === 409) throw new Error("ほかの更新と重なりました。もう一度保存してください。");
  if (!res.ok) throw new Error(`GitHub でエラーが起きました（${res.status}）。`);
  return res.json();
}

function hasConn(conn) {
  return conn.owner && conn.repo && conn.token;
}

// ===== 画面の組み立て =====
function renderCategories(selected) {
  const box = $("categories");
  box.replaceChildren(
    ...categoryNames.map((name) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = name;
      input.checked = selected.includes(name);
      const label = document.createElement("label");
      label.className = "check";
      label.append(input, name);
      return label;
    })
  );
}

function renderCount(count) {
  const select = $("count");
  select.replaceChildren(
    ...Array.from({ length: MAX_CARDS }, (_, i) => {
      const option = document.createElement("option");
      option.value = String(i + 1);
      option.textContent = `${i + 1}問`;
      return option;
    })
  );
  select.value = String(count);
  updateCost();
}

function updateCost() {
  const n = Number($("count").value);
  const yenPerMonth = (USD_BASE + USD_PER_CARD * n) * YEN_PER_USD * 21; // 平日だけ（月に約21日）
  $("cost").textContent = `費用の目安: 月 約${Math.round(yenPerMonth / 10) * 10}円（平日のみ）`;
}

function selectedCategories() {
  return [...document.querySelectorAll("#categories input:checked")].map((i) => i.value);
}

function setStatus(id, text, kind = "") {
  const p = $(id);
  p.textContent = text;
  p.className = `status-msg ${kind}`;
}

// ===== 今の設定を読む =====
// 接続情報があれば GitHub から最新を読む。なければ公開中の config.json を読む
async function loadCurrentConfig() {
  const conn = loadConn();
  if (hasConn(conn)) {
    try {
      const file = await github("GET", conn);
      return JSON.parse(fromBase64(file.content));
    } catch (e) {
      setStatus("status", `GitHub から読み込めませんでした: ${e.message}`, "ng");
    }
  }
  const res = await fetch("config.json", { cache: "no-cache" });
  return res.json();
}

// ===== 保存 =====
async function saveConfig() {
  const categories = selectedCategories();
  if (categories.length === 0) {
    setStatus("status", "分野を1つ以上選んでください。", "ng");
    return;
  }
  const conn = loadConn();
  if (!hasConn(conn)) {
    setStatus("status", "先に下の「GitHub との接続」を設定してください。", "ng");
    $("connection").open = true;
    return;
  }

  const paused = $("paused").checked;
  const config = { categories, cards_per_day: Number($("count").value), paused };
  const button = $("save");
  button.disabled = true;
  setStatus("status", "保存しています…");
  try {
    // 上書きするには、今のファイルの版の番号（sha）が必要
    const current = await github("GET", conn);
    await github("PUT", conn, {
      message: paused ? "設定を変更: 自動作成を一時停止" : `設定を変更: ${config.cards_per_day}問 / ${categories.join("・")}`,
      content: toBase64(JSON.stringify(config, null, 2) + "\n"),
      sha: current.sha,
    });
    setStatus(
      "status",
      paused ? "✅ 保存しました。自動作成を一時停止しました（翌朝から費用がかかりません）。" : "✅ 保存しました。翌朝のカードから反映されます。",
      "ok"
    );
  } catch (e) {
    setStatus("status", `保存できませんでした: ${e.message}`, "ng");
  } finally {
    button.disabled = false;
  }
}

// ===== 起動 =====
async function main() {
  // 接続情報の欄を埋める（保存済みのもの → なければURLから推測）
  const conn = { ...guessFromLocation(), ...loadConn() };
  $("owner").value = conn.owner || "";
  $("repo").value = conn.repo || "";
  $("token").value = conn.token || "";
  if (!hasConn(conn)) $("connection").open = true;

  $("save-conn").addEventListener("click", () => {
    const next = {
      owner: $("owner").value.trim(),
      repo: $("repo").value.trim(),
      token: $("token").value.trim(),
    };
    if (!hasConn(next)) {
      setStatus("conn-status", "3つとも入力してください。", "ng");
      return;
    }
    const saved = saveConn(next);
    setStatus("conn-status", saved ? "✅ この端末に保存しました。" : "このブラウザでは保存できませんでした。", saved ? "ok" : "ng");
  });

  $("all-on").addEventListener("click", () => document.querySelectorAll("#categories input").forEach((i) => (i.checked = true)));
  $("all-off").addEventListener("click", () => document.querySelectorAll("#categories input").forEach((i) => (i.checked = false)));
  $("count").addEventListener("change", updateCost);
  $("save").addEventListener("click", saveConfig);

  try {
    categoryNames = Object.keys(await (await fetch("categories.json", { cache: "no-cache" })).json());
    const config = await loadCurrentConfig();
    renderCategories(config.categories || categoryNames);
    renderCount(config.cards_per_day || 3);
    $("paused").checked = config.paused === true;
  } catch {
    setStatus("status", "設定を読み込めませんでした。", "ng");
  }
}

main();
