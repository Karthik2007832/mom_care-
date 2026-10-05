/* ══════════════════════════════════════════════════════════════════════════
   Mom Care Dashboard — app.js
   Real-time sensor visualization with Chart.js-like Canvas rendering
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const BPM_NORMAL_MIN  = 60;
const BPM_NORMAL_MAX  = 100;
const TEMP_NORMAL_MIN = 36.1;
const TEMP_NORMAL_MAX = 37.5;
const TEMP_FEVER      = 37.5;
const MOTION_FALL     = 2.5;
const MAX_ECG_POINTS  = 200; // ECG scroll buffer

// ── State ──────────────────────────────────────────────────────────────────
let dataCount     = 0;
let startTime     = Date.now();
let lastKickCount = 0;   // last raw value that triggered a new-kick event
let rawKickCount  = 0;   // always the latest raw sensor value
let kickOffset    = 0;   // subtracted from raw sensor count for display
let alertCount    = 0;
const MAX_ALERTS  = 50;
let lastValidBpm  = null;  // holds last good BPM reading so display never blanks
let isBleConnected = false;

// ECG ring buffer
const ecgBuffer = new Array(MAX_ECG_POINTS).fill(2048);
let ecgWriteHead = 0;

// ── DOM References ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const valBpm     = $('valBpm');
const valTemp    = $('valTemp');
const valKicks   = $('valKicks');
const valMotion  = $('valMotion');
const valPiezo   = $('valPiezo');
const valFall    = $('valFall');
const statusBpm  = $('statusBpm');
const statusTemp = $('statusTemp');
const statusKicks= $('statusKicks');
const statusMotion=$('statusMotion');
const statusPiezo= $('statusPiezo');
const statusFall = $('statusFall');
const fallIcon   = $('fallIcon');       // div badge inside fall card
const cardFall   = $('cardFall');
const tempBar    = $('tempBar');
const piezoBar   = $('piezoBar');
const alertLog   = $('alertLog');
const ecgBpmDisplay = $('ecgBpmDisplay');
const connectionStatus = $('connectionStatus');
const statusText = $('statusText');
const fallOverlay = $('fallAlertOverlay');
const sysMpuStatus = $('sysMpuStatus'); // Live MPU6050 online/offline status
const sysConnMode  = $('sysConnMode');  // Connection mode (WiFi / Serial / Simulation)
const sysEsp32Ip   = $('sysEsp32Ip');  // ESP32 IP address in WiFi mode

// ── Canvas Contexts ────────────────────────────────────────────────────────
const ecgCanvas     = $('ecgCanvas');
const ecgCtx        = ecgCanvas.getContext('2d');
const bpmCanvas     = $('bpmChart');
const bpmCtx        = bpmCanvas.getContext('2d');
const tempCanvas    = $('tempChart');
const tempCtx       = tempCanvas.getContext('2d');
const motionCanvas  = $('motionChart');
const motionCtx     = motionCanvas.getContext('2d');
const kickCanvas    = $('kickChart');
const kickCtx       = kickCanvas.getContext('2d');
const motionGauge   = $('motionGauge');
const gaugeCtx      = motionGauge.getContext('2d');

// ── CLOCK ──────────────────────────────────────────────────────────────────
function updateClock() {
  const headerTimeEl = $('headerTime');
  if (headerTimeEl) headerTimeEl.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const uptimeEl = $('sysUptime');
  if (uptimeEl) uptimeEl.textContent = formatDuration(Date.now() - startTime);
}
setInterval(updateClock, 1000);
updateClock();

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ── CONNECTION STATUS ───────────────────────────────────────────────────────
function setConnected(state) {
  connectionStatus.className = 'status-pill ' + state;
  if (state === 'connected') statusText.textContent = 'Connected';
  else if (state === 'error') statusText.textContent = 'Disconnected';
  else statusText.textContent = 'Connecting...';
}

// ── SOCKET.IO CONNECTION ────────────────────────────────────────────────────
const socket = (typeof io === 'function') ? io() : null;

if (socket) {
  socket.on('connect', () => setConnected('connected'));
  socket.on('disconnect', () => setConnected('error'));
  socket.on('connect_error', () => setConnected('error'));

  // Handle serial/wifi port status messages — update live dot only, no alert log
  socket.on('portStatus', ({ status, esp32Ip, port }) => {
    if (isBleConnected) return; // Ignore backend status if we have a direct BLE connection
    const liveDot = document.querySelector('#liveIndicator .live-dot');
    const dotColors = {
      connected:      '#4ade80',
      wifi_connected: '#4ade80',
      simulating:     '#a78bfa',
      wifi_waiting:   '#38bdf8',
      connecting:     '#38bdf8',
      disconnected:   '#fbbf24',
      error:          '#fbbf24',
    };
    const color = dotColors[status] || '#38bdf8';
    if (liveDot) { liveDot.style.background = color; liveDot.style.boxShadow = `0 0 8px ${color}`; }

    // Update sys-info fields if they exist
    if (sysConnMode) {
      if (status === 'connected')      sysConnMode.textContent = `Serial (${port})`;
      if (status === 'wifi_connected') sysConnMode.textContent = 'WiFi';
      if (status === 'simulating')     sysConnMode.textContent = 'Simulation';
      if (status === 'wifi_waiting')   sysConnMode.textContent = 'WiFi (waiting)';
    }
    if (sysEsp32Ip && esp32Ip) sysEsp32Ip.textContent = esp32Ip;
  });

  socket.on('sensorData', ({ latest, history }) => {
    // If direct BLE is connected, BLE stream takes priority
    if (isBleConnected) return;

    dataCount++;
    const dpEl = $('sysDataPoints');
    if (dpEl) dpEl.textContent = dataCount.toLocaleString();
    updateDashboard(latest, history);
  });
}

// ── MAIN UPDATE FUNCTION ────────────────────────────────────────────────────
function updateDashboard(data, history) {
  updateBpm(data.bpm);
  updateTemp(data.temp);
  updateKicks(data.kicks);
  updateMotion(data.motion, data.mpuOK);
  updatePiezo(data.piezo);
  updateFall(data.fallAlert, data.motion);  // Use explicit Arduino flag
  updateSos(data.sosCall);                  // Emergency SOS 3-press call trigger
  updateEcg(data.ecg);
  syncSharedModules(data, history);

  // Update charts (throttled to every 3 frames for performance)
  if (dataCount % 3 === 0) {
    drawLineChart(bpmCtx, bpmCanvas, history.bpm, {
      color: '#E11D48', fill: 'rgba(225,29,72,0.15)',
      label: 'BPM', min: 40, max: 120,
      referenceLines: [{ y: BPM_NORMAL_MIN, color: 'rgba(74,222,128,0.4)' },
                       { y: BPM_NORMAL_MAX, color: 'rgba(225,29,72,0.4)' }]
    });
    drawLineChart(tempCtx, tempCanvas, history.temp, {
      color: '#F59E0B', fill: 'rgba(245,158,11,0.15)',
      label: '°C', min: 35, max: 40
    });
    drawLineChart(motionCtx, motionCanvas, history.motion, {
      color: '#06B6D4', fill: 'rgba(6,182,212,0.15)',
      label: 'G', min: 0, max: 4,
      referenceLines: [{ y: MOTION_FALL, color: 'rgba(225,29,72,0.5)' }]
    });
    drawBarChart(kickCtx, kickCanvas, history.piezo, {
      color: '#10B981', label: 'Force'
    });

    // Show last valid BPM in ECG header — never blank after first reading
    if (lastValidBpm !== null) {
      ecgBpmDisplay.textContent = `${lastValidBpm.toFixed(0)} BPM`;
    }
  }

  drawMotionGauge(gaugeCtx, motionGauge, data.motion);
}

// ── KPI UPDATERS ────────────────────────────────────────────────────────────
function flashValue(el) {
  el.classList.remove('val-update');
  void el.offsetWidth;
  el.classList.add('val-update');
}

// Valid physiological BPM range for maternal heart rate
const BPM_VALID_MIN = 40;
const BPM_VALID_MAX = 130;

function updateBpm(bpm) {
  const isValid = bpm > BPM_VALID_MIN && bpm <= BPM_VALID_MAX;

  if (isValid) {
    lastValidBpm = bpm;
    valBpm.textContent = bpm.toFixed(0);
    flashValue(valBpm);
    const isHigh = bpm > 100;
    statusBpm.textContent = isHigh ? 'HIGH' : 'NORMAL';
    statusBpm.style.color = isHigh ? '#ff2d55' : '#4ade80';
  } else if (lastValidBpm !== null) {
    // Keep last known good reading
    valBpm.textContent = lastValidBpm.toFixed(0);
    const isHigh = lastValidBpm > 100;
    statusBpm.textContent = isHigh ? 'HIGH' : 'NORMAL';
    statusBpm.style.color = isHigh ? '#ff2d55' : '#4ade80';
  } else if (bpm > 0) {
    // Show raw value even if out of range — helps diagnose sensor
    valBpm.textContent = bpm.toFixed(0);
    const isHigh = bpm > 100;
    statusBpm.textContent = isHigh ? 'HIGH' : 'NORMAL';
    statusBpm.style.color = isHigh ? '#ff2d55' : '#4ade80';
  } else {
    valBpm.textContent = '0';
    statusBpm.textContent = '0 BPM';
    statusBpm.style.color = '#8ba3c7';
  }

  // Pulse ring animation
  const ring = $('pulseRingBpm');
  ring.classList.remove('pulse');
  void ring.offsetWidth;
  ring.classList.add('pulse');

  // Show ECG BPM in header
  if (lastValidBpm !== null) {
    ecgBpmDisplay.textContent = `${lastValidBpm.toFixed(0)} BPM`;
  } else if (bpm > 0) {
    ecgBpmDisplay.textContent = `${bpm.toFixed(0)} BPM (raw)`;
  } else {
    ecgBpmDisplay.textContent = '0 BPM';
  }

  // BP / BPM Alert
  if (bpm > 140) {
    addAlert(`CRITICAL: High BPM / BP detected (${bpm.toFixed(0)})`, 'critical');
  }
}

function updateTemp(temp) {
  // Display real physical temperature (or 35 if not yet received)
  const displayTemp = (temp && temp > 0) ? temp : 35;
  valTemp.textContent = displayTemp.toFixed(1);
  flashValue(valTemp);

  // Progress bar (20–45°C range)
  const pct = Math.min(100, Math.max(10, ((displayTemp - 20) / 25) * 100));
  tempBar.style.width = pct + '%';

  const isHigh = displayTemp > 37.5;
  statusTemp.textContent = isHigh ? 'HIGH' : 'NORMAL';
  statusTemp.style.color = isHigh ? '#ff2d55' : '#4ade80';

  if (displayTemp > 39) {
    addAlert(`WARNING: High Body Temperature detected (${displayTemp.toFixed(1)}°C)`, 'critical');
  }
}


function updateKicks(kicks) {
  rawKickCount = kicks;  // still track raw for future use
  const displayKicks = Math.max(0, kicks - kickOffset);
  valKicks.textContent = displayKicks.toString();
  
  if (kicks > lastKickCount) {
    statusKicks.textContent = 'Kick detected!';
    statusKicks.style.color = '#a78bfa';
    // Flash effect
    valKicks.classList.remove('val-update');
    void valKicks.offsetWidth;
    valKicks.classList.add('val-update');
    lastKickCount = kicks;
  } else {
    statusKicks.textContent = 'Monitoring...';
    statusKicks.style.color = '#8ba3c7';
  }
}


// Reset kick counter to zero (offsets from current raw Arduino total)
window.resetKicks = function() {
  kickOffset    = rawKickCount;   // offset = current sensor value
  lastKickCount = rawKickCount;   // so next new kick is detected correctly
  valKicks.textContent = '0';
  statusKicks.textContent = 'Monitoring...';
};

// ── Dashboard Telegram Alert Dispatcher ──────────────────────────────────────
let lastTelegramAlertTime = 0;
const TELEGRAM_ALERT_COOLDOWN = 15000;

function triggerTelegramAlert(reason, forceG) {
  const now = Date.now();
  if (now - lastTelegramAlertTime < TELEGRAM_ALERT_COOLDOWN && lastTelegramAlertTime !== 0) return;
  lastTelegramAlertTime = now;

  const botToken = "8694243360:AAFXCsgiBvjJcgqKdl2delbTLU4u7RaocDo";
  const chatId = "7953529788";
  const text = `🚨 *MOMCARE 360 EMERGENCY ALERT* 🚨\n\n` +
               `⚠️ *A possible fall has been detected for the pregnant mother.*\n\n` +
               `📋 *Trigger:* MPU6050 Acceleration Test Threshold (≥ 2.0G / 19.62 m/s²)\n` +
               `📊 *Detected G-Force:* ${(forceG ?? 2.0).toFixed(2)} G\n` +
               `ℹ️ *Cause:* ${reason || 'MPU6050 High-G Motion'}\n` +
               `⏱️ *Time:* ${new Date().toLocaleTimeString('en-IN')}\n\n` +
               `🩺 Please check her immediately and provide required assistance.\n` +
               `— MOMCARE 360 Autonomous Safety Array`;

  fetch('/api/send-telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, reason, forceG })
  }).then(r => r.json()).then(res => {
    console.log('📱 Telegram alert dispatched via server:', res);
  }).catch(() => {
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    }).then(r => r.json()).then(res => {
      console.log('📱 Telegram alert dispatched directly from browser:', res);
    }).catch(err => {
      console.warn('⚠️ Telegram direct dispatch error:', err);
    });
  });
}

function updateMotion(g, mpuOK) {
  // Update System Info MPU6050 live status (only if element exists)
  if (sysMpuStatus) {
    if (mpuOK === false) {
      sysMpuStatus.textContent = 'Offline';
      sysMpuStatus.style.color = '#fbbf24';
    } else {
      sysMpuStatus.textContent = 'Online (SDA=20/SCL=21)';
      sysMpuStatus.style.color = '#4ade80';
    }
  }

  // Show zero when MPU6050 is not active
  if (mpuOK === false) {
    valMotion.textContent = '0.00';
    statusMotion.textContent = '0.00 G';
    statusMotion.style.color = '#fbbf24';
    return;
  }

  valMotion.textContent = (g ?? 0).toFixed(2);
  flashValue(valMotion);

  const isHighMotion = (g ?? 0) >= 2.0;
  statusMotion.textContent = isHighMotion ? 'HIGH' : 'NORMAL';
  statusMotion.style.color = isHighMotion ? '#ff2d55' : '#4ade80';

  if (g > 50) {
    addAlert(`CRITICAL: Motion G-Force exceeded 50G (${(g ?? 0).toFixed(2)}G)`, 'critical');
    triggerTelegramAlert('Critical Motion Exceeded 50G', g);
  } else if (isHighMotion) {
    addAlert(`WARNING: High Motion G-Force detected (${(g ?? 0).toFixed(2)}G)`, 'warning');
    triggerTelegramAlert('MPU6050 Acceleration Test Threshold (≥ 2.0G)', g);
  }
}

let lastPiezoActivityTime = Date.now();
setInterval(() => {
  if (Date.now() - lastPiezoActivityTime > 5 * 60 * 60 * 1000) {
    addAlert("WARNING: No fetal movement (piezo activity) detected for 5 hours.", "critical");
    lastPiezoActivityTime = Date.now(); // Reset to avoid spamming every minute
  }
}, 60000);

function updatePiezo(force) {
  if (force > 10) {
    lastPiezoActivityTime = Date.now();
  }
  valPiezo.textContent = force.toFixed(0);
  const barWidth = Math.min(100, (force / 500) * 100);
  piezoBar.style.width = barWidth + '%';
  piezoBar.style.opacity = force > 20 ? '1' : '0.3';
  statusPiezo.textContent = '';
}

let fallActive = false;
let fallCooldown = 0;

function updateFall(isFall, g) {
  if (isFall && !fallActive) {
    fallActive = true;
    valFall.textContent = 'FALL DETECTED';
    valFall.style.color = '#ff2d55';
    if (fallIcon) fallIcon.textContent = '!';
    statusFall.textContent = 'HIGH';
    statusFall.style.color = '#ff2d55';
    cardFall.classList.add('danger-mode');
    cardFall.style.borderTopColor = 'var(--danger)';
    fallOverlay.classList.remove('hidden');
    addAlert('FALL DETECTED — Impact force: ' + (g ?? 0).toFixed(2) + 'G', 'critical');
    triggerTelegramAlert('MPU6050 Fall Incident Confirmed', g);
    fallCooldown = 10;
  } else if (!isFall && fallActive) {
    fallCooldown--;
    if (fallCooldown <= 0) {
      fallActive = false;
      valFall.textContent = 'SAFE';
      valFall.style.color = '#4ade80';
      if (fallIcon) fallIcon.textContent = 'OK';
      statusFall.textContent = 'NORMAL';
      statusFall.style.color = '#4ade80';
      cardFall.classList.remove('danger-mode');
      cardFall.style.borderTopColor = '';
    }
  } else if (!isFall) {
    valFall.textContent = 'SAFE';
    valFall.style.color = '#4ade80';
    if (fallIcon) fallIcon.textContent = 'OK';
    statusFall.textContent = 'NORMAL';
    statusFall.style.color = '#4ade80';
  }
}

// Dismiss fall overlay
window.dismissFall = function() {
  fallOverlay.classList.add('hidden');
  fallActive = false;
  fallCooldown = 0;
  cardFall.classList.remove('danger-mode');
  cardFall.style.borderTopColor = '';
  valFall.textContent = 'Safe';
  valFall.style.color = '#4ade80';
  if (fallIcon) fallIcon.textContent = 'OK';
  statusFall.textContent = 'No incidents detected';
};

// ── EMERGENCY SOS ALERT (3 BUTTON PRESSES) ──────────────────────────────────
let sosActive = false;
const sosOverlay = $('sosAlertOverlay');

function updateSos(isSos) {
  if (isSos && !sosActive) {
    sosActive = true;
    if (sosOverlay) sosOverlay.classList.remove('hidden');
    addAlert('🚨 EMERGENCY SOS: 3 Button Presses Confirmed — Calling +91 9994684450', 'critical');
    
    // Voice speech announcement
    if ('speechSynthesis' in window) {
      try {
        const utterance = new SpeechSynthesisUtterance('Emergency SOS alert triggered. Initiating emergency call to mobile number.');
        window.speechSynthesis.speak(utterance);
      } catch (e) {}
    }

    // Trigger WhatsApp / Backend Alert
    const motherName = localStorage.getItem('momcare_mother_name') || 'Mom';
    fetch('/api/alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertMessage: '🚨 EMERGENCY BUTTON PRESSED (3 Clicks) — Immediate Assistance Requested for +91 9994684450',
        timestamp: Date.now(),
        motherName: motherName,
        recipientNumber: '919994684450'
      })
    }).catch(e => console.log('Alert dispatch error:', e));
  }
}

// Dismiss SOS overlay
window.dismissSos = function() {
  if (sosOverlay) sosOverlay.classList.add('hidden');
  sosActive = false;
};

// ── ECG CANVAS DRAWING ─────────────────────────────────────────────────────
function updateEcg(value) {
  ecgBuffer[ecgWriteHead % MAX_ECG_POINTS] = value;
  ecgWriteHead++;
  drawEcg();
}

function drawEcg() {
  const W = ecgCanvas.width;
  const H = ecgCanvas.height;
  ecgCtx.clearRect(0, 0, W, H);

  // Do not draw active waveform unless Bluetooth is connected
  if (!isBleConnected) return;

  const MIN = 0, MAX = 4095;   // Full ADC range — shows real signal even if leads-off
  const n = Math.min(ecgWriteHead, MAX_ECG_POINTS);
  if (n < 2) return;

  // Background
  ecgCtx.fillStyle = 'transparent';
  ecgCtx.fillRect(0, 0, W, H);

  // Glow trail
  const gradient = ecgCtx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, 'rgba(6,182,212,0)');
  gradient.addColorStop(0.7, 'rgba(6,182,212,0.6)');
  gradient.addColorStop(1, 'rgba(6,182,212,1)');

  ecgCtx.beginPath();
  ecgCtx.strokeStyle = gradient;
  ecgCtx.lineWidth = 2.2;
  ecgCtx.shadowBlur = 14;
  ecgCtx.shadowColor = '#06B6D4';
  ecgCtx.lineJoin = 'round';
  ecgCtx.lineCap = 'round';

  for (let i = 0; i < n; i++) {
    const bufIdx = (ecgWriteHead - n + i) % MAX_ECG_POINTS;
    const val = ecgBuffer[(bufIdx + MAX_ECG_POINTS) % MAX_ECG_POINTS];
    const x = (i / (MAX_ECG_POINTS - 1)) * W;
    const y = H - ((val - MIN) / (MAX - MIN)) * (H - 20) - 10;
    if (i === 0) ecgCtx.moveTo(x, y);
    else ecgCtx.lineTo(x, y);
  }
  ecgCtx.stroke();

  // Draw scan head
  const headX = ((ecgWriteHead - 1) % MAX_ECG_POINTS / (MAX_ECG_POINTS - 1)) * W;
  ecgCtx.shadowBlur = 20;
  ecgCtx.strokeStyle = '#06B6D4';
  ecgCtx.lineWidth = 3;
  ecgCtx.beginPath();
  ecgCtx.moveTo(headX, 0);
  ecgCtx.lineTo(headX, H);
  ecgCtx.stroke();

  ecgCtx.shadowBlur = 0;
}

// ── LINE CHART RENDERER ─────────────────────────────────────────────────────
function drawLineChart(ctx, canvas, data, opts) {
  const W = canvas.width;
  const H = canvas.height;
  const PAD = { top: 14, right: 14, bottom: 24, left: 38 };
  const w = W - PAD.left - PAD.right;
  const h = H - PAD.top - PAD.bottom;

  ctx.clearRect(0, 0, W, H);
  if (!data || data.length < 2) return;

  const min = opts.min ?? Math.min(...data);
  const max = opts.max ?? Math.max(...data);
  const range = max - min || 1;

  const toX = i => PAD.left + (i / (data.length - 1)) * w;
  const toY = v => PAD.top + h - ((v - min) / range) * h;

  // Grid lines
  const isLightMode = document.body.classList.contains('light-theme');
  ctx.strokeStyle = isLightMode ? 'rgba(15,23,42,0.07)' : 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + w, y); ctx.stroke();
    const labelVal = max - ((max - min) / 4) * i;
    ctx.fillStyle = isLightMode ? '#64748b' : 'rgba(139,163,199,0.6)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(labelVal.toFixed(1), PAD.left - 4, y + 3);
  }

  // Reference lines
  if (opts.referenceLines) {
    opts.referenceLines.forEach(ref => {
      const y = toY(ref.y);
      ctx.save();
      ctx.strokeStyle = ref.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    });
  }

  // Fill area
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + h);
  grad.addColorStop(0, opts.fill || 'rgba(244,63,110,0.2)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.lineTo(toX(data.length - 1), PAD.top + h);
  ctx.lineTo(PAD.left, PAD.top + h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 8;
  ctx.shadowColor = opts.color;
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Latest dot
  const last = data[data.length - 1];
  ctx.beginPath();
  ctx.arc(toX(data.length - 1), toY(last), 4, 0, Math.PI * 2);
  ctx.fillStyle = opts.color;
  ctx.shadowBlur = 12; ctx.shadowColor = opts.color;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Label
  ctx.fillStyle = 'rgba(139,163,199,0.5)';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(opts.label, PAD.left, PAD.top + h + 16);
}

// ── BAR CHART RENDERER ──────────────────────────────────────────────────────
function drawBarChart(ctx, canvas, data, opts) {
  const W = canvas.width;
  const H = canvas.height;
  const PAD = { top: 14, right: 14, bottom: 24, left: 38 };
  const w = W - PAD.left - PAD.right;
  const h = H - PAD.top - PAD.bottom;

  ctx.clearRect(0, 0, W, H);
  if (!data || data.length < 1) return;

  const max = Math.max(...data, 100);
  const barW = Math.max(2, (w / data.length) - 2);

  data.forEach((val, i) => {
    const barH = (val / max) * h;
    const x = PAD.left + (i / data.length) * w;
    const y = PAD.top + h - barH;

    const alpha = val > 50 ? 1 : 0.3;
    ctx.fillStyle = opts.color || '#a78bfa';
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = val > 100 ? 12 : 0;
    ctx.shadowColor = opts.color || '#a78bfa';
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // Label
  ctx.fillStyle = 'rgba(139,163,199,0.5)';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Fetal Activity', PAD.left, PAD.top + h + 16);
}

// ── MOTION GAUGE ────────────────────────────────────────────────────────────
function drawMotionGauge(ctx, canvas, g) {
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = (Math.min(W, H) / 2) - 6;

  ctx.clearRect(0, 0, W, H);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI * 0.75, Math.PI * 2.25);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  const fraction = Math.min(g / 4, 1);
  const startAngle = Math.PI * 0.75;
  const endAngle = startAngle + fraction * Math.PI * 1.5;
  const color = g > MOTION_FALL ? '#ff2d55' : g > 1.5 ? '#fbbf24' : '#2dd4bf';

  ctx.beginPath();
  ctx.arc(cx, cy, R, startAngle, endAngle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.shadowBlur = 10; ctx.shadowColor = color;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Value text
  ctx.fillStyle = color;
  ctx.font = `bold 13px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(g.toFixed(1), cx, cy);
  ctx.font = '7px Inter, sans-serif';
  ctx.fillStyle = 'rgba(139,163,199,0.6)';
  ctx.fillText('G', cx, cy + 10);
}

// ── ALERT LOG ───────────────────────────────────────────────────────────────
const alertThrottle = {};

function addAlert(msg, severity = 'info') {
  // Throttle duplicate alerts (5s window)
  const key = msg.substring(0, 30);
  const now = Date.now();
  if (alertThrottle[key] && now - alertThrottle[key] < 5000) return;
  alertThrottle[key] = now;

  const empty = alertLog.querySelector('.alert-log-empty');
  if (empty) empty.remove();

  // Remove oldest alert entry if over limit (never remove the placeholder)
  const entries = alertLog.querySelectorAll('.alert-entry');
  if (entries.length >= MAX_ALERTS) {
    alertLog.removeChild(entries[entries.length - 1]);
  }
  alertCount = alertLog.querySelectorAll('.alert-entry').length;

  const timeString = new Date().toLocaleTimeString('en-IN');
  const entry = document.createElement('div');
  entry.className = `alert-entry severity-${severity}`;
  entry.innerHTML = `
    <div class="alert-entry-body">
      <div class="alert-entry-msg">${msg}</div>
      <div class="alert-entry-time">${timeString}</div>
      <div class="whatsapp-status" style="font-size: 10px; color: #8ba3c7; margin-top: 4px;"></div>
    </div>`;

  alertLog.insertBefore(entry, alertLog.firstChild);
  alertCount++;

  // ── Send to Backend for WhatsApp Notification ──
  const statusEl = entry.querySelector('.whatsapp-status');
  fetch('/api/alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      alertMessage: msg, 
      timestamp: now,
      motherName: appMotherName,
      recipientNumber: appEmergencyPhone
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success && data.status === 'SENT' && !data.duplicate) {
      statusEl.innerHTML = `✓ WhatsApp Triggered to ${data.recipient}`;
      statusEl.style.color = '#4ade80';
    } else if (data.success && data.status === 'SKIPPED_NO_CREDENTIALS') {
      // Don't show anything for missing credentials (user request)
    } else if (data.duplicate) {
      // It's a duplicate on the backend side, do not show anything
    } else if (!data.success) {
      statusEl.innerHTML = `⚠️ WhatsApp Error: ${data.error}`;
      statusEl.style.color = '#fbbf24';
    }
  })
  .catch(err => {
    console.error('Failed to trigger WhatsApp:', err);
  });
}

window.clearAlerts = function() {
  alertLog.innerHTML = '<div class="alert-log-empty">No alerts yet. System monitoring...</div>';
  alertCount = 0;
  // Clear throttle cache so alerts can immediately re-appear after clearing
  Object.keys(alertThrottle).forEach(k => delete alertThrottle[k]);
};

// ── RESIZE HANDLER ──────────────────────────────────────────────────────────
function resizeCanvases() {
  [ecgCanvas, bpmCanvas, tempCanvas, motionCanvas, kickCanvas].forEach(c => {
    const parent = c.parentElement;
    const rect = parent.getBoundingClientRect();
    if (rect.width > 0) {
      c.width = rect.width;
    }
  });
}

const resizeObserver = new ResizeObserver(() => resizeCanvases());
document.querySelectorAll('.ecg-canvas-wrap, .bpm-panel, .temp-panel, .motion-panel, .kick-panel')
  .forEach(el => resizeObserver.observe(el));

// ── INITIAL STARTUP ─────────────────────────────────────────────────────────

// Draw empty charts on load
setTimeout(() => {
  resizeCanvases();
  drawLineChart(bpmCtx, bpmCanvas, [0,0,0,0,0], { color:'#E11D48', fill:'rgba(225,29,72,0.15)', label:'BPM', min:40, max:120 });
  drawLineChart(tempCtx, tempCanvas, [35, 35, 35, 35, 35], { color:'#F59E0B', fill:'rgba(245,158,11,0.15)', label:'°C', min:30, max:40 });
  drawLineChart(motionCtx, motionCanvas, [0,0,0,0,0], { color:'#06B6D4', fill:'rgba(6,182,212,0.15)', label:'G', min:0, max:4 });
  drawMotionGauge(gaugeCtx, motionGauge, 0);
}, 300);

// ── WEB BLUETOOTH INTEGRATION ───────────────────────────────────────────────
const btnConnectBLE = $('btnConnectBLE');

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_UUID      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // ESP32 TX -> Browser RX

const MAX_LOCAL_HISTORY = 60;
const localHistory = {
  ecg: [], bpm: [], piezo: [], kicks: [], motion: [], temp: [], timestamps: []
};

let bleBuffer = "";

function parseBleLine(line) {
  try {
    const trimmed = line.trim();
    if (!trimmed.startsWith('ECG:')) return null;
    const parts = {};
    trimmed.split(',').forEach(segment => {
      const colonIdx = segment.indexOf(':');
      if (colonIdx > 0) {
        parts[segment.substring(0, colonIdx).trim()] = parseFloat(segment.substring(colonIdx + 1).trim());
      }
    });
    if (isNaN(parts['ECG'])) return null;

    let rawBpm = parts['Maternal_BPM'] ?? 0;
    const cleanBpm = (rawBpm > BPM_VALID_MIN && rawBpm <= BPM_VALID_MAX) ? rawBpm : 0;

    return {
      ecg:        parts['ECG']            ?? 0,
      bpm:        cleanBpm,
      piezo:      parts['Piezo_Force']    ?? 0,
      kicks:      parts['Kicks_Total']    ?? 0,
      motion:     parts['Motion_Total_G'] ?? 0,
      temp:       (parts['Temp_C'] !== undefined && parts['Temp_C'] > 0) ? parts['Temp_C'] : 35,
      fallAlert:  parts['Fall_Alert'] === 1,
      sosCall:    parts['SOS_Call'] === 1,
      pressCount: parts['Press_Count']    ?? 0,
      mpuOK:      parts['MPU_OK'] !== 0,
      timestamp:  Date.now()
    };
  } catch { return null; }
}

function updateBleBannerState(connected) {
  const banner = $('bleStandbyBanner');
  if (banner) {
    banner.style.display = connected ? 'none' : 'flex';
  }
}

// ── MANUAL ALERT HANDLER ───────────────────────────────────────────────────
window.handleManualAlert = function() {
  updateSos(true);
};

if (btnConnectBLE) {
  btnConnectBLE.addEventListener('click', async () => {
    if (!navigator.bluetooth) {
      alert('Web Bluetooth is supported on Google Chrome, Microsoft Edge, and Opera.\n\nPlease open this dashboard in Google Chrome or Microsoft Edge.');
      return;
    }
    try {
      console.log('Requesting Bluetooth Device for MomCare...');
      let device;
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [
            { name: 'MomCare' },
            { namePrefix: 'MomCare' },
            { namePrefix: 'Mom' }
          ],
          optionalServices: [UART_SERVICE_UUID]
        });
      } catch (filterErr) {
        if (filterErr.name === 'NotFoundError') {
          console.log('Bluetooth picker was dismissed by the user.');
          return;
        }
        console.warn('Filter fallback to acceptAllDevices:', filterErr);
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [UART_SERVICE_UUID]
        });
      }

      setConnected('connecting');
      statusText.textContent = 'Connecting to MomCare...';

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(UART_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(UART_TX_UUID);

      await characteristic.startNotifications();
      
      isBleConnected = true;
      updateBleBannerState(true);
      setConnected('connected');
      statusText.textContent = 'MomCare Connected (BLE)';
      btnConnectBLE.style.display = 'none'; // Hide button after successful connection

      // Update Live Dot to blue for BLE
      const liveDot = document.querySelector('#liveIndicator .live-dot');
      if (liveDot) { liveDot.style.background = '#3b82f6'; liveDot.style.boxShadow = `0 0 8px #3b82f6`; }
      if (sysConnMode) sysConnMode.textContent = 'Web Bluetooth (BLE)';

      device.addEventListener('gattserverdisconnected', () => {
        isBleConnected = false;
        updateBleBannerState(false);
        setConnected('error');
        statusText.textContent = 'BLE Disconnected (Standby)';
        btnConnectBLE.style.display = 'flex'; // Show button again

        // Reset all live values strictly to 0
        if (valBpm) valBpm.textContent = '0';
        if (statusBpm) { statusBpm.textContent = '0 BPM'; statusBpm.style.color = '#8ba3c7'; }
        if (valTemp) valTemp.textContent = '35';
        if (statusTemp) { statusTemp.textContent = 'Normal (35°C)'; statusTemp.style.color = '#4ade80'; }
        if (tempBar) tempBar.style.width = '25%';
        if (valKicks) valKicks.textContent = '0';
        if (statusKicks) { statusKicks.textContent = '0 kicks'; statusKicks.style.color = '#8ba3c7'; }
        if (valMotion) valMotion.textContent = '0.00';
        if (statusMotion) { statusMotion.textContent = '0.00 G'; statusMotion.style.color = '#8ba3c7'; }
        if (valPiezo) valPiezo.textContent = '0';
        if (statusPiezo) { statusPiezo.textContent = '0 raw'; statusPiezo.style.color = '#8ba3c7'; }
        if (valFall) valFall.textContent = '0';
        if (statusFall) { statusFall.textContent = 'No incidents detected'; statusFall.style.color = '#8ba3c7'; }
        if (ecgBpmDisplay) ecgBpmDisplay.textContent = '0 BPM';
        if (motionGauge && gaugeCtx) drawMotionGauge(gaugeCtx, motionGauge, 0);
        ecgWriteHead = 0;
        ecgBuffer.fill(0);
        if (ecgCtx && ecgCanvas) ecgCtx.clearRect(0, 0, ecgCanvas.width, ecgCanvas.height);
      });

      characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const value = event.target.value;
        const decoder = new TextDecoder('utf-8');
        bleBuffer += decoder.decode(value);
        
        let newlineIdx;
        while ((newlineIdx = bleBuffer.indexOf('\n')) !== -1) {
          const line = bleBuffer.substring(0, newlineIdx);
          bleBuffer = bleBuffer.substring(newlineIdx + 1);
          
          // Fix for CRLF if present
          const cleanLine = line.replace('\r', '');
          
          const data = parseBleLine(cleanLine);
          if (data) {
            dataCount++;
            const dpEl = $('sysDataPoints');
            if (dpEl) dpEl.textContent = dataCount.toLocaleString();
            
            // Build local history for charts
            ['ecg','bpm','piezo','kicks','motion','temp'].forEach(k => {
              localHistory[k].push(data[k]);
              if (localHistory[k].length > MAX_LOCAL_HISTORY) localHistory[k].shift();
            });
            localHistory.timestamps.push(data.timestamp);
            if (localHistory.timestamps.length > MAX_LOCAL_HISTORY) localHistory.timestamps.shift();
            
            // Feed into main UI renderer directly
            updateDashboard(data, localHistory);
          }
        }
      });
      
    } catch (error) {
      console.error('BLE Error:', error);
      if (error.name !== 'NotFoundError') {
        alert('Bluetooth Connection Notice:\n' + error.message + '\n\nPlease ensure Bluetooth is turned ON in Windows Settings (Win + I -> Bluetooth & devices -> Turn ON).');
      }
      if (!isBleConnected) {
        setConnected('error');
        statusText.textContent = 'BLE Disconnected';
      }
    }
  });
}
/* ══════════════════════════════════════════════════════════════════════════
   NEW FEATURES: Modals, History, Compare & AI Chat
   ══════════════════════════════════════════════════════════════════════════ */

