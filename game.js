/* Night Pulse MVP (2-lane)
   - data/tracks.json 에서 트랙 목록 로드
   - ?track=sample 로 특정 트랙 선택
   - data/<track>.json 에서 audio + notes 로드
   - 키: D(왼쪽) / F(오른쪽), 모바일: 레인 터치
*/

const $ = (id) => document.getElementById(id);

const state = {
  rafId: 0,
  ready: false,
  playing: false,
  audioCtx: null,
  buffer: null,
  source: null,
  startAt: 0,        // audioCtx.currentTime 기준 시작 시간
  pauseAt: 0,        // 일단 MVP에서는 pause 없음
  offsetMs: 0,       // 캘리브레이션 오프셋 (입력 타이밍 보정)
  notes: [],         // {t, lane, hit:false}
  nextIdx: [0, 0],   // lane별 다음 노트 인덱스
  score: 0,
  combo: 0,
  hitCount: 0,
  totalCount: 0,
  judgeTextTimer: 0,
  track: null
};

const config = {
  judgeLineBottomPx: 90,
  laneHeightPx: 520, // CSS min-height 맞춤
  noteTravelMs: 900, // 화면 상단->판정선 도달 시간(연출)
  perfectMs: 55,
  goodMs: 110,
  missMs: 160,        // 이 이상은 미스 처리
  missDrainMs: 220,   // 지나가면 미스
};

const dom = {
  trackName: $("trackName"),
  trackMeta: $("trackMeta"),
  score: $("score"),
  combo: $("combo"),
  acc: $("acc"),
  judgeText: $("judgeText"),
  btnStart: $("btnStart"),
  btnRetry: $("btnRetry"),
  btnCalib: $("btnCalib"),
  laneWrap: $("laneWrap"),
  lanes: Array.from(document.querySelectorAll(".lane")),
  btnStop: $("btnStop"),
  debugLine: $("debugLine"),
};

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function parseQuery() {
  const q = new URLSearchParams(location.search);
  return { track: q.get("track") || "" };
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return await res.json();
}

async function loadTrack() {
  const q = parseQuery();
  const tracks = await fetchJson("./data/tracks.json");

  let selected = tracks.find(t => t.id === q.track);
  if (!selected) selected = tracks[0];

  const data = await fetchJson(`./data/${selected.id}.json`);
  state.track = { ...selected, ...data };

  dom.trackName.textContent = `${state.track.title}`;
  dom.trackMeta.textContent = `${state.track.artist || "sglee"} · ${state.track.bpm ? `${state.track.bpm} BPM` : ""}`.trim();

  state.notes = (state.track.notes || []).map(n => ({ t: n.time, lane: n.lane, hit: false, el: null }));
  state.totalCount = state.notes.length;
}

function ensureAudioContext() {
  if (state.audioCtx) return state.audioCtx;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.audioCtx = ctx;
  return ctx;
}

