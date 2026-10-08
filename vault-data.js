// かぎばこ — 金庫の中身（復号した平文 JSON）の形（仕様書 第4章）
//
// ★Android の app/src/main/java/com/kagibako/app/vault/VaultData.kt と同じ形を読み書きすること。
//   読み取りの厳しさ・書き出しの文字列まで揃えてある（shared/vaultdata-vectors.json で両方を突き合わせる）。
// ★書き換えはすべて「新しい VaultData を返す」形にしてある（元を壊さない）。同期のときに
//   base（開いたとき）と local（編集後）を両方持つので、元が変わると比べられなくなるため。

import { VaultError, hasLoneSurrogate, isStrictJson } from './vault-crypto.js';

export const SCHEMA = 1;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;   // 2^53-1。Android 側も同じ範囲しか受け取らない
export const MAX_PLAIN_DEPTH = 32;          // 平文の入れ子の深さの上限（正しい平文は3段。知らない欄の分の余裕を見て）

/** 時刻は必ず UTC・ミリ秒まで・末尾 Z（仕様書 §4.2）。表示のときだけ日本時間に直す */
export function formatTime(ms) {
  return new Date(ms).toISOString();         // 例: 2026-10-03T02:11:05.123Z（Android の VaultTime と同じ形）
}

/** 画面で入力する欄。ログに中身が出ないよう、toString は伏せる */
export function itemFields(title, url, loginId, password, memo) {
  return Object.freeze({ title, url, loginId, password, memo, toString: () => 'ItemFields(****)' });
}

function freezeItem(it) {
  return Object.freeze({ ...it, toString: () => `VaultItem(id=${it.id}, rev=${it.rev}, deleted=${it.deleted})` });
}

export class VaultData {
  constructor({ schema, vaultRev, updatedAt, updatedBy, items, syncState }) {
    this.schema = schema;
    this.vaultRev = vaultRev;
    this.updatedAt = updatedAt;
    this.updatedBy = updatedBy;
    this.items = Object.freeze(items.slice());
    this.syncState = Object.freeze({ ...syncState });
    Object.freeze(this);
  }

  static empty(now, deviceId) {
    return new VaultData({ schema: SCHEMA, vaultRev: 0, updatedAt: now, updatedBy: deviceId, items: [], syncState: {} });
  }

  /** 消していない項目だけ */
  get liveItems() { return this.items.filter(it => !it.deleted); }

  item(id) { return this.items.find(it => it.id === id) || null; }

  #copy(changes) { return new VaultData({ ...this, ...changes }); }

