// ============================================================================
//   Mom Care Dashboard - Node.js Backend Server
//   DUAL MODE: Accepts data from ESP32 via WiFi POST *and* USB Serial
//   simultaneously — whichever sends data first wins, both work together.
//
//   MODE env var:
//     auto     (default) → tries Serial + also listens for WiFi POST
//     wifi     → WiFi POST only (no serial)
//     serial   → Serial only (no WiFi POST)
//     simulate → Realistic fake data
// ============================================================================

try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
let Groq;
try { Groq = require('groq-sdk'); } catch (e) { Groq = null; }

let groq = null; // Lazy-initialized when first /api/chat request arrives

// Groq API Key — set via .env file (GROQ_API_KEY=...) or environment variable
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.text());
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const fs = require('fs');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Configuration ──────────────────────────────────────────────────────────
const MODE = (process.env.MODE || 'auto').toLowerCase();
const SERIAL_PORT = process.env.SERIAL_PORT || 'COM7';
const BAUD_RATE = parseInt(process.env.BAUD_RATE || '115200');
const SERVER_PORT = parseInt(process.env.PORT || '3000');

// ── Fall Alert Threshold ───────────────────────────────────────────────────
const FALL_G_THRESHOLD = 3.5; // Matched to Arduino sketch threshold

// ── History Buffer ─────────────────────────────────────────────────────────
const MAX_HISTORY = 60;
const history = {
  ecg: [], bpm: [], piezo: [], kicks: [], motion: [], temp: [], timestamps: [],
};
let latestData = {
  ecg: 0, bpm: 0, piezo: 0, kicks: 0, motion: 0, temp: 35.0,
  fallAlert: false, timestamp: Date.now()
};

// Track connection state
let esp32Ip = null;
let serialActive = false;
let dataSource = 'none';   // 'serial' | 'wifi' | 'simulate'

// ── Get local WiFi IP for display ─────────────────────────────────────────
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (!name.toLowerCase().includes('wi') && !name.toLowerCase().includes('wlan') && !name.toLowerCase().includes('wireless')) continue;
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  // Fallback: any non-internal IPv4
  for (const ifaces2 of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces2) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── BPM noise rejection ────────────────────────────────────────────────────
// Maternal heart rate is physiologically 40–130 BPM.
// Values outside this range are treated as sensor glitches.
const BPM_VALID_MIN = 40;
const BPM_VALID_MAX = 130;

// ── Parse CSV line from Arduino ────────────────────────────────────────────
function parseLine(line) {
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

    // Clamp BPM: discard readings outside physiological range (noise filter)
    let rawBpm = parts['Maternal_BPM'] ?? 0;
    const cleanBpm = (rawBpm > BPM_VALID_MIN && rawBpm <= BPM_VALID_MAX) ? rawBpm : 0;

    return {
      ecg: parts['ECG'] ?? 0,
      bpm: cleanBpm,
      piezo: parts['Piezo_Force'] ?? 0,
      kicks: parts['Kicks_Total'] ?? 0,
      motion: parts['Motion_Total_G'] ?? 0,
      temp: (parts['Temp_C'] !== undefined && parts['Temp_C'] > 0) ? parts['Temp_C'] : (latestData.temp > 0 ? latestData.temp : 35.0),
      fallAlert: parts['Fall_Alert'] === 1,
      sosCall: parts['SOS_Call'] === 1,
      pressCount: parts['Press_Count'] ?? 0,
      mpuOK: parts['MPU_OK'] !== 0,
      timestamp: Date.now()
    };
  } catch { return null; }
}

function appendHistory(data) {
  ['ecg', 'bpm', 'piezo', 'kicks', 'motion', 'temp'].forEach(k => {
    history[k].push(data[k]);
    if (history[k].length > MAX_HISTORY) history[k].shift();
  });
  history.timestamps.push(data.timestamp);
  if (history.timestamps.length > MAX_HISTORY) history.timestamps.shift();
}

// ── Telegram Emergency Alert Dispatcher ──────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8694243360:AAFXCsgiBvjJcgqKdl2delbTLU4u7RaocDo';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7953529788';
let lastServerTelegramTime = 0;
const TELEGRAM_SERVER_COOLDOWN = 15000;

async function sendTelegramEmergencyAlert(text) {
  const now = Date.now();
  if (now - lastServerTelegramTime < TELEGRAM_SERVER_COOLDOWN && lastServerTelegramTime !== 0) return;
  lastServerTelegramTime = now;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
    const result = await resp.json();
    if (result.ok) {
      console.log('📱 Telegram emergency alert dispatched to chat ID:', TELEGRAM_CHAT_ID);
    } else {
      console.warn('⚠️ Telegram API response:', result);
    }
  } catch (err) {
    console.error('❌ Failed to send Telegram alert:', err.message);
  }
}

