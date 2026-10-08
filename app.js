// かぎばこ — パソコン版の画面（仕様書 §7.2 W-1〜W-4・§10.2・改訂 R-22）
//
// ★画面に出す文字は必ず textContent で入れる（innerHTML は使わない）。金庫の中身が HTML として動かないように。
// ★Google の小窓（requestAccessToken）とコピー（clipboard.writeText）は、クリック・Enter の処理の中で、
//   await より前に呼ぶ。後ろにすると、ブラウザが「利用者の操作から」と認めずに止める（§6.2・§10.2）。
// ★このページは何も保存しない。localStorage に置くのは、秘密でないもの（ファイルの番号・salt と回数・端末の番号・設定）だけ。
// ★パスワードの欄は autocomplete="one-time-code"（index.html）。ブラウザの「パスワードを保存しますか？」に
//   マスターパスワードや各項目のパスワードを拾わせない（type=password のまま。日本語入力が止まる守りは残す）。
// ★鍵をかけたら、画面の上の平文はすぐ消す。まだ保存できていない変更と編集中の下書きは、暗号化して記憶の中にだけとっておく。

import { GOOGLE_CLIENT_ID, DRIVE_SCOPE } from './config.js';
import { VaultError, deriveVaultKey } from './vault-crypto.js';
import { itemFields, trimItemSpace, isItemBlank } from './vault-data.js';
import { normalizeForSearch, matchesSearch, itemPassword } from './vault-tools.js';
import { HttpDriveRemote, DriveUnauthorized } from './drive.js';
import { WebVault, UnusualIterations } from './session.js';
import { buildXlsx, exportFileName } from './export-xlsx.js';

const $ = id => document.getElementById(id);

// ------------------------------------------------------------------
// 試しの金庫か、本物か（手元のパソコン〔localhost〕で開いたとき、または ?test を付けたときは試しの金庫）
// ------------------------------------------------------------------
const IS_TEST = ['localhost', '127.0.0.1'].includes(location.hostname) || new URLSearchParams(location.search).has('test');
const FILE_NAME = IS_TEST ? 'kagibako-vault-test.json' : 'kagibako-vault.json';
if (IS_TEST) {
  $('testBanner').textContent = `試しの金庫（${FILE_NAME}）を開きます。本物のパスワードは入れないでください。`;
  $('testBanner').hidden = false;
}

// ------------------------------------------------------------------
// localStorage（秘密でないものだけ。使えないブラウザでも動くように、失敗は黙って無視する）
// ------------------------------------------------------------------
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 使えなくてもよい */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 使えなくてもよい */ } },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** この端末（ブラウザ）の番号。仕様どおり UUID だけ。形が違えば作り直す（別のページに書き換えられても、変な文字を金庫に入れない） */
function deviceId() {
  let id = ls.get('kagibako.deviceId');
  if (!id || !UUID.test(id)) { id = crypto.randomUUID(); ls.set('kagibako.deviceId', id); }
  return id;
}
// 改訂 R-1: 前に開いたときの salt と回数（秘密ではない）。Google の画面と並べて鍵を作り始めるため
function readKdfCache() {
  try {
    const c = JSON.parse(ls.get('kagibako.kdf:' + FILE_NAME) || 'null');
    return c && typeof c.salt === 'string' && Number.isInteger(c.iterations) ? c : null;
  } catch (e) { return null; }
}
const writeKdfCache = (salt, iterations) => ls.set('kagibako.kdf:' + FILE_NAME, JSON.stringify({ salt, iterations }));

const LOCK_CHOICES = [0, 60000, 300000, 900000];
const CLIP_CHOICES = [15, 30, 60, 120];
const settings = (() => {
  let s = {};
  try { s = JSON.parse(ls.get('kagibako.settings') || '{}') || {}; } catch (e) { s = {}; }
  return {
    autoLockMs: LOCK_CHOICES.includes(s.autoLockMs) ? s.autoLockMs : 300000,   // 既定5分（§10.2）
    clipSeconds: CLIP_CHOICES.includes(s.clipSeconds) ? s.clipSeconds : 30,
  };
})();
const saveSettings = () => ls.set('kagibako.settings', JSON.stringify(settings));

// ------------------------------------------------------------------
// Google との接続（GIS のトークン。§6.2）
// ------------------------------------------------------------------
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let tokenWait = null;          // { promise, resolve, reject }
let selectAccountNext = false; // 次に Google につなぐとき、アカウントを選ぶ画面を必ず出す

function initGis() {
  if (tokenClient) return true;
  if (!window.google?.accounts?.oauth2) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    prompt: '',                      // 許可済みなら同意画面を出さない
    callback: onToken,
    error_callback: err => {
      const w = tokenWait; tokenWait = null;
      if (w) w.reject(Object.assign(new Error(err?.type || 'unknown'), { gisType: err?.type || 'unknown' }));
    },
  });
  return true;
}

/** ★必ずクリック・Enter の処理の中で、await より前に呼ぶ。小窓がもう開いていれば、新しく開かずにそれを待つ */
function requestToken() {
  if (tokenWait) return tokenWait.promise;
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  tokenWait = { promise, resolve, reject };
  const select = selectAccountNext;
  selectAccountNext = false;
  if (select) tokenClient.requestAccessToken({ prompt: 'select_account' });
  else tokenClient.requestAccessToken();
  return promise;
}

