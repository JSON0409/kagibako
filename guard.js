// かぎばこ — 枠（iframe）への埋め込みを拒む（仕様書 改訂 R-2）
//
// https://json0409.github.io の下にあるページは、ブラウザから見ると全部「同じ家」になる。
// 別のページに、このページを枠ごと埋め込まれて中身を覗かれないよう、埋め込まれていたら中身を消して止まる。
// （本当は HTTP の frame-ancestors で止めたいが、GitHub Pages では設定できず、<meta> では効かない）
//
// ★どのページでも、<head> の中で、ほかのスクリプトより先に読み込むこと。
// ★中身を消すだけではだめ。このスクリプトが動く時点では <body> がまだ読み込まれておらず、
//   消したあとでブラウザが本文を読み進めて表示してしまう（2026-10-01 に実際に起きた）。
//   window.stop() で読み込みそのものを止める。そのあとのスクリプト（アプリ本体）も動かなくなる。
if (window.top !== window.self) {
  try { window.stop(); } catch (e) { /* 止められなくても下で消す */ }
  document.documentElement.replaceChildren();
  // 念のため、読み込みが止まらなかった場合も、本文ができた時点でもう一度消す
  document.addEventListener('DOMContentLoaded', () => document.documentElement.replaceChildren());
  throw new Error('かぎばこは枠の中では動きません');
}
