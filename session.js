// かぎばこ — ウェブ版の金庫（開く・編集する・Drive とそろえる・競合を解く）
//
// 仕様書 §5（同期）・§9.5（状態の持ち方）・改訂 R-19〜R-22。Android の SyncEngine.kt と VaultService.kt を
// 1つにまとめたもの。判定の順番と、守っていること（下の★）は Android と同じにしてある。
//
// ★ウェブは金庫の暗号文も平文も、どこにも保存しない（タブを閉じたら全部消える。§9.5）。
//   localStorage に置くのは、秘密でない「ファイルの番号」と「salt と回数」（改訂 R-1）だけで、それは画面側（app.js）が持つ。
// ★Drive とのやりとりは、いつも1つずつ（#enqueue）。編集そのものはその外で、すぐ手元（local）に入る。
//   通信を待っている間に編集が入っても、ほかの端末の変更を黙って消さないように、受け取る直前・書き終えたあとに確かめる。
// ★Drive の中身は、受け取る前に必ず鍵で読めるか確かめる。読めない・知らない版・古い版に戻されたものは受け取らない。
// ★ロックしたら（lock）、通信の途中のものも、そのあと手元を書き換えない（#gen で見分ける）。
// ★ロックのときに、まだ Drive に届いていない変更と編集中の下書きは、鍵で暗号化してから記憶の中にだけとっておき、
//   同じマスターパスワードで開き直したら戻す（lockKeepingChanges。改訂 R-22）。平文は残さない。
// ★競合の3択は「出したときの Drive の版の番号」を覚えておき、答えるときに Drive が変わっていたら決め直してもらう。

// ★import の後ろに ?v= を付けない。付ける・付けないが混ざると、同じファイルが別物として2回読まれ、
//   VaultError の見分け（instanceof）が効かなくなる。キャッシュ対策は index.html の app.js?v= だけで行う。
import { VaultError, ITERATIONS, deriveVaultKey, decryptVault, encryptVault, parseOuter } from './vault-crypto.js';
import { VaultData, formatTime } from './vault-data.js';
import { DriveNotFound, DriveUnauthorized, DriveOffline, DriveHttpError, DriveBusy } from './drive.js';

/** 回数が 600000 でないファイル（改訂 R-10）。画面で確かめてから、allowUnusualIterations: true でやり直す */
export class UnusualIterations extends Error {
  constructor(iterations) { super(`回数 ${iterations}`); this.name = 'UnusualIterations'; this.iterations = iterations; }
}

// 結果の種類（Android の SyncOutcome と同じ名前）:
//   Opened{restored, draft} / UpToDate / Downloaded{reconsidered} / Uploaded / Conflict{meta, rolledBack} / NoVault / Trashed
//   Multiple{files} / Offline / AuthNeeded / Throttled / DriveError{status, reason} / Busy / Refused{code} / Locked
const out = (kind, extra = {}) => Object.freeze({ kind, ...extra });

export class WebVault {
  #remote; #fileName; #deviceId; #now; #store;
  #gen = 0;                 // ロックするたびに増える
  #chain = Promise.resolve();
  #key = null;              // VaultKey（取り出せない CryptoKey を中に持つ）
  #fileId = null;
  #base = null; #baseText = null; #baseHead = null; #baseVersion = null;
  #local = null;
  #dirty = false;
  #pending = null;          // 送ったが返事を受け取れなかったもの {text, data}（§5.3 の 14）
  #lastSyncedAt = null;
  #clockSkewMs = null;
  #rolledBackHead = null;   // 「古い版に戻された」と分かった Drive の版の番号（その版のままなら、競合も同じ説明で出す）
  #kept = [];               // ロックのときにとっておいたもの（暗号文だけ）[{ base, rolledBack, changes, draftText }]

  /**
   * @param remote   HttpDriveRemote と同じ口（getMeta / download / update / listByName）
   * @param fileName 金庫のファイル名
   * @param deviceId この端末の番号
   * @param store    { getFileId(), setFileId(id) } ファイルの番号の控え（秘密ではない）
   */
  constructor({ remote, fileName, deviceId, store, now = () => Date.now() }) {
    this.#remote = remote; this.#fileName = fileName; this.#deviceId = deviceId; this.#store = store; this.#now = now;
  }

