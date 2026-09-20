/* 本地配置模板 —— 复制成 config.js 并填入自己的 Key
 *
 *   cp web/js/config.example.js web/js/config.js
 *
 * config.js 已在 .gitignore 里，不会被提交。
 * 也可以完全不动这个文件，直接在网页的「模型设置」里填，配置会存到浏览器 localStorage。
 */
(function (root) {
  'use strict';

  var CONFIG = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',                       /* ← 在这里填，或者用界面上的「模型设置」 */
    model: 'deepseek-flash',
    knownModels: ['deepseek-flash', 'deepseek-v4-pro'],
    temperature: 0.6,

    /* 这两个模型是推理模型，思维链会计入 max_tokens：
       短点评 2500 够用，整局复盘要 6000~8000，给少了正文会是空的。 */
    maxTokens: 6000,
    timeoutMs: 180000
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
  root.XQ_CONFIG = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
