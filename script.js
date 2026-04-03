'use strict';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDqk5M_BYqn4NM5GNCnK1VHrHl9NrS36BI",
  authDomain: "order-online-ed76f.firebaseapp.com",
  databaseURL: "https://order-online-ed76f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "order-online-ed76f",
  storageBucket: "order-online-ed76f.firebasestorage.app",
  messagingSenderId: "225638064120",
  appId: "1:225638064120:web:faef65bf1c1c384e30000d"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db   = firebase.database();
const auth = firebase.auth();

/**
 * 匿名ログインを開始し、Promise を保持する。
 *
 * Firebase Realtime Database のデフォルトルールは
 *   ".read": "auth != null"
 *   ".write": "auth != null"
 * のため、認証なしでは全ての読み書きが PERMISSION_DENIED になる。
 * 匿名ログインで auth != null を満たし、別端末からの join を可能にする。
 *
 * ページ読み込み直後に開始するので、ユーザーが名前を入力して
 * ボタンを押すまでには必ず完了している。
 */
const _authReady = auth.signInAnonymously().catch(err => {
  // Anonymous Auth が Firebase コンソールで無効の場合はここに来る。
  // その場合はルールを ".read": true / ".write": true に変更する必要がある。
  console.warn('[Firebase] 匿名ログイン失敗:', err.code);
});

// ============================================================
// CONSTANTS
// ============================================================
const TOPICS = [
  '小学校でどれくらいモテるか',
  '授業中に眠くなるか',
  '夏休みに外で遊ぶか',
  '先生に好かれるか',
  '給食を食べるスピード',
  '体育の授業が好きか',
  '放課後友達と遊ぶか',
  'テストで緊張するか',
  '発表するのが得意か',
  '掃除をちゃんとするか',
  '修学旅行で夜更かしするか',
  '運動会で本気を出すか',
  '友達の秘密を守れるか',
  '宿題を先にやるか',
  '虫が平気か',
  'カラオケで盛り上がるか',
  '人見知りするか',
  '朝ごはんを食べるか',
  '遅刻をするか',
  '好きな人に気持ちを伝えられるか',
  '朝に強いか',
  '音痴かどうか',
  '方向音痴かどうか',
  'お金を貯められるか',
  '辛いものが好きか',
];

const STORE_PFX  = 'order_room_';
const BC_NAME    = 'order_broadcast';
const MIN_CARDS  = 1;
const MAX_CARDS  = 5;
const REVEAL_MS  = 700; // delay before showing result after last reveal

// ============================================================
// SESSION STATE (per tab)
// ============================================================
let myId   = null;   // unique player ID for this tab
let myName = null;   // player's chosen name
let roomId = null;   // current room ID
let room   = null;   // local copy of room state
let sel    = null;   // { src:'hand'|'field', val:number, idx:number|null }
let bc     = null;   // BroadcastChannel

// ============================================================
// UTILITIES
// ============================================================
function uid(n = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function shuffleDeck() {
  const a = Array.from({ length: 100 }, (_, i) => i + 1);
  for (let i = 99; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function el(id)          { return document.getElementById(id); }
function setText(id, v)  { const e = el(id); if (e) e.textContent = v; }
function toggleClass(id, cls, on) { el(id)?.classList.toggle(cls, on); }
function setHidden(id, hidden)    { el(id)?.classList.toggle('hidden', hidden); }

let _toastTimer;
function showToast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className   = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function copyText(text) {
  if (!text) return;
  const succeed = () => showToast('コピーしました ✓', 'success');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(succeed).catch(() => fallback());
  } else { fallback(); }
  function fallback() {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(ta.style, { position: 'fixed', opacity: '0' });
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); succeed(); } catch {}
    document.body.removeChild(ta);
  }
}

// ============================================================
// SCREEN ROUTING
// ============================================================
const app = el('app');
function showScreen(name) { app.dataset.screen = name; }

