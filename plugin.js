/**
 * ============================================================
 *  Roche 后台保活插件 v1.0.0
 *
 *  纯 Web 方案，无需特殊 APK 打包：
 *  1. Screen Wake Lock API — 防止屏幕关闭时被杀
 *  2. Web Audio API 静默音频循环 — 防止后台被系统回收
 *  3. 原生 nativeAudioBridge（如果可用）— APK 内更稳定
 *
 *  兼容：浏览器 / PWA / 任意 APK / 我们自己的 APK
 * ============================================================
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'keepalive_enabled';
  var WAKELOCK_KEY = 'keepalive_wakelock_mode';

  function $id(id) { return document.getElementById(id); }

  // ========== 环境检测 ==========

  function hasNativeAudio() {
    try { return !!(window.nativeAudioBridge && window.nativeAudioBridge.__ready); } catch (e) { return false; }
  }

  function hasWakeLock() {
    return 'wakeLock' in navigator;
  }

  function hasWebAudio() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  // ========== Wake Lock ==========

  var _wakeLockSentinel = null;

  async function requestWakeLock() {
    if (!hasWakeLock()) return false;
    try {
      _wakeLockSentinel = await navigator.wakeLock.request('screen');
      _wakeLockSentinel.addEventListener('release', function () {
        _wakeLockSentinel = null;
      });
      return true;
    } catch (e) {
      console.warn('[KeepAlive] Wake Lock 请求失败:', e);
      return false;
    }
  }

  async function releaseWakeLock() {
    if (_wakeLockSentinel) {
      await _wakeLockSentinel.release();
      _wakeLockSentinel = null;
    }
  }

  // 页面可见性变化时重新获取 Wake Lock
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && _keepAliveRunning && _wakeLockMode === 'wakelock') {
      requestWakeLock();
    }
  });

  // ========== Web Audio 静默音频 ==========

  var _audioCtx = null;
  var _silentSource = null;
  var _keepAliveRunning = false;
  var _wakeLockMode = 'audio'; // 'audio' | 'wakelock' | 'native'
  var _heartbeatInterval = null;

  function createSilentWavBlob() {
    // 生成 1 秒静默 WAV（16bit PCM, 8000Hz, 单声道）
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

    // 全部填 0（静默）
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

      // 创建静默音频缓冲
      var sampleRate = _audioCtx.sampleRate;
      var duration = 2; // 2 秒循环
      var buffer = _audioCtx.createBuffer(1, sampleRate * duration, sampleRate);
      // 缓冲区默认就是静默的（全 0）

      // 创建循环播放
      _silentSource = _audioCtx.createBufferSource();
      _silentSource.buffer = buffer;
      _silentSource.loop = true;
      _silentSource.connect(_audioCtx.destination);
      _silentSource.start();

      // 心跳：每 30 秒输出一次日志，同时确保 AudioContext 不被回收
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
      if (_silentSource) {
        _silentSource.stop();
        _silentSource.disconnect();
        _silentSource = null;
      }
      if (_audioCtx) {
        _audioCtx.close();
        _audioCtx = null;
      }
    } catch (e) { /* ignore */ }
    if (_heartbeatInterval) {
      clearInterval(_heartbeatInterval);
      _heartbeatInterval = null;
    }
  }

  // ========== HTML5 Audio 静默循环（备用方案） ==========

  var _htmlAudio = null;
  var _htmlAudioInterval = null;

  function startHtmlAudioKeepAlive() {
    try {
      var blob = createSilentWavBlob();
      var url = URL.createObjectURL(blob);

      _htmlAudio = new Audio(url);
      _htmlAudio.loop = true;
      _htmlAudio.volume = 0.01; // 几乎静音但不完全静音（部分浏览器会忽略完全静音）
      _htmlAudio.play().catch(function () {});

      // 备用：每 25 秒重新播放一次，防止被暂停
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
      if (_htmlAudio) {
        _htmlAudio.pause();
        _htmlAudio.src = '';
        _htmlAudio = null;
      }
    } catch (e) { /* ignore */ }
    if (_htmlAudioInterval) {
      clearInterval(_htmlAudioInterval);
      _htmlAudioInterval = null;
    }
  }

  // ========== 原生 Audio Bridge（APK 专用） ==========

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

  // ========== 统一启停 ==========

  async function startKeepAlive(mode) {
    _keepAliveRunning = true;
    _wakeLockMode = mode;

    if (mode === 'native') {
      return await startNativeKeepAlive();
    } else if (mode === 'wakelock') {
      var ok = await requestWakeLock();
      if (!ok) {
        // Wake Lock 不可用，回退到音频
        _wakeLockMode = 'audio';
        return startHtmlAudioKeepAlive();
      }
      return true;
    } else {
      // 默认音频模式：优先 Web Audio，备用 HTML Audio
      var ok2 = await startWebAudioKeepAlive();
      if (!ok2) {
        return startHtmlAudioKeepAlive();
      }
      return true;
    }
  }

  async function stopKeepAlive() {
    _keepAliveRunning = false;
    await releaseWakeLock();
    stopWebAudioKeepAlive();
    stopHtmlAudioKeepAlive();
    await stopNativeKeepAlive();
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
    return '.roche-plugin-keepalive{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e0e0e0;background:#1a1a2e;min-height:100vh;padding:0;box-sizing:border-box}.roche-plugin-keepalive *,.roche-plugin-keepalive *::before,.roche-plugin-keepalive *::after{box-sizing:border-box}.ka-header{display:flex;align-items:center;justify-content:space-between;padding:16px;background:#16213e;border-bottom:1px solid #0f3460}.ka-title{margin:0;font-size:18px;font-weight:600}.ka-close{background:none;border:1px solid #0f3460;color:#e0e0e0;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1}.ka-close:hover{background:#0f3460}.ka-body{padding:20px 16px}.ka-card{background:#16213e;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #0f3460}.ka-card h3{margin:0 0 8px;font-size:16px;color:#4ecca3}.ka-card p{margin:0 0 12px;font-size:13px;color:#aaa;line-height:1.6}.ka-status{display:flex;align-items:center;gap:12px;margin-bottom:20px}.ka-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}.ka-dot-on{background:#4ecca3;box-shadow:0 0 8px #4ecca3}.ka-dot-off{background:#555}.ka-status-text{font-size:15px;font-weight:500}.ka-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:16px;background:#16213e;border-radius:12px;border:1px solid #0f3460;margin-bottom:16px}.ka-toggle-label{font-size:15px;font-weight:500}.ka-toggle{position:relative;width:52px;height:28px;cursor:pointer}.ka-toggle input{opacity:0;width:0;height:0}.ka-toggle-slider{position:absolute;inset:0;background:#333;border-radius:14px;transition:background .3s}.ka-toggle-slider::before{content:"";position:absolute;width:22px;height:22px;left:3px;top:3px;background:#e0e0e0;border-radius:50%;transition:transform .3s}.ka-toggle input:checked+.ka-toggle-slider{background:#4ecca3}.ka-toggle input:checked+.ka-toggle-slider::before{transform:translateX(24px)}.ka-notice{background:#2c2e20;border:1px solid #4ecca3;border-radius:8px;padding:12px;font-size:12px;color:#aaa;line-height:1.6;margin-bottom:16px}.ka-warn{background:#3d201d;border-color:#e74c3c}.ka-btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background .2s;margin-right:8px}.ka-btn-primary{background:#4ecca3;color:#1a1a2e}.ka-btn-primary:hover{background:#3db88d}.ka-btn-danger{background:#c0392b;color:#e0e0e0}.ka-btn-danger:hover{background:#a93226}.ka-btn-outline{background:transparent;color:#4ecca3;border:1px solid #4ecca3}.ka-btn-outline:hover{background:rgba(78,204,163,0.1)}.ka-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.ka-info-item{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0f3460;font-size:13px}.ka-info-item:last-child{border-bottom:none}.ka-info-key{color:#888}.ka-info-val{color:#e0e0e0;font-weight:500}.ka-mode-select{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}.ka-mode-btn{padding:8px 16px;border-radius:8px;border:1px solid #0f3460;background:transparent;color:#aaa;cursor:pointer;font-size:13px;transition:all .2s}.ka-mode-btn.active{border-color:#4ecca3;color:#4ecca3;background:rgba(78,204,163,0.1)}.ka-mode-btn:hover{border-color:#4ecca3}.ka-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:6px}.ka-tag-native{background:#4ecca3;color:#1a1a2e}.ka-tag-web{background:#3498db;color:#fff}.ka-tag-best{background:#f39c12;color:#1a1a2e}';
  }

  // ========== 渲染 ==========

  function renderMain(container, roche) {
    var nativeAudio = hasNativeAudio();
    var wakeLock = hasWakeLock();
    var webAudio = hasWebAudio();

    Promise.all([
      storageGet(roche, STORAGE_KEY, false),
      storageGet(roche, WAKELOCK_KEY, nativeAudio ? 'native' : 'audio')
    ]).then(function (vals) {
      var enabled = vals[0];
      var mode = vals[1];

      // 自动选择最佳模式
      if (nativeAudio && mode !== 'native') mode = 'native';
      if (!nativeAudio && mode === 'native') mode = wakeLock ? 'wakelock' : 'audio';

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

      // 模式选择
      h += '<div class="ka-card">';
      h += '<h3>保活模式</h3>';
      h += '<p>选择适合当前环境的保活方式：</p>';
      h += '<div class="ka-mode-select">';

      if (nativeAudio) {
        h += '<button class="ka-mode-btn' + (mode === 'native' ? ' active' : '') + '" data-mode="native">原生 Service<span class="ka-tag ka-tag-native">APK</span><span class="ka-tag ka-tag-best">推荐</span></button>';
      }
      if (wakeLock) {
        h += '<button class="ka-mode-btn' + (mode === 'wakelock' && !nativeAudio ? ' active' : '') + '" data-mode="wakelock">Wake Lock<span class="ka-tag ka-tag-web">Web</span></button>';
      }
      h += '<button class="ka-mode-btn' + (mode === 'audio' && !nativeAudio && !wakeLock ? ' active' : '') + '" data-mode="audio">静默音频<span class="ka-tag ka-tag-web">Web</span></button>';

      h += '</div>';

      // 模式说明
      if (mode === 'native') {
        h += '<p style="margin-top:8px">使用 APK 内置的前台 Service，通知栏显示"正在播放"，系统不会杀死 Roche。最稳定。</p>';
      } else if (mode === 'wakelock') {
        h += '<p style="margin-top:8px">使用 Screen Wake Lock API 防止屏幕休眠。切到后台后保护效果有限，建议配合音频模式。</p>';
      } else {
        h += '<p style="margin-top:8px">使用 Web Audio API 循环播放静默音频，让浏览器认为正在播放媒体，减少被杀概率。通用性最好。</p>';
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
      h += '<div class="ka-info-item"><span class="ka-info-key">原生 Audio Bridge</span><span class="ka-info-val">' + (nativeAudio ? '可用' : '不可用') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">Screen Wake Lock</span><span class="ka-info-val">' + (wakeLock ? '支持' : '不支持') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">Web Audio API</span><span class="ka-info-val">' + (webAudio ? '支持' : '不支持') + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">当前模式</span><span class="ka-info-val">' + getModeLabel(mode) + '</span></div>';
      h += '<div class="ka-info-item"><span class="ka-info-key">保活状态</span><span class="ka-info-val">' + (enabled ? '运行中' : '未启动') + '</span></div>';
      h += '</div>';

      // 原理说明
      h += '<div class="ka-card"><h3>原理说明</h3>';
      h += '<p>Android / iOS 会在内存不足时杀死后台应用。本插件通过以下方式防止被杀：</p>';
      h += '<p><b>原生 Service</b>（APK 专用）：启动前台 Service + 通知栏通知，系统不会杀。</p>';
      h += '<p><b>Wake Lock</b>：防止屏幕自动关闭，适合需要持续显示的场景。</p>';
      h += '<p><b>静默音频</b>：循环播放无声音频，浏览器/WebView 认为在播放媒体，降低被杀概率。无需特殊 APK。</p>';
      h += '</div>';

      // 注意事项
      h += '<div class="ka-notice">保活不是 100% 有效。极端内存压力下，系统仍可能杀死应用。建议锁定后台、关闭电池优化以获得最佳效果。</div>';

      h += '</div>'; // ka-body
      h += '</div>'; // root

      container.innerHTML = h;

      // 绑定事件
      var closeBtn = $id('ka-close');
      if (closeBtn) closeBtn.onclick = function () { roche.ui.closeApp(); };

      // 模式选择
      var modeBtns = container.querySelectorAll('.ka-mode-btn');
      modeBtns.forEach(function (btn) {
        btn.onclick = function () {
          var newMode = btn.getAttribute('data-mode');
          storageSet(roche, WAKELOCK_KEY, newMode);
          renderMain(container, roche);
        };
      });

      // 开关
      var toggle = $id('ka-toggle');
      if (toggle) {
        toggle.onchange = function () {
          if (toggle.checked) {
            startKeepAlive(mode).then(function (ok) {
              storageSet(roche, STORAGE_KEY, true);
              storageSet(roche, WAKELOCK_KEY, mode);
              roche.ui.toast('保活已启动 (' + getModeLabel(mode) + ')');
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

      // 手动按钮
      var startBtn = $id('ka-start');
      if (startBtn) {
        startBtn.onclick = function () {
          startKeepAlive(mode).then(function () {
            storageSet(roche, STORAGE_KEY, true);
            storageSet(roche, WAKELOCK_KEY, mode);
            roche.ui.toast('保活已启动 (' + getModeLabel(mode) + ')');
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
        startKeepAlive(mode).catch(function () {});
      }
    });
  }

  function getModeLabel(mode) {
    if (mode === 'native') return '原生 Service';
    if (mode === 'wakelock') return 'Wake Lock';
    return '静默音频';
  }

  // ============================
  //  插件注册
  // ============================

  window.RochePlugin.register({
    id: 'keepalive',
    name: '后台保活',
    version: '1.0.0',
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

  console.log('[KeepAlive] 插件已注册 v1.0.0');
  console.log('  环境: 原生=' + hasNativeAudio() + ', WakeLock=' + hasWakeLock() + ', WebAudio=' + hasWebAudio());

})();
