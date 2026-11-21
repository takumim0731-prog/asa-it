/*
 * 朝IT の画面の動き
 *
 * 流れ:
 *   1. data/index.json から「どの日のデータがあるか」を読む
 *   2. 選んだ日の data/YYYY-MM-DD.json を読み、カードを表示する
 *   3. クイズに答えたら正誤と解説を出し、回答を端末（localStorage）に保存する
 */

const ANSWERS_KEY = "asa-it:answers"; // 回答の保存に使う名前

let dates = []; // データがある日付の一覧（新しい順）
let current = 0; // 今表示している日付が dates の何番目か

// ===== 回答の記録（端末の localStorage に保存） =====
// 保存形式: { "2026-11-15": { "記事のURL": 選んだ選択肢の番号, ... }, ... }
// 何枚目かではなく記事のURLで記録するので、同じ日のカードを作り直しても回答がずれない。
// 個人用なので、サーバではなくスマホのブラウザ内に保存する。
// プライベートモードなどで使えない場合もあるので、失敗しても画面は動くようにしておく。

function loadAnswers() {
  try {
    return JSON.parse(localStorage.getItem(ANSWERS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveAnswer(date, cardUrl, choiceIndex) {
  const answers = loadAnswers();
  answers[date] = { ...answers[date], [cardUrl]: choiceIndex };
  try {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify(answers));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

// ===== 画面部品を作るための小さな関数 =====
// 文字は textContent で入れる（innerHTML を使わない）。
// 記事タイトルなどに < > が含まれていても、HTMLとして解釈されず安全に表示される。
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// ===== データの読み込み =====
async function fetchJson(path) {
  // cache: "no-cache" … 毎朝新しいデータが増えるので、古いキャッシュを使わないようにする
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} を読み込めませんでした（${res.status}）`);
  return res.json();
}

// ===== 表示 =====
function showMessage(text) {
  document.getElementById("cards").replaceChildren(el("p", { class: "message", text }));
}

function formatDate(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  const week = "日月火水木金土"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${week}）`;
}

function updateScore(date, cards) {
  const answered = loadAnswers()[date] || {};
  const done = cards.filter((c) => c.url in answered).length;
  const correct = cards.filter((c) => answered[c.url] === c.quiz.answer_index).length;
  document.getElementById("score").textContent =
    done === 0 ? `クイズ ${cards.length}問` : `${done}/${cards.length}問回答 ・ ${correct}問正解`;
}

// 1枚のカード（ニュース1本分）を作る
function renderCard(card, date, cards) {
  const quiz = card.quiz;
  const quizArea = el("div", { class: "section" }, el("h3", { text: "🧠 理解度チェック" }));
  quizArea.append(el("p", { text: quiz.question }));

  const choiceButtons = quiz.choices.map((choice, i) =>
    el("button", { class: "choice", type: "button", text: `${"ABCD"[i]}. ${choice}` })
  );
  const choicesBox = el("div", { class: "choices" }, ...choiceButtons);
  const feedback = el("div");
  quizArea.append(choicesBox, feedback);

  // 回答済みの状態にする（正解・不正解の色を付け、解説を出す）
  function reveal(selected) {
    choiceButtons.forEach((btn, i) => {
      btn.disabled = true; // 一度答えたら変えられない
      if (i === quiz.answer_index) btn.classList.add("correct");
      else if (i === selected) btn.classList.add("wrong");
    });
    const ok = selected === quiz.answer_index;
    feedback.replaceChildren(
      el("p", { class: `result ${ok ? "ok" : "ng"}`, text: ok ? "⭕ 正解！" : `❌ 正解は ${"ABCD"[quiz.answer_index]}` }),
      el("p", { class: "explanation", text: quiz.explanation })
    );
  }

  choiceButtons.forEach((btn, i) =>
    btn.addEventListener("click", () => {
      saveAnswer(date, card.url, i);
      reveal(i);
      updateScore(date, cards);
    })
  );

  // 以前に答えていれば、その状態を復元する
  const previous = loadAnswers()[date]?.[card.url];
  if (previous !== undefined) reveal(previous);

  const link = el("a", { href: card.url, target: "_blank", rel: "noopener", text: card.title });

  return el(
    "article",
    { class: "card" },
    el("span", { class: "tag", text: card.category }),
    el("h2", { text: card.headline }),
    el("p", { class: "source" }, `${card.source}｜`, link),
    el("div", { class: "section" }, el("h3", { text: "📰 ニュース要約" }), el("p", { text: card.summary })),
    el("div", { class: "section" }, el("h3", { text: "🏭 工場目線" }), el("p", { text: card.factory_view })),
    el("div", { class: "section" }, el("h3", { text: "🗣 ベンダーに聞ける一言" }), el("p", { text: card.vendor_question })),
    quizArea
  );
}

async function showDay(index) {
  current = index;
  const date = dates[index];
  document.getElementById("date").textContent = formatDate(date);
  // dates は新しい順なので、「前の日」は番号が大きくなる方向
  document.getElementById("prev").disabled = index >= dates.length - 1;
  document.getElementById("next").disabled = index <= 0;

  try {
    const day = await fetchJson(`data/${date}.json`);
    const cards = day.cards;
    document.getElementById("cards").replaceChildren(...cards.map((c) => renderCard(c, date, cards)));
    updateScore(date, cards);
    window.scrollTo(0, 0);
  } catch (e) {
    showMessage(e.message);
  }
}

// ===== 起動 =====
async function main() {
  document.getElementById("prev").addEventListener("click", () => showDay(current + 1));
  document.getElementById("next").addEventListener("click", () => showDay(current - 1));

  try {
    dates = (await fetchJson("data/index.json")).dates;
  } catch (e) {
    document.getElementById("date").textContent = "—";
    showMessage(e.message);
    return;
  }
  if (dates.length === 0) {
    showMessage("まだデータがありません。");
    return;
  }
  showDay(0); // 最新の日を表示
}

main();
