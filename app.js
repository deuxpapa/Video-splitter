"use strict";

/* ==========================================================
   かんたん動画分割 - アプリ本体
   動画を約1分50秒（±5秒程度）ごとに、再エンコードなしで高速に分割する。
   処理はすべて端末内（ブラウザ内）で完結し、外部へ動画を送信しない。
   ========================================================== */

// 更新するたびに手動で書き換える（画面に表示され、更新が反映されたかの確認に使う）
const APP_VERSION = "2026-09-14.9";

const SEGMENT_SECONDS = 110; // 目安の区切り時間（実際の区切りは直後のキーフレームになるため、多少前後する）
const TARGET_SEGMENT_BYTES = 113 * 1024 * 1024; // 1パーツあたりの目標データ量（大きい動画では、これを超えないようパーツを短くする）
const MIN_SEGMENT_SECONDS = 20; // パーツを短くする場合でも、これより短くはしない
const MIN_TAIL_SECONDS = 5; // 最後の端数がこの秒数以下なら、独立させず1つ前のパーツに含める
const FFMPEG_VERSION = "0.12.10";
const UTIL_VERSION = "0.12.1";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_VERSION}/dist/esm`;
const FFMPEG_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd`;

const screens = {
  select: document.getElementById("screen-select"),
  ready: document.getElementById("screen-ready"),
  processing: document.getElementById("screen-processing"),
  result: document.getElementById("screen-result"),
};

const fileInput = document.getElementById("file-input");
const readyFilename = document.getElementById("ready-filename");
const readyMeta = document.getElementById("ready-meta");
const btnStart = document.getElementById("btn-start");
const btnReselect = document.getElementById("btn-reselect");
const btnRestart = document.getElementById("btn-restart");
const progressFill = document.getElementById("progress-bar-fill");
const progressOuter = document.getElementById("progress-bar-outer");
const progressLabel = document.getElementById("progress-label");
const progressElapsedEl = document.getElementById("progress-elapsed");
const resultHeading = document.getElementById("result-heading");
const resultElapsedEl = document.getElementById("result-elapsed");
const resultSourceDateEl = document.getElementById("result-source-date");
const resultSingleNote = document.getElementById("result-single-note");
const segmentList = document.getElementById("segment-list");
const toastEl = document.getElementById("toast");
const errorDetailEl = document.getElementById("error-detail");
const versionTagEl = document.getElementById("version-tag");

versionTagEl.textContent = `version ${APP_VERSION}`;

let currentFile = null;
let ffmpeg = null;
let toastTimer = null;
let wakeLock = null;
let ffmpegLog = [];

/* ---------- 画面切り替え ---------- */
function showScreen(name) {
  for (const key in screens) {
    screens[key].hidden = key !== name;
  }
}

/* ---------- トースト（成功・失敗の合図） ---------- */
function showToast(message, type = "success", durationMs) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.hidden = false;
  const defaultDuration = type === "success" ? 1700 : 6000;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, durationMs ?? defaultDuration);
}

const MEMORY_HINT = "端末のメモリが不足していないか確認してください。";

function showErrorToast(detail) {
  showToast(`処理に失敗しました。${MEMORY_HINT}${detail ? " " + detail : ""}`, "error");
}

function clearErrorDetail() {
  errorDetailEl.hidden = true;
  errorDetailEl.textContent = "";
}

function showErrorDetail(err) {
  const name = (err && err.name) || "UnknownError";
  const message = (err && err.message) || String(err);
  const fileInfo = currentFile
    ? `${currentFile.name} / ${formatBytes(currentFile.size)} / ${currentFile.type || "type不明"}`
    : "不明";
  const logTail = ffmpegLog.slice(-15).join("\n");
  errorDetailEl.textContent =
    `エラー詳細（サポート用）\n${name}: ${message}\n動画: ${fileInfo}` +
    (logTail ? `\n---- 内部ログ(直近) ----\n${logTail}` : "");
  errorDetailEl.hidden = false;
}

/* ---------- 画面が自動で消えないようにする（対応端末のみ） ---------- */
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (e) {
    // 取得できない場合（バッテリー節約モードなど）でも、分割処理自体は続行する
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch (e) { /* 何もしない */ }
  wakeLock = null;
}

