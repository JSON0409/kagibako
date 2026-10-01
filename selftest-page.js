// かぎばこ — ブラウザの動作テスト画面（selftest.html）を動かす
//
// 中身の判定は selftest-core.js（Node のテストと同じもの）。ここは画面に並べるだけ。

import { runAll } from './selftest-core.js';

const $ = id => document.getElementById(id);

$('env').textContent = `このブラウザ: ${navigator.userAgent}`;

if (!globalThis.crypto || !crypto.subtle) {
  $('summary').textContent = '✗ このページは https（または localhost）で開いたときだけ動きます。';
  $('summary').className = 'summary ng';
  $('run').disabled = true;
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '計算しています…';
  $('rows').replaceChildren();
  $('summary').textContent = '計算しています…（全部で数秒かかります）';
  $('summary').className = 'summary';
  try {
    const res = await fetch('testvectors.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`testvectors.json が読めません（${res.status}）`);
    const vectors = await res.json();
    const s = await runAll(vectors, addRow);
    $('summary').textContent = s.failed === 0
      ? `✓ ${s.total} 件すべて合格しました`
      : `✗ ${s.total} 件中 ${s.failed} 件が不合格です。このブラウザではまだ使わないでください`;
    $('summary').className = 'summary ' + (s.failed === 0 ? 'ok' : 'ng');
    document.body.dataset.result = s.failed === 0 ? 'pass' : 'fail';
    document.body.dataset.passed = String(s.passed);
    document.body.dataset.total = String(s.total);
  } catch (e) {
    $('summary').textContent = `✗ テストを動かせませんでした: ${e.message}`;
    $('summary').className = 'summary ng';
    document.body.dataset.result = 'error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'もう一度';
  }
});

function addRow(r) {
  const tr = document.createElement('tr');
  tr.className = r.ok ? 'ok' : 'ng';
  for (const text of [r.ok ? 'PASS' : 'FAIL', r.group, r.name, `${r.ms}ms`, r.detail]) {
    const td = document.createElement('td');
    td.textContent = text;   // textContent なので、テストの値に何が入っていても HTML として解釈されない
    tr.append(td);
  }
  $('rows').append(tr);
}