async function loadAudioBuffer(url) {
  const ctx = ensureAudioContext();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
  const arr = await res.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

function resetRun() {
  // 노트 DOM 정리
  for (const n of state.notes) {
    if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
    n.el = null;
    n.hit = false;
  }
  state.nextIdx = [0, 0];
  state.score = 0;
  state.combo = 0;
  state.hitCount = 0;
  updateHud();
  setJudge("READY");
}

function setJudge(text, kind="neutral") {
  dom.judgeText.textContent = text;
  if (kind === "perfect") dom.judgeText.style.borderColor = "rgba(120,255,190,.35)";
  else if (kind === "good") dom.judgeText.style.borderColor = "rgba(120,160,255,.45)";
  else if (kind === "miss") dom.judgeText.style.borderColor = "rgba(255,120,120,.35)";
  else dom.judgeText.style.borderColor = "rgba(255,255,255,.10)";
  state.judgeTextTimer = performance.now();
}

function updateHud() {
  dom.score.textContent = String(state.score);
  dom.combo.textContent = String(state.combo);
  const acc = state.totalCount ? Math.round((state.hitCount / state.totalCount) * 100) : 0;
  dom.acc.textContent = `${acc}%`;
}

function nowGameTimeSec() {
  if (!state.playing) return 0;
  const ctx = state.audioCtx;
  return (ctx.currentTime - state.startAt) + (state.offsetMs / 1000);
}

function spawnVisibleNotes(tSec) {
  // tSec 기준으로 앞으로 noteTravelMs 동안 내려올 노트들을 만들어두는 방식
  const lookAheadSec = config.noteTravelMs / 1000;

  for (let i = 0; i < state.notes.length; i++) {
    const n = state.notes[i];
    if (n.el) continue;
    // 노트가 화면 위에 등장할 때: (노트 시간 - travel)
    const spawnAt = n.t - lookAheadSec;
    if (tSec >= spawnAt - 0.1 && tSec <= n.t + 1.0) {
      const laneEl = dom.lanes[n.lane];
      const el = document.createElement("div");
      el.className = "note";
      el.style.top = `-30px`;
      laneEl.appendChild(el);
      n.el = el;
    }
  }
}

function updateNotes(tSec) {
  const travelSec = config.noteTravelMs / 1000;
  const laneH = dom.lanes[0].clientHeight || config.laneHeightPx;
  const judgeY = laneH - config.judgeLineBottomPx;

  for (const n of state.notes) {
    if (!n.el || n.hit) continue;

    // 노트 시간 기준 진행도 0~1: spawn -> judge
    const spawnTime = n.t - travelSec;
    const p = (tSec - spawnTime) / travelSec;
    const y = (-30) + p * (judgeY + 30);
    n.el.style.top = `${y}px`;

    // 지나가면 미스 처리
    if (tSec > n.t + (config.missDrainMs/1000)) {
      // 미스 처리
      n.hit = true;
      if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
      n.el = null;
      state.combo = 0;
      setJudge("MISS", "miss");
      updateHud();
    }
  }
}

function findClosestNote(lane, tSec) {
  // 아직 hit되지 않은 해당 lane 노트 중, 현재 시간과 가장 가까운 것
  let best = null;
  let bestDt = Infinity;
  for (const n of state.notes) {
    if (n.hit) continue;
    if (n.lane !== lane) continue;
    const dt = Math.abs((n.t) - tSec);
    if (dt < bestDt) { bestDt = dt; best = n; }
  }
  return { note: best, dt: bestDt };
}

function hit(lane) {
  if (!state.playing) return;
  const tSec = nowGameTimeSec();
  const { note, dt } = findClosestNote(lane, tSec);
  if (!note) return;

  const dtMs = dt * 1000;

  if (dtMs <= config.perfectMs) {
    applyHit(note, "PERFECT", 300, "perfect");
  } else if (dtMs <= config.goodMs) {
    applyHit(note, "GOOD", 150, "good");
  } else if (dtMs <= config.missMs) {
    applyMiss(note);
  } else {
    // 너무 멀면 무시 (오입력 방지)
  }
}

function applyHit(note, label, addScore, kind) {
  note.hit = true;
  if (note.el && note.el.parentNode) note.el.parentNode.removeChild(note.el);
  note.el = null;

  state.combo += 1;
  state.score += addScore + Math.floor(state.combo * 2);
  state.hitCount += 1;

  setJudge(label, kind);
  updateHud();
}

function applyMiss(note) {
  note.hit = true;
  if (note.el && note.el.parentNode) note.el.parentNode.removeChild(note.el);
  note.el = null;

  state.combo = 0;
  setJudge("MISS", "miss");
  updateHud();
}

function bindInputs() {
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key.toLowerCase() === "d") hit(0);
    if (e.key.toLowerCase() === "f") hit(1);
  });

  // 모바일: 레인 터치
  dom.lanes.forEach((laneEl, idx) => {
    laneEl.addEventListener("pointerdown", () => hit(idx));
  });
}