// ============================================================
// LOCAL STORAGE — source of truth
// ============================================================
function saveRoom(r) {
  r.ts = Date.now();
  localStorage.setItem(STORE_PFX + r.id, JSON.stringify(r));
  bc?.postMessage({ type: 'sync', roomId: r.id });
  pushToFirebase(r); // オンライン同期：変更を Firebase に push
}
function loadRoom(rid) {
  try   { const raw = localStorage.getItem(STORE_PFX + rid); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function deleteRoom(rid) { localStorage.removeItem(STORE_PFX + rid); }

// ============================================================
// BROADCAST CHANNEL
// ============================================================
function initBC() {
  bc?.close();
  if (typeof BroadcastChannel === 'undefined') {
    showToast('BroadcastChannel非対応ブラウザです', 'error');
    return;
  }
  bc = new BroadcastChannel(BC_NAME);
  bc.onmessage = ({ data }) => {
    if (data.roomId !== roomId) return;

    if (data.type === 'closed') {
      showToast('ホストが退出しました', 'warn');
      cleanup(); showScreen('lobby');
      return;
    }
    if (data.type === 'sync') {
      const fresh = loadRoom(roomId);
      if (!fresh) {
        showToast('ルームが閉じられました', 'warn');
        cleanup(); showScreen('lobby');
        return;
      }
      const prev = room?.phase;
      room = fresh;
      onPhaseChange(prev, room.phase);
    }
  };
}

function cleanup() {
  bc?.close(); bc = null;
  stopFirebaseListener(); // Firebase リスナーも解除
  roomId = null; room = null; sel = null;
}

// ============================================================
// FIREBASE ONLINE SYNC
// ============================================================
let _fbRef     = null;  // アクティブな Firebase リスナー参照
let _fbHasData = false; // 初回 null（新規パス）と「ホスト退出」を区別するフラグ

/**
 * Firebase から受け取ったルームデータを正規化する。
 *
 * Firebase Realtime Database は JavaScript の配列を
 * {"0": ..., "1": ..., "2": ...} のオブジェクトとして保存・返却する。
 * そのまま使うと .forEach / .filter / .every / .map が全て壊れるため、
 * 受信直後に配列へ戻す。
 */
function normalizeRoom(data) {
  if (!data) return null;
  if (data.field && !Array.isArray(data.field)) {
    data.field = Object.values(data.field);
  }
  // Firebase は null 値をオブジェクトから削除して保存する。
  // そのため slot.val / slot.owner が undefined になって返ってくる。
  // undefined === null は false なので「埋まっている」と誤判定されるのを防ぐ。
  if (Array.isArray(data.field)) {
    data.field = data.field.map(slot => ({
      val:      slot.val      ?? null,
      owner:    slot.owner    ?? null,
      revealed: slot.revealed ?? false,
    }));
  }
  if (data.players) {
    Object.values(data.players).forEach(p => {
      if (p.hand && !Array.isArray(p.hand)) {
        p.hand = Object.values(p.hand);
      }
    });
  }
  return data;
}

/**
 * ルーム状態を Firebase に書き込む。
 * _writer に自分の myId を付与し、リスナー側が自分の書き込みを
 * スキップできるようにする（エコーループ防止）。
 */
function pushToFirebase(r) {
  if (!db || !r?.id) return;
  db.ref(`rooms/${r.id}/state`).set({ ...r, _writer: myId })
    .catch(err => {
      console.error('[Firebase] write error:', err);
      if (err.code === 'PERMISSION_DENIED') {
        showToast('Firebase 書き込み権限エラー — コンソールでルールを確認してください', 'error');
      }
    });
}

/**
 * 指定ルームの Firebase 変更を監視する。
 * 別ブラウザ／デバイスのプレイヤーが書いた更新を受け取り
 * ローカル状態と UI を同期する。
 */
function startFirebaseListener(rid) {
  stopFirebaseListener();
  _fbHasData = false;
  _fbRef = db.ref(`rooms/${rid}/state`);
  _fbRef.on('value', snap => {
    const data = snap.val();

    if (!data) {
      // 新規作成直後は Firebase にまだデータが無いため最初の null は無視する。
      // _fbHasData が true（一度でもデータを受け取った後）の null は
      // ホストが別端末から退出した合図として扱う。
      if (_fbHasData && room) {
        showToast('ホストが退出しました', 'warn');
        cleanup();
        showScreen('lobby');
      }
      return;
    }

    _fbHasData = true;

    // 自分自身が書いた更新はすでにローカル適用済みなのでスキップ
    if (data._writer === myId) return;

    // Firebase が配列をオブジェクトに変換している場合に復元する
    const normalized = normalizeRoom(data);

    // 自分のプレイヤーデータ（手札・FA状態）はローカルを正とし、
    // 相手の古いスナップショットで上書きされないよう保護する。
    // カード配置直後に相手の更新が届くと手札が巻き戻るレースコンディション対策。
    if (room?.players?.[myId] && normalized.players?.[myId]) {
      const local = room.players[myId];
      // ゲーム開始時にホストが生成したラベルマップをローカルに持っていない場合は引き継ぐ
      if (!local.labels && normalized.players[myId].labels) {
        local.labels = normalized.players[myId].labels;
      }
      // waiting→playing への移行時（＝ホストによるゲーム開始）に、
      // ローカルの手札がまだ空でFirebase側に配られた手札がある場合は引き継ぐ。
      // ゲスト側はカード配布後もローカルが hand:[] のままになるレースコンディション対策。
      if (room.phase === 'waiting' && normalized.phase === 'playing'
          && (!local.hand || local.hand.length === 0)
          && normalized.players[myId].hand?.length > 0) {
        local.hand = normalized.players[myId].hand;
      }
      normalized.players[myId] = local;
    }

    const prev = room?.phase;
    room = normalized;
    // 既存の loadRoom() が localStorage を参照するので合わせて更新
    localStorage.setItem(STORE_PFX + rid, JSON.stringify(normalized));
    onPhaseChange(prev, room.phase);
  });
}

/** Firebase リスナーを解除する（退出・クリーンアップ時）。 */
function stopFirebaseListener() {
  if (_fbRef) { _fbRef.off(); _fbRef = null; }
  _fbHasData = false;
}

// ============================================================
// PHASE ROUTING
// ============================================================
function onPhaseChange(prev, next) {
  if (next === 'waiting') {
    showScreen('room'); renderRoom();
  } else if (next === 'playing') {
    if (prev !== 'playing') { sel = null; showScreen('game'); }
    renderGame();
  } else if (next === 'revealing') {
    showScreen('game'); renderGame();
  } else if (next === 'result') {
    showScreen('result'); renderResult();
  }
}

// ============================================================
// LOBBY — create room
// ============================================================
el('btn-create').addEventListener('click', () => {
  const name = el('inp-name').value.trim();
  if (!name) { showToast('名前を入力してください', 'warn'); return; }

  myId = uid(); myName = name; roomId = makeRoomCode();

  room = {
    id: roomId,
    hostId: myId,
    players: {
      [myId]: { id: myId, name, hand: [], finalAnswer: false }
    },
    settings: { cardCount: 3, topic: '' },
    phase: 'waiting',
    field: [],
    revealIndex: 0,
    result: null,
  };

  saveRoom(room);
  initBC();
  startFirebaseListener(roomId); // Firebase 監視開始
  showScreen('room');
  renderRoom();
});

// ============================================================
// LOBBY — join room
// ============================================================
el('btn-join').addEventListener('click', doJoin);
el('inp-room-id').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
el('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') el('inp-room-id').focus(); });