  /** 戻り値は [新しい VaultData, 新しい項目の id] */
  withNewItem(f, now, deviceId) {
    checkFields(f);
    const id = crypto.randomUUID();
    const item = freezeItem({
      id, rev: 1, createdAt: now, updatedAt: now, updatedBy: deviceId, deleted: false, deletedAt: null,
      title: f.title, url: f.url, loginId: f.loginId, password: f.password, memo: f.memo,
    });
    return [this.#copy({ items: [...this.items, item] }), id];
  }

  withEditedItem(id, f, now, deviceId) {
    checkFields(f);
    return this.#replace(id, old => {
      if (old.deleted) throw new Error('消した項目は編集できません');
      return { ...old, rev: bump(old.rev), updatedAt: now, updatedBy: deviceId,
        title: f.title, url: f.url, loginId: f.loginId, password: f.password, memo: f.memo };
    });
  }

  /** 消す。物理的に消さず、中身を空にした「墓標」を残す（仕様書 §1.1 #21） */
  withDeletedItem(id, now, deviceId) {
    return this.#replace(id, old => ({ ...old, rev: bump(old.rev), updatedAt: now, updatedBy: deviceId,
      deleted: true, deletedAt: now, title: '', url: '', loginId: '', password: '', memo: '' }));
  }

  /**
   * ファイル全体の印を付け直す（編集のたびに。改訂 R-20）。
   * remoteSyncState を渡すと（競合で「上書き」を選んだとき）、端末ごとの時刻を大きい方にまとめる（改訂 R-22）。
   * そうしないと、上書きされた側の端末が「自分の編集が入っていない＝古い版に戻された」と取り違える。
   * ★自分の欄は、前より小さくしない（端末の時計が戻っても、前の値 + 1ms にする。改訂 R-23）。
   *   小さくすると、ほかの端末がふつうの新しい版を「古い版に戻された」と取り違える。
   */
  stampedForUpload(now, deviceId, remoteVaultRev, remoteSyncState = null) {
    checkDeviceId(deviceId);
    // ★Map で組み立てる（sync[k] = … と書くと、"__proto__" という名前の端末が黙って消える）
    const sync = new Map(Object.entries(this.syncState));
    if (remoteSyncState) {
      for (const [k, t] of Object.entries(remoteSyncState)) { const m = sync.get(k); if (m === undefined || m < t) sync.set(k, t); }
    }
    sync.set(deviceId, nextOwnStamp(sync.get(deviceId), now));
    return this.#copy({
      vaultRev: bump(Math.max(this.vaultRev, remoteVaultRev ?? 0)),
      updatedAt: now,
      updatedBy: deviceId,
      syncState: Object.fromEntries(sync),
    });
  }

  /**
   * 競合で「上書き」を選んだとき、Drive の中身（remote）の上にこの中身を置いたものを作る（改訂 R-23）。
   * 項目ごとに: こちらにある項目はこちらの中身のまま、番号を remote より小さくしない。remote にしか無い項目は墓標にする。
   * こうしてできた版は remote を（端末ごとの時刻でも、項目ごとでも）包むので、ほかの端末が「古い版に戻された」と取り違えない。
   */
  overwriteOnto(remote, now, deviceId) {
    const mine = new Set(this.items.map(it => it.id));
    const items = this.items.map(it => {
      const r = remote.item(it.id);
      if (!r || r.rev < it.rev) return it;
      if (sameContent(r, it)) return r;          // 同じ中身なら、相手の項目のまま
      return freezeItem({ ...it, rev: bump(r.rev), updatedAt: now, updatedBy: deviceId });
    });
    for (const r of remote.items) {
      if (mine.has(r.id)) continue;
      items.push(r.deleted ? r : freezeItem({ ...r, rev: bump(r.rev), updatedAt: now, updatedBy: deviceId,
        deleted: true, deletedAt: now, title: '', url: '', loginId: '', password: '', memo: '' }));
    }
    return this.#copy({ items }).stampedForUpload(now, deviceId, remote.vaultRev, remote.syncState);
  }

  /**
   * この中身が other の中身を「包んでいる」か: other に記録のある端末すべてについて、こちらの時刻が同じか新しい。
   * 正しく作った新しい版は、必ず前の版を包む（前の版の上に編集を足して作るので）。
   */
  covers(other) {
    for (const [k, t] of Object.entries(other.syncState)) {
      if (!Object.hasOwn(this.syncState, k) || this.syncState[k] < t) return false;
    }
    return true;
  }

  /**
   * next が base より「古い版に戻された」ものか（§4.2 の安全弁。改訂 R-22・R-23）。次のどれかなら、戻された
   * （または古い版の上に足された）とみなす:
   *   ・版の番号（vaultRev）が小さい
   *   ・base にあった端末の編集が抜けている（端末ごとの時刻で包んでいない）
   *   ・base にあった項目が無い、または項目の番号（rev）が小さい（墓標は消さないので、正しい新しい版では起きない）
   * vaultRev だけで比べると、古い版の上に1件足しただけで番号が並び、すり抜ける。
   */
  static isRollback(next, base) {
    if (next.vaultRev < base.vaultRev || !next.covers(base)) return true;
    const byId = new Map(next.items.map(it => [it.id, it]));
    for (const b of base.items) {
      const n = byId.get(b.id);
      if (!n || n.rev < b.rev) return true;
    }
    return false;
  }

  #replace(id, f) {
    let found = false;
    const next = this.items.map(it => {
      if (it.id !== id) return it;
      found = true;
      return freezeItem(f(it));
    });
    if (!found) throw new Error('項目が見つかりません（ほかの端末で消された可能性があります）');
    return this.#copy({ items: next });
  }

  // ------------------------------------------------------------------
  // 平文 JSON ⇄ VaultData（欄の順番も Android と同じ。pad は必ず最後）
  // ------------------------------------------------------------------

  toJson() {
    // ★Object.fromEntries で作る（sync[k] = … と書くと、"__proto__" という名前の端末が黙って消える）
    const sync = Object.fromEntries(Object.keys(this.syncState).sort(compareUtf16).map(k => [k, this.syncState[k]]));
    return JSON.stringify({
      schema: this.schema,
      vaultRev: this.vaultRev,
      updatedAt: this.updatedAt,
      updatedBy: this.updatedBy,
      items: this.items.map(it => ({
        id: it.id, rev: it.rev, createdAt: it.createdAt, updatedAt: it.updatedAt, updatedBy: it.updatedBy,
        deleted: it.deleted, deletedAt: it.deletedAt ?? null,
        title: it.title, url: it.url, loginId: it.loginId, password: it.password, memo: it.memo,
      })),
      syncState: sync,
      pad: '',   // サイズ隠し（第3段階）。いまは常に空
    });
  }

  /**
   * 平文 JSON を読む。知らない schema なら、ほかは見ずに断る（仕様書 §4.5）。
   * 平文は認証タグで守られているので、壊れているのは「書いた側のアプリの不具合」だけ。BROKEN で止める。
   */
  static fromJson(text) {
    // 外側と同じ手書きの確認（RFC 8259 の文法・同じ名前の欄が2つ無い・入れ子の深さ）を、平文にも通す（改訂 R-22）。
    // Android の読み取り部品は JSON として正しくない書き方も読めてしまうので、両方で受け付ける範囲を揃える
    if (typeof text !== 'string' || !isStrictJson(text, MAX_PLAIN_DEPTH)) throw new VaultError('BROKEN', '平文が JSON として正しくない');
    const root = JSON.parse(text);
    if (!isObj(root)) throw new VaultError('BROKEN', '平文が JSON の {} ではない');
    if (int(root.schema) !== SCHEMA) throw new VaultError('UNKNOWN_VERSION', 'schema');
    if (!Array.isArray(root.items)) throw new VaultError('BROKEN', 'items');
    const items = root.items.map(o => {
      if (!isObj(o)) throw new VaultError('BROKEN', 'items[]');
      const rev = int(o.rev);
      if (rev === null) throw new VaultError('BROKEN', 'rev');
      if (typeof o.deleted !== 'boolean') throw new VaultError('BROKEN', 'deleted');
      const it = {
        id: str(o, 'id'), rev,
        createdAt: str(o, 'createdAt'), updatedAt: str(o, 'updatedAt'), updatedBy: str(o, 'updatedBy'),
        deleted: o.deleted,
        deletedAt: typeof o.deletedAt === 'string' ? o.deletedAt : null,
        title: str(o, 'title'), url: str(o, 'url'), loginId: str(o, 'loginId'), password: str(o, 'password'), memo: str(o, 'memo'),
      };
      // 墓標に中身が残っていたら（書いた側の不具合）、ここで空にする。消したはずのパスワードを持ち回らない
      if (it.deleted) Object.assign(it, { title: '', url: '', loginId: '', password: '', memo: '' });
      return freezeItem(it);
    });
    if (new Set(items.map(it => it.id)).size !== items.length) throw new VaultError('BROKEN', 'id の重複');
    let syncState = {};
    if (isObj(root.syncState)) {
      const entries = Object.entries(root.syncState);
      for (const [, v] of entries) if (typeof v !== 'string') throw new VaultError('BROKEN', 'syncState');
      syncState = Object.fromEntries(entries);   // ★"__proto__" という名前の端末も消さずに持つ
    }
    const vaultRev = int(root.vaultRev);
    if (vaultRev === null) throw new VaultError('BROKEN', 'vaultRev');
    return new VaultData({
      schema: SCHEMA, vaultRev, updatedAt: str(root, 'updatedAt'), updatedBy: str(root, 'updatedBy'), items, syncState,
    });
  }
}

