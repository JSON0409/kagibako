// かぎばこ — 金庫ファイルの暗号化と復号（ウェブ版）
//
// ★このファイルは Android 版の vault/VaultCrypto.kt と「1バイトも違わない」結果を出す必要がある。
//   決まりごとは docs/仕様書.md の第3章（と冒頭の「改訂」）。ここを直したら VaultCrypto.kt も同じように直し、
//   shared/testvectors.json の動作テストを両方で通すこと。
//
// ブラウザでも Node でもそのまま動く（どちらも crypto.subtle / TextEncoder / atob を持っている）。
// Node で動かせるので、PC の中だけで自動テストできる（web/test/run-node.mjs）。

export const FORMAT = 'kagibako-vault';
export const VERSION = 1;
export const KDF_NAME = 'PBKDF2-HMAC-SHA256';
export const CIPHER_NAME = 'AES-256-GCM';
export const ITERATIONS = 600000;      // 書くときは必ずこの値
export const MIN_ITERATIONS = 100000;  // 読むとき、これより少なければ「壊れている」とみなす
export const MAX_ITERATIONS = 2000000; // v1 で書くのは 600000 だけ。書き換えられたファイルで長く待たされないための上限。
                                       // 回数を上げるときは v を上げる（古い版は UNKNOWN_VERSION で止まる）
export const SALT_BYTES = 16;
export const IV_BYTES = 12;             // ちょうど12。Android 12 以降はこれ以外を受け付けない
export const TAG_BITS = 128;
export const MAX_OUTER_CHARS = 16777216; // 外側 JSON の長さの上限（約1600万文字）。金庫が普通これに届くことはない
export const MAX_JSON_DEPTH = 16;        // 入れ子の深さの上限。正しいファイルは 2（一番外の {} と kdf / cipher の {}）
export const MIN_PASSWORD_CHARS = 12;    // 新しく決めるマスターパスワードの最低の文字数（NFC にしてから数える）

// 失敗の種類。画面に出す文言は呼び出す側で code から選ぶ。
export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'VaultError';
    this.code = code;
  }
}
// code の一覧:
//   BAD_CHAR         パスワード・平文に壊れた文字（片割れのサロゲート）が入っている
//   NOT_VAULT        かぎばこの金庫ファイルではない（JSON として正しくない・深すぎる・長すぎるも含む）
//   UNKNOWN_VERSION  新しい版のアプリで作られたファイル（読むのも上書きも禁止）
//   BROKEN           ヘッダの値がおかしい（壊れている・書き換えられた）
//   SALT_CHANGED     手元の鍵と、ファイルの salt か回数が違う
//                    （別の端末でマスターパスワードを変えた・過去の版に戻した・書き換えられた、のどれか）
//   WRONG_PASSWORD   復号に失敗した（パスワード違い、または中身が書き換えられた）
//   LOCKED           ロックで消した鍵を使おうとした（保存の途中で自動ロックがかかった、など）

// ------------------------------------------------------------------
// マスターパスワード → バイト列
// ------------------------------------------------------------------

// ★NFC（「が」を1文字にそろえる正規化）。検索用の NFKC とは別物なので混ぜないこと。
//   ここを変えると、今までのファイルが開けなくなる。
export function passwordToBytes(raw) {
  const norm = String(raw).normalize('NFC');
  if (hasLoneSurrogate(norm)) throw new VaultError('BAD_CHAR');
  return new TextEncoder().encode(norm);   // TextEncoder は常に UTF-8
}

export function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

// 新しくマスターパスワードを決める・変えるときだけ使う確認（開くときは使わない）。
// 戻り値: 'OK' / 'BAD_CHAR' / 'UNSUPPORTED_CHAR' / 'TOO_SHORT'
//
// UNSUPPORTED_CHAR にする文字:
//   ・制御文字（タブ・改行など。U+0000〜U+001F, U+007F〜U+009F）
//   ・基本の範囲（U+FFFF まで）・絵文字（U+1F000〜U+1FAFF）・漢字の拡張（U+20000〜U+3FFFF）以外の文字
// ★理由: ごく新しく追加された文字（例: 2024年の Unicode 16 のキラット・ライ文字）は、
//   古い端末と新しい端末で NFC の結果が変わり、鍵が変わってしまう。そういう文字は上の範囲の外にある。
export function checkNewMasterPassword(raw) {
  const s = String(raw);
  if (hasLoneSurrogate(s)) return 'BAD_CHAR';
  const norm = s.normalize('NFC');
  let count = 0;
  for (const ch of norm) {               // for...of はサロゲートの組を1文字として回る
    const cp = ch.codePointAt(0);
    const ok = (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFFFF)
      || (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFF);
    if (!ok) return 'UNSUPPORTED_CHAR';
    count++;
  }
  return count < MIN_PASSWORD_CHARS ? 'TOO_SHORT' : 'OK';
}