function onToken(resp) {
  const w = tokenWait; tokenWait = null;
  if (resp.error) { if (w) w.reject(Object.assign(new Error(resp.error), { gisType: resp.error })); return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
    if (w) w.reject(Object.assign(new Error('scope'), { gisType: 'scope' }));
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
  updateTokenLeft();
  if (w) w.resolve();
}

const tokenValid = () => !!accessToken && Date.now() < tokenExpiresAt;
function getToken() {
  if (!tokenValid()) throw new DriveUnauthorized();
  return accessToken;
}

function gisErrorText(e, button = 'ひらく') {
  switch (e?.gisType) {
    case 'popup_failed_to_open':
      return `ブラウザが Google の小窓をふさぎました。アドレス欄の右にある小さなアイコンを押して「許可」してから、もう一度「${button}」を押してください。`;
    case 'popup_closed':
      return `Google の画面が閉じられました。もう一度「${button}」を押してください。`;
    case 'access_denied':
      return `Google ドライブを使う許可がもらえませんでした。もう一度「${button}」を押して、Google の画面で「続行」を押してください。`;
    case 'scope':
      return `Google ドライブを使う許可が足りません（Google の画面でチェックを外しませんでしたか？）。もう一度「${button}」を押してください。`;
    default:
      return `Google とつながりませんでした（${e?.gisType || e?.message || e}）。もう一度「${button}」を押してください。`;
  }
}

// ------------------------------------------------------------------
// 金庫
// ------------------------------------------------------------------
const FILE_ID_KEY = 'kagibako.fileId:' + FILE_NAME;
const vault = new WebVault({
  remote: new HttpDriveRemote(getToken),
  fileName: FILE_NAME,
  deviceId: deviceId(),
  store: { getFileId: () => ls.get(FILE_ID_KEY), setFileId: id => ls.set(FILE_ID_KEY, id) },
});

let wrongCount = 0;
let uiLocked = true;   // 画面が鍵のかかった状態か（鍵をかけたら、遅れて届いた通信の結果で画面を描き直さない）

/** 失敗の種類 → 開くときの文言（仕様書 §7.3。専門用語を出さない） */
function textOf(code) {
  switch (code) {
    case 'WRONG_PASSWORD':
      return wrongCount >= 3
        ? 'マスターパスワードが違うようです。紙の控えをご確認ください。大文字・小文字と、全角／半角も見てください。'
        : 'マスターパスワードが違うようです。大文字・小文字と、全角／半角をご確認ください。';
    case 'BAD_CHAR': return '使えない文字が入っています（絵文字のかけらなど）。消してから、もう一度入れてください。';
    case 'NOT_VAULT': case 'BROKEN': return '金庫のファイルが壊れているか、かぎばこのファイルではないようです。開けません。';
    case 'UNKNOWN_VERSION': return 'この金庫は、新しいバージョンのかぎばこで作られています。このページでは開けません（上書きもしません）。';
    case 'SALT_CHANGED': return 'この金庫は、いまとは別のマスターパスワードで保存されています。そのときのマスターパスワードで開き直してください。';
    case 'LOCKED': return 'ロックされました。もう一度開いてください。';
    default: return `開けませんでした（${code}）。`;
  }
}

/** Drive の中身を受け取れなかった・上書きできなかったときの文言（手元の中身は無事） */
function textOfSync(code) {
  switch (code) {
    case 'SALT_CHANGED':
      return 'Google ドライブの金庫が、いまとは別のマスターパスワードで保存されています。上書きも受け取りもしていません。この画面の中身はそのまま見られますが、保存は止めています。';
    case 'WRONG_PASSWORD':
      return 'Google ドライブの金庫が、いまのマスターパスワードで読めません（壊れているか、書き換えられています）。上書きも受け取りもしていません。';
    case 'UNKNOWN_VERSION':
      return 'Google ドライブの金庫は、新しいバージョンのかぎばこで保存されています。このページでは上書きしません。';
    case 'NOT_VAULT': case 'BROKEN':
      return 'Google ドライブの金庫のファイルが壊れているか、かぎばこのファイルではありません。上書きも受け取りもしていません。';
    default: return textOf(code);
  }
}

// 画面の読み上げ用（見た目には出さない）。選んだ項目や、同期の困りごとを短く知らせる
function announce(text) { $('live').textContent = text; }

// ------------------------------------------------------------------
// W-1 開く
// ------------------------------------------------------------------
let unlocking = false;
const STAGE = { download: '金庫を読んでいます…', kdf: '鍵をつくっています…（1/2）', decrypt: '金庫を開いています…（2/2）' };
const WAIT_GOOGLE = 'Google につないでいます…\nGoogle の小さな窓が出ています。見当たらないときは、画面の下のタスクバーで Chrome の窓を探してください。';

function setUnlockStatus(text, bad = false) {
  $('unlockStatus').textContent = text;
  $('unlockStatus').classList.toggle('bad', bad);
}
function setUnlockBusy(b) {
  $('openBtn').disabled = b;
  $('openBtn').textContent = b ? '開いています…' : 'ひらく';
}

$('pwShow').addEventListener('click', () => {
  const show = $('pw').type === 'password';
  $('pw').type = show ? 'text' : 'password';
  $('pwShow').textContent = show ? '隠す' : '表示';
  $('pw').focus();
});

$('chooseAccount').addEventListener('click', () => {
  selectAccountNext = true;
  accessToken = null;       // いまのつながりは使わない
  setUnlockStatus('次に「ひらく」を押すと、Google のアカウントを選ぶ画面が出ます。スマホのかぎばこと同じアカウントを選んでください。');
  $('pw').focus();
});

$('unlockForm').addEventListener('submit', e => {
  e.preventDefault();
  if (unlocking) return;
  const pw = $('pw').value;
  if (!pw) { $('pw').focus(); return; }
  if (!navigator.onLine) { setUnlockStatus('インターネットにつながっていません。このページでは金庫を開けません（見るだけならスマホのかぎばこで）。', true); return; }
  if (!initGis()) { setUnlockStatus('Google のログイン部品がまだ読み込めていません。少し待ってから、もう一度「ひらく」を押してください。', true); return; }
  // ★ここより前に await を書かない（Google の小窓がふさがれる）
  const needToken = !tokenValid();
  const tokenP = needToken ? requestToken() : Promise.resolve();
  setUnlockStatus(needToken ? WAIT_GOOGLE : STAGE.download);
  // 改訂 R-1: 控えの salt と回数があれば、Google の画面が開いて閉じるあいだに鍵を作っておく
  const cached = readKdfCache();
  const preKeyP = cached ? deriveVaultKey(pw, cached.salt, cached.iterations).catch(() => null) : Promise.resolve(null);
  $('pw').value = '';   // 入力欄に平文を残さない
  $('pw').type = 'password'; $('pwShow').textContent = '表示';
  clearTimeout(giveBackTimer);
  unlocking = true;
  setUnlockBusy(true);
  finishUnlock(pw, tokenP, preKeyP, false).finally(() => {
    unlocking = false;
    setUnlockBusy(false);
    if (!vault.isOpen) $('pw').focus();
  });
});

/**
 * パスワード違い以外で開けなかったときは、入れたマスターパスワードを欄に戻す（長い文字を打ち直させない）。
 * ★ただし1分たつか、ほかのタブに移ったら消す（席を外した間に「表示」で読まれないように）
 */
let giveBackTimer = null;
function giveBackPw(pw) {
  if ($('pw').value) return;
  $('pw').value = pw;
  clearTimeout(giveBackTimer);
  giveBackTimer = setTimeout(forgetGivenBackPw, 60_000);
}
function forgetGivenBackPw() {
  clearTimeout(giveBackTimer);
  if (!unlocking && uiLocked) { $('pw').value = ''; $('pw').type = 'password'; $('pwShow').textContent = '表示'; }
}

async function finishUnlock(pw, tokenP, preKeyP, allowUnusual) {
  try {
    await tokenP;
  } catch (e) {
    preKeyP.then(k => k && k.destroy());
    giveBackPw(pw);
    setUnlockStatus(gisErrorText(e), true);
    return;
  }
  setUnlockStatus(STAGE.download);
  let r;
  try {
    r = await vault.open(pw, { preKey: await preKeyP, allowUnusualIterations: allowUnusual, onStage: s => setUnlockStatus(STAGE[s]) });
  } catch (e) {
    if (e instanceof UnusualIterations) {
      // 改訂 R-10: 書き換えられたファイルで長く待たされないよう、鍵の計算の前に知らせる
      const yes = await confirmDlg({
        title: 'ふだんと違う設定のファイルです',
        text: `この金庫は、ふだんと違う設定（くり返し ${e.iterations} 回）で作られています。書き換えられた可能性があります。心当たりが無ければ開かないでください。`,
        yes: 'わかったうえで開く', no: 'やめる',
      });
      if (yes) return finishUnlock(pw, Promise.resolve(), Promise.resolve(null), true);
      giveBackPw(pw);
      setUnlockStatus('');
      return;
    }
    if (e instanceof VaultError) {
      if (e.code === 'WRONG_PASSWORD') wrongCount++;
      setUnlockStatus(textOf(e.code) + (e.code === 'WRONG_PASSWORD' || e.code === 'BAD_CHAR' ? '\nもう一度マスターパスワードを入れて「ひらく」を押してください。' : ''), true);
      return;
    }
    giveBackPw(pw);
    setUnlockStatus(`開けませんでした（${e?.name || e}）。もう一度「ひらく」を押してください。`, true);
    return;
  }
  if (r.kind !== 'Opened' && r.kind !== 'Multiple') giveBackPw(pw);
  switch (r.kind) {
    case 'Opened':
      wrongCount = 0;
      writeKdfCache(r.saltB64, r.iterations);
      setUnlockStatus('');
      showMain(r);
      return;
    case 'Multiple': {
      const id = await chooseFile(r.files);
      if (!id) { giveBackPw(pw); setUnlockStatus(''); return; }
      vault.chooseFile(id);
      return finishUnlock(pw, Promise.resolve(), Promise.resolve(null), allowUnusual);
    }
    case 'NoVault':
      setUnlockStatus(`Google ドライブに金庫（${FILE_NAME}）が見つかりません。金庫はスマホのかぎばこで作ってください（このページでは作れません）。\n` +
        'スマホと別の Google アカウントを選んだかもしれないときは、下の「Google アカウントを選び直す」を押してから「ひらく」を押してください。', true);
      return;
    case 'Trashed':
      setUnlockStatus(`Google ドライブで、金庫のファイル（${FILE_NAME}）がごみ箱に入っています。Google ドライブの「ごみ箱」から「復元」してから、もう一度「ひらく」を押してください。` +
        (r.others ? '\n（同じ名前の別の金庫もあります。そちらを使うときは、下の「金庫のファイルを探し直す」を押してから「ひらく」を押してください）' : ''), true);
      $('forgetFile').hidden = !r.others;
      return;
    case 'Offline': setUnlockStatus('インターネットにつながっていません。つながってから、もう一度「ひらく」を押してください。', true); return;
    case 'AuthNeeded': accessToken = null; setUnlockStatus('Google とのつながりが切れました。もう一度「ひらく」を押してください。', true); return;
    case 'Throttled': setUnlockStatus('Google が少し混み合っています。30秒ほど待ってから、もう一度「ひらく」を押してください。', true); return;
    case 'DriveError': setUnlockStatus(`Google ドライブが受け付けませんでした（コード ${r.status}）。しばらくしてから、もう一度「ひらく」を押してください。`, true); return;
    case 'Busy': setUnlockStatus('ほかの端末が保存している最中のようです。少し待ってから、もう一度「ひらく」を押してください。', true); return;
    case 'Locked': setUnlockStatus(''); return;
    default: setUnlockStatus(`開けませんでした（${r.kind}）。`, true);
  }
}

$('forgetFile').addEventListener('click', () => {
  ls.del(FILE_ID_KEY);
  $('forgetFile').hidden = true;
  setUnlockStatus('次に「ひらく」を押すと、Google ドライブから金庫を探し直します（同じ名前が2つあれば、選ぶ画面が出ます）。');
  $('pw').focus();
});

function chooseFile(files) {
  return new Promise(resolve => {
    const box = $('multiList');
    box.replaceChildren(...files.map(f => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = `最後に保存 ${localTime(f.modifiedTime)} ／ 作成 ${localTime(f.createdTime)} ／ 大きさ ${f.size} バイト`;
      b.addEventListener('click', () => { $('multiDlg').close(); resolve(f.id); });
      return b;
    }));
    $('multiCancel').onclick = () => { $('multiDlg').close(); resolve(null); };
    $('multiDlg').oncancel = () => resolve(null);
    $('multiDlg').showModal();
    $('multiCancel').focus();   // 最初からどちらかを選ばせない
  });
}