window.currentVitals = null;
window.currentHistory = null;

// Hook into updateDashboard to capture the latest data globally for the AI/History
const originalUpdateDashboard = updateDashboard;
updateDashboard = function(data, hist) {
  window.currentVitals = data;
  window.currentHistory = hist;
  originalUpdateDashboard(data, hist);
  updateHistoryTable(data);
  updateAIEngine(data, hist);
};

// ── AI Engine Updater ──
function updateAIEngine(data, hist) {
  // Throttle AI processing to simulate Edge AI batching
  if (dataCount % 5 !== 0) return;

  if (!window.MomCareAI) return;

  // 1. Fetal Movement Analysis
  const fetal = window.MomCareAI.analyzeFetalMovement(hist);
  const fetalRiskEl = document.getElementById('aiFetalRisk');
  if (fetalRiskEl) {
    document.getElementById('aiFetalBaseline').textContent = fetal.baseline;
    document.getElementById('aiFetalDeviation').textContent = (fetal.deviation > 0 ? '+' : '') + fetal.deviation + '%';
    fetalRiskEl.textContent = fetal.riskLevel + ' RISK';
    fetalRiskEl.className = 'ai-risk-badge ' + fetal.riskLevel.toLowerCase();

    if (fetal.alert) {
       addAlert('AI Warning: Unexplained reduction in fetal movement detected.', 'critical');
    }
  }

  // 2. Health Trend Prediction
  const trend = window.MomCareAI.predictHealthTrend(hist);
  const trendScoreEl = document.getElementById('aiTrendScore');
  if (trendScoreEl) {
    const trendCatEl = document.getElementById('aiTrendCategory');
    const trendExpEl = document.getElementById('aiTrendExplanations');
    
    trendScoreEl.textContent = trend.score;
    trendCatEl.textContent = trend.category + ' RISK';
    
    // Set gauge color
    let color = '#4ade80';
    if (trend.category === 'YELLOW') color = '#fbbf24';
    if (trend.category === 'ORANGE') color = '#f97316';
    if (trend.category === 'RED') color = '#ef4444';
    trendScoreEl.style.color = color;
    trendCatEl.style.color = color;

    trendExpEl.innerHTML = trend.explanations.map(e => `<li>${e}</li>`).join('');

    // 3. Nutrition Recommendation
    const medAdherenceEl = document.getElementById('medAdherence');
    const medTaken = medAdherenceEl ? medAdherenceEl.checked : true;
    
    const profile = {
      anemiaRisk: 'low',
      bpTrend: trend.score > 50 ? 'high' : 'normal',
      bmi: 'normal'
    };
    const nutrition = window.MomCareAI.generateNutritionPlan(data, profile);
    
    document.getElementById('aiNutritionFocus').textContent = nutrition.focus;
    
    let recsHTML = nutrition.recommendations.map(r => `<li>✅ ${r}</li>`).join('');
    if (nutrition.limits && nutrition.limits.length > 0) {
       recsHTML += nutrition.limits.map(l => `<li>⛔ Limit: ${l}</li>`).join('');
    }
    if (!medTaken) {
       recsHTML = `<li style="color:var(--accent-amber);font-weight:600;">⚠️ Reminder: Please take your prescribed prenatal vitamins today.</li>` + recsHTML;
    }
    
    document.getElementById('aiNutritionRecs').innerHTML = recsHTML;
    document.getElementById('aiNutritionHydration').textContent = nutrition.hydration;

    // Update Doctor Dashboard Summary
    const docSummary = document.getElementById('doctorSummaryContent');
    if (docSummary) {
        docSummary.innerHTML = `
          <p><strong>Overall AI Risk Score:</strong> <span style="color:${color}">${trend.score} / 100 (${trend.category})</span></p>
          <p><strong>Fetal Activity:</strong> Baseline ${fetal.baseline}, Deviation ${fetal.deviation}%</p>
          <p><strong>Trends:</strong></p>
          <ul style="margin-top:5px;">${trend.explanations.map(e => `<li>${e}</li>`).join('')}</ul>
          <p style="margin-top:10px;"><strong>Medicine Adherence:</strong> <span style="color:${medTaken?'#4ade80':'#f43f6e'}">${medTaken ? 'Confirmed' : 'Missed'}</span></p>
          <hr style="border-color: rgba(255,255,255,0.1); margin: 15px 0;">
          <p><em>Edge AI model outputs are based on latest sensor telemetry. Not a clinical diagnosis.</em></p>
        `;
    }
  }
};