// ------------------------------------------------------------------
// 空白とみなす文字（改訂 R-22）。JavaScript の \s と Kotlin の isWhitespace は範囲が少し違う（U+FEFF と U+001C〜U+001F）ので、
// 両方に同じ一覧を書いて使う。Android の VaultData.kt の ITEM_SPACE と同じ。
// ------------------------------------------------------------------
const ITEM_SPACE = '\t\n\u000B\f\r\u001C\u001D\u001E\u001F                  　﻿';
const isItemSpace = ch => ITEM_SPACE.includes(ch);

/** 前後の空白を削る（サイト名・URL を保存するとき） */
export function trimItemSpace(s) {
  let a = 0, b = s.length;
  while (a < b && isItemSpace(s[a])) a++;
  while (b > a && isItemSpace(s[b - 1])) b--;
  return s.slice(a, b);
}

/** 空白だけ（または空）か */
export const isItemBlank = s => trimItemSpace(String(s)) === '';

// 文字列は「全部空」もありうる（ID だけ、メモだけ、など）が、サイト名は必須
function checkFields(f) {
  if (isItemBlank(f.title)) throw new Error('サイト名を入れてください');
  for (const s of [f.title, f.url, f.loginId, f.password, f.memo]) {
    if (typeof s !== 'string') throw new TypeError('欄が文字列ではない');
    // 壊れた文字は、Android は「?」、ウェブは「�」に黙って置き換わるので、入れる前に断る（改訂 R-13）
    if (hasLoneSurrogate(s)) throw new VaultError('BAD_CHAR');
  }
}