// ------------------------------------------------------------------
// W-2 一覧と詳細
// ------------------------------------------------------------------
let selectedId = null;
let revealId = null;
let revealTimer = null;

function showMain(opened) {
  uiLocked = false;
  $('unlock').hidden = true;
  $('main').hidden = false;
  $('search').value = '';
  selectedId = null;
  revealId = null;
  lastActivity = Date.now();
  lastStop = null;
  lastConflictHead = null;
  needAccountCheck = false;
  render();
  setSync(vault.dirty ? { kind: 'Dirty' } : { kind: 'UpToDate' });
  updateTokenLeft();
  $('search').focus();
  if (clipNeedsClear) clearLeftoverClip();
  // ロックの前にとっておいたものを戻した。先に下書きの小窓を開き、お知らせは1つにまとめて、いちばん上に出す
  const notes = [];
  if (opened?.draft && restoreDraft(opened.draft)) notes.push('鍵をかける前に編集していた内容を戻しました。続けて「保存する」を押してください。');
  if (opened?.restored) {
    notes.unshift('鍵をかける前に、まだ保存できていなかった変更を戻しました。いまから Google ドライブに保存します。');
    pushNow(true);
  }
  if (opened?.rolledBack) {
    notes.unshift('Google ドライブの金庫が、この画面が前に知っていた内容より古いままです。どちらにするか、もう一度選んでください。');
    userAsked = true;
    refreshNow();
  }
  if (opened?.keptRemains) notes.push('別の金庫で、まだ保存できていなかった変更をとってあります。その金庫のマスターパスワードで開くと戻ります（このタブを閉じると消えます）。');
  if (notes.length) showMessage(notes.join('\n\n'));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, onClick, { disabled = false, cls = 'ghost small', aria } = {}) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.disabled = disabled;
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
}
const pad = n => String(n).padStart(2, '0');
function hhmm(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function localTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function visibleItems() {
  if (!vault.data) return [];
  const q = $('search').value;
  return vault.data.liveItems
    .filter(it => matchesSearch(it, q))
    .map(it => [normalizeForSearch(it.title), it])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(x => x[1]);
}
const selectedItem = () => (selectedId && vault.data ? vault.data.item(selectedId) : null);

function render() { renderList(); renderDetail(); }

function renderList() {
  if (!vault.data || uiLocked) return;
  const items = visibleItems();
  if (!items.some(it => it.id === selectedId)) { selectedId = items[0]?.id ?? null; revealId = null; }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const li = el('li');
    li.dataset.id = it.id;
    if (it.id === selectedId) { li.classList.add('sel'); li.setAttribute('aria-current', 'true'); }
    const names = el('div', 'names');
    names.append(el('div', 'title', it.title));
    if (it.loginId) names.append(el('div', 'sub', it.loginId));
    const bId = el('button', 'copyid', '👤ID');
    bId.type = 'button'; bId.dataset.copy = 'id'; bId.disabled = !it.loginId;
    bId.title = 'ID をコピー'; bId.setAttribute('aria-label', `${it.title} の ID をコピー`);
    const bPw = el('button', 'copypw', '🔑PW');
    bPw.type = 'button'; bPw.dataset.copy = 'pw'; bPw.disabled = !it.password;
    bPw.title = 'パスワードをコピー'; bPw.setAttribute('aria-label', `${it.title} のパスワードをコピー`);
    li.append(names, bId, bPw);
    frag.append(li);
  }
  $('list').replaceChildren(frag);
  const all = vault.data.liveItems.length;
  $('listEmpty').hidden = items.length > 0;
  $('listEmpty').textContent = items.length > 0 ? '' : all === 0
    ? 'まだ何も入っていません。上の「＋ 追加」から、サイト名・ID・パスワードを入れてください。'
    : `「${$('search').value}」に合うものはありません。`;
  $('list').querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
}

// 一覧のクリック（行を選ぶ・👤🔑でコピー）。コピーはこの処理の中で、すぐ行う
$('list').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li || !vault.data) return;
  const it = vault.data.item(li.dataset.id);
  if (!it) return;
  const b = e.target.closest('button');
  if (b) {
    if (b.dataset.copy === 'id') copySecret('ID', it.loginId);
    if (b.dataset.copy === 'pw') copySecret('パスワード', it.password);
    return;
  }
  if (selectedId !== it.id) select(it.id);
});

function select(id) {
  selectedId = id;
  revealId = null;
  renderList();
  renderDetail();
  const items = visibleItems();
  const i = items.findIndex(it => it.id === id);
  if (i >= 0) announce(`${items[i].title}（${items.length}件中${i + 1}件目）`);
}