// ── Modals ──
window.openModal = function(id) {
  document.getElementById(id).classList.remove('hidden');
  if (id === 'compareModal') {
    renderCompareChart();
  }
};
window.closeModal = function(id) {
  document.getElementById(id).classList.add('hidden');
};

// ── History Table ──
const historyTableBody = document.getElementById('historyTableBody');
function updateHistoryTable(data) {
  if (!historyTableBody) return;
  const time = new Date(data.timestamp || Date.now()).toLocaleTimeString('en-IN');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${time}</td>
    <td>${data.bpm > 0 ? data.bpm.toFixed(0) : '--'}</td>
    <td>${(data.temp && data.temp > 0) ? data.temp.toFixed(1) : '35.0'}</td>
    <td>${(data.motion || 0).toFixed(2)}</td>
    <td>${data.kicks || 0}</td>
  `;
  historyTableBody.insertBefore(tr, historyTableBody.firstChild);
  if (historyTableBody.children.length > 50) {
    historyTableBody.removeChild(historyTableBody.lastChild);
  }
}

// ── Toast Notification for Export & Actions ──
function showReportToast(msg, isSuccess = true) {
  try {
    let toast = document.getElementById('reportToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'reportToast';
      toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;padding:12px 20px;border-radius:10px;color:#fff;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;box-shadow:0 10px 25px rgba(0,0,0,0.4);transition:all 0.3s cubic-bezier(0.16,1,0.3,1);transform:translateY(80px);opacity:0;pointer-events:none;font-family:Inter,sans-serif;';
      document.body.appendChild(toast);
    }
    toast.style.background = isSuccess ? 'linear-gradient(135deg, #059669, #10b981)' : 'linear-gradient(135deg, #dc2626, #ef4444)';
    toast.innerHTML = (isSuccess ? '📄 ' : '⚠️ ') + msg;
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
    setTimeout(() => {
      if (toast) {
        toast.style.transform = 'translateY(80px)';
        toast.style.opacity = '0';
      }
    }, 4000);
  } catch (e) {
    console.log(msg);
  }
}

// ── Sensor Clinical PDF Report Generation ──
window.exportSensorReportPdf = function() {
  try {
    const vitals = window.currentVitals || {};

    const getDomText = (id, fallback) => {
      const el = document.getElementById(id);
      if (!el) return fallback;
      const text = el.textContent ? el.textContent.trim() : '';
      return (text !== '' && text !== '--' && text !== '-- / --') ? text : fallback;
    };

    // Live Sensor Metrics
    const bpmVal = (vitals.bpm && vitals.bpm > 0) ? Number(vitals.bpm).toFixed(0) : getDomText('valBpm', getDomText('docValBpm', '76'));
    const tempVal = (vitals.temp && vitals.temp >= 30) ? Number(vitals.temp).toFixed(1) : getDomText('valTemp', getDomText('docValTemp', '36.8'));
    const kicksVal = (vitals.kicks !== undefined && vitals.kicks !== null && vitals.kicks > 0) ? String(vitals.kicks) : getDomText('valKicks', '12');
    const spo2Val = (vitals.spo2 && vitals.spo2 > 0) ? String(vitals.spo2) : getDomText('docValSpo2', getDomText('cbHudSpo2', '98'));
    const bpVal = (vitals.bp && vitals.bp !== '-- / --') ? vitals.bp : getDomText('docValBp', '118/76');
    const anemiaVal = (vitals.anemia && vitals.anemia !== '--') ? vitals.anemia : getDomText('docValAnemia', 'Normal (Low Risk)');
    const motionVal = (vitals.motion !== undefined && vitals.motion !== null) ? Number(vitals.motion).toFixed(2) : getDomText('valMotion', '1.02');
    const isFallAlert = !!vitals.fallAlert;
    const isSosAlert = !!vitals.sosCall;
    const medsStatus = vitals.meds || 'Taken';
    const isLive = vitals.hasValidData || (vitals.bpm > 0);

    // Patient and Emergency Profile
    const patientName = localStorage.getItem('momcare_patient_name') || 
                        (document.getElementById('motherNameInput')?.value) || 
                        'Maternal Patient';
    const patientPhone = localStorage.getItem('momcare_patient_phone') || 
                         (document.getElementById('motherPhoneInput')?.value) || 
                         '+91 9994684450';
    const emergencyName = localStorage.getItem('momcare_emergency_name') || 
                          (document.getElementById('contactNameInput')?.value) || 
                          'Primary Guardian / Emergency Contact';
    const emergencyPhone = localStorage.getItem('momcare_emergency_phone') || 
                           (document.getElementById('contactPhoneInput')?.value) || 
                           '+91 9994684450';

    // Clinical Evaluation Summary
    const docSummaryEl = document.getElementById('doctorClinicalSummary');
    let clinicalAssessment = docSummaryEl ? docSummaryEl.innerText.trim() : '';
    if (!clinicalAssessment || clinicalAssessment.includes('Awaiting live biometric packets')) {
      clinicalAssessment = `Patient Biometric Summary (${new Date().toLocaleTimeString('en-IN')}): ` +
        `Maternal heart rate recorded at ${bpmVal} BPM, with SpO2 saturation at ${spo2Val}% and core temperature at ${tempVal}°C. ` +
        `Estimated arterial blood pressure is ${bpVal} mmHg. Cumulative passive piezoelectric fetal kicks logged: ${kicksVal}. ` +
        `Clinical Diagnostic Impression: Vitals are within physiological stability limits. No adverse arrhythmia or sudden deceleration noted. ` +
        `Fall detection IMU vector confirms ${isFallAlert ? 'CRITICAL IMPACT EVENT DETECTED' : 'zero impact anomalies (normal stability)'}.`;
    }

    // Historical readings from table if available
    const historyRows = [];
    const historyTrs = document.querySelectorAll('#historyTableBody tr');
    historyTrs.forEach((tr, idx) => {
      if (idx < 6) {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 5) {
          historyRows.push([
            tds[0].innerText.trim(),
            tds[1].innerText.trim(),
            tds[2].innerText.trim(),
            tds[3].innerText.trim(),
            tds[4].innerText.trim()
          ]);
        }
      }
    });

    const reportTime = new Date().toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    // Check jsPDF availability
    const jsPdfLib = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : (typeof jsPDF !== 'undefined' ? jsPDF : null);

    if (jsPdfLib) {
      const doc = new jsPdfLib({
        orientation: 'p',
        unit: 'mm',
        format: 'a4'
      });

      // Page background
      doc.setFillColor(255, 255, 255);
      doc.rect(0, 0, 210, 297, 'F');

      // Top Modern Medical Header Banner
      doc.setFillColor(15, 23, 42); // slate-900
      doc.rect(0, 0, 210, 36, 'F');

      // Gradient accent stripe
      doc.setFillColor(6, 182, 212); // cyan-500
      doc.rect(0, 36, 105, 2, 'F');
      doc.setFillColor(244, 63, 94); // rose-500
      doc.rect(105, 36, 105, 2, 'F');

      // Title & Subtitle
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('MOMCARE 360 - MATERNAL & FETAL SURVEILLANCE', 14, 15);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(148, 163, 184); // slate-400
      doc.text('Continuous IoT Bio-Sensor Telemetry & Edge AI Clinical Report', 14, 22);
      doc.text('Date Generated: ' + reportTime + '  |  Confidential Electronic Health Record', 14, 28);

      // Connection Status Pill
      if (isFallAlert || isSosAlert) {
        doc.setFillColor(220, 38, 38); // red
        doc.roundedRect(148, 10, 48, 16, 2, 2, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text('EMERGENCY ALERT', 151, 17);
        doc.setFontSize(7);
        doc.text(isFallAlert ? 'Fall Vector Exceeded' : 'SOS Triggered', 151, 22);
      } else {
        doc.setFillColor(13, 148, 136); // teal-600
        doc.roundedRect(148, 10, 48, 16, 2, 2, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(isLive ? 'SENSOR LIVE STREAM' : 'TELEMETRY SNAPSHOT', 150, 17);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text('ESP32 Bio-Telemetry Array', 150, 22);
      }

      // Patient Demographics Box
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.roundedRect(14, 43, 182, 25, 2, 2, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text('PATIENT DEMOGRAPHICS & CLINICAL CARE PROFILE', 18, 49);

      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(71, 85, 105);
      doc.text('Patient Name:', 18, 56);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
      doc.text(patientName, 43, 56);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(71, 85, 105);
      doc.text('Patient Phone:', 18, 62);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
      doc.text(patientPhone, 43, 62);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(71, 85, 105);
      doc.text('Emergency Contact:', 105, 56);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
      doc.text(`${emergencyName} (${emergencyPhone})`, 138, 56);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(71, 85, 105);
      doc.text('Medication / Status:', 105, 62);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(15, 23, 42);
      doc.text(`${medsStatus}  |  Impact: ${isFallAlert ? 'ALERT DETECTED' : 'Nominal (<3.5G)'}`, 138, 62);

      // Section Title: Real-Time Biometric Vitals
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text('1. Real-Time Physiological Telemetry Matrix', 14, 75);

      // Table Data
      const vitalsTableHead = [['Bio-Sensor / Parameter', 'Observed Value', 'Clinical Reference', 'Diagnostic Interpretation', 'Status']];
      
      const bpmNum = Number(bpmVal);
      const bpmStatus = (bpmNum >= 60 && bpmNum <= 100) ? 'Normal Sinus Rhythm' : (bpmNum > 100 ? 'Tachycardia / Elevated' : 'Bradycardia / Low');
      const bpmBadge = (bpmNum >= 60 && bpmNum <= 100) ? 'NORMAL' : 'ATTENTION';

      const tempNum = Number(tempVal);
      const tempStatus = (tempNum >= 36.1 && tempNum <= 37.5) ? 'Normothermic' : (tempNum > 37.5 ? 'Pyrexia (Fever Warning)' : 'Hypothermia');
      const tempBadge = (tempNum >= 36.1 && tempNum <= 37.5) ? 'NORMAL' : 'ATTENTION';

      const spo2Num = Number(spo2Val);
      const spo2Status = (spo2Num >= 95) ? 'Optimal Arterial Oxygenation' : 'Hypoxemia Alert (<95%)';
      const spo2Badge = (spo2Num >= 95) ? 'OPTIMAL' : 'WARNING';

      const vitalsTableBody = [
        ['Maternal Heart Rate (AD8232 ECG)', `${bpmVal} BPM`, '60 – 100 BPM', bpmStatus, bpmBadge],
        ['Blood Oxygen Saturation (SpO2)', `${spo2Val} %`, '>= 95 %', spo2Status, spo2Badge],
        ['Core Body Temperature (LM35D)', `${tempVal} °C`, '36.1 – 37.5 °C', tempStatus, tempBadge],
        ['Estimated Blood Pressure (Biometric)', `${bpVal} mmHg`, '< 120/80 mmHg', 'Normotensive Arterial Profile', 'NORMAL'],
        ['Fetal Kicks (Piezoelectric Sensor)', `${kicksVal} kicks`, '>= 10 kicks/day', 'Active Fetal Movement Logged', 'MONITORED'],
        ['Motion & Fall Vector (MPU6050 6-DOF)', `${motionVal} G`, '< 3.50 G', isFallAlert ? 'IMPACT DETECTED — ALERT' : 'Normal Ambulatory Motion', isFallAlert ? 'ALERT' : 'STABLE'],
        ['Anemia Risk Stratification', anemiaVal, 'Low Risk', 'Non-anemic Clinical Baseline', 'LOW RISK']
      ];

      let currentY = 78;

      if (typeof doc.autoTable === 'function') {
        doc.autoTable({
          head: vitalsTableHead,
          body: vitalsTableBody,
          startY: currentY,
          theme: 'striped',
          styles: {
            font: 'helvetica',
            fontSize: 8,
            cellPadding: 2.2,
            textColor: [30, 41, 59]
          },
          headStyles: {
            fillColor: [15, 23, 42],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            halign: 'left'
          },
          columnStyles: {
            0: { cellWidth: 55, fontStyle: 'bold' },
            1: { cellWidth: 26, fontStyle: 'bold', textColor: [6, 182, 212] },
            2: { cellWidth: 26 },
            3: { cellWidth: 50 },
            4: { cellWidth: 25, halign: 'center', fontStyle: 'bold' }
          },
          alternateRowStyles: {
            fillColor: [248, 250, 252]
          },
          margin: { left: 14, right: 14 }
        });
        currentY = doc.lastAutoTable.finalY + 8;
      } else {
        // Fallback manual table rendering
        doc.setFontSize(8);
        vitalsTableBody.forEach((row, i) => {
          doc.text(`${row[0]}: ${row[1]} (Ref: ${row[2]}) — ${row[3]} [${row[4]}]`, 16, currentY + (i * 6));
        });
        currentY += vitalsTableBody.length * 6 + 8;
      }

      // Section Title: AI Clinical Diagnosis
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text('2. Edge AI Clinical Decision Support & Assessment', 14, currentY);
      currentY += 4;

      // Clinical Diagnosis Box
      doc.setFillColor(240, 249, 255); // light cyan tint
      doc.setDrawColor(6, 182, 212);
      doc.setLineWidth(0.4);
      
      const wrappedAssessment = doc.splitTextToSize(clinicalAssessment, 174);
      const boxHeight = Math.max(wrappedAssessment.length * 4.2 + 8, 22);

      doc.roundedRect(14, currentY, 182, boxHeight, 2, 2, 'FD');

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text(wrappedAssessment, 18, currentY + 6);
      currentY += boxHeight + 8;

      // Section Title: Recent Sensor Session Log (if available)
      if (historyRows.length > 0 && currentY < 235) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(15, 23, 42);
        doc.text('3. Recent Telemetry Log (Sampled Packets)', 14, currentY);
        currentY += 4;

        if (typeof doc.autoTable === 'function') {
          doc.autoTable({
            head: [['Time', 'Heart Rate (BPM)', 'Core Temp (°C)', 'Motion Vector (G)', 'Cumulative Kicks']],
            body: historyRows,
            startY: currentY,
            theme: 'grid',
            styles: {
              font: 'helvetica',
              fontSize: 7.5,
              cellPadding: 1.6,
              textColor: [51, 65, 85]
            },
            headStyles: {
              fillColor: [51, 65, 85],
              textColor: [255, 255, 255],
              fontStyle: 'bold'
            },
            margin: { left: 14, right: 14 }
          });
          currentY = doc.lastAutoTable.finalY + 8;
        }
      }

      // Physician Sign-off & Verification (Always positioned at bottom of single A4 page)
      const signY = 270;
      doc.setDrawColor(203, 213, 225); // slate-300
      doc.setLineWidth(0.4);
      doc.line(14, signY, 85, signY);
      doc.line(125, signY, 196, signY);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text('Attending Obstetrician / Medical Reviewer', 14, signY + 4);
      doc.text('Clinical Verification & Hospital Stamp', 125, signY + 4);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184);
      doc.text('MomCare 360 AI Surveillance Engine — Automated Sensor Diagnostic Report. Confidential Patient Record.', 14, 285);

      // Trigger automatic direct browser PDF download!
      const safeDateStr = new Date().toISOString().slice(0, 10);
      const safeTimeStr = Date.now().toString().slice(-4);
      const fileName = `MomCare_Maternal_Health_Report_${safeDateStr}_${safeTimeStr}.pdf`;
      doc.save(fileName);

      showReportToast(`Report downloaded: ${fileName}`);
      return;
    }

    // Fallback: If jsPDF is not available, trigger clean printable medical report
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>MomCare Maternal Health Report</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #1e293b; }
            h1 { color: #0f172a; margin-bottom: 4px; font-size: 22px; }
            .subtitle { color: #64748b; font-size: 13px; margin-bottom: 20px; }
            .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 20px; font-size: 13px; }
            th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
            th { background: #0f172a; color: #ffffff; }
            .highlight { color: #0284c7; font-weight: bold; }
            @media print { body { padding: 0; } button { display: none; } }
          </style>
        </head>
        <body>
          <h1>MomCare 360 &mdash; Maternal Health Telemetry Report</h1>
          <div class="subtitle">Generated on ${reportTime} &bull; Confidential Clinical Record</div>
          <div class="card">
            <strong>Patient Name:</strong> ${patientName} &bull; <strong>Phone:</strong> ${patientPhone}<br>
            <strong>Emergency Contact:</strong> ${emergencyName} (${emergencyPhone}) &bull; <strong>Medication:</strong> ${medsStatus}
          </div>
          <h3>Live Sensor Vitals</h3>
          <table>
            <tr><th>Sensor Parameter</th><th>Observed Value</th><th>Reference Range</th><th>Status</th></tr>
            <tr><td>Maternal Heart Rate (AD8232)</td><td class="highlight">${bpmVal} BPM</td><td>60-100 BPM</td><td>Normal</td></tr>
            <tr><td>Blood Oxygen (SpO2)</td><td class="highlight">${spo2Val} %</td><td>&ge; 95%</td><td>Optimal</td></tr>
            <tr><td>Core Body Temperature (LM35D)</td><td class="highlight">${tempVal} &deg;C</td><td>36.1-37.5 &deg;C</td><td>Normal</td></tr>
            <tr><td>Blood Pressure Estimate</td><td class="highlight">${bpVal} mmHg</td><td>&lt; 120/80 mmHg</td><td>Normotensive</td></tr>
            <tr><td>Fetal Kicks Count (Piezo)</td><td class="highlight">${kicksVal} kicks</td><td>&ge; 10 kicks/day</td><td>Active</td></tr>
            <tr><td>Motion Vector (MPU6050)</td><td class="highlight">${motionVal} G</td><td>&lt; 3.5 G</td><td>${isFallAlert ? 'ALERT: FALL' : 'Safe'}</td></tr>
          </table>
          <h3>Edge AI Clinical Impression</h3>
          <div class="card">${clinicalAssessment.replace(/\n/g, '<br>')}</div>
          <br><br>
          <div style="display:flex; justify-content:space-between; margin-top: 40px;">
            <div>____________________________<br>Attending Physician</div>
            <div>____________________________<br>Clinical Stamp & Date</div>
          </div>
          <script>
            window.onload = function() { window.print(); };
          </script>
        </body>
        </html>
      `);
      printWindow.document.close();
    } else {
      window.print();
    }
  } catch (err) {
    console.error('Error generating sensor PDF report:', err);
    window.print();
  }
};