// ------------------------------------------------------------------
// 鍵
// ------------------------------------------------------------------

// 鍵には「どの salt と回数で作ったか」を一緒に持たせる。
// 復号のときにファイルの salt と比べ、違っていれば SALT_CHANGED を出す。
// （これが無いと、別の端末でマスターパスワードを変えた直後に
//   「パスワードが違います」と間違った案内を出してしまう）
//
// destroy() したあとに使うと LOCKED。消した鍵で黙って暗号化しない。
export class VaultKey {
  #cryptoKey;
  #saltB64;
  #iterations;
  constructor(cryptoKey, saltB64, iterations) {
    this.#cryptoKey = cryptoKey;
    this.#saltB64 = saltB64;
    this.#iterations = iterations;
  }
  get saltB64() { return this.#saltB64; }
  get iterations() { return this.#iterations; }
  get destroyed() { return this.#cryptoKey === null; }
  destroy() { this.#cryptoKey = null; }
  // このファイルの中だけで使う
  _cryptoKey() {
    if (this.#cryptoKey === null) throw new VaultError('LOCKED');
    return this.#cryptoKey;
  }
  toString() { return 'VaultKey(****)'; }
}

export async function deriveVaultKey(password, saltB64, iterations) {
  checkIterations(iterations);
  const salt = decodeB64Strict(saltB64, SALT_BYTES);
  // 空のパスワードで作った金庫は存在しない（作るときに12文字以上を必須にしている）。
  // Android の HMAC は空の鍵を受け付けず別の例外になるので、ここで先に「違う」と言って揃える。
  if (String(password).length === 0) throw new VaultError('WRONG_PASSWORD');
  const baseKey = await crypto.subtle.importKey(
    'raw', passwordToBytes(password), 'PBKDF2', false, ['deriveKey']);
  const cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },  // 256 を忘れると黙って AES-128 になる
    false,                              // 取り出せない鍵にする
    ['encrypt', 'decrypt']);
  return new VaultKey(cryptoKey, saltB64, iterations);
}

// 動作テスト専用。鍵のバイト列そのものを Android 側と突き合わせるために使う。
export async function pbkdf2Bytes(passwordBytes, saltBytes, iterations, dkLenBytes) {
  const k = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, k, dkLenBytes * 8);
  return new Uint8Array(bits);
}

export function newSaltB64() {
  return b64encode(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

// ------------------------------------------------------------------
// 暗号化・復号
// ------------------------------------------------------------------

// plainText（平文の JSON 文字列）を暗号化し、Drive に置く外側 JSON の文字列を返す。
// IV は毎回新しい乱数。
//
// ★Drive のファイルを上書きする前には、必ず assertKeyMatches(key, いまの Drive の中身) を通すこと。
//   別の端末でマスターパスワードが変わっていたら、古い鍵で上書きして元に戻してしまう（仕様書 改訂 R-12）。
export async function encryptVault(vaultKey, plainText) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  return encryptVaultWithIv(vaultKey, plainText, iv);
}

// ★IV を外から渡せるのは動作テストのためだけ。アプリ本体からは呼ばないこと。
//   同じ鍵で同じ IV を2回使うと、AES-GCM は壊滅的に破れる。
export async function encryptVaultWithIv(vaultKey, plainText, ivBytes) {
  if (!(vaultKey instanceof VaultKey)) throw new TypeError('vaultKey');
  // 文字列以外（undefined など）を渡されると TextEncoder は黙って空にする＝空の金庫で上書きする事故になる
  if (typeof plainText !== 'string') throw new TypeError('plainText は文字列');
  // 壊れた文字は、ウェブは「�」、Android は「?」に黙って置き換えてしまい、両者で中身が変わる
  if (hasLoneSurrogate(plainText)) throw new VaultError('BAD_CHAR');
  if (!(ivBytes instanceof Uint8Array) || ivBytes.length !== IV_BYTES) {
    throw new VaultError('BROKEN', 'IV は12バイト');
  }
  const cryptoKey = vaultKey._cryptoKey();   // 消した鍵ならここで LOCKED
  const outer = {
    format: FORMAT,
    v: VERSION,
    kdf: { name: KDF_NAME, iterations: vaultKey.iterations, salt: vaultKey.saltB64 },
    cipher: { name: CIPHER_NAME, iv: b64encode(ivBytes), tagLength: TAG_BITS },
    ciphertext: '',
  };
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes, tagLength: TAG_BITS, additionalData: buildAad(outer) },
    cryptoKey,
    new TextEncoder().encode(plainText)));   // 戻り値は「暗号文‖認証タグ16バイト」
  outer.ciphertext = b64encode(ct);
  return JSON.stringify(outer, null, 2);
}

