/**
 * Generates the script string to inject the Opscode floating Shadow DOM widget.
 * Uses an isolated shadow root attached to #opscode-recording-sidebar-root.
 */
export function getSidebarInjectionScript() {
  return `
(function() {
  if (document.getElementById('opscode-recording-sidebar-root')) return;

  const host = document.createElement('div');
  host.id = 'opscode-recording-sidebar-root';
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:none;';
  (document.body || document.documentElement).appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = \`
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .widget-container {
      width: 320px;
      max-height: 480px;
      background: #18181b;
      color: #f4f4f5;
      border: 1px solid #3f3f46;
      border-radius: 12px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 13px;
      pointer-events: auto;
      transition: all 0.2s ease-in-out;
    }
    .widget-container.minimized {
      width: auto;
      border-radius: 9999px;
    }
    .widget-header {
      padding: 10px 14px;
      background: #27272a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #3f3f46;
      cursor: grab;
      user-select: none;
    }
    .widget-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13px;
      color: #fafafa;
    }
    .rec-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      animation: pulse 1.5s infinite;
    }
    .rec-dot.paused {
      background: #eab308;
      animation: none;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    }
    .step-badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      background: #3f3f46;
      color: #d4d4d8;
    }
    .btn-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #a1a1aa;
      border-radius: 6px;
      padding: 4px 6px;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .icon-btn:hover {
      background: #3f3f46;
      color: #f4f4f5;
    }
    .icon-btn.stop {
      color: #f87171;
    }
    .icon-btn.stop:hover {
      background: #7f1d1d;
      color: #fee2e2;
    }
    .widget-body {
      flex: 1;
      max-height: 280px;
      overflow-y: auto;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #18181b;
    }
    .widget-container.minimized .widget-body,
    .widget-container.minimized .widget-footer {
      display: none;
    }
    .step-card {
      padding: 6px 8px;
      background: #27272a;
      border-radius: 6px;
      border-left: 3px solid #3b82f6;
      font-size: 12px;
      line-height: 1.3;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .step-card.click { border-left-color: #10b981; }
    .step-card.fill { border-left-color: #8b5cf6; }
    .step-card.goto { border-left-color: #3b82f6; }
    .step-card.scroll { border-left-color: #64748b; }
    .step-card.assert { border-left-color: #f59e0b; }
    .step-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #71717a;
      font-size: 10px;
      text-transform: uppercase;
      font-weight: 700;
    }
    .step-desc {
      color: #e4e4e7;
      word-break: break-word;
    }
    .widget-footer {
      padding: 8px 12px;
      background: #27272a;
      border-top: 1px solid #3f3f46;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .primary-btn {
      flex: 1;
      background: #dc2626;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: background 0.15s;
    }
    .primary-btn:hover {
      background: #b91c1c;
    }
    .secondary-btn {
      background: #3f3f46;
      color: #f4f4f5;
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s;
    }
    .secondary-btn:hover {
      background: #52525b;
    }
  \`;
  shadow.appendChild(style);

  const container = document.createElement('div');
  container.className = 'widget-container';
  container.innerHTML = \`
    <div class="widget-header">
      <div class="widget-title">
        <span class="rec-dot" id="opscode-rec-dot"></span>
        <span>Opscode Recorder</span>
        <span class="step-badge" id="opscode-step-count">0 steps</span>
      </div>
      <div class="btn-group">
        <button class="icon-btn" id="opscode-btn-pause" title="Pause / Resume">⏸</button>
        <button class="icon-btn" id="opscode-btn-min" title="Minimize / Expand">_</button>
      </div>
    </div>
    <div class="widget-body" id="opscode-step-list">
      <div style="color:#71717a; text-align:center; padding:12px 0;">Interact with the page to record steps...</div>
    </div>
    <div class="widget-footer">
      <button class="secondary-btn" id="opscode-btn-undo" title="Undo last step">↩ Undo</button>
      <button class="primary-btn" id="opscode-btn-stop" title="Stop & Save recording">⏹ Stop & Save</button>
    </div>
  \`;
  shadow.appendChild(container);

  // Widget event hooks
  const dot = shadow.getElementById('opscode-rec-dot');
  const countBadge = shadow.getElementById('opscode-step-count');
  const stepList = shadow.getElementById('opscode-step-list');
  const btnPause = shadow.getElementById('opscode-btn-pause');
  const btnMin = shadow.getElementById('opscode-btn-min');
  const btnUndo = shadow.getElementById('opscode-btn-undo');
  const btnStop = shadow.getElementById('opscode-btn-stop');

  let isPaused = false;
  let isMinimized = false;

  btnPause.addEventListener('click', (e) => {
    e.stopPropagation();
    isPaused = !isPaused;
    dot.classList.toggle('paused', isPaused);
    btnPause.textContent = isPaused ? '▶' : '⏸';
    if (window.opscodeSidebarAction) {
      window.opscodeSidebarAction({ type: isPaused ? 'pause' : 'resume' });
    }
  });

  btnMin.addEventListener('click', (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    container.classList.toggle('minimized', isMinimized);
    btnMin.textContent = isMinimized ? '□' : '_';
  });

  btnUndo.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.opscodeSidebarAction) {
      window.opscodeSidebarAction({ type: 'undo' });
    }
  });

  btnStop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.opscodeSidebarAction) {
      window.opscodeSidebarAction({ type: 'stop' });
    }
  });

  // Expose UI updater for recorder
  window.__opscodeUpdateSidebar = function(steps, paused) {
    if (typeof paused === 'boolean') {
      isPaused = paused;
      dot.classList.toggle('paused', isPaused);
      btnPause.textContent = isPaused ? '▶' : '⏸';
    }
    const total = steps ? steps.length : 0;
    countBadge.textContent = total + (total === 1 ? ' step' : ' steps');

    if (!steps || steps.length === 0) {
      stepList.innerHTML = '<div style="color:#71717a; text-align:center; padding:12px 0;">Interact with the page to record steps...</div>';
      return;
    }

    stepList.innerHTML = steps.map((s, idx) => {
      const act = (s.action || 'step').toLowerCase();
      const desc = s.description || (s.action + ' ' + (s.selector || ''));
      return \`
        <div class="step-card \${act}">
          <div class="step-meta">
            <span>#\${idx + 1} \${act}</span>
          </div>
          <div class="step-desc">\${desc.replace(/</g, '&lt;')}</div>
        </div>
      \`;
    }).join('');
    stepList.scrollTop = stepList.scrollHeight;
  };
})();
`;
}