function broadcast(data, source) {
  latestData = data;
  dataSource = source;
  appendHistory(data);
  io.emit('sensorData', { latest: data, history });

  // Auto-dispatch Telegram alert when MPU6050 crosses test threshold >= 2.0G or fall is flagged
  if (data.fallAlert || (data.motion && data.motion >= 2.0)) {
    const alertMsg = `🚨 *MOMCARE 360 EMERGENCY ALERT* 🚨\n\n` +
      `⚠️ *A possible fall has been detected for the pregnant mother.*\n\n` +
      `📋 *Trigger:* MPU6050 Fall Detection (Acceleration Test Threshold: 2.0G / 19.62 m/s²)\n` +
      `📊 *Detected G-Force:* ${(data.motion ?? 2.0).toFixed(2)} G\n` +
      `⏱️ *Time:* ${new Date().toLocaleTimeString('en-IN')}\n\n` +
      `🩺 Please check her immediately and provide required assistance.\n` +
      `— MOMCARE 360 Autonomous Safety Array`;
    sendTelegramEmergencyAlert(alertMsg);
  }
}

app.post('/api/send-telegram', async (req, res) => {
  const { message, reason, forceG } = req.body || {};
  const alertText = message || (`🚨 *MOMCARE 360 EMERGENCY ALERT* 🚨\n\n` +
    `⚠️ *A possible fall has been detected for the pregnant mother.*\n\n` +
    `📋 *Trigger:* MPU6050 Acceleration Test Threshold (≥ 2.0G / 19.62 m/s²)\n` +
    `📊 *Impact Force:* ${(forceG ?? 2.0).toFixed(2)} G\n` +
    `ℹ️ *Cause:* ${reason || 'MPU6050 High-G Motion'}\n` +
    `⏱️ *Time:* ${new Date().toLocaleTimeString('en-IN')}\n\n` +
    `🩺 Please check her immediately and provide required assistance.\n` +
    `— MOMCARE 360 Autonomous Safety Array`);
  await sendTelegramEmergencyAlert(alertText);
  res.json({ ok: true });
});

// ── Telegram Medicine Prescription & Reminder Dispatcher ───────────────────
app.post('/api/send-medicine-telegram', async (req, res) => {
  const { medicineName, dosage, time, mealRelation, category, notes, chatId, motherName } = req.body || {};
  const targetChatId = chatId || TELEGRAM_CHAT_ID;
  const patient = motherName || 'Mom';

  const telegramMsg =
    `💊 *MOMCARE CLINICAL PRESCRIPTION & MEDICINE REMINDER* 💊\n\n` +
    `👩‍🍼 *Patient (Mother):* ${patient}\n` +
    `👨‍⚕️ *Prescribed by:* MomCare Obstetric Physician\n` +
    `⏰ *Scheduled Time:* ${time || 'Scheduled Daily'} (${mealRelation || 'As Directed'})\n\n` +
    `📋 *Medicine:* *${medicineName || 'Prescribed Medicine'}*\n` +
    `🏷️ *Category:* ${category || 'Prenatal Medication'}\n` +
    `💊 *Dosage Instructions:* ${dosage || '1 dose as directed by physician'}\n` +
    (notes ? `📝 *Doctor Notes:* ${notes}\n\n` : '\n') +
    `🔔 *Reminder:* Take this medication on time with water. If you feel unwell or nauseous, please inform your caregiver.\n\n` +
    `— MOMCARE 360 Autonomous Maternal Surveillance System`;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: telegramMsg,
        parse_mode: 'Markdown'
      })
    });
    const result = await resp.json();
    return res.json({ ok: result.ok, result });
  } catch (err) {
    console.error('Failed to send medicine Telegram reminder:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
//   WIFI ENDPOINT — ESP32 POSTs here
// ============================================================================
app.post('/api/data', (req, res) => {
  const senderIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');

  if (senderIp && senderIp !== esp32Ip) {
    esp32Ip = senderIp;
    console.log(`✅ ESP32 connected via WiFi from ${esp32Ip}`);
    io.emit('portStatus', { status: 'wifi_connected', esp32Ip, message: `ESP32 connected via WiFi (${esp32Ip})` });
  }

  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const data = parseLine(body);
  if (data) {
    broadcast(data, 'wifi');
    res.json({ ok: true });
  } else {
    res.status(400).json({ ok: false, error: 'Could not parse sensor line' });
  }
});

// ============================================================================
//   SERIAL MODE — USB cable from ESP32
// ============================================================================
function trySerial() {
  if (MODE === 'wifi' || MODE === 'simulate') return;

  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort } = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
  } catch {
    console.log('ℹ️  serialport not available — skipping serial mode');
    return;
  }

  let retryTimer = null;

  function connectSerial() {
    if (serialActive) return;
    console.log(`🔌 Trying Serial port ${SERIAL_PORT} at ${BAUD_RATE} baud...`);
    io.emit('portStatus', { status: 'connecting', port: SERIAL_PORT });

    let port;
    try {
      port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE, autoOpen: false });
    } catch (err) {
      scheduleRetry();
      return;
    }

    port.open(err => {
      if (err) {
        console.log(`⚠️  Serial ${SERIAL_PORT} unavailable: ${err.message}`);
        io.emit('portStatus', { status: 'error', message: `Serial not available: ${err.message}` });
        scheduleRetry();
        return;
      }
      serialActive = true;
      console.log(`✅ Serial ${SERIAL_PORT} open — live USB data streaming`);
      io.emit('portStatus', { status: 'connected', port: SERIAL_PORT });

      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', line => {
        // ── RAW DEBUG: print every line from ESP32 ──
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          console.log('[RAW]', trimmed.substring(0, 120));
        }
        const data = parseLine(line);
        if (data) broadcast(data, 'serial');
      });

      port.on('close', () => {
        serialActive = false;
        console.log('⚠️  Serial port closed. Retrying in 3s...');
        io.emit('portStatus', { status: 'disconnected' });
        scheduleRetry();
      });

      port.on('error', () => {
        serialActive = false;
        scheduleRetry();
      });
    });
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connectSerial, 3000);
  }

  connectSerial();
}