// ファイルを「はじめて開く」ときの手順。ヘッダを確かめ → その salt で鍵を作り → 復号する。
// 戻り値の key は、同じセッション中の保存（encryptVault）にそのまま使う。
export async function openVault(password, outerText) {
  const outer = parseOuter(outerText);
  const key = await deriveVaultKey(password, outer.kdf.salt, outer.kdf.iterations);
  try {
    const plaintext = await decryptVault(key, outerText);
    return { key, plaintext };
  } catch (e) {
    key.destroy();
    throw e;
  }
}

// 外側 JSON の文字列を復号し、平文の JSON 文字列を返す。
export async function decryptVault(vaultKey, outerText) {
  if (!(vaultKey instanceof VaultKey)) throw new TypeError('vaultKey');
  const outer = parseOuter(outerText);
  if (outer.kdf.salt !== vaultKey.saltB64 || outer.kdf.iterations !== vaultKey.iterations) {
    throw new VaultError('SALT_CHANGED');
  }
  const iv = decodeB64Strict(outer.cipher.iv, IV_BYTES);
  const ct = decodeB64Strict(outer.ciphertext);
  if (ct.length < TAG_BITS / 8) throw new VaultError('BROKEN', '暗号文が短すぎる');
  const cryptoKey = vaultKey._cryptoKey();
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BITS, additionalData: buildAad(outer) },
      cryptoKey, ct);                      // タグは切らずに丸ごと渡す
  } catch (e) {
    throw new VaultError('WRONG_PASSWORD');
  }
  // 鍵は合っていて改ざんも無いのに、中身が正しい UTF-8 でない＝書いた側のアプリの不具合。
  // 黙って「?」に置き換えると、その状態で上書き保存して壊れが広がるので、ここで止める。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch (e) {
    throw new VaultError('BROKEN', '平文が UTF-8 ではない');
  }
}

// 上書きの前の確認。手元の鍵と、いまの Drive のファイルが同じ salt・回数か（復号はしない）。
// 違えば SALT_CHANGED。新しい金庫を作るときと、マスターパスワードを変えるときは使わない。
export function assertKeyMatches(vaultKey, outerText) {
  const outer = parseOuter(outerText);
  if (outer.kdf.salt !== vaultKey.saltB64 || outer.kdf.iterations !== vaultKey.iterations) {
    throw new VaultError('SALT_CHANGED');
  }
}

// ------------------------------------------------------------------
// 外側 JSON の読み取りと検証
// ------------------------------------------------------------------

// 一番先に format と v を見る。知らない v なら、ほかは一切見ずに断る。
// （古いアプリが新しいファイルを「読めないから空で上書き」して全部消す事故を防ぐ）
//
// その前に、長さと JSON の文法（RFC 8259 どおりか・深すぎないか・同じ名前の欄が2つないか）を確かめる。
// Android の読み取り部品は JSON として正しくない書き方も読めてしまい、深い入れ子では落ちるので、
// 両方の実装で「同じ手書きの確認」を先に通して、受け付ける範囲を完全に揃えている。
export function parseOuter(outerText) {
  if (typeof outerText !== 'string' || outerText.length > MAX_OUTER_CHARS) throw new VaultError('NOT_VAULT');
  if (!isStrictJson(outerText, MAX_JSON_DEPTH)) throw new VaultError('NOT_VAULT');
  const o = JSON.parse(outerText);   // 上の確認を通ったものは必ず読める
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.format !== FORMAT) throw new VaultError('NOT_VAULT');
  if (o.v !== VERSION) throw new VaultError('UNKNOWN_VERSION');
  const kdf = o.kdf, cipher = o.cipher;
  if (!isPlainObject(kdf) || kdf.name !== KDF_NAME) throw new VaultError('BROKEN', 'kdf.name');
  checkIterations(kdf.iterations);
  if (typeof kdf.salt !== 'string') throw new VaultError('BROKEN', 'kdf.salt');
  decodeB64Strict(kdf.salt, SALT_BYTES);
  if (!isPlainObject(cipher) || cipher.name !== CIPHER_NAME) throw new VaultError('BROKEN', 'cipher.name');
  if (cipher.tagLength !== TAG_BITS) throw new VaultError('BROKEN', 'cipher.tagLength');
  if (typeof cipher.iv !== 'string') throw new VaultError('BROKEN', 'cipher.iv');
  decodeB64Strict(cipher.iv, IV_BYTES);
  if (typeof o.ciphertext !== 'string') throw new VaultError('BROKEN', 'ciphertext');
  return o;
}

function isPlainObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function checkIterations(n) {
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) {
    throw new VaultError('BROKEN', 'kdf.iterations');
  }
}

// AAD（隠さないが「書き換えられていないか」は確かめる情報）。
// ★ファイルに書いてある Base64 の文字列を「そのまま」使う。デコードし直さない。
// ★JSON を作り直して使うのは禁止（キーの順番や空白でずれる）。
export function buildAad(outer) {
  const s = 'kagibako|v1|'
    + outer.kdf.name
    + '|' + String(outer.kdf.iterations)
    + '|' + outer.kdf.salt
    + '|' + outer.cipher.name
    + '|' + outer.cipher.iv;
  return new TextEncoder().encode(s);
}

// ------------------------------------------------------------------
// JSON の文法の確認（RFC 8259）。Android 版の isStrictJson と1行ずつ同じ手順。
// ・空白は スペース / タブ / LF / CR だけ
// ・数は -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)? の形だけ（01, +1, .5, 1., 0x10 は不可）
// ・文字列の中の制御文字（U+0000〜U+001F）は不可。\ のあとは " \ / b f n r t u（＋16進4桁）だけ
// ・同じ {} の中に同じ名前の欄が2つあれば不可（v のように書いても "v" と同じとみなす）
// ・{} と [] の入れ子は maxDepth まで
// ・最後に余計なものがあれば不可（先頭の BOM も不可）
// 再帰の深さは maxDepth で抑えてあるので、深い入れ子でも落ちない。
// ------------------------------------------------------------------

