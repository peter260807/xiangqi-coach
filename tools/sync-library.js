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

const header = [
  '/* 本文件由 tools/sync-library.js 自动生成，请勿手改。',
  ' * 数据源：shared/library.json',
  ' * 重新生成：node tools/sync-library.js',
  ' */',
  '(function (root) {',
  "  'use strict';",
  '  var LIB = ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') + ';',
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
console.log('已生成 web/js/library-data.js');
console.log('  杀法 ' + counts.mates + ' 条，开局 ' + counts.openings + ' 条，残局 ' + counts.studies + ' 条');
