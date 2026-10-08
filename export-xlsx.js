// かぎばこ — 一覧を Excel のファイル（.xlsx）に書き出す（印刷用・縦の A4。改訂 R-25）
//
// ★外の部品を使わず、このファイルだけで作る（.xlsx は、決まった名前の XML をいくつか ZIP にまとめたもの）。
//   パスワードの入ったファイルを作るので、よそのコードを通さない。通信もしない。
// ★値はすべて「文字列」として書く（t="inlineStr"、表示形式も「文字列」）。= で始まるパスワードも式にならず、
//   0 で始まる番号も数に化けない。
// ★XML に書けない文字（制御文字など）は U+FFFD（�）に置き換える。そのまま書くと Excel が「壊れている」と言って開かない。
// ★「_x0041_」のような並びは、Excel が1文字に読み替えてしまう（OOXML の決まり）。先頭の _ を _x005F_ にして、
//   書いたとおりに出るようにする（パスワードに _ や x が入っていても化けない）。
// ★行の高さは、折り返す行数を多めに見積もって決める。Excel は開いたときに高さを測り直さないことがあり、
//   低いままだとパスワードが途中で切れて印刷されるため（広すぎるのは害が無い）。

/** 列（左から）。width は Excel の列幅（標準の文字の幅でいくつ分か） */
export const COLUMNS = [
  { key: 'title', head: 'サイト名', width: 18 },
  { key: 'memo', head: '説明（メモ）', width: 22 },
  { key: 'url', head: 'アドレス（URL）', width: 20 },
  { key: 'loginId', head: 'ID（メールなど）', width: 20 },   // 見出しが1行に収まる長さ
  { key: 'password', head: 'パスワード', width: 24 },
];
const LETTERS = 'ABCDE';
const SHEET = '一覧';
const MAX_CELL = 32767;        // Excel の1つのセルに入る文字数の上限
const LINE_PT = 17;            // 1行ぶんの高さ（ポイント）。游ゴシック 10pt・BIZ UDゴシック 11pt より少し広め
const MAX_ROW_PT = 409;        // Excel の行の高さの上限

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 書き出すファイルの名前（ダウンロードのフォルダに、この名前で入る） */
export function exportFileName(now = new Date(), test = false) {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `かぎばこ一覧_${test ? '試し_' : ''}${d}.xlsx`;
}

// ------------------------------------------------------------------
// 文字の扱い
// ------------------------------------------------------------------

/** セルに入れる文字を整える: 改行をそろえ、Excel の読み替え（_xHHHH_）を防ぎ、長すぎれば切る */
function cellText(s) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_');
  if (t.length > MAX_CELL) t = t.slice(0, MAX_CELL - 20) + '…（長すぎるので以下略）';
  return t;
}

/** XML の文字として書けるようにする（書けない文字は U+FFFD に） */
export function xmlEscape(s) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const ok = cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF) ||
      (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
    if (!ok) out += '�';
    else if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else out += ch;
  }
  return out;
}

/** 全角（漢字・かな・全角の記号・絵文字など）は2、ほかは1として数えた幅 */
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFD);
}

/**
 * 列幅 width のセルで、text が何行に折り返されるか（少し多めに見積もる）。
 * 全角は1文字 2.1 幅（日本語はどこでも折り返せるので、余分な行はほとんど出ない。行頭に来られない「。」などの分だけ見込む）。
 * 半角は1文字 narrow 幅: ふつうの文は 1.15（英語は単語の切れ目で折り返すので、行が増える分も見込む）、
 * パスワードは 1.05（BIZ UDゴシックの半角は1文字ほぼ1幅で、単語の切れ目も無い。20文字が1行に収まる）
 */
export function estimateLines(text, width, narrow = 1.15) {
  const avail = Math.max(1, width - 1.5);
  let lines = 0;
  for (const line of String(text).split('\n')) {
    let w = 0;
    for (const ch of line) w += isWide(ch.codePointAt(0)) ? 2.1 : narrow;
    lines += Math.max(1, Math.ceil(w / avail));
  }
  return lines;
}

const rowHeight = lines => Math.min(MAX_ROW_PT, lines * LINE_PT + 4);

// ------------------------------------------------------------------
// 中身の XML
// ------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function inlineCell(ref, style, text) {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

// 書式の番号（styles.xml の cellXfs の並び）
const S_TITLE = 1, S_HEAD = 2, S_BODY = 3, S_PASSWORD = 4, S_NOTE = 5;

