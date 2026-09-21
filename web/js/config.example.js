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

    /* 这两个模型是推理模型，思维链会计入 max_tokens，而思维链长度波动很大
       （同一个任务从几千到上万 token 都有）。max_tokens 只是上限、不按它计费，
       所以直接给足 5 万：既不会因为预算不够导致正文为空，也不会多花钱。 */
    maxTokens: 50000,
    timeoutMs: 180000
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CONFIG;
  root.XQ_CONFIG = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