function renderDetail() {
  const box = $('detail');
  if (!vault.data || uiLocked) { box.replaceChildren(); return; }
  const it = selectedItem();
  if (!it || it.deleted) {
    box.replaceChildren(el('p', 'placeholder', vault.data.liveItems.length ? '左の一覧から選んでください。' : ''));
    return;
  }
  const field = (label, valueNode, buttons = []) => {
    const f = el('div', 'field');
    const row = el('div', 'row');
    row.append(valueNode, ...buttons);
    f.append(el('div', 'label', label), row);
    return f;
  };
  const parts = [el('h2', '', it.title)];
  parts.push(field('ID', el('span', 'value', it.loginId || '（なし）'),
    [btn('コピー', () => copySecret('ID', it.loginId), { disabled: !it.loginId, aria: 'ID をコピー' })]));
  const shown = revealId === it.id;
  parts.push(field('パスワード', el('span', 'value', it.password ? (shown ? it.password : '••••••••••') : '（なし）'), [
    btn(shown ? '隠す' : '表示', () => toggleReveal(it.id), { disabled: !it.password, aria: shown ? 'パスワードを隠す' : 'パスワードを表示' }),
    btn('コピー', () => copySecret('パスワード', it.password), { disabled: !it.password, aria: 'パスワードをコピー' }),
  ]));
  if (it.url) {
    const url = it.url.trim();
    let node;
    // http / https だけリンクにする（それ以外の形は、押すと何が起きるかわからないのでリンクにしない）
    if (/^https?:\/\//i.test(url)) {
      node = el('a', 'value plain', url);
      node.href = url;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else {
      node = el('span', 'value plain', url);
    }
    parts.push(field('URL', node, [btn('コピー', () => copySecret('URL', it.url), { aria: 'URL をコピー' })]));
  }
  if (it.memo) parts.push(field('メモ', el('span', 'value plain', it.memo)));
  parts.push(el('p', 'muted small', `最後に変えた日時: ${localTime(it.updatedAt)}`));
  const actions = el('div', 'actions');
  actions.append(
    btn('編集する', () => openEdit(it.id), { cls: 'primary small' }),
    btn('削除する', () => deleteItem(it.id), { cls: 'ghost small danger' }),
  );
  parts.push(actions);
  box.replaceChildren(...parts);
}

/** パスワードの表示は15秒で自動的に伏せ字に戻す（Android と同じ） */
function toggleReveal(id) {
  clearTimeout(revealTimer);
  revealId = revealId === id ? null : id;
  if (revealId) revealTimer = setTimeout(() => { revealId = null; renderDetail(); }, 15_000);
  renderDetail();
}

function moveSel(step) {
  const items = visibleItems();
  if (!items.length) return;
  const i = items.findIndex(it => it.id === selectedId);
  const next = items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + step)))];
  if (next.id !== selectedId) select(next.id);
}

$('search').addEventListener('input', () => { renderList(); renderDetail(); });

// ------------------------------------------------------------------
// コピー（§10.2。消すのは「このページを見ているとき」だけできる）
// ------------------------------------------------------------------
let clip = null;              // { label, until, tick, pending }
let clipNeedsClear = false;   // 鍵をかけたときに消せなかった（中身は持たない。印だけ）

function copySecret(label, text) {
  if (!text) return;
  if (!navigator.clipboard?.writeText) { showMessage('このブラウザではコピーできません。'); return; }
  // ★ここより前に await を書かない
  navigator.clipboard.writeText(text).then(
    () => { clipNeedsClear = false; startClip(label); },
    () => showMessage('コピーできませんでした。このページを一度クリックしてから、もう一度押してください。'),
  );
}

function startClip(label) {
  endClip();
  clip = { label, until: Date.now() + settings.clipSeconds * 1000, tick: null, pending: false };
  $('copyBanner').hidden = false;
  const tick = () => {
    if (!clip || clip.pending) return;
    const left = Math.ceil((clip.until - Date.now()) / 1000);
    if (left > 0) $('copyText').textContent = `${clip.label}をコピーしました ─ ${left}秒後に消します`;
    else clearClip();
  };
  clip.tick = setInterval(tick, 500);
  tick();
}

function clearClip() {
  if (!clip) return;
  if (document.hasFocus()) {
    navigator.clipboard.writeText('').then(endClip, markPending);
  } else {
    markPending();
  }
}
function markPending() {
  if (!clip) return;
  clearInterval(clip.tick);
  clip.pending = true;
  $('copyText').textContent = `${clip.label}を、まだ消せていません（このページに戻ると消します）`;
}
function endClip() {
  if (clip) clearInterval(clip.tick);
  clip = null;
  $('copyBanner').hidden = true;
  $('copyText').textContent = '';
}
/** 鍵をかけたときに消せなかったものを、ページに戻ったときに消す */
function clearLeftoverClip() {
  if (!clipNeedsClear || !document.hasFocus()) return;
  navigator.clipboard.writeText('').then(() => { clipNeedsClear = false; }, () => {});
}
$('copyClear').addEventListener('click', () => {
  if (!clip) return;
  navigator.clipboard.writeText('').then(endClip, () => showMessage('消せませんでした。もう一度押してください。'));
});
// ほかの画面から戻ってきたら、消せていなかったものを消す
window.addEventListener('focus', () => {
  if (clip?.pending) clearClip();
  else clearLeftoverClip();
});

// ------------------------------------------------------------------
// W-4 編集・新規
// ------------------------------------------------------------------
let editingId = null;
// 編集を始めたときの項目の印（rev・最後に変えた時刻・変えた端末）。保存するとき、その間にほかの端末で変わっていないか確かめる。
// rev だけだと、両方で1回ずつ変えたとき同じ番号になって見逃す
let editBaseMark = null;
const itemMark = it => (it ? `${it.rev}|${it.updatedAt}|${it.updatedBy}` : null);
let editInitial = null;
let closingEdit = false;

const currentFields = () => ({
  title: $('fTitle').value, loginId: $('fLogin').value, password: $('fPass').value, url: $('fUrl').value, memo: $('fMemo').value,
});
const editChanged = () => editInitial !== null && JSON.stringify(currentFields()) !== JSON.stringify(editInitial);

function fillEdit(id, fields, initial, baseMark) {
  editingId = id;
  editBaseMark = baseMark;
  $('editTitle').textContent = id ? '編集' : '新しく追加';
  $('fTitle').value = fields.title;
  $('fLogin').value = fields.loginId;
  $('fPass').value = fields.password;
  $('fUrl').value = fields.url;
  $('fMemo').value = fields.memo;
  $('fPass').type = 'password';
  $('fPassShow').textContent = '表示';
  $('fNoSym').checked = false;
  editInitial = initial;
  if (!$('editDlg').open) $('editDlg').showModal();
  $('fTitle').focus();
}

function openEdit(id) {
  if (!vault.isOpen || $('editDlg').open) return;
  const it = id ? vault.data.item(id) : null;
  if (id && (!it || it.deleted)) return;
  const f = { title: it?.title ?? '', loginId: it?.loginId ?? '', password: it?.password ?? '', url: it?.url ?? '', memo: it?.memo ?? '' };
  fillEdit(id, f, { ...f }, itemMark(it));
}

/** 鍵をかける前の下書き（暗号化してとっておくもの）。何も変えていなければ、とっておかない */
function editDraft() {
  if (!$('editDlg').open || editInitial === null || !editChanged()) return null;
  return JSON.stringify({ editingId, editBaseMark, fields: currentFields(), initial: editInitial });
}

/** とっておいた下書きで、編集の小窓を開き直す（お知らせは呼ぶ側がまとめて出す）。開けたら true */
function restoreDraft(text) {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d.fields !== 'object') return false;
    fillEdit(d.editingId ?? null, d.fields, d.initial, d.editBaseMark ?? null);
    return true;
  } catch (e) {
    return false;
  }
}

