// かぎばこ — Google ドライブとのやりとり（ウェブ版。仕様書 §5.1・§6.2）
//
// Drive の REST を fetch で直接たたく（gapi も Drive の JS 部品も使わない）。
// Android の HttpDriveRemote.kt と同じ呼び方・同じ失敗の分け方にしてある。
//
// ★ウェブではアクセストークンを「画面を出さずに」取り直せない（GIS の決まり。§6.2）。
//   だから 401 のときは取り直さずに DriveUnauthorized を投げ、画面に「つなぎ直す」ボタンを出してもらう。

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
// ★fields を必ず付ける。付けないと headRevisionId も version も返ってこない（§5.0）
const FIELDS = 'id,name,version,headRevisionId,modifiedTime,createdTime,size,trashed';
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const TIMEOUT_MS = 30_000;

/** ファイルが無い、または、このアプリから触れない（404 / 403 appNotAuthorizedToFile） */
export class DriveNotFound extends Error { constructor(m = 'ファイルが見つかりません') { super(m); this.name = 'DriveNotFound'; } }
/** Google とのつながりが切れた（トークンが無い・切れた・401） */
export class DriveUnauthorized extends Error { constructor(m = 'Google とのつながりが切れました') { super(m); this.name = 'DriveUnauthorized'; } }
/** つながらない（圏外・時間切れ） */
export class DriveOffline extends Error { constructor(m = 'インターネットにつながっていません') { super(m); this.name = 'DriveOffline'; } }
/** Google が混み合っている・Google 側の故障（429・5xx・403 の混雑）。待てば直る */
export class DriveBusy extends Error {
  constructor(status) { super(`Google が混み合っています（HTTP ${status}）`); this.name = 'DriveBusy'; this.status = status; }
}
/** そのほかの失敗（status は HTTP の番号、reason は Drive が返した理由。例: storageQuotaExceeded） */
export class DriveHttpError extends Error {
  constructor(status, reason) { super(`Drive が HTTP ${status} を返しました（${reason}）`); this.name = 'DriveHttpError'; this.status = status; this.reason = reason; }
}

/** Drive の返事 → ファイルの印（version と size は文字列で返ってくる） */
function parseMeta(o) {
  if (!o || typeof o.id !== 'string') throw new DriveOffline('Drive の返事に id が無い');
  const version = Number(o.version);
  if (!Number.isFinite(version) || typeof o.headRevisionId !== 'string') throw new DriveOffline('Drive の返事に版の番号が無い');
  return {
    id: o.id,
    name: String(o.name ?? ''),
    version,
    headRevisionId: o.headRevisionId,
    modifiedTime: String(o.modifiedTime ?? ''),
    createdTime: String(o.createdTime ?? ''),
    size: Number(o.size ?? 0),
    trashed: o.trashed === true,
  };
}

export class HttpDriveRemote {
  /**
   * @param getToken () => string  いまのアクセストークン。無い・切れていれば DriveUnauthorized を投げる
   * @param sleep   待つ関数（テストで差し替える）
   */
  constructor(getToken, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    this.getToken = getToken;
    this.sleep = sleep;
  }

  async getMeta(fileId) {
    return parseMeta(await this.#send(`${API}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}`, { method: 'GET' }, 'json'));
  }

  async download(fileId) {
    return this.#send(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' }, 'text');
  }

  async update(fileId, content) {
    const url = `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&keepRevisionForever=true&fields=${FIELDS}`;
    // ★書き込みは、混み合っていても自分では送り直さない（改訂 R-22）。待っている間にほかの端末が書いたものを、
    //   「書く直前の読み直し」を通さずに上書きしてしまうため。送り直すかどうかは、同期の手順（読み直し → 書く）に任せる
    return parseMeta(await this.#send(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(content),
    }, 'json', false));
  }

  async listByName(name) {
    // 名前に ' や \ が入ると q の書き方が壊れるので、逃がしてから入れる
    const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(`name='${escaped}' and trashed=false`);
    const r = await this.#send(`${API}/files?q=${q}&spaces=drive&pageSize=10&fields=files(${FIELDS})`, { method: 'GET' }, 'json');
    return Array.isArray(r.files) ? r.files.map(parseMeta) : [];
  }

  /**
   * 1回の呼び出し。
   *   401 → DriveUnauthorized（ウェブは画面なしで取り直せない）
   *   404・403 appNotAuthorizedToFile → DriveNotFound
   *   429・5xx・403 の混雑 → 読むときだけ、だんだん待ち時間を伸ばして3回までやり直す（乱数の揺らぎを入れる。§5.8）。
   *                          それでもだめなら（書き込みはすぐに）DriveBusy
   *   つながらない・30秒たっても返事が無い → DriveOffline
   */
  async #send(url, init, as, retry = true) {
    for (let attempt = 0; ; attempt++) {
      const token = this.getToken();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res, body;
      try {
        res = await fetch(url, {
          ...init,
          headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
          cache: 'no-store',          // ★古い中身をブラウザの控えから返されないように
          signal: ctl.signal,
        });
        body = await res.text();
      } catch (e) {
        throw new DriveOffline(e && e.name === 'AbortError' ? '返事がありません（30秒）' : 'インターネットにつながっていません');
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        if (as === 'text') return body;
        try { return JSON.parse(body); } catch (e) { throw new DriveOffline('Drive の返事が読めません'); }
      }
      const reason = reasonOf(body);
      if (res.status === 401) throw new DriveUnauthorized();
      if (res.status === 404 || (res.status === 403 && reason === 'appNotAuthorizedToFile')) throw new DriveNotFound();
      const busy = res.status === 429 || res.status >= 500 || (res.status === 403 && RATE_REASONS.has(reason));
      if (busy && retry && attempt < 3) {
        const jitter = new Uint32Array(1); crypto.getRandomValues(jitter);
        await this.sleep(Math.min((1 << attempt) * 1000 + (jitter[0] % 1000), 32_000));
        continue;
      }
      if (busy) throw new DriveBusy(res.status);
      throw new DriveHttpError(res.status, reason);
    }
  }
}

function reasonOf(body) {
  try {
    const e = JSON.parse(body).error;
    return e?.errors?.[0]?.reason ?? null;
  } catch (e) {
    return null;
  }
}
