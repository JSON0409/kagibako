// かぎばこ — 検索のための文字のそろえ方と、パスワードを作る道具
// （Android の SearchNormalize.kt・PasswordGen.kt と同じ動きにしてある）

// ------------------------------------------------------------------
// 検索（仕様書 §7.1 A-2 / §9.4 normalizeForSearch）
// ------------------------------------------------------------------
// ★これは検索専用。マスターパスワードの NFC（vault-crypto.js の passwordToBytes）とは別物。
//   マスターパスワードに NFKC をかけると、今までの金庫が開けなくなる。混ぜないこと。
//
// 「ゆうちょ」「ユウチョ」「ＹＵＣＨＯ」「yucho」が、どれでも同じものとして引っかかるようにする:
//   1. NFKC（全角英数→半角、半角カナ→全角）  2. 小文字にする  3. カタカナ→ひらがな
export function normalizeForSearch(s) {
  const n = String(s).normalize('NFKC').toLowerCase();
  let out = '';
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    // ァ(30A1)〜ヶ(30F6) を ぁ(3041)〜ゖ(3096) へ
    out += (c >= 0x30A1 && c <= 0x30F6) ? String.fromCharCode(c - 0x60) : n[i];
  }
  return out;
}

/** 検索の言葉が、サイト名・ID・URL・メモのどれかに入っていれば true */
export function matchesSearch(item, query) {
  const q = normalizeForSearch(String(query).trim());
  if (q === '') return true;
  return [item.title, item.loginId, item.url, item.memo].some(s => normalizeForSearch(s).includes(q));
}

// ------------------------------------------------------------------
// パスワードを作る（仕様書 §7.1 A-4）
// ------------------------------------------------------------------
// 似た文字（0 O o l 1 I）は既定で除く。記号は入力欄で事故りにくい13種だけ（引用符・\・括弧は入れない）
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@^_';

/** 0 以上 n 未満の偏りのない乱数（剰余の偏りが出ないよう、はみ出した値は捨てて引き直す） */
function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** 項目のパスワード。小文字・大文字・数字（記号を含むなら記号も）を、それぞれ1文字以上必ず含める */
export function itemPassword(length = 20, symbols = true, excludeSimilar = true) {
  if (!(length >= 8 && length <= 64)) throw new RangeError('length');
  const lower = excludeSimilar ? LOWER : LOWER + 'lo';
  const upper = excludeSimilar ? UPPER : UPPER + 'IO';
  const digits = excludeSimilar ? DIGITS : DIGITS + '01';
  const classes = [lower, upper, digits, ...(symbols ? [SYMBOLS] : [])];
  const all = classes.join('');
  for (;;) {
    let s = '';
    for (let i = 0; i < length; i++) s += all[randomBelow(all.length)];
    // 全種類が入っていなければ作り直す（偏りを出さないため、足し込みではなく作り直す）
    if (classes.every(cls => [...s].some(ch => cls.includes(ch)))) return s;
  }
}