/** 番号を1つ増やす。2^53-1 を超えるなら断る（超えた番号は、どの端末でも読めなくなる。改訂 R-23） */
function bump(n) {
  if (n >= MAX_SAFE) throw new VaultError('BROKEN', '番号が上限を超える');
  return n + 1;
}

const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 自分の欄の次の時刻: 前の値が now より前なら now、そうでなければ前の値 + 1ms（時計が戻っても小さくしない） */
function nextOwnStamp(prev, now) {
  if (prev === undefined || prev < now) return now;
  if (!TIME_SHAPE.test(prev)) return prev;   // 読めない形（壊れた・古い版）は、そのまま（小さくはしない）
  return formatTime(Date.parse(prev) + 1);
}

function sameContent(a, b) {
  return a.deleted === b.deleted && a.title === b.title && a.url === b.url && a.loginId === b.loginId
    && a.password === b.password && a.memo === b.memo;
}

/** 端末の番号に壊れた文字が入っていたら断る（書き出しの形が Android と食い違うのを防ぐ。改訂 R-22） */
function checkDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || deviceId === '' || hasLoneSurrogate(deviceId)) throw new VaultError('BAD_CHAR');
}

const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

function str(o, key) {
  if (typeof o[key] !== 'string') throw new VaultError('BROKEN', key);
  return o[key];
}

/** 0 以上 2^53-1 以下の整数だけ（1.0 の書き方も整数として受け取る。改訂 R-16・R-19 ⑩）。それ以外は null */
function int(x) {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > MAX_SAFE) return null;
  return x;
}

// Kotlin の toSortedMap（String.compareTo = UTF-16 の符号単位の順）と同じ並べ方
function compareUtf16(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