function clearEditForm() {
  for (const id of ['fTitle', 'fLogin', 'fPass', 'fUrl', 'fMemo']) $(id).value = '';
  editingId = null;
  editBaseMark = null;
  editInitial = null;
}
function closeEdit() {
  closingEdit = true;
  if ($('editDlg').open) $('editDlg').close();
  closingEdit = false;
  clearEditForm();
}

async function cancelEdit() {
  if (editChanged()) {
    const yes = await confirmDlg({ title: '入れた内容を捨てますか？', text: '保存していない変更は消えます。', yes: '捨てる', no: '編集を続ける' });
    if (!yes) {
      if (!$('editDlg').open && editInitial !== null && !uiLocked) $('editDlg').showModal();
      return;
    }
  }
  closeEdit();
}

$('fPassShow').addEventListener('click', () => {
  const show = $('fPass').type === 'password';
  $('fPass').type = show ? 'text' : 'password';
  $('fPassShow').textContent = show ? '隠す' : '表示';
});
$('fGen').addEventListener('click', () => { $('fPass').value = itemPassword(20, !$('fNoSym').checked); });
$('editCancel').addEventListener('click', cancelEdit);
$('editDlg').addEventListener('cancel', e => { e.preventDefault(); cancelEdit(); });   // Esc
// ブラウザが（Esc を続けて押されたときなど）小窓を勝手に閉じたら、入れた内容を捨てずに開き直す
$('editDlg').addEventListener('close', () => {
  if (closingEdit || editInitial === null || uiLocked || $('confirmDlg').open) return;
  $('editDlg').showModal();
});
$('editForm').addEventListener('submit', e => { e.preventDefault(); saveEdit(); });

async function saveEdit() {
  const c = currentFields();
  const f = itemFields(trimItemSpace(c.title), trimItemSpace(c.url), c.loginId, c.password, c.memo);
  if (isItemBlank(f.title)) { showMessage('サイト名を入れてください。'); $('fTitle').focus(); return; }
  if (editingId && !editChanged()) { closeEdit(); return; }
  let id = editingId;
  if (id) {
    // 編集している間に、ほかの端末（スマホなど）でこの項目が変わっていないか（古い中身で黙って上書きしない）
    const cur = vault.data?.item(id);
    if (!cur || cur.deleted) {
      const asNew = await confirmDlg({
        title: 'この項目は、ほかの端末で削除されました',
        text: '編集している間に、ほかの端末（スマホなど）でこの項目が削除されました。入れた内容を、新しい項目として保存しますか？',
        yes: '新しい項目として保存する', no: '保存しない（編集に戻る）',
      });
      if (!asNew) return;
      id = null;
    } else if (itemMark(cur) !== editBaseMark) {
      // ★最初の行き先と Esc は「編集に戻る」（Enter 1回で入れた内容が消えないように）
      const overwrite = await confirmDlg({
        title: 'この項目は、ほかの端末で変わりました',
        text: '編集している間に、ほかの端末（スマホなど）でこの項目が変わりました。いま入れた内容で上書きすると、その変更は消えます（Google ドライブの「過去の版」には残ります）。\n' +
          'ほかの端末の内容にしたいときは、編集に戻ってから「やめる」を押してください。',
        yes: 'いま入れた内容で上書きする', no: '編集に戻る',
      });
      if (!overwrite) return;
    }
  }
  try {
    const saved = id ? (vault.edit(id, f), id) : vault.add(f);
    closeEdit();
    selectedId = saved;
    revealId = null;
    render();
    pushNow(true);   // ウェブは「保存」を押したらすぐ Drive に送る（§7.2 W-4）。送れなかったら、理由を小窓で知らせる
  } catch (e) {
    if (e instanceof VaultError) {
      showMessage(textOf(e.code));
      if (e.code === 'LOCKED') lockNow();
    } else {
      showMessage(e?.message || '保存できませんでした。');
    }
  }
}

async function deleteItem(id) {
  const it = vault.data?.item(id);
  if (!it) return;
  const yes = await confirmDlg({ title: `「${it.title}」を削除しますか？`, text: 'ほかの端末（スマホなど）からも消えます。', yes: '削除する', no: 'やめる' });
  if (!yes || !vault.isOpen) return;
  try {
    vault.remove(id);
    selectedId = null;
    render();
    pushNow(true);
  } catch (e) {
    showMessage(e instanceof VaultError ? textOf(e.code) : (e?.message || '削除できませんでした。'));
  }
}

// ------------------------------------------------------------------
// 同期の帯（§7.4）・結果の受け取り
// ------------------------------------------------------------------
let syncState = { kind: 'UpToDate' };
let lastStop = null;
let userAsked = false;
let lastConflictHead = null;
let needAccountCheck = false;   // 開いている間に金庫が見つからなくなった（別のアカウントでつないだかもしれない）
let throttleTimer = null;

function setSync(s) {
  const was = syncState.kind;
  syncState = s;
  let text = '';
  let warn = true;
  switch (s.kind) {
    case 'Checking': text = '↻ 確認中…'; warn = false; break;
    case 'Uploading': text = '↑ 保存中…'; warn = false; break;
    case 'UpToDate': text = vault.lastSyncedAt ? `✓ 最新です（${hhmm(vault.lastSyncedAt)}）` : '✓ 最新です'; warn = false; break;
    case 'Dirty': text = '✎ まだ保存できていません（押すと保存）'; break;
    case 'Offline': text = '⚠ オフライン（保存できていません。押すともう一度）'; break;
    case 'Throttled': text = '⚠ Google が混み合っています（少し待って、もう一度試します）'; break;
    case 'AuthNeeded': text = '⚠ Google につなぎ直してください'; break;
    case 'Conflict': text = s.rolledBack ? '⚠ Google ドライブが前の状態に戻っています（押す）' : '⚠ ほかの端末でも変更がありました（押す）'; break;
    case 'Stopped': text = '⚠ 同期を止めています（押すと理由）'; break;
  }
  $('syncBar').textContent = text;
  $('syncBar').classList.toggle('warn', warn);
  if (warn && s.kind !== was) announce(text);
}

$('syncBar').addEventListener('click', () => {
  if (!vault.isOpen) return;
  if (syncState.kind === 'AuthNeeded') { reconnect(); return; }
  // 競合のときも、まず Drive を見直してから3択を出す（その間にほかの端末が直していれば、聞かずに済む）
  userAsked = true;
  if (vault.dirty) pushNow(); else refreshNow();
});

/** asked = 本人が「保存する」「削除する」を押した（送れなかったら、理由を小窓で知らせる） */
function pushNow(asked = false) {
  if (!vault.isOpen) return;
  setSync({ kind: 'Uploading' });
  vault.push().then(o => handleOutcome(o, asked), unexpected);
}
function refreshNow() {
  if (!vault.isOpen) return;
  if (!tokenValid()) { updateTokenLeft(); return; }
  setSync({ kind: 'Checking' });
  vault.refresh().then(handleOutcome, unexpected);
}
function unexpected(e) {
  if (uiLocked) return;
  setSync({ kind: 'Stopped' });
  showMessage(`思いがけない失敗です（${e?.name || e}）。この画面の中身は残っています。同期の帯を押して、もう一度お試しください。`);
}

/** 同期を止める理由を知らせる。前と同じ理由なら、帯を押されたときだけ */
function stop(text, asked) {
  const say = asked || lastStop !== text;
  lastStop = text;
  setSync({ kind: 'Stopped', text });
  if (say) showMessage(text);
}