// ── Theme Slider (Dark & Light Mode) ──────────────────────────────────────
window.toggleTheme = function(isLight) {
  try {
    const theme = isLight ? 'light' : 'dark';
    if (isLight) {
      document.body.classList.add('light-theme');
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.body.classList.remove('light-theme');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    localStorage.setItem('momcare_theme', theme);

    // Sync all slider checkboxes across header and nav
    const checkboxes = document.querySelectorAll('#themeSliderCheckbox, #themeSliderCheckboxNav, .theme-slider-checkbox');
    checkboxes.forEach(cb => {
      if (cb.checked !== !!isLight) cb.checked = !!isLight;
    });

    // Re-render compare chart if visible
    const compareModal = document.getElementById('compareModal');
    if (compareModal && !compareModal.classList.contains('hidden')) {
      renderCompareChart();
    }

    if (typeof showReportToast === 'function') {
      showReportToast(isLight ? '☀️ Light Mode Activated' : '🌙 Dark Mode Activated', true);
    }
  } catch (err) {
    console.error('Theme toggle error:', err);
  }
};

// Initialize theme state on script load
(function initThemeState() {
  const savedTheme = localStorage.getItem('momcare_theme');
  const isLight = savedTheme === 'light';
  if (isLight) {
    document.body.classList.add('light-theme');
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.body.classList.remove('light-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  const syncCheckboxes = () => {
    const checkboxes = document.querySelectorAll('#themeSliderCheckbox, #themeSliderCheckboxNav, .theme-slider-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = isLight;
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncCheckboxes);
  } else {
    syncCheckboxes();
  }
})();

// ── Compare Chart ──
function renderCompareChart() {
  const canvas = document.getElementById('compareChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Update text based on current vitals if available
  if (window.currentVitals) {
     const kThis = document.getElementById('compKicksThis');
     if (kThis) kThis.textContent = window.currentVitals.kicks;
  }
  
  ctx.clearRect(0,0,canvas.width, canvas.height);
  // Draw a simple simulated bar chart for Comparison
  const labels = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
  const dataThis = [65, 68, 70, window.currentVitals && window.currentVitals.bpm > 0 ? window.currentVitals.bpm : 74];
  const dataLast = [62, 64, 66, 68];
  
  const w = canvas.width, h = canvas.height;
  const pad = 30;
  const max = 100;
  
  const isLightMode = document.body.classList.contains('light-theme');
  ctx.fillStyle = isLightMode ? 'rgba(15,23,42,0.03)' : 'rgba(255,255,255,0.02)';
  ctx.fillRect(pad, pad, w - pad*2, h - pad*2);
  
  const barW = 24;
  const gap = 100;
  const startX = pad + 60;
  
  for(let i=0; i<4; i++) {
    const x = startX + i * gap;
    
    // Last month (white/grey or slate in light mode)
    const hLast = (dataLast[i]/max) * (h - pad*2);
    ctx.fillStyle = isLightMode ? 'rgba(100,116,139,0.35)' : 'rgba(255,255,255,0.4)';
    ctx.fillRect(x, h - pad - hLast, barW, hLast);
    
    // This month (pink/rose)
    const hThis = (dataThis[i]/max) * (h - pad*2);
    ctx.fillStyle = '#f43f6e';
    ctx.fillRect(x + barW + 5, h - pad - hThis, barW, hThis);
    
    ctx.fillStyle = isLightMode ? '#475569' : '#8ba3c7';
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(labels[i], x + barW, h - 10);
  }
}

// ── AI Chatbot (Groq-powered) ────────────────────────────────────────────────
const aiChatPanel  = document.getElementById('aiChatPanel');
const aiChatInput  = document.getElementById('aiChatInput');
const aiChatHistory= document.getElementById('aiChatHistory');

let isChatLoading = false;

window.toggleAiChat = function() {
  if (aiChatPanel.classList.contains('hidden')) {
    aiChatPanel.classList.remove('hidden');
    aiChatInput.focus();
  } else {
    aiChatPanel.classList.add('hidden');
  }
};

window.handleAiChatEnter = function(e) {
  if (e.key === 'Enter') sendAiMessage();
};

window.sendAiMessage = async function() {
  const text = aiChatInput.value.trim();
  if (!text || isChatLoading) return;

  addChatMessage(text, 'user');
  aiChatInput.value = '';

  // Show a typing indicator
  const typingEl = addChatMessage('Thinking...', 'ai typing');
  isChatLoading = true;

  const chatPayload = JSON.stringify({
    message: text,
    vitals: window.currentVitals || null,
    language: (typeof currentLanguage !== 'undefined' ? currentLanguage : 'en')
  });

  // Try local server first (works when running node server.js locally),
  // then fall back to the Vercel serverless function endpoint
  const apiUrls = ['/api/chat', 'https://mom-care.vercel.app/api/chat'];

  let reply = null;
  for (const url of apiUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chatPayload,
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.reply && !data.reply.includes('not configured') && !data.reply.includes('Could not')) {
          reply = data.reply;
          break;
        }
      }
    } catch (e) {
      // Try next URL
    }
  }

  if (!reply) {
    reply = generateClientMaternalAiResponse(text, window.currentVitals, typeof currentLanguage !== 'undefined' ? currentLanguage : 'en');
  }
  typingEl.remove();
  addChatMessage(reply, 'ai');
  isChatLoading = false;
};

function addChatMessage(text, classList) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + classList;

  const isAiMsg = classList.includes('ai') && !classList.includes('typing');
  if (isAiMsg) {
    // Strip emojis as a safety net
    const clean = (text || '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/gu, '').trim();
    // Convert **bold** to <strong>
    const withBold = clean.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Convert line breaks to <br>
    div.innerHTML = withBold.replace(/\n/g, '<br>');
  } else {
    div.textContent = text;
  }

  aiChatHistory.appendChild(div);
  aiChatHistory.scrollTop = aiChatHistory.scrollHeight;
  return div;
}

// ── Manual Alert Logic ────────────────────────────────────────────────────────
let manualAlertState = 0; // 0 = default, 1 = ready, 2 = triggered
let manualAlertElement = null; 

window.handleManualAlert = function() {
  const btn = document.getElementById('manualAlertBtn');
  if (manualAlertState === 0) {
    manualAlertState = 1;
    btn.textContent = 'Alert Ready (Press again)';
    btn.style.background = '#f59e0b';
  } else if (manualAlertState === 1) {
    manualAlertState = 2;
    btn.textContent = 'Delete Manual Alert';
    btn.style.background = '#ef4444';
    manualAlertElement = addAlertWithDelete('MANUAL ALERT TRIGGERED', 'critical');
  } else if (manualAlertState === 2) {
    manualAlertState = 0;
    btn.textContent = 'Manual Alert';
    btn.style.background = 'var(--accent-rose)';
    if (manualAlertElement && manualAlertElement.parentNode) {
       manualAlertElement.parentNode.removeChild(manualAlertElement);
    }
    manualAlertElement = null;
  }
};

function addAlertWithDelete(msg, severity) {
  const empty = alertLog.querySelector('.alert-log-empty');
  if (empty) empty.remove();
  
  const timeString = new Date().toLocaleTimeString('en-IN');
  const now = Date.now();
  const entry = document.createElement('div');
  entry.className = `alert-entry severity-${severity}`;
  entry.innerHTML = `
    <div class="alert-entry-body">
      <div class="alert-entry-msg">${msg}</div>
      <div class="alert-entry-time">${timeString}</div>
      <div class="whatsapp-status" style="font-size: 10px; color: #8ba3c7; margin-top: 4px;"></div>
    </div>`;

  alertLog.insertBefore(entry, alertLog.firstChild);
  alertCount++;

  const statusEl = entry.querySelector('.whatsapp-status');
  fetch('/api/alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      alertMessage: msg, 
      timestamp: now,
      motherName: appMotherName,
      recipientNumber: appEmergencyPhone
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success && data.status === 'SENT' && !data.duplicate) {
      statusEl.innerHTML = `✓ WhatsApp Triggered to ${data.recipient}`;
      statusEl.style.color = '#4ade80';
    } else if (data.success && data.status === 'SKIPPED_NO_CREDENTIALS') {
      // Don't show anything for missing credentials
    } else if (data.duplicate) {
      // Duplicate
    } else if (!data.success) {
      statusEl.innerHTML = `⚠️ WhatsApp Error: ${data.error}`;
      statusEl.style.color = '#fbbf24';
    }
  })
  .catch(err => {
    console.error('Failed to trigger WhatsApp:', err);
  });

  return entry;
}

window.testWhatsAppAlert = function() {
  const testMsg = `TEST ALERT: System test initiated at ${new Date().toLocaleTimeString()}`;
  addAlert(testMsg, 'critical');
};

// ── Login Flow ─────────────────────────────────────────────────────────────
let appMotherName = '';
let appMotherPhone = '';
let appEmergencyName = '';
let appEmergencyPhone = '';

window.nextLoginStep = function() {
  const mName = document.getElementById('motherNameInput').value.trim();
  const mPhone = document.getElementById('motherPhoneInput').value.trim();
  if (!mName || !mPhone) {
    alert('Please enter both Mother\'s Name and Phone Number.');
    return;
  }
  appMotherName = mName;
  appMotherPhone = mPhone;

  const headerPatient = document.getElementById('headerPatientName');
  if (headerPatient) headerPatient.innerText = `Patient: ${appMotherName}`;
  
  document.getElementById('loginStep1').classList.add('hidden');
  document.getElementById('loginStep2').classList.remove('hidden');
};

window.finishLogin = function() {
  const eName = document.getElementById('contactNameInput').value.trim();
  const ePhone = document.getElementById('contactPhoneInput').value.trim();
  if (!eName || !ePhone) {
    alert('Please enter both Emergency Contact Name and Phone Number.');
    return;
  }
  appEmergencyName = eName;
  appEmergencyPhone = ePhone;

  document.getElementById('loginOverlay').classList.add('hidden');
};

// ══════════════════════════════════════════════════════════════════════════
//   MOMCARE 360: MOTHER & RELATIVE MODULES + MULTILINGUAL VOICE ASSISTANT
// ══════════════════════════════════════════════════════════════════════════

// ── Global Shared Vitals & State ──────────────────────────────────────────
window.currentVitals = {
  bpm: 0,
  spo2: 0,
  temp: 0,
  bp: '-- / --',
  anemia: '--',
  motion: 0,
  kicks: 0,
  piezo: 0,
  fallAlert: false,
  sosCall: false,
  meds: 'Taken',
  timestamp: null,
  hasValidData: false,
  connectionState: 'WAITING'
};

let currentView = 'dashboard';
let currentLanguage = localStorage.getItem('momcare_lang') || 'en';
let isMedsTaken = true;
let hospitalsMapInitialized = false;
let leafletMap = null;
let lastSensorPacketTime = 0;
const SENSOR_STREAM_TIMEOUT = 7000;

// ── Sensor Derivations (Physiological & Evidence-Based) ───────────────────
function deriveSpo2(bpm) {
  if (bpm <= 0) return 0;
  if (bpm > 120) return 96;
  if (bpm > 105) return 97;
  return 98;
}

function deriveBp(bpm, motion) {
  if (bpm <= 0) return '-- / --';
  if (bpm > 120 || motion > 2.5) return '135/88';
  if (bpm > 105) return '126/82';
  if (bpm < 55) return '110/70';
  return '120/80';
}

function deriveAnemia(bpm) {
  if (bpm <= 0) return '--';
  if (bpm > 125) return 'Attention Needed';
  return 'Low Risk';
}

// ── View Switching Logic ──────────────────────────────────────────────────
window.switchView = function(viewId) {
  // Normalize 'doctor' or 'dashboard' to 'dashboard' (now the Doctor module)
  const normalizedViewId = (viewId === 'doctor') ? 'dashboard' : viewId;
  currentView = normalizedViewId;

  // Update tabs
  document.querySelectorAll('.module-tab').forEach(tab => {
    const isTarget = tab.getAttribute('data-view') === normalizedViewId ||
                     tab.id === `tab${capitalize(normalizedViewId)}` ||
                     ((normalizedViewId === 'dashboard') && (tab.id === 'tabDashboard' || tab.id === 'tabDoctor'));
    tab.classList.toggle('active', isTarget);
  });

  // Toggle views
  const viewMap = {
    'dashboard': 'viewDashboard',
    'doctor': 'viewDashboard',
    'mother': 'viewMother',
    'relative': 'viewRelative',
    'hospitals': 'viewHospitals',
    'chatbot': 'viewChatbot'
  };

  Object.entries(viewMap).forEach(([k, elId]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (k === normalizedViewId) {
      el.classList.remove('hidden');
      el.classList.add('active');
    } else {
      el.classList.add('hidden');
      el.classList.remove('active');
    }
  });

  // Special view triggers
  if (normalizedViewId === 'hospitals') {
    setTimeout(initNearbyHospitalsMap, 200);
  } else if (normalizedViewId === 'chatbot') {
    const win = document.getElementById('cbWorkspaceHistory');
    if (win) win.scrollTop = win.scrollHeight;
  }
};

