'use strict';

// Shown while the bundled engine starts (usually well under a second), and if it fails to start.
const zh = (navigator.language || '').toLowerCase().startsWith('zh');
const text = zh
  ? { starting: '正在启动', failed: 'ShibaSlim 没能启动', hint: '请重新打开试试。如果仍然失败，把上面的信息发给开发者。', empty: '（没有更多信息）' }
  : { starting: 'Starting', failed: 'ShibaSlim could not start', hint: 'Try opening it again. If it still fails, send the details above to the developer.', empty: '(no details)' };

document.documentElement.lang = zh ? 'zh-CN' : 'en';

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('status').textContent = text.starting;
});

// Called by the app (see src-tauri/src/main.rs).
window.showEngineError = (details) => {
  const show = () => {
    document.body.classList.add('error');
    document.getElementById('status').textContent = text.failed;
    document.getElementById('details').textContent = details || text.empty;
    document.getElementById('hint').textContent = text.hint;
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', show);
  else show();
};