async function doJoin() {
  const name = el('inp-name').value.trim();
  const rid  = el('inp-room-id').value.trim().toUpperCase();
  if (!name) { showToast('名前を入力してください', 'warn'); return; }
  if (!rid)  { showToast('ルームIDを入力してください', 'warn'); return; }

  // 同一ブラウザなら localStorage から、別ブラウザ／端末なら Firebase から取得
  let r = loadRoom(rid);
  if (!r) {
    try {
      showToast('ルームを検索中...', '');
      // 匿名ログインが完了してから読み込む（auth != null ルール対応）
      await _authReady;
      const snap = await db.ref(`rooms/${rid}/state`).once('value');
      // Firebase は配列をオブジェクトに変換するため正規化が必要
      r = normalizeRoom(snap.val());
    } catch (err) {
      console.error('[Firebase] join fetch error:', err);
      if (err.code === 'PERMISSION_DENIED') {
        showToast('Firebase 権限エラー — データベースのルール設定を確認してください', 'error');
      } else {
        showToast('接続エラー: ' + (err.message || err.code), 'error');
      }
      return;
    }
  }

  if (!r)                                    { showToast('ルームが見つかりません', 'error'); return; }
  if (Object.keys(r.players).length >= 2)    { showToast('ルームが満員です', 'error'); return; }
  if (r.phase !== 'waiting')                 { showToast('ゲームはすでに始まっています', 'error'); return; }

  myId = uid(); myName = name; roomId = rid;
  r.players[myId] = { id: myId, name, hand: [], finalAnswer: false };
  saveRoom(r);
  room = r;
  initBC();
  startFirebaseListener(roomId); // Firebase 監視開始
  showScreen('room');
  renderRoom();
}