function handleOutcome(o, askedArg = false) {
  const asked = askedArg || userAsked;
  userAsked = false;
  if (uiLocked || !vault.isOpen || o.kind === 'Locked') return;
  if (['UpToDate', 'Downloaded', 'Uploaded'].includes(o.kind)) { lastStop = null; lastConflictHead = null; needAccountCheck = false; }
  if (o.kind !== 'Throttled') clearTimeout(throttleTimer);
  switch (o.kind) {
    case 'UpToDate':
    case 'Uploaded':
    case 'Downloaded':
      setSync(vault.dirty ? { kind: 'Dirty' } : { kind: 'UpToDate' });
      if (o.kind === 'Downloaded') render();
      checkSkew();
      updateTokenLeft();
      if (o.kind === 'Uploaded' && vault.dirty) pushNow();   // 送っている間に入れた編集を続けて送る
      break;
    case 'Conflict': {
      const head = o.meta?.headRevisionId ?? null;
      setSync({ kind: 'Conflict', rolledBack: o.rolledBack, head });
      // 同じ競合で、5分おきの見直しのたびに小窓を出し直さない（帯を押したときと、新しい競合のときだけ出す）
      const reason = o.reconsidered ? 'reconsidered' : o.editedMeanwhile ? 'editedMeanwhile' : null;
      if (asked || head !== lastConflictHead) openConflict(o.rolledBack, head, reason);
      lastConflictHead = head;
      break;
    }
    case 'AuthNeeded':
      accessToken = null;
      updateTokenLeft();
      setSync({ kind: 'AuthNeeded' });
      if (asked) showMessage('保存できていません（Google との接続が切れました）。変更はこの画面の中にだけあります。上の「つなぎ直す」を押すと、自動で保存します。それまで、このタブを閉じたり PC の電源を切ったりしないでください。');
      break;
    case 'Offline':
      setSync({ kind: 'Offline' });
      if (asked) showMessage('保存できていません（インターネットにつながっていません）。変更はこの画面の中にだけあります。つながったら同期の帯を押してください。それまで、このタブを閉じたり PC の電源を切ったりしないでください。');
      break;
    case 'Throttled':
      setSync({ kind: 'Throttled' });
      clearTimeout(throttleTimer);
      throttleTimer = setTimeout(() => {
        if (!uiLocked && vault.isOpen && syncState.kind === 'Throttled') { if (vault.dirty) pushNow(); else refreshNow(); }
      }, 32_000);
      break;
    case 'Trashed':
      stop(`Google ドライブで、金庫のファイル（${FILE_NAME}）がごみ箱に入っています。Google ドライブの「ごみ箱」から「復元」してください（ごみ箱のファイルは30日で消えます）。戻すまで保存は止めています。`, asked);
      break;
    case 'NoVault':
      needAccountCheck = true;
      updateTokenLeft();
      stop('Google ドライブに金庫が見つかりません。スマホと別の Google アカウントでつないでいませんか？ 上の帯の「アカウントを選んでつなぎ直す」を押して、スマホと同じアカウントを選んでください。' +
        '（金庫が消された場合は、この画面の中身は残っていますが、保存はできません）', asked);
      break;
    case 'DriveError':
      stop(o.reason === 'storageQuotaExceeded'
        ? 'Google ドライブの容量がいっぱいで、保存できませんでした。いらないファイルを消して空きを作ってから、同期の帯を押してください。'
        : `Google ドライブが受け付けませんでした（コード ${o.status}）。しばらくしてから、同期の帯を押してください。`, asked);
      break;
    case 'Refused':
      stop(textOfSync(o.code), asked);
      break;
    case 'Busy':
      setSync(vault.dirty ? { kind: 'Dirty' } : { kind: 'UpToDate' });
      showMessage('ほかの端末が保存している最中のようです。少し待ってから、同期の帯を押してください。');
      break;
  }
}

/** この PC の時計が5分以上ずれていたら知らせる（§5.6。書いたときの Drive の時刻と比べる） */
function checkSkew() {
  const s = vault.clockSkewMs;
  if (s == null || Math.abs(s) <= 5 * 60_000) { $('skewBand').hidden = true; return; }
  $('skewBand').textContent = `⚠ この PC の時計が約${Math.round(Math.abs(s) / 60_000)}分ずれています。Windows の「設定 → 時刻と言語 → 日付と時刻」で「時刻を自動的に設定する」をオンにしてください。`;
  $('skewBand').hidden = false;
}

// ------------------------------------------------------------------
// 競合の3択（§5.4）。出したときの Drive の版の番号を覚えておき、答えるときに Drive が変わっていたら決め直す
// ------------------------------------------------------------------
let conflictRolledBack = false;
let conflictHead = null;

const CONFLICT_REASON = {
  reconsidered: '選んでいる間に、ほかの端末がまた Google ドライブを変更しました。いまの状態で、もう一度選んでください。',
  editedMeanwhile: '「読み直す」を押したあとに、この画面で新しい変更がありました。その変更も捨ててよいか、もう一度選んでください。',
};

function openConflict(rolledBack, head, reason = null) {
  if ($('conflictDlg').open || !vault.isOpen || uiLocked) return;
  conflictRolledBack = !!rolledBack;
  conflictHead = head;
  const lead = reason ? [CONFLICT_REASON[reason]] : [];
  const lines = lead.concat(rolledBack
    ? ['Google ドライブの金庫が、この画面が知っている内容より古くなっています（「過去の版」に戻された、など）。',
      '・古い方にする … Google ドライブの内容に合わせます。この画面が知っていた新しい内容は消えます。',
      '・新しい方に戻す … この画面が知っていた新しい内容で、Google ドライブを上書きします。',
      '・あとで決める … いまは何もしません。']
    : ['この画面の変更と、ほかの端末（スマホなど）の変更が、両方あります。',
      '・読み直す … ほかの端末の内容にします。この画面でした変更は消えます。',
      '・上書きする … この画面の内容にします。ほかの端末でした変更は、Google ドライブの「過去の版」に残ります。',
      '・あとで決める … いまは何もしません。この画面の変更は残ります。']);
  $('conflictTitle').textContent = rolledBack ? 'Google ドライブが前の状態に戻っています' : 'ほかの端末で更新されています';
  $('conflictText').replaceChildren(...lines.map(t => el('p', '', t)));
  $('conflictReload').textContent = rolledBack ? '古い方にする（Google ドライブに合わせる）' : '読み直す（この画面の変更は捨てる）';
  $('conflictOverwrite').textContent = rolledBack ? '新しい方に戻す（上書きする）' : 'この画面の内容で上書きする';
  $('conflictDlg').showModal();
  $('conflictLater').focus();   // 最初から「捨てる」側を選ばせない（Enter 1回で消えないように）
}

async function resolveConflict(choice) {
  $('conflictDlg').close();
  if (choice === 'later' || !vault.isOpen) {
    setSync({ kind: 'Conflict', rolledBack: conflictRolledBack, head: conflictHead });
    return;
  }
  const rolledBack = conflictRolledBack;
  setSync({ kind: 'Checking' });
  userAsked = true;   // 断られたとき・決め直しのときは、必ず知らせる
  const o = await (choice === 'reload' ? vault.resolveByReload(conflictHead) : vault.resolveByOverwrite(conflictHead))
    .catch(e => { unexpected(e); return null; });
  if (!o || uiLocked) return;
  handleOutcome(o);
  if (o.kind === 'Downloaded' && o.reconsidered) showMessage('Google ドライブは、もうほかの端末で新しい内容になっていました。その内容に合わせました（この画面に変更はありませんでした）。');
  else if (o.kind === 'Downloaded') showMessage(rolledBack ? 'Google ドライブの内容（前の状態）に合わせました。' : 'ほかの端末の内容に読み直しました。');
  if (o.kind === 'Uploaded') showMessage('この画面の内容で上書きしました。前の内容は Google ドライブの「過去の版」に残っています。');
}
$('conflictReload').addEventListener('click', () => resolveConflict('reload'));
$('conflictOverwrite').addEventListener('click', () => resolveConflict('overwrite'));
$('conflictLater').addEventListener('click', () => resolveConflict('later'));
$('conflictDlg').addEventListener('cancel', e => { e.preventDefault(); resolveConflict('later'); });