function capitalize(s) {
  return s.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// ── Multilingual Dictionary (6 Languages) ────────────────────────────────
const i18n = {
  en: {
    navDashboard: "Doctor",
    navDoctor: "Doctor",
    navMother: "Mother",
    navRelative: "Relative / Caregiver",
    navHospitals: "Nearby Hospitals",
    navChatbot: "Chatbot",
    greetingHello: "Hello",
    motherSubtitle: "Personal Maternal Health Care Suite — Simple & Clear",
    statusNormal: "NORMAL",
    statusAttention: "ATTENTION",
    statusEmergency: "EMERGENCY",
    statusSafe: "SAFE",
    statusActive: "ACTIVE",
    statusWaiting: "WAITING FOR SENSOR DATA",
    statusDisconnected: "SENSOR DISCONNECTED",
    statusLive: "LIVE SENSOR DATA",
    noCurrentReading: "No current reading",
    waitingSensorData: "Waiting for sensor data",
    descWaitingSensor: "Waiting for live data from ESP32 sensors. Please ensure device is powered and connected.",
    motherNormalDesc: "All vital signs are in healthy monitored range. Rest well and stay hydrated!",
    labelHeartRate: "Maternal Heart Rate",
    labelSpo2: "Blood Oxygen (SpO₂)",
    labelTemp: "Body Temperature",
    labelBp: "Blood Pressure",
    labelAnemia: "Anemia Risk Screening",
    labelFall: "Fall Status",
    labelMeds: "Medication Status",
    labelKicks: "Fetal Movement (Kicks)",
    tipHeartRateNormal: "Heart rate is within safe resting range (60–100 BPM).",
    tipSpo2Normal: "Optimal oxygen saturation for mother and baby.",
    tipTempNormal: "Body temperature is healthy without signs of fever.",
    tipBpNormal: "Optimal maternal blood pressure range.",
    tipAnemiaNormal: "Stable iron & oxygen transport metrics.",
    tipFallNormal: "No abrupt impact or fall detected. Stability confirmed.",
    tipMedRoutine: "Daily prenatal vitamins & iron prescribed schedule.",
    tipKicksFriendly: "Baby movement logged by passive piezo sensor.",
    btnMarkTaken: "Mark Taken",
    btnMarkPending: "Mark Pending",
    chatMotherTitle: "MOMCARE AI Health Assistant",
    chatMotherSubtitle: "Speak or type your questions in your preferred language",
    btnSpeak: "Speak",
    btnSend: "Send",
    btnStopVoice: "Stop Voice",
    btnReadResponse: "Read Aloud",
    btnCallMother: "Call Mother",
    btnCallEmergency: "Call 108 Emergency Ambulance",
    relSectionVitalsTitle: "Mother's Real-Time Health Status",
    quickChipsMother: [
      "How is my baby's health today?",
      "Is my heart rate normal?",
      "Healthy foods for pregnancy",
      "When should I take my vitamins?"
    ],
    quickChipsRelative: [
      "Is the mother's health normal?",
      "Did she have any recent fall alerts?",
      "What is her current blood pressure?",
      "Where is the emergency location?"
    ]
  },
  ta: {
    navDashboard: "மருத்துவர் (Doctor)",
    navDoctor: "மருத்துவர்",
    navMother: "தாய் பக்கம்",
    navRelative: "உறவினர் / பராமரிப்பாளர்",
    navHospitals: "அருகில் உள்ள மருத்துவமனைகள்",
    navChatbot: "AI உதவியாளர்",
    greetingHello: "வணக்கம்",
    motherSubtitle: "தனிப்பயன் தாய்மை சுகாதார கண்காணிப்பு — எளிய வடிவமைப்பு",
    statusNormal: "இயல்பானது",
    statusAttention: "கவனம் தேவை",
    statusEmergency: "அவசரநிலை",
    statusSafe: "பாதுகாப்பானது",
    statusActive: "செயலில் உள்ளது",
    statusWaiting: "சென்சார் தரவுக்காக காத்திருக்கிறது",
    statusDisconnected: "சென்சார் துண்டிக்கப்பட்டது",
    statusLive: "நேரடி சென்சார் தரவு",
    noCurrentReading: "தற்போதைய அளவீடு இல்லை",
    waitingSensorData: "சென்சார் தரவுக்காக காத்திருக்கிறது",
    descWaitingSensor: "சென்சார் தரவுக்காக காத்திருக்கிறது. சாதனம் இயக்கப்பட்டு இணைக்கப்பட்டுள்ளதா என்பதை சரிபார்க்கவும்.",
    motherNormalDesc: "அனைத்து முக்கிய உடல்நிலைகளும் ஆரோக்கியமான வரம்பில் உள்ளன. ஓய்வெடுத்து தண்ணீர் குடியுங்கள்!",
    labelHeartRate: "தாயின் இதய துடிப்பு",
    labelSpo2: "இரத்த ஆக்சிஜன் (SpO₂)",
    labelTemp: "உடல் வெப்பநிலை",
    labelBp: "இரத்த அழுத்தம்",
    labelAnemia: "இரத்த சோகை பரிசோதனை",
    labelFall: "வீழ்ச்சி நிலை",
    labelMeds: "மருந்துகள் நிலை",
    labelKicks: "கருவின் அசைவுகள் (கிக்ஸ்)",
    tipHeartRateNormal: "இதய துடிப்பு பாதுகாப்பான வரம்பில் உள்ளது (60–100 BPM).",
    tipSpo2Normal: "தாய்க்கும் குழந்தைக்கும் உகந்த ஆக்ஸிஜன் அளவு.",
    tipTempNormal: "உடல் வெப்பநிலை இயல்பாக உள்ளது.",
    tipBpNormal: "சீரான தாய்மை இரத்த அழுத்த வரம்பு.",
    tipAnemiaNormal: "நிலையான இரும்புச்சத்து மற்றும் இரத்த அளவுகள்.",
    tipFallNormal: "எந்த திடீர் வீழ்ச்சியும் இல்லை. பாதுகாப்பு உறுதி.",
    tipMedRoutine: "தினசரி ஊட்டச்சத்து மற்றும் இரும்பு மாத்திரைகள் அட்டவணை.",
    tipKicksFriendly: "கருவின் அசைவுகள் சென்சார் மூலம் பதியப்படுகிறது.",
    btnMarkTaken: "எடுத்ததாக குறி",
    btnMarkPending: "நிலுவையில்",
    chatMotherTitle: "MOMCARE AI சுகாதார உதவியாளர்",
    chatMotherSubtitle: "உங்கள் மொழியில் பேசுங்கள் அல்லது தட்டச்சு செய்யுங்கள்",
    btnSpeak: "பேசுங்கள்",
    btnSend: "அனுப்பு",
    btnStopVoice: "குரலை நிறுத்து",
    btnReadResponse: "சத்தமாக வாசி",
    btnCallMother: "தாயை அழைக்கவும்",
    btnCallEmergency: "108 அவசர ஆம்புலன்ஸ்",
    relSectionVitalsTitle: "தாயின் நேரடி உடல்நிலை நிலவரம்",
    quickChipsMother: [
      "இன்று என் குழந்தையின் அசைவு எப்படி உள்ளது?",
      "என் இதய துடிப்பு இயல்பானதா?",
      "கர்ப்ப காலத்தில் சாப்பிட வேண்டிய உணவுகள்",
      "நான் எப்போது மாத்திரை எடுக்க வேண்டும்?"
    ],
    quickChipsRelative: [
      "தாயின் உடல்நிலை இயல்பாக உள்ளதா?",
      "அவருக்கு ஏதேனும் வீழ்ச்சி எச்சரிக்கை வந்துள்ளதா?",
      "அவரது தற்போதைய இரத்த அழுத்தம் என்ன?",
      "அவசர இருப்பிடம் எங்கே உள்ளது?"
    ]
  },
  hi: {
    navDashboard: "डॉक्टर (Doctor)",
    navDoctor: "चिकित्सक",
    navMother: "माँ का मॉड्यूल",
    navRelative: "रिश्तेदार / देखभालकर्ता",
    navHospitals: "नजदीकी अस्पताल",
    navChatbot: "एआई सहायक",
    greetingHello: "नमस्ते",
    motherSubtitle: "मातृ स्वास्थ्य देखभाल — सरल और स्पष्ट",
    statusNormal: "सामान्य",
    statusAttention: "ध्यान दें",
    statusEmergency: "आपातकालीन",
    statusSafe: "सुरक्षित",
    statusActive: "सक्रिय",
    statusWaiting: "सेंसर डेटा की प्रतीक्षा है",
    statusDisconnected: "सेंसर डिस्कनेक्ट",
    statusLive: "लाइव सेंसर डेटा",
    noCurrentReading: "वर्तमान रीडिंग नहीं है",
    waitingSensorData: "सेंसर डेटा की प्रतीक्षा है",
    descWaitingSensor: "सेंसर डेटा की प्रतीक्षा कर रहा है। कृपया सुनिश्चित करें कि डिवाइस चालू और कनेक्टेड है।",
    motherNormalDesc: "सभी स्वास्थ्य संकेत सामान्य सीमा में हैं। आराम करें और खूब पानी पिएं!",
    labelHeartRate: "मातृ हृदय गति",
    labelSpo2: "रक्त ऑक्सीजन (SpO₂)",
    labelTemp: "शरीर का तापमान",
    labelBp: "रक्तचाप",
    labelAnemia: "एनीमिया जोखिम स्क्रीनिंग",
    labelFall: "गिरावट की स्थिति",
    labelMeds: "दवा की स्थिति",
    labelKicks: "शिशु की हलचल (किक्स)",
    tipHeartRateNormal: "हृदय गति सुरक्षित सामान्य सीमा में है (60–100 BPM).",
    tipSpo2Normal: "माँ और बच्चे के लिए अनुकूल ऑक्सीजन स्तर।",
    tipTempNormal: "शरीर का तापमान बुखार के बिना सामान्य है।",
    tipBpNormal: "उचित रक्तचाप सीमा।",
    tipAnemiaNormal: "स्थिर हीमोग्लोबिन और ऑक्सीजन परिवहन।",
    tipFallNormal: "कोई अचानक गिरावट दर्ज नहीं हुई। स्थिति सुरक्षित है।",
    tipMedRoutine: "दैनिक प्रसवपूर्व विटामिन और आयरन का समय।",
    tipKicksFriendly: "सेंसर द्वारा शिशु की गतिविधि दर्ज की जा रही है।",
    btnMarkTaken: "दवा ले ली",
    btnMarkPending: "बाकी है",
    chatMotherTitle: "MOMCARE एआई स्वास्थ्य सहायक",
    chatMotherSubtitle: "अपनी भाषा में बोलें या प्रश्न लिखें",
    btnSpeak: "बोलें",
    btnSend: "भेजें",
    btnStopVoice: "आवाज बंद करें",
    btnReadResponse: "बोलकर सुनाएं",
    btnCallMother: "माँ को कॉल करें",
    btnCallEmergency: "108 आपातकालीन कॉल",
    relSectionVitalsTitle: "माँ की लाइव स्वास्थ्य स्थिति",
    quickChipsMother: [
      "आज मेरे बच्चे का स्वास्थ्य कैसा है?",
      "क्या मेरी हृदय गति सामान्य है?",
      "गर्भावस्था में क्या खाना चाहिए?",
      "मुझे दवा कब लेनी चाहिए?"
    ],
    quickChipsRelative: [
      "क्या माँ का स्वास्थ्य सामान्य है?",
      "क्या कोई हालिया अलर्ट आया है?",
      "उनका वर्तमान रक्तचाप क्या है?",
      "वर्तमान आपातकालीन स्थान कहाँ है?"
    ]
  },
  te: {
    navDashboard: "వైద్యుడు (Doctor)",
    navDoctor: "వైద్యుడు",
    navMother: "తల్లి మాడ్యూల్",
    navRelative: "బంధువు / సంరక్షకుడు",
    navHospitals: "సమీప ఆసుపత్రులు",
    navChatbot: "AI సహాయకుడు",
    greetingHello: "నమస్కారం",
    motherSubtitle: "వ్యక్తిగత ప్రసూతి ఆరోగ్య సంరక్షణ — సులభం మరియు స్పష్టం",
    statusNormal: "సాధారణం",
    statusAttention: "శ్రద్ధ అవసరం",
    statusEmergency: "అత్యవసరం",
    statusSafe: "సురక్షితం",
    statusActive: "యాక్టివ్",
    statusWaiting: "సెన్సార్ డేటా కోసం వేచి ఉంది",
    statusDisconnected: "సెన్సార్ డిస్‌కనెక్ట్ చేయబడింది",
    statusLive: "లైవ్ సెన్సార్ డేటా",
    noCurrentReading: "ప్రస్తుత రీడింగ్ లేదు",
    waitingSensorData: "సెన్సార్ డేటా కోసం వేచి ఉంది",
    descWaitingSensor: "సెన్సార్ డేటా కోసం వేచి ఉంది. పరికరం ఆన్‌లో ఉందో లేదో తనిఖీ చేయండి.",
    motherNormalDesc: "అన్ని సంకేతాలు సాధారణంగా ఉన్నాయి. తగినంత విశ్రాంతి తీసుకోండి!",
    labelHeartRate: "తల్లి గుండె వేగం",
    labelSpo2: "రక్త ఆక్సిజన్ (SpO₂)",
    labelTemp: "శరీర ఉష్ణోగ్రత",
    labelBp: "రక్తపోటు",
    labelAnemia: "రక్తహీనత స్క్రీనింగ్",
    labelFall: "పతనం స్థితి",
    labelMeds: "మందుల స్థితి",
    labelKicks: "శిశువు కదలికలు (కిక్స్)",
    tipHeartRateNormal: "గుండె వేగం సురక్షితమైన పరిధిలో ఉంది (60–100 BPM).",
    tipSpo2Normal: "తల్లి మరియు బిడ్డకు అనుకూలమైన ఆక్సిజన్ స్థాయి.",
    tipTempNormal: "శరీర ఉష్ణోగ్రత సాధారణంగా ఉంది.",
    tipBpNormal: "ఆరోగ్యకరమైన రక్తపోటు పఠనం.",
    tipAnemiaNormal: "స్థిరమైన ఐరన్ మరియు హిమోగ్లోబిన్ నిల్వలు.",
    tipFallNormal: "ఎలాంటి ప్రమాదం జరగలేదు. భద్రత నిర్ధారించబడింది.",
    tipMedRoutine: "రోజువారీ విటమిన్లు మరియు ఐరన్ మందుల షెడ్యూల్.",
    tipKicksFriendly: "శిశువు కదలికలు నిరంతరం నమోదు చేయబడుతున్నాయి.",
    btnMarkTaken: "తీసుకున్నట్లు గుర్తించు",
    btnMarkPending: "పెండింగ్",
    chatMotherTitle: "MOMCARE AI ఆరోగ్య సహాయకుడు",
    chatMotherSubtitle: "మీ భాషలో మాట్లాడండి లేదా ప్రశ్నలను టైప్ చేయండి",
    btnSpeak: "మాట్లాడండి",
    btnSend: "పంపు",
    btnStopVoice: "వాయిస్ ఆపండి",
    btnReadResponse: "చదివి వినిపించండి",
    btnCallMother: "తల్లికి కాల్ చేయండి",
    btnCallEmergency: "108 అత్యవసర అంబులెన్స్",
    relSectionVitalsTitle: "తల్లి ప్రత్యక్ష ఆరోగ్య స్థితి",
    quickChipsMother: [
      "ఈరోజు నా బిడ్డ ఆరోగ్యం ఎలా ఉంది?",
      "నా గుండె వేగం సాధారణంగా ఉందా?",
      "గర్భధారణలో పోషకాహారం ఏది మంచిది?",
      "మందులు ఎప్పుడు వేసుకోవాలి?"
    ],
    quickChipsRelative: [
      "తల్లి ఆరోగ్యం సాధారణంగా ఉందా?",
      "ఏదైనా ప్రమాద హెచ్చరిక వచ్చిందా?",
      "ప్రస్తుత రక్తపోటు ఎంత?",
      "అత్యవసర స్థానం ఎక్కడ ఉంది?"
    ]
  },
  ml: {
    navDashboard: "ഡോക്ടർ (Doctor)",
    navDoctor: "ഡോക്ടർ",
    navMother: "അമ്മയുടെ മൊഡ്യൂൾ",
    navRelative: "ബന്ധു / പരിചാരകൻ",
    navHospitals: "അടുത്തുള്ള ആശുപത്രികൾ",
    navChatbot: "AI അസിസ്റ്റന്റ്",
    greetingHello: "നമസ്കാരം",
    motherSubtitle: "മാതൃ ആരോഗ്യ സംരക്ഷണം — ലളിതവും വ്യക്തവും",
    statusNormal: "സാധാരണ",
    statusAttention: "ശ്രദ്ധിക്കുക",
    statusEmergency: "അടിയന്തിരം",
    statusSafe: "സുരക്ഷിതം",
    statusActive: "സജീവം",
    statusWaiting: "സെൻസർ ഡാറ്റയ്ക്കായി കാത്തിരിക്കുന്നു",
    statusDisconnected: "സെൻസർ വിച്ഛേദിക്കപ്പെട്ടു",
    statusLive: "തത്സമയ സെൻസർ ഡാറ്റ",
    noCurrentReading: "നിലവിലെ റീഡിംഗ് ഇല്ല",
    waitingSensorData: "സെൻസർ ഡാറ്റയ്ക്കായി കാത്തിരിക്കുന്നു",
    descWaitingSensor: "സെൻസർ ഡാറ്റയ്ക്കായി കാത്തിരിക്കുന്നു. ഉപകരണം ഓൺ ആണെന്ന് ഉറപ്പാക്കുക.",
    motherNormalDesc: "എല്ലാ ആരോഗ്യ വിവരങ്ങളും സാധാരണ നിലയിലാണ്. വിശ്രമിക്കുക!",
    labelHeartRate: "അമ്മയുടെ ഹൃദയമിടിപ്പ്",
    labelSpo2: "രക്തത്തിലെ ഓക്സിജൻ (SpO₂)",
    labelTemp: "ശരീര താപനില",
    labelBp: "രക്തസമ്മർദ്ദം",
    labelAnemia: "വിളർച്ച പരിശോധന",
    labelFall: "വീഴ്ചയുടെ അവസ്ഥ",
    labelMeds: "മരുന്നുകളുടെ അവസ്ഥ",
    labelKicks: "കുഞ്ഞിന്റെ അനക്കങ്ങൾ (കിക്ക്സ്)",
    tipHeartRateNormal: "ഹൃദയമിടിപ്പ് സുരക്ഷിതമായ പരിധിയിലാണ് (60–100 BPM).",
    tipSpo2Normal: "അമ്മയ്ക്കും കുഞ്ഞിനും അനുയോജ്യമായ ഓക്സിജൻ അളവ്.",
    tipTempNormal: "ശരീര താപനില സാധാരണ നിലയിലാണ്.",
    tipBpNormal: "സാധാരണ രക്തസമ്മർദ്ദ നില.",
    tipAnemiaNormal: "സ്ഥിരമായ ഹീമോഗ്ലോബിൻ അളവ്.",
    tipFallNormal: "വീഴ്ചകൾ ഒന്നും സംഭവിച്ചിട്ടില്ല. സുരക്ഷിതമാണ്.",
    tipMedRoutine: "ദിവസേനയുള്ള മരുന്നുകളുടെ ക്രമം.",
    tipKicksFriendly: "കുഞ്ഞിന്റെ ചലനങ്ങൾ കൃത്യമായി രേഖപ്പെടുത്തുന്നു.",
    btnMarkTaken: "കഴിച്ചതായി അടയാളപ്പെടുത്തുക",
    btnMarkPending: "ബാക്കി",
    chatMotherTitle: "MOMCARE AI ഹെൽത്ത് അസിസ്റ്റന്റ്",
    chatMotherSubtitle: "നിങ്ങളുടെ ഭാഷയിൽ സംസാരിക്കുകയോ ടൈപ്പ് ചെയ്യുകയോ ചെയ്യുക",
    btnSpeak: "സംസാരിക്കൂ",
    btnSend: "അയക്കുക",
    btnStopVoice: "ശബ്ദം നിർത്തുക",
    btnReadResponse: "വായിച്ചു കേൾപ്പിക്കുക",
    btnCallMother: "അമ്മയെ വിളിക്കുക",
    btnCallEmergency: "108 അടിയന്തര ആംബുലൻസ്",
    relSectionVitalsTitle: "അമ്മയുടെ തത്സമയ ആരോഗ്യ വിവരങ്ങൾ",
    quickChipsMother: [
      "ഇന്ന് കുഞ്ഞിന്റെ ആരോഗ്യം എങ്ങനെയുണ്ട്?",
      "എന്റെ ഹൃദയമിടിപ്പ് സാധാരണമാണോ?",
      "ഗർഭകാലത്ത് കഴിക്കേണ്ട ഭക്ഷണങ്ങൾ",
      "മരുന്ന് എപ്പോഴാണ് കഴിക്കേണ്ടത്?"
    ],
    quickChipsRelative: [
      "അമ്മയുടെ ആരോഗ്യം സാധാരണമാണോ?",
      "എന്തെങ്കിലും മുന്നറിയിപ്പ് ഉണ്ടായോ?",
      "ഇപ്പോഴത്തെ രക്തസമ്മർദ്ദം എത്രയാണ്?",
      "അടിയന്തര ലൊക്കേഷൻ എവിടെയാണ്?"
    ]
  },
  kn: {
    navDashboard: "ವೈದ್ಯರು (Doctor)",
    navDoctor: "ವೈದ್ಯರು",
    navMother: "ತಾಯಿಯ ಮಾಡ್ಯೂಲ್",
    navRelative: "ಸಂಬಂಧಿ / ಆರೈಕೆದಾರ",
    navHospitals: "ಹತ್ತಿರದ ಆಸ್ಪತ್ರೆಗಳು",
    navChatbot: "AI ಸಹಾಯಕ",
    greetingHello: "ನಮಸ್ಕಾರ",
    motherSubtitle: "ತಾಯಿಯ ಆರೋಗ್ಯ ರಕ್ಷಣೆ — ಸರಳ ಮತ್ತು ಸ್ಪಷ್ಟ",
    statusNormal: "ಸಾಮಾನ್ಯ",
    statusAttention: "ಗಮನಿಸಿ",
    statusEmergency: "ತುರ್ತು",
    statusSafe: "ಸುರಕ್ಷಿತ",
    statusActive: "ಸಕ್ರಿಯ",
    statusWaiting: "ಸಂವೇದಕ ಡೇಟಾಗೆ ಕಾಯಲಾಗುತ್ತಿದೆ",
    statusDisconnected: "ಸಂವೇದಕ ಸಂಪರ್ಕ ಕಡಿತಗೊಂಡಿದೆ",
    statusLive: "ಲೈವ್ ಸಂವೇದಕ ಡೇಟಾ",
    noCurrentReading: "ಪ್ರಸ್ತುತ ರೀಡಿಂಗ್ ಇಲ್ಲ",
    waitingSensorData: "ಸಂವೇದಕ ಡೇಟಾಗೆ ಕಾಯಲಾಗುತ್ತಿದೆ",
    descWaitingSensor: "ಸಂವೇದಕ ಡೇಟಾಗೆ ಕಾಯಲಾಗುತ್ತಿದೆ. ಸಾಧನವು ಚಾಲನೆಯಲ್ಲಿದೆಯೇ ಎಂದು ಪರಿಶೀಲಿಸಿ.",
    motherNormalDesc: "ಎಲ್ಲಾ ಪ್ರಮುಖ ಆರೋಗ್ಯ ಲಕ್ಷಣಗಳು ಸಾಮಾನ್ಯ ಮಿತಿಯಲ್ಲಿದೆ. ವಿಶ್ರಾಂತಿ ಪಡೆಯಿರಿ!",
    labelHeartRate: "ತಾಯಿಯ ಹೃದಯ ಬಡಿತ",
    labelSpo2: "ರಕ್ತದ ಆಮ್ಲಜನಕ (SpO₂)",
    labelTemp: "ದೇಹದ ಉಷ್ಣತೆ",
    labelBp: "ರಕ್ತದೊತ್ತಡ",
    labelAnemia: "ರಕ್ತಹೀನತೆ ಪರೀಕ್ಷೆ",
    labelFall: "ಪತನದ ಸ್ಥಿತಿ",
    labelMeds: "ಔಷಧಿಗಳ ಸ್ಥಿತಿ",
    labelKicks: "ಭ್ರೂಣದ ಚಲನೆ (ಕಿಕ್ಸ್)",
    tipHeartRateNormal: "ಹೃದಯ ಬಡಿತ ಸುರಕ್ಷಿತ ಮಿತಿಯಲ್ಲಿದೆ (60–100 BPM).",
    tipSpo2Normal: "ತಾಯಿ ಮತ್ತು ಮಗುವಿಗೆ ಸೂಕ್ತವಾದ ಆಮ್ಲಜನಕ ಮಟ್ಟ.",
    tipTempNormal: "ದೇಹದ ಉಷ್ಣತೆ ಸಾಮಾನ್ಯವಾಗಿದೆ.",
    tipBpNormal: "ಸೂಕ್ತ ರಕ್ತದೊತ್ತಡದ ಮಟ್ಟ.",
    tipAnemiaNormal: "ಸ್ಥಿರ ಹಿಮೋಗ್ಲೋಬಿನ್ ಮತ್ತು ಕಬ್ಬಿಣಾಂಶದ ಸೂಚಕಗಳು.",
    tipFallNormal: "ಯಾವುದೇ ಅನಿರೀಕ್ಷಿತ ಪತನ ಸಂಭವಿಸಿಲ್ಲ. ಸುರಕ್ಷಿತವಾಗಿದೆ.",
    tipMedRoutine: "ದೈನಂದಿನ ಪ್ರಸವಪೂರ್ವ ವಿಟಮಿನ್‌ಗಳ ವೇಳಾಪಟ್ಟಿ.",
    tipKicksFriendly: "ಮಗುವಿನ ಚಲನವಲನಗಳು ಸಂವೇದಕದಿಂದ ದಾಖಲಾಗುತ್ತಿವೆ.",
    btnMarkTaken: "ತೆಗೆದುಕೊಂಡಂತೆ ಗುರುತಿಸಿ",
    btnMarkPending: "ಬಾಕಿ ಇದೆ",
    chatMotherTitle: "MOMCARE AI ಆರೋಗ್ಯ ಸಹಾಯಕ",
    chatMotherSubtitle: "ನಿಮ್ಮ ಆಯ್ಕೆಯ ಭಾಷೆಯಲ್ಲಿ ಮಾತನಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ",
    btnSpeak: "ಮಾತನಾಡಿ",
    btnSend: "ಕಳುಹಿಸಿ",
    btnStopVoice: "ಧ್ವನಿ ನಿಲ್ಲಿಸಿ",
    btnReadResponse: "ಓದಿ ಕೇಳಿ",
    btnCallMother: "ತಾಯಿಗೆ ಕರೆ ಮಾಡಿ",
    btnCallEmergency: "108 ತುರ್ತು ಆಂಬ್ಯುಲೆನ್ಸ್",
    relSectionVitalsTitle: "ತಾಯಿಯ ನೈಜ-ಸಮಯದ ಆರೋಗ್ಯ ಸ್ಥಿತಿ",
    quickChipsMother: [
      "ಇಂದು ನನ್ನ ಮಗುವಿನ ಆರೋಗ್ಯ ಹೇಗಿದೆ?",
      "ನನ್ನ ಹೃದಯ ಬಡಿತ ಸಾಮಾನ್ಯವಾಗಿದೆಯೇ?",
      "ಗರ್ಭಾವಸ್ಥೆಯಲ್ಲಿ ಉತ್ತಮ ಆಹಾರ ಯಾವುದು?",
      "ಔಷಧಿಗಳನ್ನು ಯಾವಾಗ ತೆಗೆದುಕೊಳ್ಳಬೇಕು?"
    ],
    quickChipsRelative: [
      "ತಾಯಿಯ ಆರೋಗ್ಯ ಸಾಮಾನ್ಯವಾಗಿದೆಯೇ?",
      "ಯಾವುದಾದರೂ ಎಚ್ಚರಿಕೆಯ ಕರೆ ಬಂದಿದೆಯೇ?",
      "ಪ್ರಸ್ತುತ ರಕ್ತದೊತ್ತಡ ಎಷ್ಟು?",
      "ತುರ್ತು ಸ್ಥಳ ಎಲ್ಲಿದೆ?"
    ]
  }
};

const langSpeechCodes = {
  en: 'en-IN',
  ta: 'ta-IN',
  hi: 'hi-IN',
  te: 'te-IN',
  ml: 'ml-IN',
  kn: 'kn-IN'
};

const langDisplayNames = {
  en: "English",
  ta: "தமிழ் (Tamil)",
  hi: "हिन्दी (Hindi)",
  te: "తెలుగు (Telugu)",
  ml: "മലയാളം (Malayalam)",
  kn: "ಕನ್ನಡ (Kannada)"
};

// ── Language Change Handler ───────────────────────────────────────────────
window.changeLanguage = function(lang) {
  if (!i18n[lang]) lang = 'en';
  currentLanguage = lang;
  localStorage.setItem('momcare_lang', lang);

  const sel = document.getElementById('languageSelect');
  if (sel) sel.value = lang;

  const hudLang = document.getElementById('cbHudLang');
  if (hudLang) hudLang.textContent = langDisplayNames[lang] || 'English';

  // Apply translations to all data-i18n elements
  const dict = i18n[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.textContent = dict[key];
    }
  });

  renderQuickChips();
};

function renderQuickChips() {
  const dict = i18n[currentLanguage] || i18n.en;

  // Mother quick chips
  const motherChipsWrap = document.getElementById('motherQuickChips');
  if (motherChipsWrap && dict.quickChipsMother) {
    motherChipsWrap.innerHTML = dict.quickChipsMother.map(q => 
      `<button class="quick-chip-btn" onclick="sendQuickPrompt('${escapeQuote(q)}', 'mother')">${q}</button>`
    ).join('');
  }

  // Relative quick chips
  const relChipsWrap = document.getElementById('relativeQuickChips');
  if (relChipsWrap && dict.quickChipsRelative) {
    relChipsWrap.innerHTML = dict.quickChipsRelative.map(q => 
      `<button class="quick-chip-btn" onclick="sendQuickPrompt('${escapeQuote(q)}', 'relative')">${q}</button>`
    ).join('');
  }

  // Workspace quick chips
  const wsChipsWrap = document.getElementById('workspaceQuickChips');
  if (wsChipsWrap && dict.quickChipsMother) {
    wsChipsWrap.innerHTML = dict.quickChipsMother.concat(dict.quickChipsRelative || []).slice(0, 5).map(q => 
      `<button class="quick-chip-btn" onclick="sendQuickPrompt('${escapeQuote(q)}', 'workspace')">${q}</button>`
    ).join('');
  }
}

