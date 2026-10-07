#!/usr/bin/env node
/* 同步棋谱库：shared/library.json  →  两个消费端
 *
 *   web/js/library-data.js                    网页端
 *       （页面要支持 file:// 直接打开，不能用 fetch，所以做成 JS 常量）
 *   ios/XiangqiCoach/Resources/library.json   iOS 端
 *       （XcodeGen 把 ios/XiangqiCoach 整目录收作源，App 直接从 bundle 读这个文件）
 *   android/app/src/main/assets/library.json  Android 端
 *       （Gradle 把 src/main/assets 打进 APK，App 从 AssetManager 读这个文件）
 *
 * shared/library.json 是棋谱库的唯一数据源。改完棋谱后运行：
 *   node tools/sync-library.js
 *
 * ⚠️ **每一端都必须由这个脚本产出。**
 * 以前这里只生成网页端那份，iOS 那份是手工 cp 进去的「独立副本」，
 * 于是导入 445 道 + 用 Pikafish 又解出 525 道（共 981 道）之后，
 * 网页端有 981 道、iOS 端还停在 11 道 —— 而**所有单测照样全绿**，
 * 因为它们统统只在 bundle 上断言「非空」，恰好那 11 道也非空。
 * 现在 iOS 那份也在同步链里，`LibraryTests.testBundleIsNotTheStaleCopy` 守着它。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jsonPath = path.join(root, 'shared', 'library.json');
const webPath = path.join(root, 'web', 'js', 'library-data.js');
const iosPath = path.join(root, 'ios', 'XiangqiCoach', 'Resources', 'library.json');
const androidPath = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'library.json');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

/* 别把空库推给两端 —— 源头被写坏时宁可报错也别静默覆盖（覆盖了 App 就是空题库） */
if (!Array.isArray(data.mates) || data.mates.length === 0) {
  console.error('shared/library.json 里 mates 是空的，拒绝同步（源头可能被写坏了）');
  process.exit(2);
}

/* ⚠️ 两个产物都用**紧凑** JSON（不带缩进）。
 * 原因：mates 已有 981 条 —— 带缩进的输出约 900 KB，
 *   而 web 那份是网页首屏必须加载的、iOS 那份要打进 App bundle。
 * 可读性由源头 `shared/library.json` 保证（它仍然是缩进格式，也仍然是唯一数据源），
 * 这两个都是派生物、不进人工编辑流程，所以紧凑是对的。
 * 代价：它们的 git diff 会是一整行 —— 真要 review 改了什么，去看 library.json。 */
const json = JSON.stringify(data);

const header = [
  '/* 本文件由 tools/sync-library.js 自动生成，请勿手改。',
  ' * 数据源：shared/library.json（要看差异请 diff 那个文件，这里是紧凑格式）',
  ' * 重新生成：node tools/sync-library.js',
  ' */',
  '(function (root) {',
  "  'use strict';",
  '  var LIB = ' + json + ';',
  '  root.XQ_LIBRARY = LIB;',
  "  if (typeof module !== 'undefined' && module.exports) module.exports = LIB;",
  "})(typeof globalThis !== 'undefined' ? globalThis : this);",
  ''
].join('\n');

fs.writeFileSync(webPath, header);
fs.writeFileSync(iosPath, json + '\n');
fs.mkdirSync(path.dirname(androidPath), { recursive: true });
fs.writeFileSync(androidPath, json + '\n');

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB';
console.log('已同步棋谱库（源 shared/library.json ' + kb(jsonPath) + '）');
console.log('  web/js/library-data.js                   ' + kb(webPath));
console.log('  ios/XiangqiCoach/Resources/library.json  ' + kb(iosPath));
console.log('  android/app/src/main/assets/library.json ' + kb(androidPath));
console.log('  杀法 ' + data.mates.length + ' 条，开局 ' + data.openings.length
  + ' 条，残局 ' + data.studies.length + ' 条，名局 ' + ((data.classics || []).length) + ' 条');