// ============================================================
// ROOM SCREEN — render
// ============================================================
function renderRoom() {
  if (!room) return;

  setText('rid-display', roomId);

  const players = Object.values(room.players);
  const host    = players.find(p => p.id === room.hostId);
  const guest   = players.find(p => p.id !== room.hostId);

  setText('pname-host', host?.name || '---');
  setText('pname-guest', guest?.name || '参加待ち...');

  const gc = el('pcard-guest');
  if (gc) {
    gc.classList.toggle('pcard-empty', !guest);
    gc.classList.toggle('pcard-joined', !!guest);
    gc.querySelector('.pcard-crown').textContent = guest ? '🎮' : '⏳';
  }

  const isHost = room.hostId === myId;
  const two    = players.length === 2;

  el('settings-host').style.display  = isHost ? '' : 'none';
  el('settings-guest').style.display = isHost ? 'none' : '';
  setText('cards-display', room.settings.cardCount);
  setText('cards-display-guest', room.settings.cardCount);
  el('btn-cards-dec').disabled = room.settings.cardCount <= MIN_CARDS;
  el('btn-cards-inc').disabled = room.settings.cardCount >= MAX_CARDS;

  const startBtn = el('btn-start');
  const waitMsg  = el('wait-msg');
  if (isHost) {
    startBtn.style.display = '';
    startBtn.disabled = !two;
    waitMsg.style.display = two ? 'none' : '';
    waitMsg.textContent = 'もう1人の参加を待っています...';
  } else {
    startBtn.style.display = 'none';
    waitMsg.style.display = '';
    waitMsg.textContent = two
      ? 'ホストがゲームを開始するのを待っています...'
      : 'もう1人の参加を待っています...';
  }
}

el('btn-copy-rid').addEventListener('click', () => copyText(roomId));

el('btn-cards-dec').addEventListener('click', () => {
  const r = loadRoom(roomId);
  if (!r || r.settings.cardCount <= MIN_CARDS) return;
  r.settings.cardCount--;
  room = r; saveRoom(room); renderRoom();
});

el('btn-cards-inc').addEventListener('click', () => {
  const r = loadRoom(roomId);
  if (!r || r.settings.cardCount >= MAX_CARDS) return;
  r.settings.cardCount++;
  room = r; saveRoom(room); renderRoom();
});

el('btn-start').addEventListener('click', () => {
  if (room?.hostId !== myId) return;
  openTopicModal();
});

el('btn-leave-room').addEventListener('click', leaveRoom);

function leaveRoom() {
  if (!room || !roomId) { showScreen('lobby'); return; }
  if (room.hostId === myId) {
    deleteRoom(roomId);
    bc?.postMessage({ type: 'closed', roomId });
    db.ref(`rooms/${roomId}/state`).remove().catch(() => {}); // Firebase も削除
  } else {
    const r = loadRoom(roomId) || room;
    delete r.players[myId];
    saveRoom(r);
  }
  bc?.close();
  cleanup();
  showScreen('lobby');
}

// ============================================================
// TOPIC MODAL
// ============================================================
function openTopicModal() {
  el('inp-topic').value = '';
  el('modal-topic').classList.remove('hidden');
  el('inp-topic').focus();
}

el('btn-random-topic').addEventListener('click', () => {
  el('inp-topic').value = TOPICS[Math.floor(Math.random() * TOPICS.length)];
});
el('btn-confirm-topic').addEventListener('click', confirmTopic);
el('inp-topic').addEventListener('keydown', e => { if (e.key === 'Enter') confirmTopic(); });
el('modal-backdrop').addEventListener('click', () => el('modal-topic').classList.add('hidden'));