  get isOpen() { return this.#key !== null && !this.#key.destroyed; }
  get data() { return this.isOpen ? this.#local : null; }
  get dirty() { return this.isOpen && this.#dirty; }
  get lastSyncedAt() { return this.#lastSyncedAt; }
  /** 端末の時計が Drive の時計からどれだけずれているか（ミリ秒。書いたときの modifiedTime から測る） */
  get clockSkewMs() { return this.#clockSkewMs; }
  get fileName() { return this.#fileName; }
  /** ロックのときにとっておいた、まだ届いていない変更か下書きがある（同じマスターパスワードで開けば戻る） */
  get hasKept() { return this.#kept.length > 0; }

  #nowText() { return formatTime(this.#now()); }

  #alive(gen) { return gen === this.#gen && this.isOpen; }

  /** Drive とのやりとりを1つずつ並べる */
  #enqueue(fn) {
    const p = this.#chain.then(fn, fn);
    this.#chain = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------
  // 見つける・開く
  // ------------------------------------------------------------------

  /** 金庫のファイルを見つける（仕様書 §5.2） */
  async #locate() {
    const id = this.#store.getFileId();
    if (id) {
      try {
        const rm = await this.#remote.getMeta(id);
        // ★ごみ箱の中のファイルも、番号で聞けば普通に返ってくる。書き続けると30日後に版の履歴ごと消える
        if (!rm.trashed) return out('Found', { meta: rm });
        const others = await this.#remote.listByName(this.#fileName);
        return out('Trashed', { others: others.length });
      } catch (e) {
        if (!(e instanceof DriveNotFound)) throw e;   // 消されたか、連携を外された。名前で探し直す
      }
    }
    const list = await this.#remote.listByName(this.#fileName);   // ごみ箱の中は探さない
    if (list.length === 0) return out('NoVault');
    if (list.length > 1) return out('Multiple', { files: list });
    this.#store.setFileId(list[0].id);
    return out('Found', { meta: list[0] });
  }

  /** 同じ名前の金庫が2つ以上あったとき、利用者が選んだ方を使う（自動では選ばない。§5.2 の 2-b） */
  chooseFile(id) { this.#store.setFileId(id); }

  /**
   * Drive から取ってきて、マスターパスワードで開く。
   * preKey: 控えておいた salt と回数で、Google の画面と並べて先に作っておいた鍵（改訂 R-1）。ファイルと違えば作り直す。
   * onStage: 画面に段階を出すため（'download' / 'kdf' / 'decrypt'）
   * 戻り値 Opened の restored は「ロックの前に届いていなかった変更を戻した」、draft は「とっておいた下書き（文字列）」。
   */
  open(password, { preKey = null, allowUnusualIterations = false, onStage = () => {} } = {}) {
    return this.#enqueue(async () => {
      const gen = this.#gen;
      let key = null;
      try {
        onStage('download');
        const loc = await this.#locate();
        if (loc.kind !== 'Found') return loc;
        const f = await this.#fetchStable(loc.meta);
        if (!f) return out('Busy');
        const outer = parseOuter(f.text);   // 知らない版・壊れたファイルはここで止まる
        if (outer.kdf.iterations !== ITERATIONS && !allowUnusualIterations) throw new UnusualIterations(outer.kdf.iterations);
        if (preKey && !preKey.destroyed && preKey.saltB64 === outer.kdf.salt && preKey.iterations === outer.kdf.iterations) {
          key = preKey; preKey = null;
        } else {
          onStage('kdf');
          key = await deriveVaultKey(password, outer.kdf.salt, outer.kdf.iterations);
        }
        onStage('decrypt');
        const data = VaultData.fromJson(await decryptVault(key, f.text));
        if (gen !== this.#gen) return out('Locked');   // 開いている途中でロックされた
        if (this.#key) this.#key.destroy();
        this.#key = key; key = null;
        this.#fileId = f.meta.id;
        this.#adopt(f.text, f.meta, data);
        this.#local = data;
        this.#dirty = false;
        this.#pending = null;
        const kept = await this.#restoreKept(gen, data);
        if (gen !== this.#gen) return out('Locked');
        return out('Opened', { saltB64: outer.kdf.salt, iterations: outer.kdf.iterations, ...kept });
      } catch (e) {
        // 通信の失敗は結果として返す。パスワード違い（VaultError）と回数の確かめ（UnusualIterations）は、そのまま投げる
        const o = driveOutcome(e);
        if (o) return o;
        throw e;
      } finally {
        if (key) key.destroy();
        if (preKey) preKey.destroy();
      }
    });
  }

  /**
   * ロックの前にとっておいたものを、いまの鍵で戻す（改訂 R-22・R-23）。
   * ・変更は「とっておいたときの base と版の番号」ごと戻すので、その間に Drive が変わっていれば（別のファイルを選び直した
   *   ときも）、次の送信で競合として聞く。黙って捨てない
   * ・「古い版に戻されています」の答え待ちだったときは、いまの Drive がまだ古ければ、新しい方を手元に戻して3択を出し直す
   * ・いまの鍵で読めない（別のマスターパスワードの金庫を開いた）ときは、戻さずにとっておいたまま（keptRemains）。
   *   正しい金庫を開き直せば戻る。タブを閉じれば消える
   * 戻り値: { restored, draft, rolledBack, keptRemains }
   */
  async #restoreKept(gen, opened) {
    const none = { restored: false, draft: null, rolledBack: false, keptRemains: false };
    if (this.#kept.length === 0) return none;
    let k = null, changes = null, keptBase = null, draft = null;
    for (const entry of this.#kept) {
      try {
        let ch = null, kb = null, dr = null;
        if (entry.changes) {
          const c = entry.changes;
          const pending = c.pendingText ? { text: c.pendingText, data: VaultData.fromJson(await decryptVault(this.#key, c.pendingText)) } : null;
          // 送っている最中だったものと同じ中身なら、同じものとして戻す（届いていたとき、同じ中身をもう一度書かないように）
          const local = c.localIsPending && pending ? pending.data : VaultData.fromJson(await decryptVault(this.#key, c.localText));
          ch = { local, pending };
        }
        if (entry.base) kb = { ...entry.base, data: VaultData.fromJson(await decryptVault(this.#key, entry.base.baseText)) };
        if (entry.draftText) dr = await decryptVault(this.#key, entry.draftText);
        k = entry; changes = ch; keptBase = kb; draft = dr;
        break;
      } catch (e) {
        // この金庫（いまのマスターパスワード）では読めない。別の金庫のものなので、戻さずにとっておく
      }
    }
    if (!k) return { ...none, keptRemains: true };
    if (gen !== this.#gen) return none;
    this.#kept = this.#kept.filter(e => e !== k);
    const result = { ...none, draft, keptRemains: this.#kept.length > 0 };
    if (changes && keptBase) {
      // とっておいたときの base ごと戻す。Drive がその後に変わっていれば（別のファイルを選び直したときも）、
      // 次の送信で「変わった」と分かり、競合として聞く（古い版に戻されていれば、その説明で）
      this.#setBase(keptBase);
      this.#local = changes.local;
      this.#dirty = true;
      this.#pending = changes.pending;
      result.restored = true;
    } else if (keptBase && k.rolledBack && VaultData.isRollback(opened, keptBase.data)) {
      // 「古い版に戻されています」の答え待ちだった。いまの Drive もまだ古いので、この端末が知っていた新しい方を
      // 手元に戻す（次の同期で、もう一度3択が出る）
      this.#setBase(keptBase);
      this.#local = keptBase.data;
      this.#dirty = false;
      result.rolledBack = true;
    }
    return result;
  }

  #setBase(b) {
    this.#base = b.data; this.#baseText = b.baseText; this.#baseHead = b.baseHead; this.#baseVersion = b.baseVersion;
  }

  // ------------------------------------------------------------------
  // 編集（手元にすぐ入れる。Drive に送るのは push で、別に行う）
  // ------------------------------------------------------------------

  add(f) { let id = ''; this.#mutate((d, now, dev) => { const [n, i] = d.withNewItem(f, now, dev); id = i; return n; }); return id; }
  edit(id, f) { this.#mutate((d, now, dev) => d.withEditedItem(id, f, now, dev)); }
  remove(id) { this.#mutate((d, now, dev) => d.withDeletedItem(id, now, dev)); }

  #mutate(op) {
    if (!this.isOpen) throw new VaultError('LOCKED');
    const now = this.#nowText();
    this.#local = op(this.#local, now, this.#deviceId).stampedForUpload(now, this.#deviceId, this.#base.vaultRev);
    this.#dirty = true;
  }

  // ------------------------------------------------------------------
  // Drive とそろえる
  // ------------------------------------------------------------------

  /** この端末の変更を送る（編集のたびに呼ぶ。§5.3 の 6〜13） */
  push() { return this.#enqueue(() => this.#guard(gen => this.#pushLocked(gen))); }

  /**
   * Drive とそろえる（画面に戻ったとき・数分おき。§5.7 の4ケース）
   *   a 変更なし → UpToDate / b Drive だけ変わった → 確かめてから Downloaded
   *   c この端末だけ変わった → 送る / d 両方変わった → Conflict
   */
  refresh() {
    return this.#enqueue(() => this.#guard(async gen => {
      const rm = await this.#metaOrRelocate(gen);
      if (!this.#alive(gen)) return out('Locked');
      if (rm.trashed) return out('Trashed');
      if (await this.#settle(rm, gen)) return this.#dirty ? this.#pushLocked(gen) : out('Uploaded');
      const changed = await this.#contentChanged(rm, gen);
      if (!this.#alive(gen)) return out('Locked');
      if (!changed && !this.#dirty) { this.#lastSyncedAt = this.#nowText(); return out('UpToDate'); }
      if (!changed) return this.#pushLocked(gen);
      if (this.#dirty) return this.#dirtyConflict(rm, gen);
      const f = await this.#fetchStable(rm);
      if (!f) return out('Busy');
      return this.#judge(f, gen);
    }));
  }

  /**
   * 競合で「読み直す（この端末の編集は捨てる）」を選んだとき。expectHead は3択を出したときの Drive の版の番号。
   * ★Drive の中身がいまの鍵で読めると確かめてから捨てる。読めなければ何も変えずに Refused。
   * ★3択を出したあとに Drive が変わっていた・押したあとに編集が入ったときは、捨てずに決め直してもらう。
   */
  resolveByReload(expectHead = null) {
    // 押した瞬間の手元を覚える（先に並んでいる同期を待つ間に入った編集も、「捨てる」と決めたものには入っていない）
    const chosen = this.#local;
    return this.#enqueue(() => this.#guard(async gen => {
      const f = await this.#fetchCurrent(gen);
      if (f.kind) return f;
      const d = await this.#readable(f.text);
      if (!this.#alive(gen)) return out('Locked');
      if (expectHead && f.meta.headRevisionId !== expectHead) return { ...this.#reconsider(f, d), reconsidered: true };
      if (this.#local !== chosen) return { ...this.#conflict(f.meta), editedMeanwhile: true };
      this.#adopt(f.text, f.meta, d);
      this.#local = d;
      this.#dirty = false;
      this.#pending = null;
      return out('Downloaded');
    }));
  }

  /**
   * 競合で「この端末の内容で上書きする」を選んだとき。expectHead は3択を出したときの Drive の版の番号。
   * ★Drive の中身をいまの鍵で読めなければ（別のマスターパスワード・知らない版）、何も変えずに Refused（改訂 R-12・§4.5）。
   * ★3択を出したあとに Drive が変わっていたら、上書きせずに決め直してもらう（その間のほかの端末の変更を黙って消さない）。
   * ★送るのは、取ってきたあとの「いちばん新しい手元の中身」（取ってくる間に入れた編集も含む）。
   */
  resolveByOverwrite(expectHead = null) {
    return this.#enqueue(() => this.#guard(async gen => {
      const f = await this.#fetchCurrent(gen);
      if (f.kind) return f;
      const d = await this.#readable(f.text);
      if (!this.#alive(gen)) return out('Locked');
      if (expectHead && f.meta.headRevisionId !== expectHead) return { ...this.#reconsider(f, d), reconsidered: true };
      this.#adopt(f.text, f.meta, d);
      // Drive の中身の上に、この端末の中身を置く（項目の番号・端末ごとの時刻を相手より小さくしない。相手だけの項目は墓標に）。
      // ほかの端末が「古い版に戻された」と取り違えないように（改訂 R-22・R-23）
      this.#local = this.#local.overwriteOnto(d, this.#nowText(), this.#deviceId);
      this.#dirty = true;
      this.#pending = null;
      return this.#pushLocked(gen);
    }));
  }

  /** ロックする。鍵を消し、復号した中身も手放す（通信の途中のものも、このあと手元を書き換えない） */
  lock() {
    this.#gen++;
    if (this.#key) this.#key.destroy();
    this.#key = null;
    this.#base = this.#local = null;
    this.#baseText = this.#baseHead = this.#baseVersion = null;
    this.#dirty = false;
    this.#pending = null;
    this.#rolledBackHead = null;
  }

  /**
   * ロックする。ただし、まだ Drive に届いていない変更と、編集中の下書き（draft: 文字列）は、
   * 鍵で暗号化してから記憶の中にとっておく（同じマスターパスワードで開き直したら戻る。タブを閉じれば消える）。
   * 通信の途中のものは、この瞬間から手元を書き換えない。
   */
  async lockKeepingChanges(draft = null) {
    if (!this.isOpen) { this.lock(); return; }
    const key = this.#key;
    const dirty = this.#dirty;
    const rolledBack = this.#rolledBackHead !== null;
    // base は Drive の暗号文そのもの（新しい秘密は増えない）。変更があるとき・古い版の答え待ちのときに、版の番号ごととっておく
    const base = dirty || rolledBack ? { baseText: this.#baseText, baseHead: this.#baseHead, baseVersion: this.#baseVersion } : null;
    const local = this.#local;
    const pending = this.#pending;
    this.#key = null;      // 鍵は下で暗号化してから消す
    this.lock();           // 手元の平文はここで手放す
    try {
      if (!base && !draft) return;
      const kept = { base, rolledBack, changes: null, draftText: null };
      if (dirty) {
        const localIsPending = !!pending && local === pending.data;
        kept.changes = {
          localText: localIsPending ? null : await encryptVault(key, local.toJson()),
          pendingText: pending ? pending.text : null,
          localIsPending,
        };
      }
      if (draft) kept.draftText = await encryptVault(key, draft);
      // 前に別の金庫で戻せずに残っているものは、消さずに並べて持つ
      this.#kept.push(kept);
    } catch (e) {
      // 暗号化できなかった（鍵がもう無い等）。とっておけない
    } finally {
      key.destroy();
    }
  }

  /** とっておいたものを捨てる（別のマスターパスワードで開き直すときなど） */
  discardKept() { this.#kept = []; }

  // ------------------------------------------------------------------

  #adopt(text, meta, data) {
    this.#base = data;
    this.#baseText = text;
    this.#baseHead = meta.headRevisionId;
    this.#baseVersion = meta.version;
    this.#lastSyncedAt = this.#nowText();
    this.#rolledBackHead = null;
    this.#store.setFileId(meta.id);
  }

  #conflict(meta) {
    return out('Conflict', { meta, rolledBack: meta.headRevisionId === this.#rolledBackHead });
  }

  /**
   * 手元に変更があるのに Drive も変わっていた。Drive の中身を読んで、古い版に戻されたものなら、その説明の競合にする
   * （ふつうの競合の「読み直す」を選ぶと、保存済みの新しい中身まで消えるので。改訂 R-23）。読めなければ、ふつうの競合。
   */
  async #dirtyConflict(rm, gen) {
    if (rm.headRevisionId !== this.#rolledBackHead) {
      const f = await this.#fetchStable(rm);
      if (!this.#alive(gen)) return out('Locked');
      if (f) {
        try {
          const d = await this.#readable(f.text);
          if (VaultData.isRollback(d, this.#base)) this.#rolledBackHead = f.meta.headRevisionId;
          return this.#conflict(f.meta);
        } catch (e) {
          if (e instanceof VaultError && e.code === 'LOCKED') throw e;
          // 読めない中身（別のマスターパスワード・知らない版）は、答えるときに断る
        }
      }
    }
    return this.#conflict(rm);
  }

  /** 取ってきた中身を確かめて、受け取ってよければ受け取る（§4.2 の安全弁を含む） */
  async #judge(f, gen) {
    const d = await this.#readable(f.text);   // 読めなければ VaultError → Refused（受け取らない）
    if (!this.#alive(gen)) return out('Locked');
    return this.#reconsider(f, d);
  }

  /** 取ってきた中身 d で判定し直す（refresh・3択を出したあとに Drive が変わっていたとき） */
  #reconsider(f, d) {
    // この端末の知っている中身より古い版（過去の版に戻された、古い版の上に足された）は、黙って受け取らない
    if (VaultData.isRollback(d, this.#base)) {
      this.#rolledBackHead = f.meta.headRevisionId;
      return out('Conflict', { meta: f.meta, rolledBack: true });
    }
    // 取ってくる途中で編集が入っていたら、受け取らずに競合にする（黙って相手の変更を消さない）
    if (this.#dirty) return out('Conflict', { meta: f.meta, rolledBack: false });
    this.#adopt(f.text, f.meta, d);
    this.#local = d;
    return out('Downloaded', { reconsidered: true });
  }

  /** いまの鍵で読めて、知っている版であること（読めなければ VaultError。ロックのあとは LOCKED） */
  async #readable(text) {
    if (!this.isOpen) throw new VaultError('LOCKED');
    return VaultData.fromJson(await decryptVault(this.#key, text));
  }

  /**
   * 覚えているファイルの印を取る。無くなっていたら（404）名前で探し直し、別のファイルがあれば、
   * いまの鍵で読めるときだけ乗り換える（作り直された金庫。別のアカウントの別の金庫には乗り換えない）。
   * 乗り換えたら base の版の番号を外すので、必ず「変わった」として比べ直す。
   */
  async #metaOrRelocate(gen) {
    try {
      return await this.#remote.getMeta(this.#fileId);
    } catch (e) {
      if (!(e instanceof DriveNotFound)) throw e;
      const list = await this.#remote.listByName(this.#fileName);
      if (list.length !== 1 || list[0].id === this.#fileId) throw e;
      const f = await this.#fetchStable(list[0]);
      if (!f) throw e;
      try {
        await this.#readable(f.text);
      } catch (e2) {
        // いまの鍵で読めない金庫（別のアカウントの別の金庫など）には乗り換えず、「見つからない」のままにする
        // （画面は「別のアカウントでつないでいませんか？」と案内する）
        if (e2 instanceof VaultError && e2.code === 'LOCKED') throw e2;
        throw e;
      }
      if (this.#alive(gen)) {
        this.#fileId = f.meta.id;
        this.#baseHead = null;
        this.#baseVersion = null;
      }
      return f.meta;
    }
  }

  /** 競合を解くときの「いまの Drive の中身」 */
  async #fetchCurrent(gen) {
    const rm = await this.#metaOrRelocate(gen);
    if (rm.trashed) return out('Trashed');
    const f = await this.#fetchStable(rm);
    return f || out('Busy');
  }

  /**
   * 中身を取ってきて、取る間に書き換えられていないか版の番号で確かめる（最大3回）。
   * 書き換えられ続けたら null。meta はその中身の版の番号。
   */
  async #fetchStable(first) {
    let rm = first;
    for (let i = 0; i < 3; i++) {
      const text = await this.#remote.download(rm.id);
      const after = await this.#remote.getMeta(rm.id);
      if (after.headRevisionId === rm.headRevisionId) return { text, meta: after };
      rm = after;
    }
    return null;
  }

  /**
   * Drive の中身が、最後にそろえたとき（base）から変わったか。
   * headRevisionId（中身が変わると変わる）で決め、version だけ変わったとき（名前を変えた等）は中身を取って比べる（改訂 R-20）。
   */
  async #contentChanged(rm, gen) {
    if (this.#baseHead === null || rm.headRevisionId !== this.#baseHead) return true;
    if (rm.version !== this.#baseVersion) {
      const text = await this.#remote.download(rm.id);
      if (!this.#alive(gen)) return false;
      if (text !== this.#baseText) return true;
      this.#baseVersion = rm.version;
    }
    return false;
  }

  /**
   * 前に送ったとき、返事を受け取れなかった（圏外・混雑）。
   * やみくもに送り直さず、まず Drive の中身が「自分が送ったもの」かを確かめる（§5.3 の 14。push の道でも通す）。
   */
  async #settle(rm, gen) {
    const p = this.#pending;
    if (!p) return false;
    if (rm.headRevisionId === this.#baseHead) { this.#pending = null; return false; }   // 届いていなかった
    const text = await this.#remote.download(rm.id);
    if (!this.#alive(gen)) return false;
    this.#pending = null;
    if (text !== p.text) return false;
    this.#adopt(text, rm, p.data);
    // 送ったあとの編集が残っていれば、まだ送るものがある（同じ中身なら無い）
    this.#dirty = this.#local !== p.data && this.#local.toJson() !== p.data.toJson();
    if (!this.#dirty) this.#local = p.data;
    return true;
  }

  /** §5.3 の 6〜13 */
  async #pushLocked(gen) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.#alive(gen)) return out('Locked');
      if (!this.#dirty) return out('UpToDate');
      // 6. 書く直前に読み直す
      const rm = await this.#metaOrRelocate(gen);
      if (!this.#alive(gen)) return out('Locked');
      if (rm.trashed) return out('Trashed');
      // 14. 前の送信の返事を受け取れていなければ、まずそれを片づける
      if (await this.#settle(rm, gen)) {
        if (!this.#dirty) return out('Uploaded');
        continue;
      }
      // 7. 開いたときから変わっていたら、書かない（第1段階はマージしない）
      if (await this.#contentChanged(rm, gen)) return this.#dirtyConflict(rm, gen);
      if (!this.#alive(gen)) return out('Locked');
      // 上書きの前の確認（改訂 R-12）: いまの Drive の中身（= base）と、手元の鍵の salt・回数が同じこと
      const b = parseOuter(this.#baseText);
      if (b.kdf.salt !== this.#key.saltB64 || b.kdf.iterations !== this.#key.iterations) return out('Refused', { code: 'SALT_CHANGED' });
      const snapshot = this.#local;
      const text = await encryptVault(this.#key, snapshot.toJson());   // 消した鍵なら LOCKED で止まる
      if (!this.#alive(gen)) return out('Locked');
      // 11. 書く（返事が来なかったときのために、送るものを先に覚えておく）
      this.#pending = { text, data: snapshot };
      const um = await this.#remote.update(this.#fileId, text);
      const written = Date.parse(um.modifiedTime);
      if (Number.isFinite(written)) this.#clockSkewMs = this.#now() - written;
      // 12. 検算: いま一番新しいのが自分の書いたものか
      const vm = await this.#remote.getMeta(this.#fileId);
      if (!this.#alive(gen)) return out('Locked');
      if (vm.headRevisionId === um.headRevisionId) {
        this.#adopt(text, vm, snapshot);
        this.#pending = null;
        this.#dirty = this.#local !== snapshot;   // 送っている間に入れた編集は、消さずに残す
        return out('Uploaded');
      }
      // 割り込まれた。自分の版は Drive の「過去の版」に残っている。やり直す（次は 7 で競合になる）
      this.#pending = null;
    }
    return out('Busy');
  }

  /** 失敗 → 結果（Android の SyncEngine.outcomeOf と同じ分け方） */
  async #guard(fn) {
    const gen = this.#gen;
    if (!this.#alive(gen)) return out('Locked');
    try {
      return await fn(gen);
    } catch (e) {
      if (e instanceof VaultError) return e.code === 'LOCKED' ? out('Locked') : out('Refused', { code: e.code });
      const o = driveOutcome(e);
      if (o) return o;
      throw e;
    }
  }
}

/** 通信の失敗 → 結果。通信の失敗でなければ null */
function driveOutcome(e) {
  if (e instanceof DriveNotFound) return out('NoVault');
  if (e instanceof DriveUnauthorized) return out('AuthNeeded');
  if (e instanceof DriveOffline) return out('Offline');
  if (e instanceof DriveBusy) return out('Throttled');
  // 4xx（容量がいっぱい等）は、待っても直らない。「オフライン」とは分けて知らせる（§5.8）
  if (e instanceof DriveHttpError) return e.status >= 400 && e.status < 500 ? out('DriveError', { status: e.status, reason: e.reason }) : out('Offline');
  return null;
}
