// api/chat.js - Vercel Serverless Function for MomCare 360 Maternal AI Chat
let Groq;
try {
  Groq = require('groq-sdk');
} catch (e) {
  Groq = null;
}

function generateClinicalFallback(message, vitals, language) {
  const text = (message || '').toLowerCase();
  const v = vitals || {};
  const isLive = !!(v && (v.hasValidData || v.bpm > 0));
  const bpm = isLive && v.bpm ? Number(v.bpm).toFixed(0) : null;
  const spo2 = isLive && v.spo2 ? v.spo2 : null;
  const temp = isLive && v.temp ? Number(v.temp).toFixed(1) : null;
  const bp = isLive && v.bp && v.bp !== '-- / --' ? v.bp : null;
  const kicks = isLive && v.kicks !== undefined ? v.kicks : null;
  const isFall = !!(v && v.fallAlert);

  const lang = (language || 'en').toLowerCase();

  // 1. Heart Rate / Pulse
  if (text.includes('heart') || text.includes('pulse') || text.includes('bpm') || text.includes('துடிப்பு') || text.includes('धड़कन') || text.includes('గుండె')) {
    if (lang === 'ta') {
      return bpm
        ? `உங்கள் தற்போதைய தாய்வழி இதயத் துடிப்பு ${bpm} BPM ஆக உள்ளது. இது இயல்பான அளவில் (${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'சீராக' : 'கண்காணிப்பில்'}) உள்ளது. ஆழ்ந்த சுவாசம் எடுத்து அமைதியாக ஓய்வெடுக்கவும்.`
        : 'தற்போது இதயத் துடிப்பு சென்சார் தரவுக்காக காத்திருக்கிறது. ESP32 சென்சார் சரியாக இணைக்கப்பட்டுள்ளதா என்பதை உறுதிப்படுத்தவும்.';
    }
    if (lang === 'hi') {
      return bpm
        ? `आपकी वर्तमान हृदय गति ${bpm} BPM है। यह ${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'सामान्य और स्थिर' : 'निगरानी में'} है। पर्याप्त पानी पिएं और विश्राम करें।`
        : 'वर्तमान में हृदय गति सेंसर डेटा की प्रतीक्षा की जा रही है। कृपया सुनिश्चित करें कि ईएसपी32 सेंसर ठीक से लगा हुआ है।';
    }
    return bpm
      ? `Your current maternal heart rate is ${bpm} BPM, which is ${Number(bpm) >= 60 && Number(bpm) <= 100 ? 'within the normal physiological range (60–100 BPM)' : 'under clinical observation'}. Continue comfortable seated rest and stay hydrated.`
      : 'Live maternal heart rate telemetry is currently waiting for sensor data. Please ensure the AD8232 ECG sensor leads are securely positioned.';
  }

  // 2. Fetal Movement / Kicks
  if (text.includes('kick') || text.includes('movement') || text.includes('baby') || text.includes.apply(text, ['குழந்தை', 'உதை', 'लात', 'शिशु', 'పిల్ల'])) {
    if (lang === 'ta') {
      return kicks !== null
        ? `இன்று பதிவுசெய்யப்பட்ட குழந்தையின் அசைவுகள்: ${kicks} உதைகள். பொதுவாக உணவுக்குப் பின் குழந்தை சுறுசுறுப்பாக இருக்கும். ஏதேனும் மாற்றம் தெரிந்தால் மருத்துவரை அணுகவும்.`
        : 'கருவின் அசைவு சென்சார் தயாராக உள்ளது. குழந்தை உதைக்கும் போது சென்சார் துல்லியமாக பதிவு செய்யும்.';
    }
    if (lang === 'hi') {
      return kicks !== null
        ? `आज कुल ${kicks} शिशु किक्स दर्ज किए गए हैं। भोजन के बाद शिशु की गतिविधि सामान्यतः अधिक होती है।`
        : 'शिशु गतिविधि सेंसर सक्रिय है और किक्स रिकॉर्ड करने के लिए तैयार है।';
    }
    return kicks !== null
      ? `Total fetal movements logged today: ${kicks} kicks. Healthy fetal activity generally exceeds 10 movements over a monitoring window. Continue routine daily kick tracking.`
      : 'The piezoelectric fetal movement sensor is active and ready to log acoustic kicks as the baby moves.';
  }

  // 3. Temperature / Fever
  if (text.includes('temp') || text.includes('fever') || text.includes('heat') || text.includes('வெப்பநிலை') || text.includes('காய்ச்சல்') || text.includes('बुखार')) {
    if (lang === 'ta') {
      return temp
        ? `உடல் வெப்பநிலை: ${temp}°C. இது இயல்பான (${Number(temp) <= 37.5 ? 'காய்ச்சல் இல்லை' : 'லேசான வெப்பம்'}) வரம்பில் உள்ளது. நிறைய தண்ணீர் குடிக்கவும்.`
        : 'வெப்பநிலை சென்சார் அளவீடுக்காக காத்திருக்கிறது.';
    }
    return temp
      ? `Current body temperature is ${temp}°C. Physiological baseline is 36.1°C – 37.5°C (${Number(temp) <= 37.5 ? 'Normothermic / No fever' : 'Elevated temperature noted'}). Stay well hydrated.`
      : 'Waiting for LM35D temperature sensor telemetry. Ensure the sensor probe is in stable contact.';
  }

  // 4. Blood Pressure / SpO2 / Vitals Summary
  if (text.includes('health') || text.includes('status') || text.includes('report') || text.includes('bp') || text.includes('spo2') || text.includes('நலம்') || text.includes('स्वास्थ्य') || text.includes('బాగు')) {
    if (lang === 'ta') {
      return isLive
        ? `தற்போதைய உடல்நிலை சுருக்கம்: இதயத் துடிப்பு: ${bpm || '--'} BPM, ஆக்ஸிஜன்: ${spo2 || '--'}%, வெப்பநிலை: ${temp || '--'}°C, இரத்த அழுத்தம்: ${bp || '--'} mmHg. ${isFall ? 'எச்சரிக்கை: வீழ்ச்சி கண்டறியப்பட்டுள்ளது!' : 'உடல்நிலை சீராக உள்ளது.'}`
        : 'சென்சார் இணைப்புக்காக காத்திருக்கிறது. சாதனம் இயக்கப்பட்டவுடன் உங்கள் உடல்நிலை தானாக பகுப்பாய்வு செய்யப்படும்.';
    }
    if (lang === 'hi') {
      return isLive
        ? `स्वास्थ्य स्थिति: हृदय गति: ${bpm || '--'} BPM, ऑक्सीजन: ${spo2 || '--'}%, तापमान: ${temp || '--'}°C, रक्तचाप: ${bp || '--'} mmHg। ${isFall ? 'सावधान: गिरावट दर्ज की गई!' : 'स्थिति सामान्य है।'}`
        : 'सेंसर डेटा की प्रतीक्षा की जा रही है। डिवाइस कनेक्ट होने पर स्वचालित मूल्यांकन उपलब्ध होगा।';
    }
    return isLive
      ? `Current Maternal Biometric Summary: Heart Rate: ${bpm || '--'} BPM, SpO2: ${spo2 || '--'}%, Core Temp: ${temp || '--'}°C, BP: ${bp || '--'} mmHg, Kicks: ${kicks ?? 0}. ${isFall ? 'ALERT: Fall vector detected!' : 'All telemetry signals indicate physiological stability.'}`
      : 'Awaiting real-time biometric packets from the ESP32 bio-sensor array. Once connected, your comprehensive maternal assessment will update automatically.';
  }

  // 5. Emergency / Hospital / Help
  if (text.includes('emergency') || text.includes('help') || text.includes('hospital') || text.includes('doctor') || text.includes('sos') || text.includes('ஆபத்து') || text.includes('மருத்துவமனை') || text.includes('अस्पताल')) {
    if (lang === 'ta') {
      return 'அவசர நிலைக்கு உடனடியாக 108 ஐ அழைக்கவும் அல்லது ஸ்ரீ சக்தி கல்லூரி அருகில் உள்ள கே.எம்.சி.எச் (அவிநாசி ரோடு) / சின்னியம்பாளையம் பி.எச்.சி மருத்துவமனையை தொடர்பு கொள்ளவும். டாஷ்போர்டில் உள்ள அவசர SOS பட்டனையும் பயன்படுத்தலாம்.';
    }
    return 'For acute medical emergencies, immediately contact National Emergency Services (108). In Coimbatore near Sri Shakthi College, nearby centers include KMCH (Avinashi Rd), NG Hospital, and Chinniyampalayam PHC. You can also trigger the Emergency SOS button on your dashboard.';
  }

  // Default Greeting / Maternal Care Advice
  if (lang === 'ta') {
    return 'வணக்கம்! நான் மாம்கேர் AI மருத்துவ உதவியாளர். உங்கள் கர்ப்பகால நலம், இதயத் துடிப்பு, குழந்தையின் அசைவுகள் மற்றும் ஊட்டச்சத்து பற்றி என்னிடம் எப்போது வேண்டுமானாலும் கேட்கலாம்.';
  }
  if (lang === 'hi') {
    return 'नमस्ते! मैं मॉमकेयर एआई स्वास्थ्य सहायक हूँ। आप अपनी गर्भावस्था, हृदय गति, शिशु की किक्स और स्वास्थ्य सलाह के बारे में मुझसे कभी भी पूछ सकते हैं।';
  }
  return 'Hello! I am MomCare Clinical AI. I continuously monitor your maternal vital signs, fetal movement patterns, and general pregnancy wellness. Feel free to ask about your heart rate, kicks, blood pressure, or prenatal health advice.';
}

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'MomCare 360 AI Service Online' });
  }

  const { message, vitals, language } = req.body || {};
  const currentLang = language || 'en';

  if (!message) {
    return res.status(400).json({ error: 'No message provided.' });
  }

  // Attempt Groq Cloud AI if configured
  if (process.env.GROQ_API_KEY && Groq) {
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const langNames = {
        'en': 'English',
        'ta': 'Tamil (தமிழ்)',
        'hi': 'Hindi (हिन्दी)',
        'te': 'Telugu (తెలుగు)',
        'ml': 'Malayalam (മലയാളം)',
        'kn': 'Kannada (ಕನ್ನಡ)'
      };
      const targetLang = langNames[currentLang] || 'English';
      const hasLiveReading = vitals && (vitals.hasValidData || vitals.bpm > 0);

      const vitalsContext = hasLiveReading
        ? `CURRENT LIVE SENSOR TELEMETRY:
- Maternal Heart Rate: ${vitals.bpm} BPM
- Blood Oxygen (SpO2): ${vitals.spo2}%
- Body Temperature: ${vitals.temp} °C
- Blood Pressure: ${vitals.bp} mmHg
- Fetal Kicks: ${vitals.kicks ?? 0} kicks
- Fall Alert: ${vitals.fallAlert ? 'ALERT: POSSIBLE FALL' : 'Nominal Safe'}`
        : `HARDWARE SENSOR STATUS: WAITING FOR SENSOR DATA (No live packets yet). Advise user to check ESP32 sensor connection.`;

      const systemPrompt = `You are MomCare Clinical AI, an expert, compassionate obstetric maternal health medical assistant integrated into the MOMCARE 360 real-time IoT surveillance system.
${vitalsContext}

STRICT FORMATTING RULES:
- Do NOT use any emojis, emoticons, or Unicode symbols.
- Do NOT use markdown headers (##, ###, etc.).
- Use plain numbered lists or bullet points (using - or *) for structured information.
- Write in clear, professional, clinical prose.
- Keep answers concise, medically accurate, reassuring, and practical.
- Write your entire response fluently in ${targetLang}.`;

      const completion = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 600,
        temperature: 0.6
      }).catch(async () => {
        return await groq.chat.completions.create({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ],
          max_tokens: 500,
          temperature: 0.6
        });
      });

      const reply = completion.choices[0]?.message?.content?.trim();
      if (reply) {
        return res.status(200).json({ reply });
      }
    } catch (groqErr) {
      console.warn('Groq cloud fallback:', groqErr.message);
    }
  }

  // Clinical fallback engine
  const reply = generateClinicalFallback(message, vitals, currentLang);
  return res.status(200).json({ reply });
};