function confirmTopic() {
  const topic = el('inp-topic').value.trim();
  if (!topic) { showToast('お題を入力してください', 'warn'); return; }
  el('modal-topic').classList.add('hidden');
  startGame(topic);
}

// ============================================================
// GAME — start / deal
// ============================================================
function startGame(topic) {
  // localStorage が消えている場合に備えてインメモリの room にフォールバック
  const r = loadRoom(roomId) || room;
  const { cardCount } = r.settings;
  const players = Object.values(r.players);

  const deck = shuffleDeck();
  // Deal and sort hands for readability
  players[0].hand = deck.slice(0, cardCount).sort((a, b) => a - b);
  players[1].hand = deck.slice(cardCount, cardCount * 2).sort((a, b) => a - b);
  players.forEach(p => { p.finalAnswer = false; });

  // Assign alphabet labels to each card for identification on card backs.
  // Host's cards get A, B, C, ... and guest's cards get the next letters.
  const hostPlayer  = players.find(p => p.id === r.hostId);
  const guestPlayer = players.find(p => p.id !== r.hostId);
  hostPlayer.labels  = {};
  hostPlayer.hand.forEach((val, i) => { hostPlayer.labels[val]  = String.fromCharCode(65 + i); });
  guestPlayer.labels = {};
  guestPlayer.hand.forEach((val, i) => { guestPlayer.labels[val] = String.fromCharCode(65 + cardCount + i); });

  r.field = Array.from({ length: cardCount * 2 }, () => ({ val: null, owner: null, revealed: false }));
  r.settings.topic = topic;
  r.phase = 'playing';
  r.revealIndex = 0;
  r.result = null;

  room = r; sel = null;
  saveRoom(room);
  showScreen('game');
  renderGame();
}

// ============================================================
// GAME — render
// ============================================================
function renderGame() {
  if (!room) return;

  const me     = room.players[myId];
  const opp    = Object.values(room.players).find(p => p.id !== myId);
  const phase  = room.phase;
  const isHost = room.hostId === myId;

  // Topbar
  setText('gtop-rid', roomId || '---');
  setText('gtop-topic', room.settings.topic || '---');

  const pb = el('gtop-phase');
  if (pb) {
    if (phase === 'playing') {
      const myFA = me?.finalAnswer;
      pb.textContent = myFA ? 'FA提出済み' : '配置中';
      pb.className = 'phase-badge' + (myFA ? ' phase-fa' : '');
    } else if (phase === 'revealing') {
      pb.textContent = '答え合わせ中';
      pb.className = 'phase-badge phase-rev';
    }
  }

  // Opponent hand (face-down placeholders)
  const oppHandEl = el('opp-hand');
  if (oppHandEl) {
    oppHandEl.innerHTML = '';
    const cnt = opp?.hand?.length ?? 0;
    for (let i = 0; i < cnt; i++) {
      oppHandEl.insertAdjacentHTML('beforeend', '<div class="card card-back card-sm"></div>');
    }
    setText('opp-count', cnt + '枚');
  }
  toggleClass('opp-fa-ind', 'hidden', !opp?.finalAnswer);

  // My hand
  const myHandEl = el('my-hand');
  if (myHandEl && me) {
    myHandEl.innerHTML = '';
    (me.hand || []).forEach(v => {
      const isSel = sel?.src === 'hand' && sel.val === v;
      const d = document.createElement('div');
      d.className = 'card card-face' + (isSel ? ' card-selected' : '');
      const label = me.labels?.[v] ?? '';
      d.innerHTML = `<span class="card-num">${v}</span><span class="card-label">${label}</span>`;
      d.addEventListener('click', () => onHandClick(v));
      myHandEl.appendChild(d);
    });
    setText('my-count', (me.hand?.length ?? 0) + '枚');
  }
  toggleClass('my-fa-ind', 'hidden', !me?.finalAnswer);

  // Field
  renderField();

  // Final Answer button
  const faBtn = el('btn-fa');
  if (faBtn) {
    const allPlaced = room.field.every(s => s.val !== null);
    const myFA = me?.finalAnswer;
    faBtn.disabled = !allPlaced || !!myFA || phase !== 'playing';
    faBtn.classList.toggle('fa-done', !!myFA);
    el('field-hint').textContent = allPlaced
      ? 'フィールドが埋まりました'
      : 'カードを選んでスロットに置こう';
  }

  // Reveal controls
  if (phase === 'revealing') {
    const allDone = room.revealIndex >= room.field.length;
    setHidden('btn-kokai', !isHost || allDone);
    setHidden('reveal-waiting-msg', isHost || allDone);
  } else {
    setHidden('btn-kokai', true);
    setHidden('reveal-waiting-msg', true);
  }
}