// 画面ロックなどで一度解除されても、処理中に復帰したら取り直す
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !screens.processing.hidden) {
    requestWakeLock();
  }
});

/* ---------- ユーティリティ ---------- */
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getExtension(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || "");
  return m ? m[1].toLowerCase() : "mp4";
}

function getBaseName(filename) {
  return (filename || "video").replace(/\.[a-zA-Z0-9]+$/, "");
}

/* ---------- ステップ1→2：ファイル選択 ---------- */
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  currentFile = file;

  readyFilename.textContent = file.name;
  readyMeta.textContent = `${formatBytes(file.size)}・動画の長さは分割開始時に確認します`;

  showScreen("ready");
});

btnReselect.addEventListener("click", () => {
  resetToSelect();
});

btnRestart.addEventListener("click", () => {
  resetToSelect();
});

function resetToSelect() {
  currentFile = null;
  fileInput.value = "";
  clearErrorDetail();
  showScreen("select");
}

/* ---------- 外部スクリプトの読み込み（動画分割エンジン本体） ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`ライブラリの読み込みに失敗しました: ${src}`));
    document.head.appendChild(s);
  });
}

/* ---------- FFmpeg 読み込み ---------- */
async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;

  if (!window.FFmpegWASM) {
    await loadScript(`${FFMPEG_BASE}/ffmpeg.js`);
  }
  if (!window.FFmpegUtil) {
    await loadScript(`https://cdn.jsdelivr.net/npm/@ffmpeg/util@${UTIL_VERSION}/dist/umd/index.js`);
  }

  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL } = window.FFmpegUtil;

  const instance = new FFmpeg();

  instance.on("progress", ({ progress }) => {
    updateProgress(progressBase + (progress || 0) * progressWeight);
  });
  instance.on("log", ({ message }) => {
    ffmpegLog.push(message);
    if (ffmpegLog.length > 60) ffmpegLog.shift();
  });

  progressLabel.textContent = "分割の準備をしています…";

  await instance.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    classWorkerURL: await toBlobURL(`${FFMPEG_BASE}/814.ffmpeg.js`, "text/javascript"),
  });

  ffmpeg = instance;
  return ffmpeg;
}

let progressBase = 0; // 完了済みパーツ分の進捗（0〜1）
let progressWeight = 1; // 今のパーツ1個分が、全体のうちどれだけの割合か
let progressPartLabel = ""; // 「（2/5個目）」のような表示

function updateProgress(ratio) {
  const pct = Math.min(100, Math.max(0, Math.round((ratio || 0) * 100)));
  progressFill.style.width = `${pct}%`;
  progressOuter.setAttribute("aria-valuenow", String(pct));
  progressLabel.textContent = `分割しています…${progressPartLabel}（${pct}%）`;
}

/* ---------- 経過時間の表示（止まって見えるのを防ぐ） ---------- */
let elapsedTimerId = null;
let elapsedStartMs = 0;