async function startGame() {
  try {
    dom.btnStart.disabled = true;
    dom.btnRetry.disabled = true;

    if (!state.track) await loadTrack();

    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume();

    if (!state.buffer) {
      state.buffer = await loadAudioBuffer(state.track.audio);
    }
     
    resetRun();

    if (!state.notes || state.notes.length === 0) {
      alert("노트(notes)가 0개야. data/sample.json의 notes 배열을 확인해줘.");
    }
     
    // 오디오 재생
    const source = ctx.createBufferSource();
    source.buffer = state.buffer;
    source.connect(ctx.destination);
    state.source = source;

    state.startAt = ctx.currentTime + 0.08; // 살짝 미래에 시작 (안정)
    state.playing = true;

    setJudge("GO", "good");
    source.start(state.startAt);

    source.onended = () => {
      if (!state.playing) return;
      state.playing = false;
      setJudge("FINISH");
      dom.btnStart.disabled = false;
      dom.btnRetry.disabled = false;
    };

    // 루프
    state.rafId = requestAnimationFrame(tick);

  } catch (err) {
    console.error(err);
    alert(`Start failed: ${err.message}`);
    dom.btnStart.disabled = false;
    dom.btnRetry.disabled = false;
  }
}

function stopGame() {
  // 1) 루프 완전 중단
  state.playing = false;
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  // 2) 예약된 start까지 고려해서 AudioContext를 닫고 새로 만들 준비
  // (BufferSource는 stop()이 안 먹는 경우가 가끔 있어서, 이게 제일 확실함)
  try {
    if (state.source) {
      try { state.source.onended = null; } catch {}
      try { state.source.stop(0); } catch {}
      try { state.source.disconnect(); } catch {}
    }
  } catch {}
  state.source = null;

  // 오디오 컨텍스트 자체를 닫아버리면 100% 소리 멈춤
  try {
    if (state.audioCtx && state.audioCtx.state !== "closed") {
      state.audioCtx.close();
    }
  } catch {}
  state.audioCtx = null;
  state.buffer = null; // 다음 Start 때 다시 로드(안정)

  // 3) 노트/화면 정리
  for (const n of state.notes) {
    if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
    n.el = null;
    n.hit = false;
  }

  state.score = 0;
  state.combo = 0;
  state.hitCount = 0;
  updateHud();
  setJudge("STOPPED");

  // 버튼 상태 복구
  dom.btnStart.disabled = false;
  dom.btnRetry.disabled = false;
}

function retryGame() {
  stopGame();
  startGame();
}

function calibrate() {
  // 단순 캘리브레이션: 클릭/터치 후 + / - 버튼 없이 MVP로는 prompt로 입력
  const cur = state.offsetMs || 0;
  const next = prompt(
    "입력 타이밍 오프셋(ms)\n예) -40: 더 빠르게 판정 / +40: 더 늦게 판정\n현재: " + cur,
    String(cur)
  );
  if (next === null) return;
  const v = Number(next);
  if (Number.isFinite(v)) {
    state.offsetMs = clamp(v, -200, 200);
    alert(`오프셋 적용: ${state.offsetMs}ms`);
  }
}

function tick() {
  if (!state.playing) return;

  const tSec = nowGameTimeSec();
  spawnVisibleNotes(tSec);
  updateNotes(tSec);

  // 판정 텍스트 너무 오래 유지되면 살짝 페이드 느낌(문구만 리셋)
  if (performance.now() - state.judgeTextTimer > 900) {
    // 유지하되 기본 테두리만
    dom.judgeText.style.borderColor = "rgba(255,255,255,.10)";
  }
   
   // 디버그: 현재시간/노트수/스폰된 DOM 수 표시
   const spawned = state.notes.reduce((acc, n) => acc + (n.el ? 1 : 0), 0);
   dom.debugLine.textContent = `debug: t=${tSec.toFixed(2)}s, total=${state.totalCount}, spawned=${spawned}`;
  
   state.rafId = requestAnimationFrame(tick);
}

async function init() {
  bindInputs();
  dom.btnStart.addEventListener("click", startGame);
  dom.btnRetry.addEventListener("click", retryGame);
  dom.btnCalib.addEventListener("click", calibrate);
  dom.btnStop.addEventListener("click", stopGame);
   
  await loadTrack();
  setJudge("READY");

  dom.btnStart.disabled = false;
  dom.btnRetry.disabled = false;
}

init();