function sheetXml(rows, { title, note, exportedAt }) {
  const last = 3 + rows.length;
  const cols = COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  const out = [];
  out.push(`<row r="1" ht="28" customHeight="1">${inlineCell('A1', S_TITLE, title)}</row>`);
  out.push(`<row r="2" ht="18" customHeight="1">${inlineCell('A2', S_NOTE, note)}</row>`);
  const headLines = Math.max(...COLUMNS.map(c => estimateLines(c.head, c.width)));
  out.push(`<row r="3" ht="${rowHeight(headLines)}" customHeight="1">` +
    COLUMNS.map((c, i) => inlineCell(`${LETTERS[i]}3`, S_HEAD, c.head)).join('') + '</row>');
  rows.forEach((cells, n) => {
    const r = 4 + n;
    const lines = Math.max(...cells.map((t, i) => estimateLines(t, COLUMNS[i].width, COLUMNS[i].key === 'password' ? 1.05 : 1.15)));
    const xml = cells.map((t, i) => {
      const style = COLUMNS[i].key === 'password' ? S_PASSWORD : S_BODY;
      // 空のセルも枠線を引くために、書式だけのセルを置く
      return t === '' ? `<c r="${LETTERS[i]}${r}" s="${style}"/>` : inlineCell(`${LETTERS[i]}${r}`, style, t);
    }).join('');
    out.push(`<row r="${r}" ht="${rowHeight(lines)}" customHeight="1">${xml}</row>`);
  });
  const foot = `&amp;L${xmlEscape('書き出し ' + exportedAt)}&amp;C&amp;P / &amp;N&amp;R${xmlEscape('取り扱い注意')}`;
  return XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:E${last}"/>` +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A4" sqref="A4"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="17"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${out.join('')}</sheetData>` +
    '<mergeCells count="2"><mergeCell ref="A1:E1"/><mergeCell ref="A2:E2"/></mergeCells>' +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    // 9 = A4、縦。横は1ページに収め（fitToWidth=1）、縦は何ページでも（fitToHeight=0）
    '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' +
    // 1枚目は上に表題があるので、ページの上の見出しは2枚目から
    `<headerFooter differentFirst="1"><oddHeader>&amp;C${xmlEscape(title)}</oddHeader>` +
    `<oddFooter>${foot}</oddFooter><firstFooter>${foot}</firstFooter></headerFooter>` +
    '</worksheet>';
}

const FONT_JA = '<name val="游ゴシック"/><family val="3"/><charset val="128"/>';
const STYLES_XML = XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="5">' +
  `<font><sz val="10"/>${FONT_JA}</font>` +                                    // 0 ふつう
  `<font><b/><sz val="14"/>${FONT_JA}</font>` +                                // 1 表題
  `<font><b/><sz val="10"/>${FONT_JA}</font>` +                                // 2 見出し
  // 3 パスワード: BIZ UDゴシック（半角が等幅で、0 と O・1 と l などが見分けやすい）
  '<font><sz val="11"/><name val="BIZ UDゴシック"/><family val="3"/><charset val="128"/></font>' +
  `<font><sz val="9"/><color rgb="FF9F1239"/>${FONT_JA}</font>` +              // 4 注意書き
  '</fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right>' +
  '<top style="thin"><color rgb="FF808080"/></top><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="6">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
  '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  // 49 = 表示形式「文字列」（あとで書き換えても、数や日付に化けない）
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
  '<alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="49" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' +
  '<alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const CONTENT_TYPES_XML = XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS_XML = XML_HEAD +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELS_XML = XML_HEAD +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS_R}/styles" Target="styles.xml"/>` +
  '</Relationships>';

const WORKBOOK_XML = XML_HEAD +
  `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}">` +
  `<sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/></sheets>` +
  // 印刷すると、どのページにも3行目（列の見出し）が出る
  `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${SHEET}'!$3:$3</definedName></definedNames>` +
  '</workbook>';

// ------------------------------------------------------------------
// ZIP（圧縮しない「格納」だけ。.xlsx の入れ物として Excel が読める最小の形）
// ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files, date) {
  const enc = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF;
  const day = (((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);    // 署名
    lv.setUint16(4, 20, true);            // 読むのに要る版（2.0）
    lv.setUint16(6, 0, true);             // 旗
    lv.setUint16(8, 0, true);             // 0 = 圧縮しない
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);       // このファイルの頭の位置（ほかの欄は 0）
    cd.set(name, 46);
    parts.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const part of [...parts, ...central, end]) { out.set(part, p); p += part.length; }
  return out;
}

// ------------------------------------------------------------------
// 入口
// ------------------------------------------------------------------

/**
 * 項目の一覧から .xlsx のバイト列を作る。
 * @param items  { title, memo, url, loginId, password } の配列（並べ替えは呼ぶ側で。消した項目は入れないこと）
 * @param now    書き出した時刻（表題とページの下に出す）
 * @param test   試しの金庫なら true（表題に「試し」と出す）
 */
export function buildXlsx(items, { now = new Date(), test = false } = {}) {
  const exportedAt = stamp(now);
  const name = test ? 'かぎばこ　パスワード一覧（試しの金庫）' : 'かぎばこ　パスワード一覧';
  const title = `${name}　${exportedAt} 現在・${items.length} 件`;
  // 1行に収まる長さにする（この行は折り返さない）
  const note = '取り扱い注意：パスワードがそのまま書かれています。人に見られない場所に保管してください。';
  const rows = items.map(it => COLUMNS.map(c => cellText(it[c.key])));
  const enc = new TextEncoder();
  const files = [
    ['[Content_Types].xml', CONTENT_TYPES_XML],
    ['_rels/.rels', ROOT_RELS_XML],
    ['xl/workbook.xml', WORKBOOK_XML],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML],
    ['xl/styles.xml', STYLES_XML],
    ['xl/worksheets/sheet1.xml', sheetXml(rows, { title, note, exportedAt })],
  ].map(([n, text]) => ({ name: n, data: enc.encode(text) }));
  return zipStore(files, now);
}
