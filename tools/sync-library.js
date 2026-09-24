#!/usr/bin/env node
/* 单向同步：shared/library.json  →  web/js/library-data.js
 *
 * shared/library.json 是棋谱库的唯一数据源（iOS 端从 bundle 直接读它），
 * 网页端因为要支持 file:// 直接打开、不能用 fetch，所以由本脚本生成一份 JS 常量。
 * 改完棋谱后运行：  node tools/sync-library.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jsonPath = path.join(root, 'shared', 'library.json');
const outPath = path.join(root, 'web', 'js', 'library-data.js');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

/* ⚠️ 这里用**紧凑** JSON（不带缩进）而不是 `null, 2`。
 * 原因：导入公开题库之后 mates 有 456 条，带缩进的输出约 240 KB，
 * 而这个文件是网页首屏必须加载的；紧凑后约 120 KB（gzip 后 ~30 KB）。
 * 可读性由源头 `shared/library.json` 保证（它仍然是缩进格式，也仍然是唯一数据源），
 * 这个文件是派生产物、不进人工编辑流程，所以紧凑是对的。
 * 代价：它的 git diff 会是一整行 —— 真要 review 改了什么，去看 library.json。 */
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
  '  if (typeof module !== \'undefined\' && module.exports) module.exports = LIB;',
  '})(typeof globalThis !== \'undefined\' ? globalThis : this);',
  ''
].join('\n');

fs.writeFileSync(outPath, header);

const counts = {
  mates: data.mates.length,
  openings: data.openings.length,
  studies: data.studies.length
};
console.log('已生成 web/js/library-data.js（' + fs.statSync(outPath).size + ' 字节）');
console.log('  杀法 ' + counts.mates + ' 条，开局 ' + counts.openings + ' 条，残局 ' + counts.studies + ' 条');