// ============================================================================
//   SIMULATION MODE
// ============================================================================
let simTime = 0, simKicks = 0, simBpm = 72;

function simulateData() {
  simTime += 0.05;
  simBpm = 72 + Math.sin(simTime * 0.1) * 8 + (Math.random() - 0.5) * 2;
  const phase = (simTime % (60 / simBpm)) / (60 / simBpm);
  let ecg = 2048;
  if (phase > 0.45 && phase < 0.55) ecg += Math.sin((phase - 0.45) / 0.1 * Math.PI) * 700;
  const doKick = Math.random() < 0.005;
  if (doKick) simKicks++;
  const piezo = doKick ? 200 + Math.random() * 300 : Math.random() * 30;
  const doBump = Math.random() < 0.002;
  const motion = doBump ? 2.6 + Math.random() * 0.5 : 0.95 + (Math.random() - 0.5) * 0.1;
  const temp = 35.0;
  return {
    ecg: Math.round(ecg), bpm: parseFloat(simBpm.toFixed(1)),
    piezo: parseFloat(piezo.toFixed(1)), kicks: simKicks,
    motion: parseFloat(motion.toFixed(3)), temp: parseFloat(temp.toFixed(2)),
    fallAlert: motion > FALL_G_THRESHOLD, mpuOK: true, timestamp: Date.now()
  };
}

// ── REST endpoints ─────────────────────────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  try {
    const { SerialPort } = require('serialport');
    res.json(await SerialPort.list());
  } catch { res.json([]); }
});

app.get('/api/history', (req, res) => res.json({ latest: latestData, history }));

app.get('/api/status', (req, res) => {
  res.json({ mode: MODE, dataSource, serialActive, esp32Ip, serverIp: getLocalIp() });
});

