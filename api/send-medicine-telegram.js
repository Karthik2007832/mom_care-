// api/send-medicine-telegram.js - Vercel Serverless Function for Telegram Reminders
try { require('dotenv').config(); } catch (e) {}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8694243360:AAFXCsgiBvjJcgqKdl2delbTLU4u7RaocDo';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7953529788';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'MomCare Telegram Medicine Service Online' });
  }

  const { medicineName, dosage, time, mealRelation, category, notes, chatId, motherName, message } = req.body || {};
  const targetChatId = chatId || TELEGRAM_CHAT_ID;
  const patient = motherName || 'Mom';

  const telegramMsg = message || (
    `💊 *MOMCARE CLINICAL PRESCRIPTION & MEDICINE REMINDER* 💊\n\n` +
    `👩‍🍼 *Patient (Mother):* ${patient}\n` +
    `👨‍⚕️ *Prescribed by:* MomCare Obstetric Physician\n` +
    `⏰ *Scheduled Time:* ${time || 'Scheduled Daily'} (${mealRelation || 'As Directed'})\n\n` +
    `📋 *Medicine:* *${medicineName || 'Prescribed Medicine'}*\n` +
    `🏷️ *Category:* ${category || 'Prenatal Medication'}\n` +
    `💊 *Dosage Instructions:* ${dosage || '1 dose as directed by physician'}\n` +
    (notes ? `📝 *Doctor Notes:* ${notes}\n\n` : '\n') +
    `🔔 *Reminder:* Take this medication on time with water. If you feel unwell or nauseous, please inform your caregiver.\n\n` +
    `— MOMCARE 360 Autonomous Maternal Surveillance System`
  );

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
    return res.status(200).json({ ok: result.ok, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