// ------------------------------------------------------------------
// W-3 Google につなぎ直す（一覧も中身もそのまま。つながったら、保存できていない変更を自動で送る）
// ------------------------------------------------------------------
function updateTokenLeft() {
  if (!vault.isOpen || uiLocked) return;
  if (needAccountCheck) {
    $('authText').textContent = 'Google ドライブに金庫が見つかりません。スマホと同じ Google アカウントか確かめてください。';
    $('reconnectBtn').textContent = 'アカウントを選んでつなぎ直す';
    $('authBand').hidden = false;
  } else if (tokenValid()) {
    $('authBand').hidden = true;
  } else {
    $('authText').textContent = 'Google との接続が切れました（保存はまだできません）';
    $('reconnectBtn').textContent = 'つなぎ直す';
    $('authBand').hidden = false;
    if (syncState.kind !== 'Conflict' && syncState.kind !== 'Stopped') setSync({ kind: 'AuthNeeded' });
  }
  $('tokenLeft').textContent = tokenValid() ? `Google 接続: 残り${Math.max(0, Math.floor((tokenExpiresAt - Date.now()) / 60_000))}分` : '';
}

function reconnect() {
  if (!initGis()) { showMessage('Google のログイン部品がまだ読み込めていません。少し待ってから、もう一度押してください。'); return; }
  if (needAccountCheck) selectAccountNext = true;
  // ★await より前に呼ぶ
  requestToken().then(
    () => { needAccountCheck = false; updateTokenLeft(); userAsked = true; if (vault.dirty) pushNow(); else refreshNow(); },
    e => showMessage(gisErrorText(e, 'つなぎ直す')),
  );
}
$('reconnectBtn').addEventListener('click', reconnect);
setInterval(updateTokenLeft, 30_000);

// ------------------------------------------------------------------
// 自動ロック（§10.2。setTimeout は裏のタブで間引かれるので、時刻を比べる）
// ------------------------------------------------------------------
let lastActivity = Date.now();
const idleLimit = () => settings.autoLockMs || 300_000;
// ★scroll は入れない（一覧の自動スクロールでも起きて、鍵をかける時刻が延びてしまう）
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) {
  window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
}
setInterval(() => {
  if (!uiLocked && vault.isOpen && Date.now() - lastActivity > idleLimit()) lockNow('しばらく操作が無かったので、鍵をかけました。');
}, 15_000);