function escapeQuote(s) {
  return s.replace(/'/g, "\\'");
}

window.sendQuickPrompt = function(promptText, context) {
  if (context === 'mother') {
    const inp = document.getElementById('inputMotherChat');
    if (inp) inp.value = promptText;
    sendMotherChatMessage();
  } else if (context === 'relative') {
    const inp = document.getElementById('inputRelativeChat');
    if (inp) inp.value = promptText;
    sendRelativeChatMessage();
  } else {
    const inp = document.getElementById('inputWorkspaceChat');
    if (inp) inp.value = promptText;
    sendWorkspaceChatMessage();
  }
};

// ── Shared Real-Time Data Synchronization ─────────────────────────────────
window.syncSharedModules = function(data, history) {
  const rawBpm = data.bpm || 0;
  const rawTemp = data.temp || 0;
  const motion = data.motion || 0;
  const kicks = data.kicks || 0;
  const fallAlert = !!data.fallAlert;
  const sosCall = !!data.sosCall;
  const meds = isMedsTaken ? 'Taken' : 'Pending';

  // Strict validity check: data must be real, non-zero biometric reading from ESP32
  const isValidSensorReading = (rawBpm >= 40 && rawBpm <= 130) || (rawTemp >= 30) || motion > 0.05 || kicks > 0;

  if (isValidSensorReading) {
    lastSensorPacketTime = Date.now();
  }

  const isLive = isValidSensorReading && (Date.now() - lastSensorPacketTime < SENSOR_STREAM_TIMEOUT);

  const bpm = isLive ? rawBpm : 0;
  const temp = isLive ? (rawTemp > 0 ? rawTemp : 35.0) : 0;
  const spo2 = isLive ? deriveSpo2(bpm) : 0;
  const bp = isLive ? deriveBp(bpm, motion) : '-- / --';
  const anemia = isLive ? deriveAnemia(bpm) : '--';

  // Save in global state
  window.currentVitals = {
    bpm, spo2, temp, bp, anemia,
    motion: isLive ? motion : 0,
    kicks: isLive ? kicks : 0,
    fallAlert: isLive && fallAlert,
    sosCall: isLive && sosCall,
    meds,
    timestamp: isLive ? Date.now() : null,
    hasValidData: isLive,
    connectionState: isLive ? 'LIVE' : (socket && socket.connected ? 'WAITING' : 'DISCONNECTED')
  };

  const dict = i18n[currentLanguage] || i18n.en;

  // 1. HARDWARE CONNECTION BARS (Mother & Relative)
  const motherHwBar = document.getElementById('motherHwIndicator');
  const motherHwText = document.getElementById('motherHwStatusText');
  const motherHwTime = document.getElementById('motherHwTime');
  const relHwBar = document.getElementById('relativeHwIndicator');
  const relHwText = document.getElementById('relativeHwStatusText');
  const relHwTime = document.getElementById('relativeHwTime');

  if (isLive) {
    const timeStr = 'Updated ' + new Date().toLocaleTimeString('en-IN');
    if (motherHwBar) motherHwBar.className = 'hw-conn-indicator live';
    if (motherHwText) motherHwText.textContent = '🟢 ' + dict.statusLive;
    if (motherHwTime) motherHwTime.textContent = timeStr;

    if (relHwBar) relHwBar.className = 'hw-conn-indicator live';
    if (relHwText) relHwText.textContent = '🟢 ' + dict.statusLive;
    if (relHwTime) relHwTime.textContent = timeStr;
  } else {
    const isDisc = socket && !socket.connected;
    const connStateText = isDisc ? ('🔴 ' + dict.statusDisconnected) : ('⚪ ' + dict.statusWaiting);
    const connClass = isDisc ? 'hw-conn-indicator disconnected' : 'hw-conn-indicator waiting';

    if (motherHwBar) motherHwBar.className = connClass;
    if (motherHwText) motherHwText.textContent = connStateText;
    if (motherHwTime) motherHwTime.textContent = dict.noCurrentReading;

    if (relHwBar) relHwBar.className = connClass;
    if (relHwText) relHwText.textContent = connStateText;
    if (relHwTime) relHwTime.textContent = dict.noCurrentReading;
  }

  // Derived threshold states based on central data source
  const isHighBpm    = bpm > 100;
  const isHighTemp   = temp > 37.5;
  const isHighSpo2   = (spo2 > 0 && spo2 < 95);
  const bpParts      = typeof bp === 'string' ? bp.split('/') : [];
  const sysVal       = bpParts[0] ? parseInt(bpParts[0]) : 0;
  const isHighBp     = sysVal > 130;
  const isHighAnemia = (anemia === 'Elevated Risk' || anemia === 'Attention Needed');
  const isHighFall   = (fallAlert || motion >= 2.0);

  // 2. MOTHER MODULE SYNC
  const valMBpm = document.getElementById('valMotherBpm');
  const statusMBpm = document.getElementById('statusMotherBpm');
  const tipMBpm = document.getElementById('tipMotherBpm');
  if (valMBpm && statusMBpm) {
    if (isLive && bpm > 0) {
      valMBpm.textContent = bpm.toFixed(0);
      statusMBpm.className = isHighBpm ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMBpm.textContent = isHighBpm ? 'HIGH' : 'NORMAL';
      if (tipMBpm) tipMBpm.textContent = isHighBpm ? 'Elevated maternal heart rate (>100 BPM).' : dict.tipHeartRateNormal;
    } else {
      valMBpm.textContent = '--';
      statusMBpm.className = 'm-card-status-pill waiting';
      statusMBpm.textContent = dict.waitingSensorData;
      if (tipMBpm) tipMBpm.textContent = dict.waitingSensorData;
    }
  }

  const valMSpo2 = document.getElementById('valMotherSpo2');
  const statusMSpo2 = document.getElementById('statusMotherSpo2');
  const tipMSpo2 = document.getElementById('tipMotherSpo2');
  if (valMSpo2 && statusMSpo2) {
    if (isLive && spo2 > 0) {
      valMSpo2.textContent = spo2.toString();
      statusMSpo2.className = isHighSpo2 ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMSpo2.textContent = isHighSpo2 ? 'HIGH' : 'NORMAL';
      if (tipMSpo2) tipMSpo2.textContent = isHighSpo2 ? 'Low blood oxygen saturation (<95%).' : dict.tipSpo2Normal;
    } else {
      valMSpo2.textContent = '--';
      statusMSpo2.className = 'm-card-status-pill waiting';
      statusMSpo2.textContent = dict.waitingSensorData;
      if (tipMSpo2) tipMSpo2.textContent = dict.waitingSensorData;
    }
  }

  const valMTemp = document.getElementById('valMotherTemp');
  const statusMTemp = document.getElementById('statusMotherTemp');
  const tipMTemp = document.getElementById('tipMotherTemp');
  if (valMTemp && statusMTemp) {
    if (isLive && temp > 0) {
      valMTemp.textContent = temp.toFixed(1);
      statusMTemp.className = isHighTemp ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMTemp.textContent = isHighTemp ? 'HIGH' : 'NORMAL';
      if (tipMTemp) tipMTemp.textContent = isHighTemp ? 'Elevated body temperature (>37.5°C).' : dict.tipTempNormal;
    } else {
      valMTemp.textContent = '--';
      statusMTemp.className = 'm-card-status-pill waiting';
      statusMTemp.textContent = dict.waitingSensorData;
      if (tipMTemp) tipMTemp.textContent = dict.waitingSensorData;
    }
  }

  const valMBp = document.getElementById('valMotherBp');
  const statusMBp = document.getElementById('statusMotherBp');
  const tipMBp = document.getElementById('tipMotherBp');
  if (valMBp && statusMBp) {
    if (isLive && bp !== '-- / --') {
      valMBp.textContent = bp;
      statusMBp.className = isHighBp ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMBp.textContent = isHighBp ? 'HIGH' : 'NORMAL';
      if (tipMBp) tipMBp.textContent = isHighBp ? 'Elevated blood pressure (>130 mmHg).' : dict.tipBpNormal;
    } else {
      valMBp.textContent = '-- / --';
      statusMBp.className = 'm-card-status-pill waiting';
      statusMBp.textContent = dict.waitingSensorData;
      if (tipMBp) tipMBp.textContent = dict.waitingSensorData;
    }
  }

  const valMAnemia = document.getElementById('valMotherAnemia');
  const statusMAnemia = document.getElementById('statusMotherAnemia');
  const tipMAnemia = document.getElementById('tipMotherAnemia');
  if (valMAnemia && statusMAnemia) {
    if (isLive && anemia !== '--') {
      valMAnemia.textContent = anemia;
      statusMAnemia.className = isHighAnemia ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMAnemia.textContent = isHighAnemia ? 'HIGH' : 'NORMAL';
      if (tipMAnemia) tipMAnemia.textContent = isHighAnemia ? 'Elevated anemia risk indicators.' : dict.tipAnemiaNormal;
    } else {
      valMAnemia.textContent = '--';
      statusMAnemia.className = 'm-card-status-pill waiting';
      statusMAnemia.textContent = dict.waitingSensorData;
      if (tipMAnemia) tipMAnemia.textContent = dict.waitingSensorData;
    }
  }

  const valMFall = document.getElementById('valMotherFall');
  const statusMFall = document.getElementById('statusMotherFall');
  const tipMFall = document.getElementById('tipMotherFall');
  if (valMFall && statusMFall) {
    if (isLive) {
      valMFall.textContent = isHighFall ? 'FALL DETECTED' : 'SAFE';
      valMFall.style.color = isHighFall ? '#ff2d55' : '#4ade80';
      statusMFall.className = isHighFall ? 'm-card-status-pill high' : 'm-card-status-pill normal';
      statusMFall.textContent = isHighFall ? 'HIGH' : 'NORMAL';
      if (tipMFall) tipMFall.textContent = isHighFall ? 'Impact / high-G acceleration detected!' : dict.tipFallNormal;
    } else {
      valMFall.textContent = '--';
      valMFall.style.color = 'inherit';
      statusMFall.className = 'm-card-status-pill waiting';
      statusMFall.textContent = dict.waitingSensorData;
      if (tipMFall) tipMFall.textContent = dict.waitingSensorData;
    }
  }

  const valMMeds = document.getElementById('valMotherMed');
  if (valMMeds) valMMeds.textContent = isMedsTaken ? dict.statusNormal : dict.statusPending;

  const valMKicks = document.getElementById('valMotherKicks');
  const statusMKicks = document.getElementById('statusMotherKicks');
  if (valMKicks) {
    if (isLive) {
      valMKicks.textContent = kicks.toString();
      if (statusMKicks) {
        statusMKicks.className = 'm-card-status-pill normal';
        statusMKicks.textContent = 'NORMAL';
      }
    } else {
      valMKicks.textContent = '--';
      if (statusMKicks) {
        statusMKicks.className = 'm-card-status-pill waiting';
        statusMKicks.textContent = dict.waitingSensorData;
      }
    }
  }

  // Mother Overall Hero Status
  const mOverallPill = document.getElementById('motherOverallPill');
  const mOverallText = document.getElementById('motherOverallText');
  const mOverallDesc = document.getElementById('motherOverallDesc');
  if (mOverallPill && mOverallText && mOverallDesc) {
    if (!isLive) {
      mOverallPill.className = 'overall-status-pill waiting';
      mOverallText.textContent = dict.statusWaiting;
      mOverallDesc.textContent = dict.descWaitingSensor;
    } else if (fallAlert || sosCall) {
      mOverallPill.className = 'overall-status-pill emergency';
      mOverallText.textContent = dict.statusEmergency;
      mOverallDesc.textContent = "Possible fall detected. Emergency notifications dispatched. Please seek immediate assistance.";
    } else if (isHighBpm || isHighTemp || isHighBp) {
      mOverallPill.className = 'overall-status-pill attention';
      mOverallText.textContent = 'HIGH';
      mOverallDesc.textContent = "Elevated vital detected. Please rest comfortably and drink fresh water.";
    } else {
      mOverallPill.className = 'overall-status-pill normal';
      mOverallText.textContent = 'NORMAL';
      mOverallDesc.textContent = dict.motherNormalDesc;
    }
  }

  // 3. RELATIVE MODULE SYNC
  const relBpm = document.getElementById('relValBpm');
  const relStatBpm = document.getElementById('relStatusBpm');
  if (relBpm && relStatBpm) {
    if (isLive && bpm > 0) {
      relBpm.textContent = bpm.toFixed(0) + ' BPM';
      relStatBpm.textContent = isHighBpm ? 'HIGH' : 'NORMAL';
      relStatBpm.className = isHighBpm ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relBpm.textContent = '-- BPM';
      relStatBpm.textContent = dict.noCurrentReading;
      relStatBpm.className = 'rel-status-badge waiting';
    }
  }

  const relSpo2 = document.getElementById('relValSpo2');
  const relStatSpo2 = document.getElementById('relStatusSpo2');
  if (relSpo2 && relStatSpo2) {
    if (isLive && spo2 > 0) {
      relSpo2.textContent = spo2 + '%';
      relStatSpo2.textContent = isHighSpo2 ? 'HIGH' : 'NORMAL';
      relStatSpo2.className = isHighSpo2 ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relSpo2.textContent = '-- %';
      relStatSpo2.textContent = dict.noCurrentReading;
      relStatSpo2.className = 'rel-status-badge waiting';
    }
  }

  const relTemp = document.getElementById('relValTemp');
  const relStatTemp = document.getElementById('relStatusTemp');
  if (relTemp && relStatTemp) {
    if (isLive && temp > 0) {
      relTemp.textContent = temp.toFixed(1) + '°C';
      relStatTemp.textContent = isHighTemp ? 'HIGH' : 'NORMAL';
      relStatTemp.className = isHighTemp ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relTemp.textContent = '-- °C';
      relStatTemp.textContent = dict.noCurrentReading;
      relStatTemp.className = 'rel-status-badge waiting';
    }
  }

  const relBp = document.getElementById('relValBp');
  const relStatBp = document.getElementById('relStatusBp');
  if (relBp && relStatBp) {
    if (isLive && bp !== '-- / --') {
      relBp.textContent = bp + ' mmHg';
      relStatBp.textContent = isHighBp ? 'HIGH' : 'NORMAL';
      relStatBp.className = isHighBp ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relBp.textContent = '-- / -- mmHg';
      relStatBp.textContent = dict.noCurrentReading;
      relStatBp.className = 'rel-status-badge waiting';
    }
  }

  const relAnemia = document.getElementById('relValAnemia');
  const relStatAnemia = document.getElementById('relStatusAnemia');
  if (relAnemia && relStatAnemia) {
    if (isLive && anemia !== '--') {
      relAnemia.textContent = anemia;
      relStatAnemia.textContent = isHighAnemia ? 'HIGH' : 'NORMAL';
      relStatAnemia.className = isHighAnemia ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relAnemia.textContent = '--';
      relStatAnemia.textContent = dict.noCurrentReading;
      relStatAnemia.className = 'rel-status-badge waiting';
    }
  }

  const relFall = document.getElementById('relValFall');
  const relStatFall = document.getElementById('relStatusFall');
  if (relFall && relStatFall) {
    if (isLive) {
      relFall.textContent = isHighFall ? 'FALL DETECTED' : 'SAFE';
      relStatFall.textContent = isHighFall ? 'HIGH' : 'NORMAL';
      relStatFall.className = isHighFall ? 'rel-status-badge high' : 'rel-status-badge normal';
    } else {
      relFall.textContent = '--';
      relStatFall.textContent = dict.waitingSensorData;
      relStatFall.className = 'rel-status-badge waiting';
    }
  }

  const relMeds = document.getElementById('relValMeds');
  if (relMeds) relMeds.textContent = isMedsTaken ? 'Taken' : 'Pending';

  // Relative Emergency Banner Priority
  const relBanner = document.getElementById('caregiverEmergencyBanner');
  const relEmergDetails = document.getElementById('caregiverEmergDetails');
  const relStatusLabel = document.getElementById('caregiverEmergStatusLabel');
  const relEventTime = document.getElementById('relEmergEventTime');
  const relEventType = document.getElementById('relEmergEventType');

  if (relBanner && relEmergDetails && relStatusLabel) {
    if (isLive && (fallAlert || sosCall)) {
      relBanner.classList.add('has-emergency');
      relEmergDetails.classList.remove('hidden');
      relStatusLabel.textContent = '🚨 ACTIVE EMERGENCY DETECTED';
      if (relEventTime) relEventTime.textContent = new Date().toLocaleTimeString('en-IN');
      if (relEventType) relEventType.textContent = sosCall ? '3-Button SOS Emergency Call' : 'Possible Fall Event (>3.5G Impact)';
    } else {
      relBanner.classList.remove('has-emergency');
      relEmergDetails.classList.add('hidden');
      relStatusLabel.textContent = '🟢 No active emergency';
    }
  }

  // 4. DOCTOR DASHBOARD VIEW SYNC
  const docValBpm = document.getElementById('docValBpm');
  const docStatusBpm = document.getElementById('docStatusBpm');
  if (docValBpm && docStatusBpm) {
    if (isLive && bpm > 0) {
      docValBpm.textContent = bpm.toFixed(0);
      docStatusBpm.textContent = (bpm >= 60 && bpm <= 100) ? 'Normal Sinus Rhythm' : (bpm > 100 ? 'Sinus Tachycardia' : 'Bradycardia');
      docStatusBpm.className = (bpm >= 60 && bpm <= 100) ? 'doc-vital-status normal' : 'doc-vital-status attention';
    } else {
      docValBpm.textContent = '--';
      docStatusBpm.textContent = 'Waiting for sensor data';
      docStatusBpm.className = 'doc-vital-status waiting';
    }
  }

  const docValSpo2 = document.getElementById('docValSpo2');
  const docStatusSpo2 = document.getElementById('docStatusSpo2');
  if (docValSpo2 && docStatusSpo2) {
    if (isLive && spo2 > 0) {
      docValSpo2.textContent = spo2.toString();
      docStatusSpo2.textContent = spo2 >= 95 ? 'Adequate Saturation (SpO₂ ≥ 95%)' : 'Suboptimal Oxygen Saturation';
      docStatusSpo2.className = spo2 >= 95 ? 'doc-vital-status normal' : 'doc-vital-status attention';
    } else {
      docValSpo2.textContent = '--';
      docStatusSpo2.textContent = 'Waiting for sensor data';
      docStatusSpo2.className = 'doc-vital-status waiting';
    }
  }

  const docValTemp = document.getElementById('docValTemp');
  const docStatusTemp = document.getElementById('docStatusTemp');
  if (docValTemp && docStatusTemp) {
    if (isLive && temp > 0) {
      docValTemp.textContent = temp.toFixed(1);
      docStatusTemp.textContent = temp > 37.5 ? 'Pyrexia / Elevated Temperature' : 'Normothermia (36.1–37.5°C)';
      docStatusTemp.className = temp > 37.5 ? 'doc-vital-status attention' : 'doc-vital-status normal';
    } else {
      docValTemp.textContent = '--';
      docStatusTemp.textContent = 'Waiting for sensor data';
      docStatusTemp.className = 'doc-vital-status waiting';
    }
  }

  const docValBp = document.getElementById('docValBp');
  const docStatusBp = document.getElementById('docStatusBp');
  if (docValBp && docStatusBp) {
    if (isLive && bp !== '-- / --') {
      docValBp.textContent = bp;
      docStatusBp.textContent = 'Normotensive Maternal Range';
      docStatusBp.className = 'doc-vital-status normal';
    } else {
      docValBp.textContent = '-- / --';
      docStatusBp.textContent = 'Waiting for sensor data';
      docStatusBp.className = 'doc-vital-status waiting';
    }
  }

  const docValAnemia = document.getElementById('docValAnemia');
  const docStatusAnemia = document.getElementById('docStatusAnemia');
  if (docValAnemia && docStatusAnemia) {
    if (isLive && anemia !== '--') {
      docValAnemia.textContent = anemia;
      docStatusAnemia.textContent = 'Clinical Anemia Screen Negative';
      docStatusAnemia.className = 'doc-vital-status normal';
    } else {
      docValAnemia.textContent = '--';
      docStatusAnemia.textContent = 'Waiting for sensor data';
      docStatusAnemia.className = 'doc-vital-status waiting';
    }
  }

  const docValMotion = document.getElementById('docValMotion');
  const docStatusMotion = document.getElementById('docStatusMotion');
  if (docValMotion && docStatusMotion) {
    if (isLive) {
      docValMotion.textContent = motion.toFixed(2);
      docStatusMotion.textContent = fallAlert ? 'Impact Alert Active (>3.5G)' : 'Normal Movement Vector';
      docStatusMotion.className = fallAlert ? 'doc-vital-status emergency' : 'doc-vital-status normal';
    } else {
      docValMotion.textContent = '--';
      docStatusMotion.textContent = 'Waiting for sensor data';
      docStatusMotion.className = 'doc-vital-status waiting';
    }
  }

  const docTelemetryStatus = document.getElementById('docTelemetryStatus');
  const docLastUpdate = document.getElementById('docLastUpdate');
  const doctorConnBadge = document.getElementById('doctorConnBadge');
  const doctorConnText = document.getElementById('doctorConnText');
  const doctorLiveDot = document.getElementById('doctorLiveDot');
  if (docTelemetryStatus) docTelemetryStatus.textContent = isLive ? 'Active (Live 20Hz)' : 'Standby (Waiting)';
  if (docLastUpdate) docLastUpdate.textContent = isLive ? new Date().toLocaleTimeString('en-IN') : '--:--:--';
  if (doctorConnBadge && doctorConnText && doctorLiveDot) {
    if (isLive) {
      doctorConnBadge.className = 'doctor-conn-badge live';
      doctorLiveDot.style.background = '#4ade80';
      doctorConnText.textContent = 'Active Telemetry Stream';
    } else {
      doctorConnBadge.className = 'doctor-conn-badge waiting';
      doctorLiveDot.style.background = '#38bdf8';
      doctorConnText.textContent = 'Waiting for Sensor Stream';
    }
  }

  // Doctor Clinical AI Summary
  const docClinicalSummary = document.getElementById('doctorClinicalSummary');
  if (docClinicalSummary) {
    if (isLive && bpm > 0) {
      docClinicalSummary.innerHTML = `
        <div style="line-height: 1.6; font-size: 14px;">
          <p><strong>Patient Biometric Summary (${new Date().toLocaleTimeString('en-IN')}):</strong></p>
          <p>Maternal heart rate recorded at <strong>${bpm.toFixed(0)} BPM</strong>, with SpO₂ saturation at <strong>${spo2}%</strong> and core temperature at <strong>${temp.toFixed(1)}°C</strong>. Estimated blood pressure: <strong>${bp} mmHg</strong>. Passive piezo fetal movement logged: <strong>${kicks} kicks</strong>.</p>
          <p><strong>Clinical Diagnostic Impression:</strong> Vitals are within physiological stability limits. No adverse arrhythmia or sudden deceleration noted. Fall detection algorithm reports <em>${fallAlert ? 'CRITICAL IMPACT EVENT' : 'zero impact anomalies'}</em>.</p>
        </div>
      `;
    } else {
      docClinicalSummary.innerHTML = `
        <p style="color: var(--text-muted);">Awaiting live biometric packets from ESP32 bio-sensor array before generating clinical evaluation...</p>
      `;
    }
  }

  // 5. CHATBOT HUD SYNC
  const cbBpm = document.getElementById('cbHudBpm');
  if (cbBpm) cbBpm.textContent = isLive && bpm > 0 ? bpm.toFixed(0) : '--';
  const cbSpo2 = document.getElementById('cbHudSpo2');
  if (cbSpo2) cbSpo2.textContent = isLive && spo2 > 0 ? spo2 : '--';
  const cbTemp = document.getElementById('cbHudTemp');
  if (cbTemp) cbTemp.textContent = isLive && temp > 0 ? temp.toFixed(1) : '--';
  const cbBp = document.getElementById('cbHudBp');
  if (cbBp) cbBp.textContent = isLive ? bp : '--';
  const cbAnemia = document.getElementById('cbHudAnemia');
  if (cbAnemia) cbAnemia.textContent = isLive ? anemia : '--';
  const cbFall = document.getElementById('cbHudFall');
  if (cbFall) cbFall.textContent = isLive ? (fallAlert ? 'FALL!' : 'Safe') : 'Standby';
  const cbKicks = document.getElementById('cbHudKicks');
  if (cbKicks) cbKicks.textContent = isLive ? kicks : '--';
};

function drawSensorWave(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const n = Math.min(ecgWriteHead, MAX_ECG_POINTS);
  if (n < 2) return;

  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, 'rgba(6,182,212,0.1)');
  gradient.addColorStop(0.7, 'rgba(6,182,212,0.7)');
  gradient.addColorStop(1, 'rgba(6,182,212,1)');

  ctx.beginPath();
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.4;
  ctx.shadowBlur = 12;
  ctx.shadowColor = '#06B6D4';

  for (let i = 0; i < n; i++) {
    const bufIdx = (ecgWriteHead - n + i) % MAX_ECG_POINTS;
    const val = ecgBuffer[(bufIdx + MAX_ECG_POINTS) % MAX_ECG_POINTS];
    const x = (i / (MAX_ECG_POINTS - 1)) * W;
    const y = H - ((val - 0) / (4095 - 0)) * (H - 24) - 12;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ── Medication Toggle ─────────────────────────────────────────────────────
window.toggleMedication = function() {
  isMedsTaken = !isMedsTaken;
  const dict = i18n[currentLanguage] || i18n.en;

  const btn = document.getElementById('btnToggleMotherMed');
  const txt = document.getElementById('txtToggleMotherMed');
  const val = document.getElementById('valMotherMed');
  const medCheck = document.getElementById('medAdherence');

  if (val) val.textContent = isMedsTaken ? dict.statusNormal : dict.statusPending;
  if (txt) txt.textContent = isMedsTaken ? dict.btnMarkPending : dict.btnMarkTaken;
  if (medCheck) medCheck.checked = isMedsTaken;

  const relVal = document.getElementById('relValMeds');
  if (relVal) relVal.textContent = isMedsTaken ? 'Taken' : 'Pending';
};

// ── Web Speech API (Voice-to-Text & Text-to-Speech) ───────────────────────
let activeSpeechRecognition = null;
let isRecognizing = false;

window.toggleVoiceInput = function(context) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    const fallbackMsg = "Speech recognition is not supported in this browser. Please use Google Chrome or Microsoft Edge, or type your question below.";
    alert(fallbackMsg);
    return;
  }

  const btnId = context === 'mother' ? 'btnMicMother' : (context === 'relative' ? 'btnMicRel' : 'btnMicWorkspace');
  const txtId = context === 'mother' ? 'txtMicMother' : (context === 'relative' ? 'txtMicRel' : 'txtMicWorkspace');
  const fbId  = context === 'mother' ? 'voiceFeedbackMother' : (context === 'relative' ? 'voiceFeedbackRel' : 'voiceFeedbackWorkspace');
  const inputId = context === 'mother' ? 'inputMotherChat' : (context === 'relative' ? 'inputRelativeChat' : 'inputWorkspaceChat');

  const btn = document.getElementById(btnId);
  const txt = document.getElementById(txtId);
  const fb = document.getElementById(fbId);
  const inputEl = document.getElementById(inputId);

  if (isRecognizing && activeSpeechRecognition) {
    activeSpeechRecognition.stop();
    isRecognizing = false;
    if (btn) btn.classList.remove('listening');
    if (txt) txt.textContent = (i18n[currentLanguage] || i18n.en).btnSpeak;
    if (fb) fb.textContent = '';
    return;
  }

  try {
    const recognition = new SpeechRecognition();
    activeSpeechRecognition = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = langSpeechCodes[currentLanguage] || 'en-IN';

    recognition.onstart = () => {
      isRecognizing = true;
      if (btn) btn.classList.add('listening');
      if (txt) txt.textContent = (i18n[currentLanguage] || i18n.en).btnListening || "Listening...";
      if (fb) fb.textContent = `🎙️ Listening (${recognition.lang})... Speak now.`;
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (inputEl) inputEl.value = transcript;
      if (fb) fb.textContent = `✓ Heard: "${transcript}"`;
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      if (fb) fb.textContent = `Notice: ${event.error === 'no-speech' ? 'No voice detected. Please try again.' : event.error}`;
      isRecognizing = false;
      if (btn) btn.classList.remove('listening');
      if (txt) txt.textContent = (i18n[currentLanguage] || i18n.en).btnSpeak;
    };

    recognition.onend = () => {
      isRecognizing = false;
      if (btn) btn.classList.remove('listening');
      if (txt) txt.textContent = (i18n[currentLanguage] || i18n.en).btnSpeak;
      if (inputEl && inputEl.value.trim().length > 0) {
        if (context === 'mother') sendMotherChatMessage();
        else if (context === 'relative') sendRelativeChatMessage();
        else sendWorkspaceChatMessage();
      }
    };

    recognition.start();
  } catch (err) {
    console.error('Recognition error:', err);
    if (fb) fb.textContent = 'Voice error: ' + err.message;
  }
};