function renderField() {
  const container = el('field-slots');
  if (!container || !room) return;

  container.innerHTML = '';
  const phase = room.phase;
  const isRev = phase === 'revealing';

  room.field.forEach((slot, idx) => {
    let node = document.createElement('div');

    if (slot.val === null) {
      // Empty slot
      const isTarget = sel !== null && phase === 'playing';
      node.className = 'field-slot-empty' + (isTarget ? ' slot-target' : '');
      node.innerHTML = `<span class="slot-num">${idx + 1}</span>`;
      node.addEventListener('click', () => onFieldClick(idx));

    } else if (isRev) {
      // Reveal phase
      if (slot.revealed) {
        node.className = 'card card-face card-revealed';
        const label = room.players[slot.owner]?.labels?.[slot.val] ?? '';
        node.innerHTML = `<span class="card-num">${slot.val}</span><span class="card-label">${label}</span><span class="card-pos">${idx + 1}</span>`;
      } else {
        node.className = 'card card-back';
        const label = room.players[slot.owner]?.labels?.[slot.val] ?? '';
        node.innerHTML = `<span class="card-label">${label}</span><span class="card-pos">${idx + 1}</span>`;
      }

    } else {
      // Playing phase
      // 自分のカード → 表向き（数字を表示）
      // 相手のカード → 裏向き（数字を非公開）
      // どちらのカードも移動・入れ替え可能なのでリスナーは全スロットに付ける
      const isMine = slot.owner === myId;
      const isSel  = sel?.src === 'field' && sel.idx === idx;
      if (isMine) {
        node.className = 'card card-face' + (isSel ? ' card-selected' : '');
        const label = room.players[slot.owner]?.labels?.[slot.val] ?? '';
        node.innerHTML = `<span class="card-num">${slot.val}</span><span class="card-label">${label}</span><span class="card-pos">${idx + 1}</span>`;
      } else {
        node.className = 'card card-back' + (isSel ? ' card-selected' : '');
        const label = room.players[slot.owner]?.labels?.[slot.val] ?? '';
        node.innerHTML = `<span class="card-label">${label}</span><span class="card-pos">${idx + 1}</span>`;
      }
      node.addEventListener('click', () => onFieldClick(idx));
    }

    container.appendChild(node);
  });

  const placed = room.field.filter(s => s.val !== null).length;
  setText('field-count', `${placed} / ${room.field.length}`);
}

// ============================================================
// CARD INTERACTIONS
// ============================================================
function onHandClick(val) {
  if (room?.phase !== 'playing') return;
  if (room.players[myId]?.finalAnswer) return;

  sel = (sel?.src === 'hand' && sel.val === val) ? null : { src: 'hand', val, idx: null };
  renderGame();
}

function onFieldClick(idx) {
  if (room?.phase !== 'playing') return;
  if (room.players[myId]?.finalAnswer) return;

  const slot = room.field[idx];

  if (!sel) {
    // フィールド上のカードはどちらのプレイヤーでも選択・移動可能
    if (slot.val !== null) {
      sel = { src: 'field', val: slot.val, idx };
      renderGame();
    }
    return;
  }

  if (sel.src === 'hand') {
    if (slot.val !== null) {
      showToast('そのスロットは埋まっています', 'warn');
      sel = null; renderGame(); return;
    }
    // Place hand card onto empty field slot
    const r  = loadRoom(roomId);
    const me = r.players[myId];
    me.hand  = me.hand.filter(v => v !== sel.val);
    r.field[idx] = { val: sel.val, owner: myId, revealed: false };
    room = r; sel = null;
    saveRoom(room); renderGame();

  } else {
    // Move / swap field cards
    if (sel.idx === idx) { sel = null; renderGame(); return; }
    const r    = loadRoom(roomId);
    const from = { ...r.field[sel.idx] };
    const to   = { ...r.field[idx] };
    r.field[idx]      = { ...from, revealed: false };
    r.field[sel.idx]  = { ...to,   revealed: false };
    room = r; sel = null;
    saveRoom(room); renderGame();
  }
}