function onBackToPage() {
  if (uiLocked || !vault.isOpen) return;
  if (Date.now() - lastActivity > idleLimit()) lockNow('しばらく離れていたので、鍵をかけました。');
  else refreshNow();   // §5.7: 戻ってきたら Drive とそろえる
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { onBackToPage(); return; }
  lastActivity = Date.now();
  if (!uiLocked && vault.isOpen && settings.autoLockMs === 0) lockNow('タブを離れたので、鍵をかけました。');
});
// 同じタブでほかのページに移ってから「戻る」で帰ってきたとき（ブラウザがページを丸ごと覚えていた場合）
window.addEventListener('pageshow', e => { if (e.persisted) onBackToPage(); });
// 同じタブでほかのサイトへ移るとき、ブラウザがページを丸ごと凍らせてとっておく（「戻る」で開いたまま出てくる）なら、
// 先に鍵をかける（保存できていない変更と下書きは、暗号化してとっておかれる）
window.addEventListener('pagehide', e => { if (e.persisted && !uiLocked && vault.isOpen) lockNow('ほかのページに移ったので、鍵をかけました。'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') forgetGivenBackPw(); });

// 開いている間は、5分おきに Drive とそろえる（§5.8。見えているときだけ）
setInterval(() => {
  if (!uiLocked && vault.isOpen && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) refreshNow();
}, 5 * 60_000);

/**
 * 鍵をかける。画面の上の平文はすぐ消す。まだ保存できていない変更と編集中の下書きは、
 * 暗号化して記憶の中にだけとっておく（同じマスターパスワードで開き直したら戻る。タブを閉じたら消える）。
 */
function lockNow(reason = '') {
  const draft = editDraft();
  const hadChanges = vault.dirty;
  uiLocked = true;
  vault.lockKeepingChanges(draft);
  clearTimeout(revealTimer);
  clearTimeout(throttleTimer);
  if (clip) {
    clipNeedsClear = true;   // 消せなかったら、このページに戻ったときに消す
    endClip();
    clearLeftoverClip();
  }
  closingEdit = true;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  closingEdit = false;
  clearEditForm();
  // ★画面の上の平文も消す（隠れた所に残っているものも）。書き出しのファイルの URL も手放す
  $('list').replaceChildren();
  $('detail').replaceChildren();
  $('search').value = '';
  $('exportPw').value = '';
  releaseExportUrl();
  for (const id of ['listEmpty', 'msgText', 'confirmTitle', 'confirmText', 'conflictTitle', 'copyText', 'tokenLeft', 'syncBar', 'live', 'authText', 'exportStatus']) $(id).textContent = '';
  for (const id of ['conflictText', 'sInfo', 'multiList']) $(id).replaceChildren();
  selectedId = null;
  revealId = null;
  $('authBand').hidden = true;
  $('skewBand').hidden = true;
  $('main').hidden = true;
  $('unlock').hidden = false;
  const kept = hadChanges || draft
    ? '\nまだ保存できていなかった変更（編集の途中の内容）は、暗号化してとってあります。同じマスターパスワードで開くと戻ります（このタブを閉じると消えます）。'
    : '';
  setUnlockStatus(reason + kept);
  $('pw').value = '';
  $('pw').focus();
}
$('lockBtn').addEventListener('click', () => lockNow());

// 閉じる・再読み込みの前に、保存できていない変更があれば知らせる（このページは何も残さないので、閉じると消える）
window.addEventListener('beforeunload', e => {
  if (vault.dirty || vault.hasKept || ($('editDlg').open && editChanged())) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------
// キーボードだけで使う（§7.2 W-2）
// ------------------------------------------------------------------
document.addEventListener('keydown', e => {
  if ($('main').hidden || document.querySelector('dialog[open]')) return;
  if (e.isComposing || e.keyCode === 229) return;          // 日本語の変換中は触らない
  const t = e.target;
  const inSearch = t === $('search');
  if (!inSearch && t.matches?.('input, textarea, select')) return;
  const onControl = t.tagName === 'BUTTON' || t.tagName === 'A';
  const k = e.key;
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveSel(k === 'ArrowDown' ? 1 : -1); return; }
  if (k === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (onControl) return;   // ボタンやリンクの上では、そのボタンを押す
    const it = selectedItem();
    if (!it) return;
    e.preventDefault();
    if (e.shiftKey) copySecret('ID', it.loginId); else copySecret('パスワード', it.password);
    return;
  }
  const lower = k.length === 1 ? k.toLowerCase() : k;
  if (e.ctrlKey && e.shiftKey && lower === 'c') { e.preventDefault(); const it = selectedItem(); if (it) copySecret('ID', it.loginId); return; }
  if ((e.altKey && !e.ctrlKey && lower === 'v') || (e.ctrlKey && e.shiftKey && lower === 'v')) {
    e.preventDefault(); const it = selectedItem(); if (it?.password) toggleReveal(it.id); return;
  }
  if ((e.altKey && !e.ctrlKey && lower === 'n') || (e.ctrlKey && !e.shiftKey && !e.altKey && lower === 'n')) { e.preventDefault(); openEdit(null); return; }
  if (k === 'Escape') {
    e.preventDefault();
    if ($('search').value) { $('search').value = ''; renderList(); renderDetail(); $('search').focus(); } else lockNow();
    return;
  }
  // 文字を打ったら、どこにいても検索欄へ（ボタンの上の Space などは、ボタンのために残す）
  if (!inSearch && !onControl && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) $('search').focus();
});

// ------------------------------------------------------------------
// 上のボタン・設定
// ------------------------------------------------------------------
$('addBtn').addEventListener('click', () => openEdit(null));

$('settingsBtn').addEventListener('click', () => {
  $('sLock').value = String(settings.autoLockMs);
  $('sClip').value = String(settings.clipSeconds);
  const info = [
    `Google ドライブのファイル名: ${FILE_NAME}`,
    `入っている件数: ${vault.data ? vault.data.liveItems.length : 0} 件`,
    `最後に Google ドライブとそろえた時刻: ${vault.lastSyncedAt ? localTime(vault.lastSyncedAt) : 'まだ'}`,
  ];
  $('sInfo').replaceChildren(...info.map(t => el('li', '', t)));
  $('settingsDlg').showModal();
});
$('sLock').addEventListener('change', () => {
  const v = Number($('sLock').value);
  if (LOCK_CHOICES.includes(v)) { settings.autoLockMs = v; saveSettings(); }
});
$('sClip').addEventListener('change', () => {
  const v = Number($('sClip').value);
  if (CLIP_CHOICES.includes(v)) { settings.clipSeconds = v; saveSettings(); }
});
// 開いたまま選び直すと、次の保存で控えが元に戻ってしまうので、鍵をかけてから探し直す
// （保存できていない変更は暗号化してとっておかれ、選び直した金庫を開くと戻って、競合として聞く）
$('sForgetFile').addEventListener('click', () => {
  lockNow();
  ls.del(FILE_ID_KEY);
  setUnlockStatus('鍵をかけました。マスターパスワードを入れて「ひらく」を押すと、Google ドライブから金庫を探し直します（同じ名前が2つあれば、選ぶ画面が出ます）。');
});
$('settingsClose').addEventListener('click', () => $('settingsDlg').close());

// ------------------------------------------------------------------
// 一覧を Excel に書き出す（印刷用・縦の A4。改訂 R-25）
// ★パスワードが暗号化されずに入るファイルを作るので、書き出す前にマスターパスワードをもう一度入れてもらう
//   （開いたまま席を離れた間に、ほかの人が一度に全部を持ち出せないように）。
// ★ファイルはこのページの中だけで作る（export-xlsx.js。通信しない）。ダウンロードのフォルダに入る。
// ------------------------------------------------------------------
let exporting = false;
let exportUrl = null;   // ダウンロードに渡した blob: の URL（鍵をかけたら、すぐ手放す）

function setExportStatus(text, bad = false) {
  $('exportStatus').textContent = text;
  $('exportStatus').classList.toggle('bad', bad);
}
function releaseExportUrl() {
  if (exportUrl) { URL.revokeObjectURL(exportUrl); exportUrl = null; }
}
/** すべての項目を、一覧と同じ順（サイト名の読みの順）で */
function sortedItems() {
  return vault.data.liveItems
    .map(it => [normalizeForSearch(it.title), it])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(x => x[1]);
}

$('sExport').addEventListener('click', () => {
  if (!vault.isOpen) return;
  $('settingsDlg').close();
  if (vault.data.liveItems.length === 0) { showMessage('まだ何も入っていないので、書き出すものがありません。'); return; }
  $('exportPw').value = '';
  setExportStatus('');
  $('exportGo').disabled = $('exportCancel').disabled = false;
  $('exportDlg').showModal();
  $('exportPw').focus();
});
$('exportCancel').addEventListener('click', () => { $('exportPw').value = ''; $('exportDlg').close(); });
$('exportDlg').addEventListener('close', () => { $('exportPw').value = ''; });

$('exportForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (exporting) return;
  const pw = $('exportPw').value;
  $('exportPw').value = '';
  if (!vault.isOpen) { $('exportDlg').close(); return; }
  if (!pw) { setExportStatus('マスターパスワードを入れてください。', true); $('exportPw').focus(); return; }
  // 古い session.js が残っている（キャッシュ）ときは、読み直してもらう
  if (typeof vault.checkPassword !== 'function') { setExportStatus('ページを読み直してください（Ctrl キーを押しながら F5）。', true); return; }
  exporting = true;
  $('exportGo').disabled = $('exportCancel').disabled = true;
  setExportStatus('マスターパスワードを確かめています…');
  try {
    const okPw = await vault.checkPassword(pw);
    if (!vault.isOpen || !$('exportDlg').open) return;   // 確かめている間に鍵がかかった
    if (!okPw) {
      setExportStatus('マスターパスワードが違うようです。大文字・小文字と、全角／半角をご確認ください。', true);
      return;
    }
    const now = new Date();
    const rows = sortedItems().map(it => ({ title: it.title, memo: it.memo, url: it.url, loginId: it.loginId, password: it.password }));
    const bytes = buildXlsx(rows, { now, test: IS_TEST });
    const name = exportFileName(now, IS_TEST);
    releaseExportUrl();
    exportUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    bytes.fill(0);   // Blob は写しを持つので、手元の分は消しておく
    const a = el('a');
    a.href = exportUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    const url = exportUrl;
    setTimeout(() => { if (exportUrl === url) releaseExportUrl(); }, 60000);
    $('exportDlg').close();
    showMessage(`「${name}」を書き出しました（${rows.length} 件。ダウンロードのフォルダに入ります）。\n` +
      'Excel で開いて、そのまま印刷できます（縦の A4）。\n' +
      '印刷が終わったら、ファイルを消して、ごみ箱も空にしてください。');
  } catch (err) {
    if ($('exportDlg').open) setExportStatus('書き出せませんでした。もう一度お試しください。', true);
  } finally {
    exporting = false;
    $('exportGo').disabled = $('exportCancel').disabled = false;
    if ($('exportDlg').open) $('exportPw').focus();
  }
});

// ------------------------------------------------------------------
// お知らせ・確かめ
// ------------------------------------------------------------------
function showMessage(text) {
  $('msgText').textContent = text;
  // ほかの小窓（編集など）の後ろに隠れないよう、開いていても一番上に積み直す
  if ($('msgDlg').open) $('msgDlg').close();
  if (!$('msgDlg').open) $('msgDlg').showModal();
  $('msgOk').focus();
}
$('msgOk').addEventListener('click', () => $('msgDlg').close());

function confirmDlg({ title, text, yes, no }) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yes;
    $('confirmNo').textContent = no;
    const done = v => { $('confirmDlg').close(); resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    $('confirmDlg').oncancel = e => { e.preventDefault(); done(false); };
    $('confirmDlg').showModal();
    $('confirmNo').focus();
  });
}

// このブラウザが設定を覚えられない（プライベートウィンドウなど）ときは、ひとこと知らせる
const LS_OK = (() => { try { localStorage.setItem('kagibako.t', '1'); localStorage.removeItem('kagibako.t'); return true; } catch (e) { return false; } })();
if (!LS_OK) setUnlockStatus('このブラウザは設定を覚えられません（プライベートウィンドウなど）。開くたびに、Google ドライブから金庫を探し直します。使うのに問題はありません。');

$('pw').focus({ preventScroll: true });   // 上の「試しの金庫」の帯が隠れないように