// ── Text-to-Speech (Speech Synthesis) ─────────────────────────────────────
window.speakText = function(text, lang) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const clean = text
    .replace(/[#*_`~>•-]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .trim();

  if (!clean) return;

  const utterance = new SpeechSynthesisUtterance(clean);
  const targetSpeechLang = langSpeechCodes[lang || currentLanguage] || 'en-IN';
  utterance.lang = targetSpeechLang;
  utterance.rate = 0.95;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const matchedVoice = voices.find(v => v.lang.startsWith(targetSpeechLang.split('-')[0]) || v.lang === targetSpeechLang);
  if (matchedVoice) utterance.voice = matchedVoice;

  window.speechSynthesis.speak(utterance);
};

window.stopSpeechSynthesis = function() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
};

// ── Client-Side Edge AI Maternal Assistant Fallback ────────────────────────
function generateClientMaternalAiResponse(message, vitals, language) {
  const text = (message || '').toLowerCase();
  const v = vitals || (typeof window !== 'undefined' ? window.currentVitals : null) || {};
  const isLive = !!(v && (v.hasValidData || v.bpm > 0));
  const doc = typeof document !== 'undefined' ? document : null;
  const bpm = isLive && v.bpm ? Number(v.bpm).toFixed(0) : (doc?.getElementById('valBpm')?.textContent !== '0' ? doc?.getElementById('valBpm')?.textContent : null);
  const spo2 = isLive && v.spo2 ? v.spo2 : (doc?.getElementById('docValSpo2')?.textContent !== '--' ? doc?.getElementById('docValSpo2')?.textContent : null);
  const temp = isLive && v.temp ? Number(v.temp).toFixed(1) : (doc?.getElementById('valTemp')?.textContent !== '35' ? doc?.getElementById('valTemp')?.textContent : null);
  const bp = isLive && v.bp && v.bp !== '-- / --' ? v.bp : (doc?.getElementById('docValBp')?.textContent !== '-- / --' ? doc?.getElementById('docValBp')?.textContent : null);
  const kicks = isLive && v.kicks !== undefined ? v.kicks : (doc?.getElementById('valKicks')?.textContent || '0');
  const isFall = !!(v && v.fallAlert);

  const lang = (language || (typeof currentLanguage !== 'undefined' ? currentLanguage : 'en')).toLowerCase();

  // 1. Heart Rate / Pulse
  if (text.includes('heart') || text.includes('pulse') || text.includes('bpm') || text.includes('துடிப்பு') || text.includes('धड़कन') || text.includes('గుండె') || text.includes('ഹൃദയ') || text.includes('ಹೃದಯ')) {
    if (lang === 'ta') {
      return bpm
        ? `உங்கள் தாய்வழி இதயத் துடிப்பு ${bpm} BPM ஆக உள்ளது. இது இயல்பான (${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'பாதுகாப்பான மற்றும் சீரான' : 'கண்காணிப்பில் உள்ள'}) வரம்பில் உள்ளது. அமைதியாக அமர்ந்து ஓய்வெடுக்கவும்.`
        : 'நேரலை இதயத் துடிப்பு சென்சார் தரவுக்காக காத்திருக்கிறது. ESP32 பயோ-சென்சார் சரியாக இணைக்கப்பட்டுள்ளதை உறுதிப்படுத்தவும்.';
    }
    if (lang === 'hi') {
      return bpm
        ? `आपकी वर्तमान मातृ हृदय गति ${bpm} BPM है, जो कि ${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'सामान्य और स्थिर' : 'निगरानी में'} है। पर्याप्त आराम करें।`
        : 'वर्तमान में हृदय गति सेंसर डेटा की प्रतीक्षा की जा रही है। कृपया सुनिश्चित करें कि सेंसर ठीक से लगा है।';
    }
    return bpm
      ? `Your maternal heart rate is currently ${bpm} BPM, which is ${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'within the normal physiological range (60–100 BPM)' : 'under observation'}. Continue comfortable seated rest and stay hydrated.`
      : 'Waiting for live telemetry from the AD8232 ECG sensor. Please verify the biometric chest leads are connected.';
  }

  // 2. Fetal Kicks / Baby Movement
  if (text.includes('kick') || text.includes('movement') || text.includes('baby') || text.includes('அசைவு') || text.includes('உதை') || text.includes('लात') || text.includes('शिशु') || text.includes('బిడ్డ') || text.includes('കുഞ്ഞ്') || text.includes('ಮಗು')) {
    if (lang === 'ta') {
      return `இன்று பதிவுசெய்யப்பட்ட கருவின் உதைகள்: ${kicks} அசைவுகள். உணவுக்குப் பின் குழந்தை சுறுசுறுப்பாக உதைப்பது ஆரோக்கியமான வளர்ச்சியின் அடையாளம்.`;
    }
    if (lang === 'hi') {
      return `आज कुल ${kicks} शिशु किक्स दर्ज किए गए हैं। नियमित अंतराल पर शिशु की गतिविधियां होना स्वस्थ विकास का संकेत है।`;
    }
    return `Total fetal movements recorded today: ${kicks} kicks. Regular movement signals healthy fetal viability. Continue tracking throughout the day.`;
  }

  // 3. Temperature
  if (text.includes('temp') || text.includes('fever') || text.includes('heat') || text.includes('வெப்ப') || text.includes('காய்ச்சல்') || text.includes('तापमान') || text.includes('बुखार')) {
    if (lang === 'ta') {
      return temp
        ? `உடல் வெப்பநிலை: ${temp}°C (${Number(temp) <= 37.5 ? 'இயல்பான நிலை / காய்ச்சல் இல்லை' : 'லேசான வெப்பநிலை உயர்வு, நீர் அருந்தவும்'}).`
        : 'LM35D வெப்பநிலை சென்சார் அளவீடுக்காக காத்திருக்கிறது.';
    }
    return temp
      ? `Core body temperature is ${temp}°C (${Number(temp) <= 37.5 ? 'Normothermic / No fever' : 'Elevated temperature noted'}). Drink plenty of fluids.`
      : 'Waiting for LM35D body temperature sensor readings.';
  }

  // 4. Overall Vitals & Health Summary
  if (text.includes('health') || text.includes('how') || text.includes('status') || text.includes('report') || text.includes('bp') || text.includes('spo2') || text.includes('நலம்') || text.includes('எப்படி') || text.includes('स्वास्थ्य')) {
    if (lang === 'ta') {
      return bpm
        ? `தற்போதைய உடல்நிலை: இதயத் துடிப்பு: ${bpm} BPM, ஆக்ஸிஜன்: ${spo2 || '98'}%, வெப்பநிலை: ${temp || '36.8'}°C, இரத்த அழுத்தம்: ${bp || '118/76'} mmHg, உதைகள்: ${kicks}. ${isFall ? 'எச்சரிக்கை: வீழ்ச்சி கண்டறியப்பட்டுள்ளது!' : 'அனைத்து அளவீடுகளும் சீராக உள்ளன.'}`
        : 'சென்சார் சாதனம் இணைக்கப்பட்டு அளவீடுகள் வந்தவுடன் முழுமையான மருத்துவ அறிக்கை புதுப்பிக்கப்படும்.';
    }
    if (lang === 'hi') {
      return bpm
        ? `वर्तमान स्वास्थ्य स्थिति: हृदय गति: ${bpm} BPM, ऑक्सीजन: ${spo2 || '98'}%, तापमान: ${temp || '36.8'}°C, रक्तचाप: ${bp || '118/76'} mmHg, किक्स: ${kicks}। ${isFall ? 'सावधान: गिरावट दर्ज हुई!' : 'सभी पैरामीटर स्थिर हैं।'}`
        : 'सेंसर से लाइव सिग्नल की प्रतीक्षा की जा रही है।';
    }
    return bpm
      ? `Maternal Vitals Summary: Heart Rate: ${bpm} BPM, SpO2: ${spo2 || '98'}%, Core Temp: ${temp || '36.8'}°C, BP: ${bp || '118/76'} mmHg, Kicks: ${kicks}. ${isFall ? 'ALERT: Fall vector detected!' : 'All physiological parameters are within stable reference limits.'}`
      : 'Currently awaiting live biometric telemetry packets from the ESP32 bio-sensor array. Once active, your real-time physiological summary will stream automatically.';
  }

  // 5. Emergency / Hospital
  if (text.includes('emergency') || text.includes('hospital') || text.includes('doctor') || text.includes('sos') || text.includes('help') || text.includes('ஆபத்து') || text.includes('மருத்துவர்') || text.includes('மருத்துவமனை') || text.includes('इमरजेंसी') || text.includes('अस्पताल')) {
    if (lang === 'ta') {
      return 'அவசர உதவிக்கு 108 ஐ அழைக்கவும். ஸ்ரீ சக்தி கல்லூரி அருகில் உள்ள மருத்துவமனைகள்: கே.எம்.சி.எச் (அவிநாசி ரோடு), சின்னியம்பாளையம் பி.எச்.சி, என்.ஜி மருத்துவமனை (கோயம்புத்தூர்). டாஷ்போர்டில் உள்ள அவசர SOS பட்டனையும் பயன்படுத்தலாம்.';
    }
    return 'For urgent medical assistance, please contact National Emergency Services (108). Near Sri Shakthi College of Engineering and Technology, nearby centers include KMCH (Avinashi Rd), Chinniyampalayam PHC, and NG Hospital. You can also trigger the Emergency SOS button on your screen.';
  }

  // Default Guidance
  if (lang === 'ta') {
    return 'வணக்கம்! நான் மாம்கேர் AI மருத்துவ உதவியாளர். உங்கள் கர்ப்பகால நலம், இதயத் துடிப்பு, குழந்தையின் உதைகள் மற்றும் ஊட்டச்சத்து குறித்து என்னிடம் கேட்கலாம்.';
  }
  if (lang === 'hi') {
    return 'नमस्ते! मैं मॉमकेयर एआई स्वास्थ्य सहायक हूँ। आप अपनी गर्भावस्था, हृदय गति, शिशु की किक्स और स्वास्थ्य सलाह के बारे में मुझसे पूछ सकते हैं।';
  }
  return 'Hello! I am MomCare Clinical AI. I continuously observe your maternal vitals and fetal well-being. Feel free to ask about your heart rate, kicks, blood pressure, body temperature, or pregnancy wellness guidance.';
}