// ============================================================
// FINAL ANSWER
// ============================================================
el('btn-fa').addEventListener('click', () => {
  if (!room || room.phase !== 'playing') return;

  const r  = loadRoom(roomId); // fresh read
  const me = r.players[myId];
  if (!me || me.finalAnswer) return;

  if (!r.field.every(s => s.val !== null)) {
    showToast('全カードをフィールドに置いてください', 'warn'); return;
  }

  me.finalAnswer = true;

  const allFA = Object.values(r.players).every(p => p.finalAnswer);
  if (allFA) {
    r.field.forEach(s => { s.revealed = false; });
    r.phase = 'revealing';
    r.revealIndex = 0;
    showToast('答え合わせ開始！', 'success');
  } else {
    showToast('ファイナルアンサー！相手を待っています...', '');
  }

  room = r;
  saveRoom(room);
  renderGame();
});

// ============================================================
// REVEAL (host-controlled, left to right)
// ============================================================
el('btn-kokai').addEventListener('click', () => {
  if (room?.hostId !== myId || room.phase !== 'revealing') return;
  if (room.revealIndex >= room.field.length) return;

  const r = loadRoom(roomId);
  r.field[r.revealIndex].revealed = true;
  r.revealIndex++;
  room = r;
  saveRoom(room);
  renderGame();

  if (room.revealIndex >= room.field.length) {
    setTimeout(checkResult, REVEAL_MS);
  }
});

function checkResult() {
  const r    = loadRoom(roomId);
  const vals = r.field.map(s => s.val);
  let win    = true;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] <= vals[i - 1]) { win = false; break; }
  }
  r.phase  = 'result';
  r.result = win ? 'win' : 'lose';
  room = r;
  saveRoom(room);
  showScreen('result');
  renderResult();
}

// ============================================================
// RESULT
// ============================================================
function renderResult() {
  if (!room) return;
  const win = room.result === 'win';

  el('result-emblem').className = `result-emblem ${win ? 'win' : 'lose'}`;
  setText('result-icon', win ? '🎉' : '😢');
  setText('result-title', win ? 'CLEAR!' : 'GAME OVER');
  setText('result-sub', win
    ? '素晴らしい！全員で協力して正しく並べられました！'
    : '残念...並び順が違いました。次こそクリアしよう！');

  const rf = el('result-field');
  if (rf) {
    rf.innerHTML = room.field.map(s => {
      const mine = s.owner === myId;
      return `<div class="rcard ${mine ? 'rcard-mine' : 'rcard-opp'}">
        <span class="rcard-num">${s.val}</span>
        <span class="rcard-who">${mine ? '自分' : '相手'}</span>
      </div>`;
    }).join('');
  }
}

el('btn-continue').addEventListener('click', () => {
  if (!room) return;
  const r = loadRoom(roomId) || room;
  Object.values(r.players).forEach(p => { p.hand = []; p.finalAnswer = false; });
  r.phase = 'waiting'; r.field = []; r.revealIndex = 0; r.result = null; r.settings.topic = '';
  room = r; sel = null;
  saveRoom(room);
  showScreen('room');
  renderRoom();
});

el('btn-exit').addEventListener('click', leaveRoom);

// ============================================================
// MISC EVENT LISTENERS
// ============================================================
el('btn-copy-gid').addEventListener('click', () => copyText(roomId));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sel) { sel = null; renderGame(); }
});

// ============================================================
// INIT — check BroadcastChannel support
// ============================================================
(function init() {
  if (typeof BroadcastChannel === 'undefined') {
    el('lobby-note') && (el('lobby-note').textContent =
      '⚠ BroadcastChannel非対応のブラウザです。Chrome / Firefox をお使いください。');
  }
})();
