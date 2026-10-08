// かぎばこ — Google との接続の設定（ウェブ版）
//
// ここに書くのは、すべて「公開してよい」値。GitHub Pages で誰でも見られる前提で置いている。
// ★クライアントシークレットは、ここにも、どこにも書かないこと（ウェブ版では使わない）。
//
// 2026-10-01 に Google Cloud で作ったもの（プロジェクト kagibako / son.j49@gmail.com）。
// Android 用のクライアントは、パッケージ名と署名の SHA-1 で見分けられるので、アプリの中に ID を書く必要はない。

// ウェブ用の OAuth クライアント ID（種類: ウェブ アプリケーション、名前: kagibako-web）
// 承認済みの JavaScript 生成元: https://json0409.github.io と http://localhost:8080
export const GOOGLE_CLIENT_ID = '832927099352-p1bmshp95pligl243fqhegr5k0rnt451.apps.googleusercontent.com';

// Google Cloud のプロジェクト番号。Google Picker の setAppId に渡す（仕様書 §5.2 の3）
export const GOOGLE_PROJECT_NUMBER = '832927099352';

// 使う権限はこれ1つだけ（このアプリが作ったファイルだけを読み書きできる）
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