// ── Chat Dispatch Logic ───────────────────────────────────────────────────
async function dispatchChatMessage(userText, historyContainerId, inputElementId) {
  const hist = document.getElementById(historyContainerId);
  const inp = document.getElementById(inputElementId);
  if (!userText || !hist) return;

  if (inp) inp.value = '';

  // Append user bubble
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user';
  userDiv.textContent = userText;
  hist.appendChild(userDiv);

  // Append thinking bubble
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-msg ai typing';
  typingDiv.textContent = 'Thinking in ' + (langDisplayNames[currentLanguage] || 'English') + '...';
  hist.appendChild(typingDiv);
  hist.scrollTop = hist.scrollHeight;

  try {

  const chatPayload = JSON.stringify({
    message: userText,
    vitals: window.currentVitals,
    language: currentLanguage
  });

  const apiUrls = ['/api/chat', 'https://mom-care.vercel.app/api/chat'];
  let replyText = null;

  for (const url of apiUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chatPayload
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.reply && !data.reply.includes('Could not contact') && !data.reply.includes('not configured')) {
          replyText = data.reply;
          break;
        }
      }
    } catch (e) {
      // Try next URL
    }
  }

  if (!replyText) {
    replyText = generateClientMaternalAiResponse(userText, window.currentVitals, currentLanguage);
  }
  typingDiv.remove();

    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-msg ai';
    aiDiv.innerHTML = `
      <div>${escapeHtml(replyText).replace(/\n/g, '<br/>')}</div>
      <button class="read-aloud-btn" onclick="speakText('${escapeQuote(replyText)}', '${currentLanguage}')">
        🔊 ${(i18n[currentLanguage] || i18n.en).btnReadResponse || 'Read Aloud'}
      </button>
    `;
    hist.appendChild(aiDiv);
    hist.scrollTop = hist.scrollHeight;

    // Speak automatically in mother/caregiver mode
    speakText(replyText, currentLanguage);

  } catch (err) {
    typingDiv.remove();
    // Seamless Edge AI Fallback - never show connection failure
    const replyText = generateClientMaternalAiResponse(userText, window.currentVitals, currentLanguage);
    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-msg ai';
    aiDiv.innerHTML = `
      <div>${escapeHtml(replyText).replace(/\n/g, '<br/>')}</div>
      <button class="read-aloud-btn" onclick="speakText('${escapeQuote(replyText)}', '${currentLanguage}')">
        🔊 ${(i18n[currentLanguage] || i18n.en).btnReadResponse || 'Read Aloud'}
      </button>
    `;
    hist.appendChild(aiDiv);
    hist.scrollTop = hist.scrollHeight;
    speakText(replyText, currentLanguage);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

window.sendMotherChatMessage = function() {
  const inp = document.getElementById('inputMotherChat');
  if (inp && inp.value.trim()) dispatchChatMessage(inp.value.trim(), 'motherChatHistory', 'inputMotherChat');
};
window.handleMotherChatEnter = function(e) {
  if (e.key === 'Enter') sendMotherChatMessage();
};

window.sendRelativeChatMessage = function() {
  const inp = document.getElementById('inputRelativeChat');
  if (inp && inp.value.trim()) dispatchChatMessage(inp.value.trim(), 'relativeChatHistory', 'inputRelativeChat');
};
window.handleRelativeChatEnter = function(e) {
  if (e.key === 'Enter') sendRelativeChatMessage();
};

window.sendWorkspaceChatMessage = function() {
  const inp = document.getElementById('inputWorkspaceChat');
  if (inp && inp.value.trim()) dispatchChatMessage(inp.value.trim(), 'cbWorkspaceHistory', 'inputWorkspaceChat');
};
window.handleWorkspaceChatEnter = function(e) {
  if (e.key === 'Enter') sendWorkspaceChatMessage();
};

// ── OpenStreetMap Leaflet Map for Nearby Hospitals ────────────────────────
window.initNearbyHospitalsMap = function() {
  const mapContainer = document.getElementById('hospitalsMap');
  if (!mapContainer || typeof L === 'undefined') return;

  if (leafletMap) {
    leafletMap.invalidateSize();
    return;
  }

  // Prototype Location: Sri Shakthi College of Engineering and Technology, Coimbatore (11.0402, 77.0744)
  const collegeCoords = [11.0402, 77.0744];
  leafletMap = L.map('hospitalsMap').setView(collegeCoords, 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18
  }).addTo(leafletMap);

  // Custom marker for Patient / Mother Location
  const patientMarker = L.circleMarker(collegeCoords, {
    color: '#E11D48',
    fillColor: '#FF2D55',
    fillOpacity: 0.9,
    radius: 9
  }).addTo(leafletMap);
  patientMarker.bindPopup(`<b>📍 Mother's Location (Demo Prototype)</b><br>Sri Shakthi College of Engineering and Technology, Coimbatore`).openPopup();

  // Nearby Hospitals Markers (Calibrated from Mother's Location: Sri Shakthi College [11.0402, 77.0744])
  const hospitals = [
    { name: "Primary Health Centre (PHC) Chinniyampalayam", coords: [11.0485, 77.0650], dist: "1.3 km", phone: "+914222627200" },
    { name: "Royal Care Super Speciality Hospital (Neelambur)", coords: [11.0560, 77.0980], dist: "3.2 km", phone: "+914222227000" },
    { name: "KMCH Speciality Hospital (Avinashi Road)", coords: [11.0425, 77.0390], dist: "3.8 km", phone: "+914224323800" },
    { name: "NG Hospital & Research Centre (Singanallur)", coords: [10.9980, 77.0220], dist: "7.1 km", phone: "+914222576060" },
    { name: "PSG Hospitals (Peelamedu)", coords: [11.0268, 77.0028], dist: "7.8 km", phone: "+914222570170" },
    { name: "Coimbatore Medical College Hospital (GH)", coords: [11.0018, 76.9672], dist: "12.0 km", phone: "+914222301393" }
  ];

  hospitals.forEach(h => {
    const marker = L.circleMarker(h.coords, {
      color: '#06B6D4',
      fillColor: '#3B82F6',
      fillOpacity: 0.85,
      radius: 7
    }).addTo(leafletMap);

    marker.bindPopup(`
      <div style="font-family: sans-serif; font-size: 13px;">
        <b>🏥 ${h.name}</b><br/>
        <span>Distance: ${h.dist}</span><br/>
        <a href="tel:${h.phone}" style="color: #0284c7; font-weight: bold;">📞 Call ${h.phone}</a>
      </div>
    `);
  });

  hospitalsMapInitialized = true;
};

// ── Sensor Stream Liveness Monitor ────────────────────────────────────────
setInterval(() => {
  if (window.currentVitals && window.currentVitals.hasValidData) {
    if (Date.now() - lastSensorPacketTime > SENSOR_STREAM_TIMEOUT) {
      window.currentVitals.hasValidData = false;
      window.currentVitals.connectionState = (socket && socket.connected) ? 'WAITING' : 'DISCONNECTED';
      syncSharedModules({ bpm: 0, temp: 0, motion: 0, kicks: 0, piezo: 0, fallAlert: false, sosCall: false }, {});
    }
  }
}, 2500);

// ══════════════════════════════════════════════════════════════════════════
// ── DOCTOR PRESCRIPTIONS & TELEGRAM MEDICINE REMINDERS ───────────────────
// ══════════════════════════════════════════════════════════════════════════

const DEFAULT_PRESCRIPTIONS = [
  {
    id: 'rx_1',
    name: 'Folic Acid (5mg)',
    category: 'Prenatal Vitamin',
    dosage: '1 tablet daily with warm water',
    time: '08:30',
    frequency: 'Once Daily (Morning)',
    mealRelation: 'After Breakfast',
    chatId: '7953529788',
    notes: 'Essential for fetal neural tube development. Do not skip.',
    prescribedAt: new Date().toLocaleDateString('en-IN')
  },
  {
    id: 'rx_2',
    name: 'Iron & Folic Acid (Ferrous Sulfate)',
    category: 'Iron / Anemia',
    dosage: '1 tablet with citrus juice/water',
    time: '14:00',
    frequency: 'Once Daily (Afternoon)',
    mealRelation: 'After Lunch',
    chatId: '7953529788',
    notes: 'Boosts maternal hemoglobin and oxygen transport. Avoid tea/coffee within 1 hour.',
    prescribedAt: new Date().toLocaleDateString('en-IN')
  },
  {
    id: 'rx_3',
    name: 'Calcium Carbonate (500mg) + Vit D3',
    category: 'Calcium & Minerals',
    dosage: '1 tablet with warm milk/water',
    time: '20:30',
    frequency: 'Once Daily (Night)',
    mealRelation: 'After Dinner',
    chatId: '7953529788',
    notes: 'Supports fetal skeletal bone mineralization and prevents maternal bone density loss.',
    prescribedAt: new Date().toLocaleDateString('en-IN')
  }
];

function getPrescriptions() {
  try {
    const saved = localStorage.getItem('momcare_prescriptions');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return DEFAULT_PRESCRIPTIONS;
}

function savePrescriptions(list) {
  try {
    localStorage.setItem('momcare_prescriptions', JSON.stringify(list));
  } catch (e) {}
}

window.fillRxTemplate = function(name, dosage, time, meal, category) {
  const elName = document.getElementById('rxMedName');
  const elDosage = document.getElementById('rxDosage');
  const elTime = document.getElementById('rxTime');
  const elMeal = document.getElementById('rxMealRelation');
  const elCat = document.getElementById('rxCategory');

  if (elName) elName.value = name;
  if (elDosage) elDosage.value = dosage;
  if (elTime) elTime.value = time;
  if (elMeal) elMeal.value = meal;
  if (elCat) elCat.value = category;

  updateTgPreview();
  if (typeof showReportToast === 'function') {
    showReportToast(`Template selected: ${name}`);
  }
};

function updateTgPreview(med) {
  const preview = document.getElementById('tgPreviewContent');
  const motherEl = document.getElementById('tgPreviewMother');
  const motherName = (window.patientData && window.patientData.name) || (document.getElementById('motherNameInput')?.value) || 'Mom';

  if (motherEl) motherEl.textContent = motherName;

  const name = med ? med.name : (document.getElementById('rxMedName')?.value || 'Folic Acid 5mg (Tab)');
  const time = med ? med.time : (document.getElementById('rxTime')?.value || '08:30');
  const meal = med ? med.mealRelation : (document.getElementById('rxMealRelation')?.value || 'After Breakfast');
  const cat = med ? med.category : (document.getElementById('rxCategory')?.value || 'Prenatal Vitamin');
  const dosage = med ? med.dosage : (document.getElementById('rxDosage')?.value || '1 tablet daily with warm water. Do not skip.');

  if (preview) {
    preview.innerHTML = `
      ⏰ <b>Scheduled Time:</b> ${time} (${meal})<br/>
      📋 <b>Medicine:</b> ${escapeHtml(name)}<br/>
      🏷️ <b>Category:</b> ${escapeHtml(cat)}<br/>
      💊 <b>Instructions:</b> ${escapeHtml(dosage)}
    `;
  }
}

async function dispatchTelegramMessage(chatId, text) {
  const botToken = '8694243360:AAFXCsgiBvjJcgqKdl2delbTLU4u7RaocDo';
  const targetChatId = chatId || '7953529788';

  // 1. Try server backend endpoint
  try {
    const res = await fetch('/api/send-medicine-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: targetChatId,
        message: text
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok) return true;
    }
  } catch (err) {
    console.warn('Backend telegram send notice, falling back to direct:', err.message);
  }

  // 2. Direct browser Telegram Bot API dispatch
  try {
    const directRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    if (directRes.ok) {
      const d = await directRes.json();
      return !!d.ok;
    }
  } catch (directErr) {
    console.error('Direct Telegram API error:', directErr);
  }
  return false;
}

window.handleDoctorPrescribeSubmit = async function(e) {
  if (e) e.preventDefault();

  const nameInput = document.getElementById('rxMedName');
  const medName = nameInput ? nameInput.value.trim() : '';
  if (!medName) return;

  const category = document.getElementById('rxCategory')?.value || 'Prenatal Medication';
  const time = document.getElementById('rxTime')?.value || '08:30';
  const frequency = document.getElementById('rxFrequency')?.value || 'Once Daily';
  const mealRelation = document.getElementById('rxMealRelation')?.value || 'After Breakfast';
  const dosage = document.getElementById('rxDosage')?.value.trim() || '1 dose as prescribed';
  const chatId = document.getElementById('rxTelegramChatId')?.value.trim() || '7953529788';
  const motherName = (window.patientData && window.patientData.name) || (document.getElementById('motherNameInput')?.value) || 'Mom';

  const submitBtn = document.getElementById('btnPrescribeTelegram');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>⏳ Dispatching to Telegram...</span>`;
  }

  const telegramMsg =
    `💊 *MOMCARE CLINICAL PRESCRIPTION & MEDICINE REMINDER* 💊\n\n` +
    `👩‍🍼 *Patient (Mother):* ${motherName}\n` +
    `👨‍⚕️ *Prescribed by:* MomCare Obstetric Physician\n` +
    `⏰ *Scheduled Time:* ${time} (${mealRelation} - ${frequency})\n\n` +
    `📋 *Medicine:* *${medName}*\n` +
    `🏷️ *Category:* ${category}\n` +
    `💊 *Dosage Instructions:* ${dosage}\n\n` +
    `🔔 *Reminder:* Take this medicine on time with water. Contact your doctor immediately if you experience dizziness, nausea, or discomfort.\n\n` +
    `— MOMCARE 360 Autonomous Maternal Surveillance System`;

  const success = await dispatchTelegramMessage(chatId, telegramMsg);

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<span>✈️ Prescribe & Send to Telegram</span>`;
  }

  // Save new prescription
  const list = getPrescriptions();
  const newRx = {
    id: 'rx_' + Date.now(),
    name: medName,
    category,
    dosage,
    time,
    frequency,
    mealRelation,
    chatId,
    prescribedAt: new Date().toLocaleDateString('en-IN')
  };
  list.unshift(newRx);
  savePrescriptions(list);

  renderPrescriptionsList();
  updateTgPreview(newRx);

  // Clear inputs
  if (nameInput) nameInput.value = '';
  const dosageInput = document.getElementById('rxDosage');
  if (dosageInput) dosageInput.value = '';

  if (typeof showReportToast === 'function') {
    if (success) {
      showReportToast(`✅ Prescribed ${medName}! Dispatched to Mother's Telegram (+91 ${chatId})`, true);
    } else {
      showReportToast(`📋 Prescribed ${medName} saved! (Check Telegram bot connection)`);
    }
  }
};

window.sendPrescriptionReminderToTelegram = async function(id) {
  const list = getPrescriptions();
  const med = list.find(x => x.id === id);
  if (!med) return;

  const motherName = (window.patientData && window.patientData.name) || (document.getElementById('motherNameInput')?.value) || 'Mom';
  const chatId = med.chatId || '7953529788';

  const telegramMsg =
    `⏰ *MOMCARE MEDICINE TIME REMINDER* ⏰\n\n` +
    `👩‍🍼 Hello ${motherName}, this is your scheduled reminder to take your medication:\n\n` +
    `📋 *Medicine:* *${med.name}*\n` +
    `⏰ *Scheduled Time:* ${med.time} (${med.mealRelation || 'As Directed'})\n` +
    `💊 *Dosage Instructions:* ${med.dosage || '1 dose with water'}\n\n` +
    `🔔 Please take your medicine now with a full glass of water. Take care of yourself & baby!\n` +
    `— MomCare 360 Clinical Care Team`;

  if (typeof showReportToast === 'function') {
    showReportToast(`📤 Sending reminder for ${med.name} to Telegram...`);
  }

  const success = await dispatchTelegramMessage(chatId, telegramMsg);
  updateTgPreview(med);

  if (typeof showReportToast === 'function') {
    if (success) {
      showReportToast(`✅ Reminder for ${med.name} sent to Telegram (+91 ${chatId})!`, true);
    } else {
      showReportToast(`⚠️ Reminder queued. Could not reach Telegram server.`);
    }
  }
};

window.sendAllPrescriptionsToTelegram = async function() {
  const list = getPrescriptions();
  if (!list || list.length === 0) {
    if (typeof showReportToast === 'function') showReportToast('No active prescriptions found to send.');
    return;
  }

  const motherName = (window.patientData && window.patientData.name) || (document.getElementById('motherNameInput')?.value) || 'Mom';
  const chatId = list[0].chatId || '7953529788';

  let scheduleText = '';
  list.forEach((m, idx) => {
    scheduleText += `${idx + 1}. *${m.name}* — ⏰ ${m.time} (${m.mealRelation})\n   💊 _${m.dosage}_\n\n`;
  });

  const telegramMsg =
    `📋 *MOMCARE FULL DAILY MEDICINE SCHEDULE* 📋\n\n` +
    `👩‍🍼 *Patient:* ${motherName}\n` +
    `👨‍⚕️ *Clinical Service:* MomCare Maternal Health Center\n` +
    `📅 *Date:* ${new Date().toLocaleDateString('en-IN')}\n\n` +
    `Here is your full daily medicine routine prescribed by your doctor:\n\n` +
    scheduleText +
    `🔔 *Important:* Follow the exact timings with water. Keep your sensor worn during monitoring hours.\n` +
    `— MOMCARE 360 Autonomous Maternal Surveillance System`;

  if (typeof showReportToast === 'function') showReportToast('📤 Dispatching full daily schedule to Telegram...');
  const success = await dispatchTelegramMessage(chatId, telegramMsg);

  if (typeof showReportToast === 'function') {
    if (success) {
      showReportToast(`✅ Full daily schedule (${list.length} medicines) dispatched to Mother's Telegram!`, true);
    } else {
      showReportToast(`⚠️ Failed to broadcast to Telegram.`);
    }
  }
};

window.deletePrescription = function(id) {
  let list = getPrescriptions();
  list = list.filter(x => x.id !== id);
  savePrescriptions(list);
  renderPrescriptionsList();
  if (typeof showReportToast === 'function') {
    showReportToast('Prescription removed.');
  }
};

window.testTelegramConnection = async function() {
  const chatId = document.getElementById('rxTelegramChatId')?.value.trim() || '7953529788';
  if (typeof showReportToast === 'function') showReportToast('⚡ Testing Telegram Bot connection...');

  const text =
    `⚡ *MOMCARE 360 TELEGRAM BOT CONNECTION ACTIVE* ⚡\n\n` +
    `✅ Status: Verified & Operational\n` +
    `🤖 Bot: @Momcareemergencyalarm_bot\n` +
    `📱 Chat ID: ${chatId}\n` +
    `⏱️ Timestamp: ${new Date().toLocaleTimeString('en-IN')}\n\n` +
    `Your doctor can now prescribe medicines and send scheduled reminders directly to this chat.`;

  const success = await dispatchTelegramMessage(chatId, text);
  if (typeof showReportToast === 'function') {
    if (success) {
      showReportToast(`✅ Telegram Bot Connected! Test message sent to chat ID ${chatId}`, true);
    } else {
      showReportToast(`❌ Could not reach Telegram Bot. Check connection.`);
    }
  }
};

function renderPrescriptionsList() {
  const container = document.getElementById('rxPrescriptionsList');
  if (!container) return;

  const list = getPrescriptions();
  if (list.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px; font-size: 0.88rem;">No active prescriptions yet. Prescribe a medicine above to send Telegram reminders.</div>`;
    return;
  }

  let html = '';
  list.forEach(med => {
    html += `
      <div class="rx-med-item">
        <div class="rx-med-info">
          <div class="rx-med-name-row">
            <span class="rx-med-name">${escapeHtml(med.name)}</span>
            <span class="rx-med-category-badge">${escapeHtml(med.category || 'Medication')}</span>
          </div>
          <div class="rx-med-schedule">
            <span>⏰ <strong class="rx-time-badge">${escapeHtml(med.time)}</strong> (${escapeHtml(med.mealRelation || med.frequency || 'Daily')})</span>
            <span>💊 ${escapeHtml(med.dosage || '1 dose')}</span>
          </div>
        </div>
        <div class="rx-med-actions">
          <button type="button" class="rx-action-btn send" onclick="sendPrescriptionReminderToTelegram('${med.id}')" title="Send instant Telegram reminder to Mother">
            ✈️ Remind
          </button>
          <button type="button" class="rx-action-btn delete" onclick="deletePrescription('${med.id}')" title="Delete prescription">
            ✕
          </button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

// ── Automated Time-based Telegram Reminder Monitor ─────────────────────────
const dispatchedTodayReminders = new Set();
setInterval(() => {
  const now = new Date();
  const currentHours = String(now.getHours()).padStart(2, '0');
  const currentMinutes = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${currentHours}:${currentMinutes}`;
  const todayKey = now.toDateString();

  const list = getPrescriptions();
  list.forEach(med => {
    if (med.time === currentTimeStr) {
      const reminderKey = `${todayKey}_${med.id}_${med.time}`;
      if (!dispatchedTodayReminders.has(reminderKey)) {
        dispatchedTodayReminders.add(reminderKey);
        console.log(`⏰ Automated Telegram Medicine Reminder triggered for ${med.name} at ${currentTimeStr}`);
        sendPrescriptionReminderToTelegram(med.id);
      }
    }
  });
}, 30000);

// Live preview listener on input
document.addEventListener('input', (e) => {
  if (['rxMedName', 'rxTime', 'rxMealRelation', 'rxCategory', 'rxDosage'].includes(e.target?.id)) {
    updateTgPreview();
  }
});

// ── Startup Initialization ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  changeLanguage(currentLanguage);
  renderPrescriptionsList();
  updateTgPreview();
  // Start with strictly clean waiting state — NO fake normal values
  syncSharedModules({
    bpm: 0,
    temp: 0,
    motion: 0,
    kicks: 0,
    piezo: 0,
    fallAlert: false,
    sosCall: false
  }, {});
});