function startElapsedTimer() {
  elapsedStartMs = Date.now();
  updateElapsedDisplay();
  clearInterval(elapsedTimerId);
  elapsedTimerId = setInterval(updateElapsedDisplay, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimerId);
  elapsedTimerId = null;
  progressElapsedEl.textContent = "";
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function updateElapsedDisplay() {
  const sec = (Date.now() - elapsedStartMs) / 1000;
  progressElapsedEl.textContent = `経過時間 ${formatDuration(sec)}`;
}

/* ---------- 動画の長さ・撮影日時を取得（ffprobeの代わりにログから読み取る） ---------- */
async function probeMediaInfo(instance, inputName) {
  let durationText = "";
  let creationTimeText = "";
  const onLog = ({ message }) => {
    const d = /Duration:\s*(\d\d):(\d\d):(\d\d)\.(\d+)/.exec(message);
    if (d) durationText = d[0];
    if (!creationTimeText) {
      const c = /creation_time\s*:\s*(.+)/.exec(message);
      if (c) creationTimeText = c[1].trim();
    }
  };
  instance.on("log", onLog);
  try {
    await instance.exec(["-i", inputName]);
  } catch (e) {
    // 出力先を指定していないため、ffmpegは必ずエラー終了する（想定内）
  }
  instance.off("log", onLog);

  let durationSeconds = null;
  const m = /Duration:\s*(\d\d):(\d\d):(\d\d)\.(\d+)/.exec(durationText);
  if (m) {
    const hours = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    const secs = parseInt(m[3], 10);
    const frac = parseInt(m[4], 10) / Math.pow(10, m[4].length);
    durationSeconds = hours * 3600 + mins * 60 + secs + frac;
  }

  let creationDate = null;
  if (creationTimeText) {
    const parsed = new Date(creationTimeText);
    if (!isNaN(parsed.getTime())) creationDate = parsed;
  }

  return { durationSeconds, creationDate };
}

// 写真アプリが動画の日付表示に使う、Apple独自のメタデータ形式
// （例: 2022-04-07T17:48:02+0900）。端末のタイムゾーンで書き出す。
function toAppleDateString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad(Math.floor(absMin / 60));
  const offM = pad(absMin % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${offH}${offM}`
  );
}

/* ---------- ステップ2→3→4：分割開始 ---------- */
btnStart.addEventListener("click", async () => {
  if (!currentFile) return;
  clearErrorDetail();
  ffmpegLog = [];

  showScreen("processing");
  progressBase = 0;
  progressWeight = 1;
  progressPartLabel = "";
  progressLabel.textContent = "準備しています…";
  updateProgress(0);
  startElapsedTimer();
  await requestWakeLock();

  const ext = getExtension(currentFile.name);
  const inputName = `input.${ext}`;
  const baseName = getBaseName(currentFile.name);

  try {
    // 動画の長さ・撮影日時を確認するためだけに、一度エンジンを読み込む。
    // 確認が終わったら、このエンジンは完全に終了させる（下記参照）。
    let probeInstance = await ensureFFmpeg();

    progressLabel.textContent = "動画を読み込んでいます…";
    let fileData = new Uint8Array(await currentFile.arrayBuffer());
    await probeInstance.writeFile(inputName, fileData);
    fileData = null; // 書き込み終わったら、JS側が持つ分（動画と同じ大きさ）を早めに解放する

    progressLabel.textContent = "動画の長さを確認しています…";
    const { durationSeconds, creationDate: probedCreationDate } = await probeMediaInfo(probeInstance, inputName);
    const totalSeconds = durationSeconds && durationSeconds > 0 ? durationSeconds : SEGMENT_SECONDS;

    // 動画ファイル自体の更新日時（iPhoneが動画を渡してくるときに、動画データの
    // 内部メタデータ（撮影日時）が書き換わってしまうことがあるため、
    // そちらより信頼できる可能性がある「ファイルの更新日時」も見ておく）。
    const fileLastModifiedDate = currentFile.lastModified ? new Date(currentFile.lastModified) : null;
    // ファイルの更新日時があればそちらを優先し、無ければ動画内部のメタデータを使う。
    const creationDate = fileLastModifiedDate || probedCreationDate;

    // ここでエンジンを完全に終了する。パーツを1個処理するごとにエンジンを
    // 作り直すことで、処理を重ねるうちに内部状態が少しずつ積み上がって
    // メモリを圧迫する（＝クラッシュしやすくなる）のを防ぐ。
    try {
      await probeInstance.deleteFile(inputName);
    } catch (e) { /* 何もしない */ }
    try {
      probeInstance.terminate();
    } catch (e) { /* 何もしない */ }
    ffmpeg = null;
    probeInstance = null;

    // 動画のビットレート（1秒あたりのデータ量）を概算し、大きい動画では
    // パーツ1個分のデータ量が目標値を超えないよう、区切り時間を自動で短くする。
    // （パーツを処理する間、元動画とパーツの両方をメモリ上に抱えるため、
    // 　パーツが大きいほどメモリ不足になりやすい）
    const bytesPerSecond = currentFile.size / totalSeconds;
    const effectiveSegmentSeconds = Math.max(
      MIN_SEGMENT_SECONDS,
      Math.min(SEGMENT_SECONDS, Math.floor(TARGET_SEGMENT_BYTES / bytesPerSecond))
    );
    let segmentCount = Math.max(1, Math.ceil(totalSeconds / effectiveSegmentSeconds));
    // 最後のパーツが短すぎる（5秒以内）場合は、独立した1パーツにはせず、
    // 1つ前のパーツに吸収させる（＝パーツ数を1減らし、最後のパーツは動画の終端まで含める）。
    if (segmentCount > 1) {
      const lastPartSeconds = totalSeconds - (segmentCount - 1) * effectiveSegmentSeconds;
      // 動画の長さの読み取りには小さな誤差があるため、少し余裕を持たせて比較する
      if (lastPartSeconds <= MIN_TAIL_SECONDS + 1) {
        segmentCount -= 1;
      }
    }

    // 1パーツずつ順番に処理する。パーツごとにエンジンを作り直して完全に
    // 終了させることで、処理を重ねてもメモリ使用量が積み上がらないようにする。
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
      progressBase = i / segmentCount;
      progressWeight = 1 / segmentCount;
      progressPartLabel = segmentCount > 1 ? `（${i + 1}/${segmentCount}個目）` : "";
      progressLabel.textContent = `準備しています…${progressPartLabel}`;

      const segInstance = await ensureFFmpeg();

      progressLabel.textContent = `動画を読み込んでいます…${progressPartLabel}`;
      let segFileData = new Uint8Array(await currentFile.arrayBuffer());
      await segInstance.writeFile(inputName, segFileData);
      segFileData = null;

      progressLabel.textContent = `切り出しています…${progressPartLabel}`;
      updateProgress(progressBase);

      const outName = `out_${String(i).padStart(3, "0")}.mp4`;
      const nominalStart = i * effectiveSegmentSeconds;
      const isLast = i === segmentCount - 1;

      const execArgs = [
        "-ss", String(nominalStart),
        "-i", inputName,
      ];
      // 最後のパーツだけは長さを指定せず、動画の終端までそのまま含める
      // （吸収された端数分もここに含まれる）
      if (!isLast) {
        execArgs.push("-t", String(effectiveSegmentSeconds));
      }
      execArgs.push(
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-map_metadata", "0",
        // MP4/MOVは既定だと標準的でないメタデータ項目を書き込まずに捨ててしまうため、
        // 独自キー（com.apple.quicktime.creationdate）を確実に書き込むために必要
        "-movflags", "use_metadata_tags"
      );
      if (creationDate) {
        // 写真アプリで「分割前データの直後」に順番通り並ぶよう、
        // 元動画の撮影日時 + このパーツの開始位置（+1秒）を撮影日時として設定する。
        const segTime = new Date(creationDate.getTime() + (nominalStart + 1) * 1000);
        execArgs.push("-metadata", `creation_time=${segTime.toISOString()}`);
        // 写真アプリが実際に参照するApple独自のキーにも同じ日時を設定する
        execArgs.push("-metadata", `com.apple.quicktime.creationdate=${toAppleDateString(segTime)}`);
      }
      execArgs.push(outName);

      await segInstance.exec(execArgs);

      const data = await segInstance.readFile(outName);
      try {
        await segInstance.deleteFile(outName);
      } catch (e) { /* 何もしない */ }
      try {
        await segInstance.deleteFile(inputName);
      } catch (e) { /* 何もしない */ }
      try {
        segInstance.terminate();
      } catch (e) { /* 何もしない */ }
      ffmpeg = null;

      if (data.byteLength === 0) {
        // 最後のパーツが動画の終端をわずかに超えて要求した場合など。中身が無いので無視する。
        continue;
      }

      const blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      segments.push({
        index: segments.length + 1,
        start: nominalStart,
        end: isLast ? totalSeconds : nominalStart + effectiveSegmentSeconds,
        url,
        blob,
        filename: `${baseName}_${String(segments.length + 1).padStart(2, "0")}.mp4`,
        sizeBytes: data.byteLength,
      });
    }

    if (segments.length === 0) {
      throw new Error("分割結果を読み取れませんでした。");
    }

    renderResults(segments);
    resultElapsedEl.textContent = `処理時間 ${formatDuration((Date.now() - elapsedStartMs) / 1000)}`;
    if (creationDate) {
      const dateText = creationDate.toLocaleString("ja-JP");
      resultSourceDateEl.innerHTML =
        `元動画の撮影日時：${dateText}<br>元動画の日時に更新しています。`;
    } else {
      resultSourceDateEl.textContent = "";
    }
    showScreen("result");
    showToast("分割が完了しました", "success");
  } catch (err) {
    console.error(err);
    ffmpeg = null;
    showErrorToast("動画を短くするか、他のアプリを閉じてからもう一度お試しください。");
    showErrorDetail(err);
    showScreen("ready");
  } finally {
    stopElapsedTimer();
    releaseWakeLock();
  }
});

/* ---------- 保存する（共有シート経由。使えない環境ではダウンロードにフォールバック） ---------- */
function markSaved(btn) {
  btn.textContent = "保存済み ✓";
  btn.dataset.saved = "true";
}

function fallbackDownload(seg) {
  const a = document.createElement("a");
  a.href = seg.url;
  a.download = seg.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveSegment(seg, btn) {
  const file = new File([seg.blob], seg.filename, { type: "video/mp4" });
  let canShareFile = false;
  if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
    try {
      canShareFile = navigator.canShare({ files: [file] });
    } catch (e) {
      canShareFile = false;
    }
  }

  if (canShareFile) {
    try {
      await navigator.share({ files: [file] });
      markSaved(btn);
      showToast(`${seg.index}番目を保存しました`, "success");
    } catch (err) {
      if (err && err.name === "AbortError") {
        // 共有シートをキャンセルしただけなので、何もしない
        return;
      }
      console.error(err);
      showToast(`共有に失敗しました。${MEMORY_HINT}`, "error");
    }
    return;
  }

  // 共有シートが使えない環境（PCのブラウザなど）ではダウンロードに切り替える
  fallbackDownload(seg);
  markSaved(btn);
  showToast(`${seg.index}番目を保存しました`, "success");
}

/* ---------- 結果表示 ---------- */
function renderResults(segments) {
  segmentList.innerHTML = "";
  resultHeading.textContent = `${segments.length}個に分割できました`;
  resultSingleNote.hidden = segments.length !== 1;

  for (const seg of segments) {
    const li = document.createElement("li");
    li.className = "segment-item";

    const row = document.createElement("div");
    row.className = "segment-item__row";

    const badge = document.createElement("div");
    badge.className = "segment-item__badge";
    badge.textContent = String(seg.index);
    badge.setAttribute("aria-hidden", "true");

    const info = document.createElement("div");
    info.className = "segment-item__info";

    const range = document.createElement("p");
    range.className = "segment-item__range";
    range.textContent = `元動画の ${formatTime(seg.start)}〜${formatTime(seg.end)}`;

    const dur = document.createElement("p");
    dur.className = "segment-item__dur";
    dur.textContent = `長さ ${formatTime(seg.end - seg.start)}・${formatBytes(seg.sizeBytes)}`;

    info.appendChild(range);
    info.appendChild(dur);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "segment-item__save";
    saveBtn.textContent = "保存する";
    saveBtn.setAttribute("aria-label", `${seg.index}番目（元動画の${formatTime(seg.start)}から${formatTime(seg.end)}）を保存する`);
    saveBtn.addEventListener("click", () => saveSegment(seg, saveBtn));

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(saveBtn);

    // プレビューは「内容を確認するだけ」の表示に徹する（長押しでの直接保存は
    // iPhone側の複数動画の自動再生制限や、長押しジェスチャーが周囲の文字の
    // 選択に取られてしまう問題があり、安定して動かせなかったため取りやめた）。
    const preview = document.createElement("video");
    preview.className = "segment-item__preview";
    preview.src = seg.url;
    preview.controls = true;
    preview.playsInline = true;
    preview.setAttribute("aria-label", `${seg.index}番目のプレビュー`);

    li.appendChild(row);
    li.appendChild(preview);
    segmentList.appendChild(li);
  }
}

/* ---------- 想定外のクラッシュも必ず日本語で伝える ---------- */
window.addEventListener("error", (event) => {
  if (!screens.processing.hidden) {
    stopElapsedTimer();
    releaseWakeLock();
    showErrorToast();
    showErrorDetail(event.error || { name: "Error", message: event.message });
    showScreen("ready");
  }
});
window.addEventListener("unhandledrejection", (event) => {
  if (!screens.processing.hidden) {
    stopElapsedTimer();
    releaseWakeLock();
    showErrorToast();
    showErrorDetail(event.reason);
    showScreen("ready");
  }
});

/* ---------- PWA: サービスワーカー登録 ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // オフライン用の登録に失敗しても、通常の利用には影響しない
    });
  });
}