export function isStrictJson(text, maxDepth) {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) i++;
      else break;
    }
  };
  const isDigit = c => c >= 0x30 && c <= 0x39;
  const isHex = c => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

  // 文字列を読む。成功したら中身（\ を解いたもの。keep が false なら空文字）を、失敗したら null を返す。
  // 中身を組み立てるのは欄の名前のときだけ（値の文字列は 1MB 級の暗号文のことがあるので組み立てない）
  const ESC = { 0x22: '"', 0x5C: '\\', 0x2F: '/', 0x62: '\b', 0x66: '\f', 0x6E: '\n', 0x72: '\r', 0x74: '\t' };
  const readString = keep => {
    if (i >= n || text.charCodeAt(i) !== 0x22) return null;
    i++;
    let out = '';
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) return null;
      if (c === 0x5C) {
        if (i + 1 >= n) return null;
        const e = text.charCodeAt(i + 1);
        if (e === 0x75) {   // \uXXXX
          if (i + 5 >= n) return null;
          for (let k = 2; k <= 5; k++) if (!isHex(text.charCodeAt(i + k))) return null;
          if (keep) out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16));
          i += 6;
          continue;
        }
        if (!(e in ESC)) return null;
        if (keep) out += ESC[e];
        i += 2;
        continue;
      }
      if (keep) out += text[i];
      i++;
    }
    return null;   // 閉じていない
  };

  const readNumber = () => {
    if (text.charCodeAt(i) === 0x2D) i++;                       // -
    if (i >= n) return false;
    if (text.charCodeAt(i) === 0x30) {                          // 0
      i++;
    } else if (text.charCodeAt(i) >= 0x31 && text.charCodeAt(i) <= 0x39) {
      while (i < n && isDigit(text.charCodeAt(i))) i++;
    } else {
      return false;
    }
    if (i < n && text.charCodeAt(i) === 0x2E) {                 // .
      i++;
      if (i >= n || !isDigit(text.charCodeAt(i))) return false;
      while (i < n && isDigit(text.charCodeAt(i))) i++;
    }
    if (i < n && (text.charCodeAt(i) === 0x65 || text.charCodeAt(i) === 0x45)) {   // e E
      i++;
      if (i < n && (text.charCodeAt(i) === 0x2B || text.charCodeAt(i) === 0x2D)) i++;
      if (i >= n || !isDigit(text.charCodeAt(i))) return false;
      while (i < n && isDigit(text.charCodeAt(i))) i++;
    }
    return true;
  };

  const readLiteral = word => {
    if (text.startsWith(word, i)) { i += word.length; return true; }
    return false;
  };

  const readValue = depth => {
    ws();
    if (i >= n) return false;
    const c = text.charCodeAt(i);
    if (c === 0x7B) return readObject(depth + 1);               // {
    if (c === 0x5B) return readArray(depth + 1);                // [
    if (c === 0x22) return readString(false) !== null;          // "
    if (c === 0x2D || isDigit(c)) return readNumber();
    if (c === 0x74) return readLiteral('true');
    if (c === 0x66) return readLiteral('false');
    if (c === 0x6E) return readLiteral('null');
    return false;
  };

  const readObject = depth => {
    if (depth > maxDepth) return false;
    i++;   // {
    ws();
    if (i < n && text.charCodeAt(i) === 0x7D) { i++; return true; }   // {}
    const names = new Set();
    for (;;) {
      ws();
      const name = readString(true);
      if (name === null || names.has(name)) return false;
      names.add(name);
      ws();
      if (i >= n || text.charCodeAt(i) !== 0x3A) return false;      // :
      i++;
      if (!readValue(depth)) return false;
      ws();
      if (i >= n) return false;
      const d = text.charCodeAt(i);
      i++;
      if (d === 0x2C) continue;                                     // ,
      if (d === 0x7D) return true;                                  // }
      return false;
    }
  };

  const readArray = depth => {
    if (depth > maxDepth) return false;
    i++;   // [
    ws();
    if (i < n && text.charCodeAt(i) === 0x5D) { i++; return true; }   // []
    for (;;) {
      if (!readValue(depth)) return false;
      ws();
      if (i >= n) return false;
      const d = text.charCodeAt(i);
      i++;
      if (d === 0x2C) continue;                                     // ,
      if (d === 0x5D) return true;                                  // ]
      return false;
    }
  };

  if (!readValue(0)) return false;
  ws();
  return i === n;
}

// ------------------------------------------------------------------
// Base64（RFC 4648 の標準形・= の詰め物あり・改行なし）
// ------------------------------------------------------------------

export function b64encode(bytes) {
  let s = '';
  const CH = 0x2000;   // 一度に全部渡すと大きいデータで落ちるので 8KB ずつ
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64Value(c) {
  if (c >= 0x41 && c <= 0x5A) return c - 0x41;        // A-Z
  if (c >= 0x61 && c <= 0x7A) return c - 0x61 + 26;   // a-z
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;   // 0-9
  if (c === 0x2B) return 62;                          // +
  if (c === 0x2F) return 63;                          // /
  return -1;
}

// 標準形の Base64 か（長さが4の倍数・使える文字だけ・= は最後に2個まで・余りのビットが0）。
// 「余りのビットが0」= デコードして作り直すと必ず同じ文字列に戻る。
// （"…IA==" と "…IB==" は同じバイト列になるが、後者は標準形でないので断る）
// Android 版の isStrictB64 と同じ手順で書いてある（あちらは正規表現だと長い文字列で落ちるため）。
export function isStrictB64(s) {
  if (s.length % 4 !== 0) return false;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  for (let i = 0; i < s.length - pad; i++) {
    if (b64Value(s.charCodeAt(i)) < 0) return false;
  }
  if (pad > 0) {
    const last = b64Value(s.charCodeAt(s.length - pad - 1));
    if (pad === 2 && (last & 0x0F) !== 0) return false;
    if (pad === 1 && (last & 0x03) !== 0) return false;
  }
  return true;
}

// Android の java.util.Base64 と同じくらい厳しく読む（空白・改行・URL用の - _ は受け付けない）。
// atob は空白を黙って読み飛ばすので、そのままだと両者で結果が食い違う。
export function decodeB64Strict(str, expectLen) {
  if (typeof str !== 'string' || !isStrictB64(str)) throw new VaultError('BROKEN', 'base64');
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (expectLen !== undefined && out.length !== expectLen) throw new VaultError('BROKEN', 'length');
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