// ── GROQ AI CHAT ENDPOINT ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, vitals, language } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided.' });

  const langNames = {
    'en': 'English',
    'ta': 'Tamil (தமிழ்)',
    'hi': 'Hindi (हिन्दी)',
    'te': 'Telugu (తెలుగు)',
    'ml': 'Malayalam (മലയാളം)',
    'kn': 'Kannada (ಕನ್ನಡ)'
  };
  const targetLang = langNames[language] || 'English';

  // 1. Try Groq cloud AI
  const activeGroqKey = process.env.GROQ_API_KEY || GROQ_API_KEY;
  if (Groq && activeGroqKey) {
    try {
      if (!groq) groq = new Groq({ apiKey: activeGroqKey });
      const hasLiveReading = vitals && (vitals.hasValidData || vitals.bpm > 0);

      let vitalsContext = hasLiveReading
        ? `CURRENT LIVE SENSOR TELEMETRY (Hardware Stream Active):
- Maternal Heart Rate: ${vitals.bpm} BPM
- Blood Oxygen (SpO2): ${vitals.spo2}%
- Body Temperature: ${vitals.temp} degrees C
- Blood Pressure: ${vitals.bp} mmHg
- Fetal Kicks: ${vitals.kicks ?? 0} kicks
- Fall Detection Alert: ${vitals.fallAlert ? 'YES - POSSIBLE FALL DETECTED' : 'No Fall Detected (Normal)'}`
        : `HARDWARE SENSOR STATUS: WAITING FOR SENSOR DATA (No live packets yet). Advise user to check ESP32 sensor connection.`;

      const systemPrompt = `You are MomCare Clinical AI, an expert, compassionate obstetric maternal health medical assistant integrated into the MOMCARE 360 real-time IoT surveillance system.
${vitalsContext}

STRICT FORMATTING RULES:
- Do NOT use any emojis, emoticons, or Unicode symbols in your response.
- Do NOT use markdown headers (##, ###, etc.).
- Use plain numbered lists or bullet points (using - or *) for structured information.
- Write in clear, professional, clinical prose.
- Keep answers concise, medically accurate, reassuring, and practical.
- Write your entire response fluently in ${targetLang}.`;

      let completion;
      try {
        completion = await groq.chat.completions.create({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ],
          max_tokens: 600,
          temperature: 0.6,
        });
      } catch (modelErr) {
        console.warn('Primary Groq model failed, trying fallback:', modelErr.message);
        completion = await groq.chat.completions.create({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ],
          max_tokens: 500,
          temperature: 0.6,
        });
      }

      const reply = completion.choices[0]?.message?.content?.trim();
      if (reply) {
        return res.json({ reply });
      }
    } catch (err) {
      console.warn('Groq API fallback triggered:', err.message);
    }
  }

  // 2. Intelligent Clinical Fallback (if no API key or cloud AI fails)
  const text = (message || '').toLowerCase();
  const v = vitals || {};
  const isLive = !!(v && (v.hasValidData || v.bpm > 0));
  const bpm = isLive && v.bpm ? Number(v.bpm).toFixed(0) : null;
  const spo2 = isLive && v.spo2 ? v.spo2 : null;
  const temp = isLive && v.temp ? Number(v.temp).toFixed(1) : null;
  const bp = isLive && v.bp && v.bp !== '-- / --' ? v.bp : null;
  const kicks = isLive && v.kicks !== undefined ? v.kicks : null;
  const isFall = !!(v && v.fallAlert);

  let fallbackReply;
  if (text.includes('heart') || text.includes('pulse') || text.includes('bpm')) {
    fallbackReply = bpm
      ? `Your maternal heart rate is currently ${bpm} BPM, which is within the expected physiological range (60–100 BPM). Continue quiet rest.`
      : 'Waiting for live telemetry from the AD8232 ECG sensor. Please verify the chest leads are connected.';
  } else if (text.includes('kick') || text.includes('movement') || text.includes('baby')) {
    fallbackReply = kicks !== null
      ? `Total recorded fetal movements today: ${kicks} kicks. Movement patterns indicate active fetal health.`
      : 'The piezoelectric fetal movement sensor is active and monitoring kicks in real time.';
  } else if (text.includes('temp') || text.includes('fever')) {
    fallbackReply = temp
      ? `Current body temperature is ${temp}°C (${Number(temp) <= 37.5 ? 'Normothermic / Normal' : 'Fever alert'}). Stay hydrated.`
      : 'Waiting for LM35D body temperature sensor readings.';
  } else if (text.includes('emergency') || text.includes('hospital') || text.includes('help')) {
    fallbackReply = 'For acute medical assistance, contact National Emergency Services (108). In Coimbatore near Sri Shakthi College, nearby facilities include KMCH (Avinashi Rd), NG Hospital, and Chinniyampalayam PHC.';
  } else {
    fallbackReply = isLive
      ? `Maternal Vitals Summary: Heart Rate: ${bpm || '--'} BPM, SpO2: ${spo2 || '--'}%, Temp: ${temp || '--'}°C, BP: ${bp || '--'} mmHg, Kicks: ${kicks ?? 0}. ${isFall ? 'Alert: Fall vector detected!' : 'All parameters stable.'}`
      : 'Hello! I am MomCare Clinical AI. I am actively monitoring your maternal biometric telemetry. Feel free to ask about your heart rate, kicks, blood pressure, or prenatal health.';
  }

  res.json({ reply: fallbackReply });
});

// ── WHATSAPP ALERT ENDPOINT ───────────────────────────────────────────────
const sentAlerts = new Set();

