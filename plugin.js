/**
 * ============================================================
 *  Roche 后台保活插件 v2.0.0
 *
 *  核心方案：APK 原生前台 Service（nativeAudioBridge）
 *  备用方案：Web 静默音频循环（无 APK 时自动启用）
 *
 *  - 有 APK → 原生 Service 保活，通知栏显示"正在播放"，最稳定
 *  - 无 APK → 自动降级为 Web Audio / HTML5 Audio 静默循环
 *  - 两种 APK 打包方式都支持原生保活
 * ============================================================
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'keepalive_enabled';

  function $id(id) { return document.getElementById(id); }

  // ========== 环境检测 ==========

  function hasNativeAudio() {
    try { return !!(window.nativeAudioBridge && window.nativeAudioBridge.__ready); } catch (e) { return false; }
  }

  function hasWebAudio() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  // ========== 原生 Audio Bridge（APK 保活，核心方案） ==========

  var SILENCE_URL = 'https://raw.githubusercontent.com/yechen1844/char-task-monitor/main/silence.wav';

  async function startNativeKeepAlive() {
    if (!hasNativeAudio()) return false;
    try {
      await window.nativeAudioBridge.replaceQueue([{
        id: 'keepalive',
        title: 'Roche保活',
        artist: '',
        cover: '',
        url: SILENCE_URL
      }], 0, 'loop', true);
      return true;
    } catch (e) {
      console.warn('[KeepAlive] 原生保活启动失败:', e);
      return false;
    }
  }

  async function stopNativeKeepAlive() {
    if (!hasNativeAudio()) return;
    try { await window.nativeAudioBridge.stop(); } catch (e) { /* ignore */ }
  }

  // ========== Web Audio 静默音频（备用方案） ==========

  var _audioCtx = null;
  var _silentSource = null;
  var _heartbeatInterval = null;
  var _htmlAudio = null;
  var _htmlAudioInterval = null;
  var _keepAliveRunning = false;

  function createSilentWavBlob() {
    var sampleRate = 8000;
    var numSamples = sampleRate;
    var dataSize = numSamples * 2;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeString(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    for (var i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, 0, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function startWebAudioKeepAlive() {
    if (!hasWebAudio()) return false;
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      _audioCtx = new AudioCtx();

      var sampleRate = _audioCtx.sampleRate;
      var duration = 2;
      var buffer = _audioCtx.createBuffer(1, sampleRate * duration, sampleRate);

      _silentSource = _audioCtx.createBufferSource();
      _silentSource.buffer = buffer;
      _silentSource.loop = true;
      _silentSource.connect(_audioCtx.destination);
      _silentSource.start();

      _heartbeatInterval = setInterval(function () {
        if (_audioCtx && _audioCtx.state === 'suspended') {
          _audioCtx.resume();
        }
      }, 30000);

      return true;
    } catch (e) {
      console.warn('[KeepAlive] Web Audio 启动失败:', e);
      return false;
    }
  }

  function stopWebAudioKeepAlive() {
    try {
      if (_silentSource) { _silentSource.stop(); _silentSource.disconnect(); _silentSource = null; }
      if (_audioCtx) { _audioCtx.close(); _audioCtx = null; }
    } catch (e) { /* ignore */ }
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
  }

  // HTML5 Audio 备用
  function startHtmlAudioKeepAlive() {
    try {
      var blob = createSilentWavBlob();
      var url = URL.createObjectURL(blob);

      _htmlAudio = new Audio(url);
      _htmlAudio.loop = true;
      _htmlAudio.volume = 0.01;
      _htmlAudio.play().catch(function () {});

      _htmlAudioInterval = setInterval(function () {
        if (_htmlAudio && _htmlAudio.paused) {
          _htmlAudio.play().catch(function () {});
        }
      }, 25000);

      return true;
    } catch (e) {
      console.warn('[KeepAlive] HTML Audio 启动失败:', e);
      return false;
    }
  }

  function stopHtmlAudioKeepAlive() {
    try {
      if (_htmlAudio) { _htmlAudio.pause(); _htmlAudio.src = ''; _htmlAudio = null; }
    } catch (e) { /* ignore */ }
    if (_htmlAudioInterval) { clearInterval(_htmlAudioInterval); _htmlAudioInterval = null; }
  }

  // ========== 统一启停 ==========

  async function startKeepAlive() {
    _keepAliveRunning = true;

    // 优先使用 APK 原生保活
    if (hasNativeAudio()) {
      var ok = await startNativeKeepAlive();
      if (ok) return true;
    }

    // 无 APK 或原生启动失败，降级为 Web 保活
    var ok2 = await startWebAudioKeepAlive();
    if (ok2) return true;

    return startHtmlAudioKeepAlive();
  }

  async function stopKeepAlive() {
    _keepAliveRunning = false;
    await stopNativeKeepAlive();
    stopWebAudioKeepAlive();
    stopHtmlAudioKeepAlive();
  }

  // ========== Storage 辅助 ==========

  function storageGet(roche, key, fallback) {
    try {
      return roche.storage.get(key).then(function (v) {
        return v !== null && v !== undefined ? v : fallback;
      }).catch(function () { return fallback; });
    } catch (e) { return Promise.resolve(fallback); }
  }

  function storageSet(roche, key, value) {
    try { return roche.storage.set(key, value); } catch (e) { return Promise.resolve(); }
  }

  // ========== CSS ==========

  function getCSS() {
    return '.roche-plugin-keepalive{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e0e0e0;background:#1a1a2e;min-height:100vh;padding:0;box-sizing:border-box}.roche-plugin-keepalive *,.roche-plugin-keepalive *::before,.roche-plugin-keepalive *::after{box-sizing:border-box}.ka-header{display:flex;align-items:center;justify-content:space-between;padding:16px;background:#16213e;border-bottom:1px solid #0f3460}.ka-title{margin:0;font-size:18px;font-weight:600}.ka-close{background:none;border:1px solid #0f3460;color:#e0e0e0;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1}.ka-close:hover{background:#0f3460}.ka-body{padding:20px 16px}.ka-card{background:#16213e;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #0f3460}.ka-card h3{margin:0 0 8px;font-size:16px;color:#4ecca3}.ka-card p{margin:0 0 12px;font-size:13px;color:#aaa;line-height:1.6}.ka-status{display:flex;align-items:center;gap:12px;margin-bottom:20px}.ka-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}.ka-dot-on{background:#4ecca3;box-shadow:0 0 8px #4ecca3}.ka-dot-off{background:#555}.ka-status-text{font-size:15px;font-weight:500}.ka-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:16px;background:#16213e;border-radius:12px;border:1px solid #0f3460;margin-bottom:16px}.ka-toggle-label{font-size:15px;font-weight:500}.ka-toggle{position:relative;width:52px;height:28px;cursor:pointer}.ka-toggle input{opacity:0;width:0;height:0}.ka-toggle-slider{position:absolute;inset:0;background:#333;border-radius:14px;transition:background .3s}.ka-toggle-slider::before{content:"";position:absolute;width:22px;height:22px;left:3px;top:3px;background:#e0e0e0;border-radius:50%;transition:transform .3s}.ka-toggle input:checked+.ka-toggle-slider{background:#4ecca3}.ka-toggle input:checked+.ka-toggle-slider::before{transform:translateX(24px)}.ka-notice{background:#2c2e20;border:1px solid #4ecca3;border-radius:8px;padding:12px;font-size:12px;color:#aaa;line-height:1.6;margin-bottom:16px}.ka-warn{background:#3d201d;border-color:#e74c3c}.ka-btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background .2s;margin-right:8px}.ka-btn-primary{background:#4ecca3;color:#1a1a2e}.ka-btn-primary:hover{background:#3db88d}.ka-btn-danger{background:#c0392b;color:#e0e0e0}.ka-btn-danger:hover{background:#a93226}.ka-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.ka-info-item{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0f3460;font-size:13px}.ka-info-item:last-child{border-bottom:none}.ka-info-key{color:#888}.ka-info-val{color:#e0e0e0;font-weight:500}.ka-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:6px}.ka-badge-apk{background:#4ecca3;color:#1a1a2e}.ka-badge-web{background:#3498db;color:#fff}.ka-badge-best{background:#f39c12;color:#1a1a2e}.ka-method-label{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:600}';
  }

  // ========== 渲染 ==========

  function renderMain(container, roche) {
    var nativeAudio = hasNativeAudio();
    var webAudio = hasWebAudio();

    storageGet(roche, STORAGE_KEY, false).then(function (enabled) {
      var method = nativeAudio ? 'native' : 'web';

      var h = '<div class="roche-plugin-keepalive">';
      h += '<style>' + getCSS() + '</style>';

      // Header
      h += '<div class="ka-header"><h2 class="ka-title">后台保活</h2><button class="ka-close" id="ka-close">\u2715</button></div>';

      h += '<div class="ka-body">';

      // 状态指示
      h += '<div class="ka-status">';
      h += '<div class="ka-dot ' + (enabled ? 'ka-dot-on' : 'ka-dot-off') + '"></div>';
      h += '<span class="ka-status-text">' + (enabled ? '保活运行中' : '保活未启动') + '</span>';
      h += '</div>';

      // 当前保活方式
      h += '<div class="ka-card">';
      h += '<h3>保活方式</h3>';

      if (nativeAudio) {
        h += '<div class="ka-method-label"><span>原生前台 Service</span><span class="ka-badge ka-badge-apk">APK</span><span class="ka-badge ka-badge-best">推荐</span></div>';
        h += '<p>检测到 APK 环境，使用原生前台 Service 保活。通知栏显示"正在播放"通知，系统不会杀死 Roche。这是最稳定的保活方式。</p>';
      } else {
        h += '<div class="ka-method-label"><span>Web 静默音频</span><span class="ka-badge ka-badge-web">Web</span></div>';
        h += '<p>未检测到 APK 原生插件，自动使用 Web Audio 静默音频循环。让浏览器/WebView 认为正在播放媒体，降低被杀概率。</p>';
        h += '<p style="color:#f39c12">建议：将 Roche 打包为 APK 可获得更稳定的原生保活效果。</p>';
      }

      h += '</div>';

      // 启停开关
      h += '<div class="ka-toggle-row"><span class="ka-toggle-label">启用后台保活</span>';
      h += '<label class="ka-toggle"><input type="checkbox" id="ka-toggle"' + (enabled ? ' checked' : '') + '><span class="ka-toggle-slider"></span></label>';
      h += '</div>';

      // 手动操作
      h += '<div class="ka-actions">';
      h += '<button class="ka-btn ka-btn-primary" id="ka-start">立即启动</button>';
      h += '<button class="ka-btn ka-btn-danger" id="ka-stop">停止保活</button>';
      h += '</div>';

      // 环境信息
      h += '<div class="ka-card"><h3>环境信息</h3>';
      h += '<div class="ka-info-item"><span class="ka-info-key">nativeAudioBridge</span><span class="ka-info-val">' + (nativeAudio ? '已注册' : '未注册') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">Web Audio API</span><span class="ka-info-val">' + (webAudio ? '支持' : '不支持') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">当前保活方式</span><span class="ka-info-val">' + (nativeAudio ? '原生 Service' : 'Web 静默音频') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">保活状态</span><span class="ka-info-val">' + (enabled ? '运行中' : '未启动') + '</span></div>';
      h += '</div>';

      // 原理说明
      h += '<div class="ka-card"><h3>原理说明</h3>';
      h += '<p>Android 会在内存不足时杀死后台应用。本插件通过以下方式防止被杀：</p>';
      h += '<p><b>APK 原生 Service</b>（核心方案）：启动前台 Service + 通知栏通知，Android 不会杀前台 Service 应用。需要 APK 内置 BackgroundAudioPlugin。</p>';
      h += '<p><b>Web 静默音频</b>（备用方案）：循环播放无声音频，浏览器/WebView 认为在播放媒体，降低被杀概率。无需特殊 APK，但效果不如原生方案。</p>';
      h += '</div>';

      // 注意事项
      if (!nativeAudio) {
        h += '<div class="ka-notice ka-warn">当前为 Web 保活模式，效果有限。建议将 Roche 打包为 APK 以获得原生前台 Service 保活。</div>';
      } else {
        h += '<div class="ka-notice">保活运行时通知栏会显示"Roche保活"通知，这是 Android 前台 Service 的要求，无法隐藏。</div>';
      }

      h += '</div>'; // ka-body
      h += '</div>'; // root

      container.innerHTML = h;

      // 绑定事件
      var closeBtn = $id('ka-close');
      if (closeBtn) closeBtn.onclick = function () { roche.ui.closeApp(); };

      var toggle = $id('ka-toggle');
      if (toggle) {
        toggle.onchange = function () {
          if (toggle.checked) {
            startKeepAlive().then(function () {
              storageSet(roche, STORAGE_KEY, true);
              roche.ui.toast('保活已启动 (' + (hasNativeAudio() ? '原生 Service' : 'Web 静默音频') + ')');
              renderMain(container, roche);
            }).catch(function (e) {
              roche.ui.toast('启动失败: ' + e);
              toggle.checked = false;
            });
          } else {
            stopKeepAlive().then(function () {
              storageSet(roche, STORAGE_KEY, false);
              roche.ui.toast('保活已停止');
              renderMain(container, roche);
            });
          }
        };
      }

      var startBtn = $id('ka-start');
      if (startBtn) {
        startBtn.onclick = function () {
          startKeepAlive().then(function () {
            storageSet(roche, STORAGE_KEY, true);
            roche.ui.toast('保活已启动 (' + (hasNativeAudio() ? '原生 Service' : 'Web 静默音频') + ')');
            renderMain(container, roche);
          }).catch(function (e) {
            roche.ui.toast('启动失败: ' + e);
          });
        };
      }

      var stopBtn = $id('ka-stop');
      if (stopBtn) {
        stopBtn.onclick = function () {
          stopKeepAlive().then(function () {
            storageSet(roche, STORAGE_KEY, false);
            roche.ui.toast('保活已停止');
            renderMain(container, roche);
          });
        };
      }

      // 如果之前已启用，自动启动保活
      if (enabled) {
        startKeepAlive().catch(function () {});
      }
    });
  }

  // ============================
  //  插件注册
  // ============================

  window.RochePlugin.register({
    id: 'keepalive',
    name: '后台保活',
    version: '2.0.0',
    apps: [
      {
        id: 'keepalive-home',
        name: '后台保活',
        icon: 'battery_charging_full',
        iconImage: '',
        async mount(container, roche) {
          renderMain(container, roche);
        },
        async unmount(container, roche) {
          container.replaceChildren();
        }
      }
    ]
  });

  console.log('[KeepAlive] 插件已注册 v2.0.0');
  console.log('  保活方式: ' + (hasNativeAudio() ? 'APK 原生 Service (推荐)' : 'Web 静默音频 (备用)'));

})();
