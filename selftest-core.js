// かぎばこ — 動作テストの本体（ウェブ版）
//
// shared/testvectors.json の全項目を、vault-crypto.js で実際に計算して答え合わせする。
// Node（web/test/run-node.mjs）からも、ブラウザの動作テスト画面（?selftest=1）からも同じものを使う。
//
// Android 版の SelfTest.kt も「同じ項目を・同じ判定で」通すこと。

import * as V from './vault-crypto.js';

// onResult({ group, name, ok, detail, ms }) が1項目ごとに呼ばれる。全部終わると集計を返す。
export async function runAll(vectors, onResult = () => {}) {
  const results = [];
  const enc = new TextEncoder();
  const report = (group, name, ok, detail, t0) => {
    const r = { group, name, ok, detail: ok ? '' : detail, ms: Math.round(now() - t0) };
    results.push(r);
    onResult(r);
  };
  const attempt = async (group, name, fn) => {
    const t0 = now();
    try {
      const err = await fn();
      report(group, name, !err, err || '', t0);
    } catch (e) {
      report(group, name, false, `例外: ${e && (e.code || e.message) || e}`, t0);
    }
  };

  // ---- 第1層: PBKDF2 単体 ----
  for (const v of vectors.pbkdf2) {
    await attempt('PBKDF2', v.name, async () => {
      const got = V.toHex(await V.pbkdf2Bytes(enc.encode(v.passwordAscii), enc.encode(v.saltAscii), v.iterations, v.dkLen));
      return got === v.expectedHex ? null : `got ${got.slice(0, 32)}… / want ${v.expectedHex.slice(0, 32)}…`;
    });
  }

  // ---- 第2層: AES-256-GCM 単体 ----
  for (const v of vectors.gcm) {
    await attempt('AES-GCM', v.name, async () => {
      const key = await crypto.subtle.importKey('raw', V.fromHex(v.keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const p = { name: 'AES-GCM', iv: V.fromHex(v.ivHex), tagLength: 128 };
      if (v.aadHex) p.additionalData = V.fromHex(v.aadHex);
      const out = new Uint8Array(await crypto.subtle.encrypt(p, key, V.fromHex(v.ptHex)));
      if (V.toHex(out) !== v.expectedHex) return `暗号化が違う got ${V.toHex(out).slice(0, 32)}…`;
      const back = new Uint8Array(await crypto.subtle.decrypt(p, key, out));
      return V.toHex(back) === v.ptHex ? null : '復号して元に戻らない';
    });
  }

  // ---- 第3層: アプリ全体 ----
  for (const v of vectors.app) {
    await attempt('アプリ', v.name, async () => {
      // (1) 入力文字列が JSON から正しく読めているか（文字化け検出）
      if (V.toHex(enc.encode(v.password)) !== v.passwordUtf8Hex) return 'テストの値を読み違えている（文字化け）';
      // (2) 鍵のバイト列そのもの（ここが違えば NFC・UTF-8・PBKDF2 のどれか）
      const keyBytes = await V.pbkdf2Bytes(V.passwordToBytes(v.password), V.decodeB64Strict(v.saltB64, 16), v.iterations, 32);
      if (V.toHex(keyBytes) !== v.expectedKeyHex) return `鍵が違う got ${V.toHex(keyBytes).slice(0, 16)}… / want ${v.expectedKeyHex.slice(0, 16)}…`;
      // (3) AAD の文字列
      const aad = new TextDecoder().decode(V.buildAad({
        kdf: { name: V.KDF_NAME, iterations: v.iterations, salt: v.saltB64 },
        cipher: { name: V.CIPHER_NAME, iv: v.ivB64 } }));
      if (aad !== v.expectedAad) return `AAD が違う: ${aad}`;
      // (4) 暗号化した結果
      const plaintext = v.plaintextGen ? genPlaintext(v.plaintextGen) : v.plaintext;
      if (v.plaintextGen && (await sha256Hex(enc.encode(plaintext))) !== v.plaintextUtf8Sha256) return '大きい平文の作り方が違う';
      const key = await V.deriveVaultKey(v.password, v.saltB64, v.iterations);
      const outerText = await V.encryptVaultWithIv(key, plaintext, V.decodeB64Strict(v.ivB64, 12));
      const ct = V.decodeB64Strict(JSON.parse(outerText).ciphertext);
      if (v.plaintextGen) {
        if ((await sha256Hex(ct)) !== v.expectedCiphertextSha256) return '暗号文が違う（sha256）';
      } else if (V.toHex(ct) !== v.expectedCiphertextHex) {
        return `暗号文が違う got ${V.toHex(ct).slice(0, 32)}…`;
      }
      // (5) 自分で書いたものを開ける
      const back1 = await V.openVault(v.password, outerText);
      if (back1.plaintext !== plaintext) return '自分で書いたものを開くと中身が違う';
      // (6) 相手（node:crypto）が書いたものを開ける
      if (v.outer) {
        const back2 = await V.openVault(v.password, v.outer);
        if (back2.plaintext !== plaintext) return 'テストの外側JSONを開くと中身が違う';
      }
      return null;
    });
  }

  // keyFrom があれば「そのアプリ用ベクタの salt と回数で作った、手元の鍵」を使う
  const keyFor = async v => {
    const src = vectors.app.find(a => a.name === v.keyFrom);
    return V.deriveVaultKey(v.password, src.saltB64, src.iterations);
  };
  // op: 'parseOuter'（読み取りだけ）/ 'assertKeyMatches'（上書き前の確認）/ なし（開く。keyFrom があれば手元の鍵で復号）
  const runOp = async v => {
    if (v.op === 'parseOuter') { V.parseOuter(v.outer); return null; }
    if (v.op === 'assertKeyMatches') { V.assertKeyMatches(await keyFor(v), v.outer); return null; }
    if (v.keyFrom) return V.decryptVault(await keyFor(v), v.outer);
    return (await V.openVault(v.password, v.outer)).plaintext;
  };

  // ---- 第4層: 断らなければいけないファイル ----
  for (const v of vectors.reject) {
    await attempt('断る', v.name, async () => {
      try {
        await runOp(v);
      } catch (e) {
        if (e instanceof V.VaultError) return e.code === v.expectCode ? null : `${e.code} で断った（${v.expectCode} であるべき）`;
        return `VaultError ではない例外: ${e && e.message}`;
      }
      return `断らずに通してしまった（${v.expectCode} であるべき）`;
    });
  }

  // ---- 第5層: 受け付けなければいけないファイル ----
  for (const v of vectors.accept) {
    await attempt('受け付ける', v.name, async () => {
      const plaintext = await runOp(v);
      if (v.expectPlaintext === undefined) return null;
      return plaintext === v.expectPlaintext ? null : '中身が違う';
    });
  }

  // ---- 第6層: 暗号化を断らなければいけない平文 ----
  for (const v of vectors.encryptReject) {
    await attempt('暗号化を断る', v.name, async () => {
      try {
        await V.encryptVault(await keyFor(v), v.plaintext);
      } catch (e) {
        if (e instanceof V.VaultError) return e.code === v.expectCode ? null : `${e.code} で断った（${v.expectCode} であるべき）`;
        return `VaultError ではない例外: ${e && e.message}`;
      }
      return `断らずに暗号化してしまった（${v.expectCode} であるべき）`;
    });
  }

  // ---- 第7層: 新しいマスターパスワードの規則 ----
  for (const v of vectors.passwordPolicy) {
    await attempt('新しいパスワード', v.name, async () => {
      const got = V.checkNewMasterPassword(v.password);
      return got === v.expect ? null : `${got} になった（${v.expect} であるべき）`;
    });
  }

  // ---- 第8層: 乱数を使う本番の暗号化（毎回 IV が変わる・往復できる・消した鍵は使えない）----
  await attempt('本番の暗号化', 'destroyed-key-is-locked', async () => {
    const key = await V.deriveVaultKey('correct-horse-battery-staple', V.newSaltB64(), V.MIN_ITERATIONS);
    const outer = await V.encryptVault(key, '{"x":1}');
    key.destroy();
    for (const [what, fn] of [['暗号化', () => V.encryptVault(key, '{"x":1}')], ['復号', () => V.decryptVault(key, outer)]]) {
      try {
        await fn();
        return `消した鍵で${what}できてしまった`;
      } catch (e) {
        if (!(e instanceof V.VaultError) || e.code !== 'LOCKED') return `${what}: LOCKED でなく ${e && (e.code || e.message)}`;
      }
    }
    return null;
  });
  await attempt('本番の暗号化', 'iv-is-fresh', async () => {
    const key = await V.deriveVaultKey('correct-horse-battery-staple', V.newSaltB64(), V.MIN_ITERATIONS);
    const a = JSON.parse(await V.encryptVault(key, '{"x":1}'));
    const b = JSON.parse(await V.encryptVault(key, '{"x":1}'));
    if (a.cipher.iv === b.cipher.iv) return '2回とも同じ IV になった';
    if (V.decodeB64Strict(a.cipher.iv).length !== 12) return 'IV が12バイトでない';
    if (a.kdf.iterations !== V.MIN_ITERATIONS) return 'iterations が鍵と違う';
    const back = await V.decryptVault(key, JSON.stringify(a));
    return back === '{"x":1}' ? null : '往復できない';
  });
  await attempt('本番の暗号化', 'writes-600000', async () => {
    return V.ITERATIONS === 600000 ? null : `ITERATIONS が ${V.ITERATIONS} になっている`;
  });

  const passed = results.filter(r => r.ok).length;
  return { passed, failed: results.length - passed, total: results.length, results };
}

export function genPlaintext(g) {
  return g.prefix + g.chunk.repeat(g.times) + g.suffix;
}

async function sha256Hex(bytes) {
  return V.toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function now() {
  return (typeof performance !== 'undefined' ? performance : Date).now();
}