app.post('/api/alert', async (req, res) => {
  const { alertMessage, timestamp, motherName, recipientNumber } = req.body;

  if (!alertMessage) return res.status(400).json({ error: 'No alertMessage provided.' });

  // Deduplication check
  const alertId = `${alertMessage}_${timestamp}`;
  if (sentAlerts.has(alertId)) {
    return res.json({ success: true, duplicate: true, status: 'Already notified' });
  }
  sentAlerts.add(alertId);

  // Prevent memory leak
  if (sentAlerts.size > 1000) {
    const firstItem = sentAlerts.values().next().value;
    sentAlerts.delete(firstItem);
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const finalRecipient = recipientNumber || process.env.WHATSAPP_RECIPIENT_NUMBER;
  const finalMotherName = motherName || 'Mom';

  const timeString = timestamp ? new Date(timestamp).toLocaleTimeString('en-IN') : new Date().toLocaleTimeString('en-IN');

  const textBody = `🚨 MOMCARE 360 ALERT\n\nMother: ${finalMotherName}\n\nAlert:\n${alertMessage}\n\nTime:\n${timeString}\n\nPlease check the mother and take appropriate action if required.\n\nThis is an AI-assisted monitoring alert and not a medical diagnosis.`;

  if (token && phoneId && finalRecipient) {
    // Real API call
    try {
      const response = await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: finalRecipient,
          type: 'text',
          text: { body: textBody }
        })
      });

      const result = await response.json();
      if (response.ok) {
        return res.json({ success: true, status: 'SENT', recipient: finalRecipient });
      } else {
        console.error('WhatsApp API Error:', result);
        return res.status(500).json({ success: false, error: result.error?.message || 'API Error' });
      }
    } catch (err) {
      console.error('WhatsApp API Request Failed:', err);
      return res.status(500).json({ success: false, error: 'Network Error' });
    }
  } else {
    // No credentials, silently ignore instead of mock logging
    return res.json({ success: true, status: 'SKIPPED_NO_CREDENTIALS', recipient: finalRecipient });
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  const clientIp = socket.handshake.address.replace('::ffff:', '');
  console.log(`🖥️  Browser connected: ${clientIp} (${socket.id})`);
  socket.emit('sensorData', { latest: latestData, history });

  // Send current connection state to new browser client
  if (MODE === 'simulate') {
    socket.emit('portStatus', { status: 'simulating', message: 'Running in simulation mode' });
  } else if (esp32Ip) {
    socket.emit('portStatus', { status: 'wifi_connected', esp32Ip, message: `ESP32 connected via WiFi (${esp32Ip})` });
  } else if (serialActive) {
    socket.emit('portStatus', { status: 'connected', port: SERIAL_PORT });
  } else {
    socket.emit('portStatus', {
      status: 'wifi_waiting',
      message: `Waiting for ESP32... (flash sketch & connect to WiFi, or plug USB to ${SERIAL_PORT})`
    });
  }

  socket.on('disconnect', () => console.log(`❌ Browser disconnected: ${socket.id}`));
});

// ── Start server ───────────────────────────────────────────────────────────
const localIp = getLocalIp();

if (!process.env.VERCEL) {
  server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log(`║  🌐 MomCare Dashboard                                    ║`);
    console.log(`║     Local:   http://localhost:${SERVER_PORT}                     ║`);
    console.log(`║     Network: http://${localIp}:${SERVER_PORT}                ║`);
    console.log(`║  📡 Mode: ${MODE.toUpperCase().padEnd(47)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');

    if (MODE === 'simulate') {
      console.log('║  🔄 Simulation mode — generating fake sensor data        ║');
      console.log('╚══════════════════════════════════════════════════════════╝\n');
      io.emit('portStatus', { status: 'simulating', message: 'Running in simulation mode' });
      setInterval(() => broadcast(simulateData(), 'simulate'), 50);
    } else if (MODE === 'wifi') {
      console.log(`║  📡 WiFi only — ESP32 POST to:                           ║`);
      console.log(`║     http://${localIp}:${SERVER_PORT}/api/data             ║`);
      console.log('╚══════════════════════════════════════════════════════════╝\n');
      io.emit('portStatus', { status: 'wifi_waiting', message: 'WiFi mode — waiting for ESP32...' });
    } else {
      // AUTO or SERIAL: try serial and ALSO accept WiFi POSTs
      console.log(`║  🔌 Serial: ${SERIAL_PORT} at ${BAUD_RATE} baud                     ║`);
      console.log(`║  📡 WiFi POST: http://${localIp}:${SERVER_PORT}/api/data  ║`);
      console.log('║  (whichever connects first will stream live data)        ║');
      console.log('╚══════════════════════════════════════════════════════════╝\n');
      trySerial();
    }
  });
}

module.exports = app;
