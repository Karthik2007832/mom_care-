/* ══════════════════════════════════════════════════════════════════════════
   Mom Care Dashboard — Edge AI Simulated Models
   This module simulates the output of TensorFlow Lite Micro models that
   will eventually be deployed on the ESP32-S3.

   Disclaimer: This is for early warning and monitoring.
   Not a medical diagnosis. Consult a healthcare professional.
   ══════════════════════════════════════════════════════════════════════════ */

   const MomCareAI = {

    // ── 1. AI Fetal Movement Pattern Analysis ─────────────────────────────
    analyzeFetalMovement: function(history) {
        if (!history || !history.kicks || history.kicks.length === 0) {
            return {
                baseline: 0,
                current: 0,
                deviation: 0,
                riskLevel: 'LOW',
                alert: false
            };
        }
        
        // In a real Edge AI model, this would be an LSTM or Anomaly Detection Autoencoder.
        // We simulate "baseline" as a rolling average of past kicks (excluding the very latest few ticks for stability).
        const data = history.kicks;
        const currentKicks = data[data.length - 1];
        
        let baseline = 0;
        let count = 0;
        // Calculate average of the first 80% of the history buffer to represent "baseline"
        const limit = Math.max(1, Math.floor(data.length * 0.8));
        for (let i = 0; i < limit; i++) {
            baseline += data[i];
            count++;
        }
        baseline = count > 0 ? baseline / count : 0;
        
        // Deviation percentage
        const deviation = baseline > 0 ? ((currentKicks - baseline) / baseline) * 100 : 0;
        
        let riskLevel = 'LOW';
        let alert = false;
        
        if (deviation < -50) {
            riskLevel = 'HIGH';
            alert = true;
        } else if (deviation < -25) {
            riskLevel = 'MODERATE';
        }
        
        return {
            baseline: Math.round(baseline),
            current: currentKicks,
            deviation: Math.round(deviation),
            riskLevel: riskLevel,
            alert: alert
        };
    },

    // ── 2. AI Pregnancy Health Trend Prediction ───────────────────────────
    predictHealthTrend: function(history) {
        if (!history || !history.bpm || history.bpm.length < 5) {
            return { score: 0, category: 'GREEN', explanations: ['Collecting baseline data...'] };
        }

        // Simulate a Multivariate Regression / Gradient Boosting model.
        // We extract linear trends (slope) from the history array.
        
        const getSlope = (arr) => {
            if (arr.length < 2) return 0;
            const n = arr.length;
            let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
            for (let i = 0; i < n; i++) {
                sumX += i;
                sumY += arr[i];
                sumXY += i * arr[i];
                sumX2 += i * i;
            }
            return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        };

        const bpmSlope = getSlope(history.bpm);
        const tempSlope = getSlope(history.temp);
        
        const currentBpm = history.bpm[history.bpm.length - 1];
        const currentTemp = history.temp[history.temp.length - 1];

        let riskScore = 10; // Base score
        let explanations = [];

        // Trend logic
        if (bpmSlope > 0.5 && currentBpm > 95) {
            riskScore += 30;
            explanations.push("Progressive upward trend in Heart Rate detected.");
        }
        if (tempSlope > 0.05 && currentTemp > 37.2) {
            riskScore += 40;
            explanations.push("Steady rise in Body Temperature approaching fever range.");
        }
        if (currentBpm > 110) {
            riskScore += 20;
            explanations.push("Resting Heart Rate is significantly elevated.");
        }

        // Ensure bounds 0-100
        riskScore = Math.min(100, Math.max(0, Math.round(riskScore)));

        let category = 'GREEN';
        if (riskScore >= 75) category = 'RED';
        else if (riskScore >= 50) category = 'ORANGE';
        else if (riskScore >= 25) category = 'YELLOW';

        if (explanations.length === 0) {
            explanations.push("Vitals are stable. No concerning trends detected.");
        }

        return {
            score: riskScore,
            category: category,
            explanations: explanations
        };
    },

    // ── 3. AI Personalized Nutrition Recommendation ───────────────────────
    generateNutritionPlan: function(vitals, profile) {
        // Simulates an Expert System or LLM chain for dietary advice.
        
        let focus = "Balanced Prenatal Nutrition";
        let recommendations = [
            "Maintain a balanced diet rich in leafy greens, lean proteins, and whole grains."
        ];
        let limits = ["Raw fish", "Unpasteurized dairy", "Excess caffeine"];
        let hydration = "Drink at least 8-10 glasses of water daily.";

        if (!vitals) return { focus, recommendations, limits, hydration };

        // Anemia logic (mocked profile risk or high heart rate correlation)
        if (profile.anemiaRisk === 'high' || (vitals.bpm && vitals.bpm > 100)) {
            focus = "Iron-Rich & Cardiac Support Diet";
            recommendations.push("Prioritize iron-rich foods: spinach, lentils, and fortified cereals.");
            recommendations.push("Pair iron sources with Vitamin C (oranges, bell peppers) for better absorption.");
        }

        // BP logic (simulated by motion or manual profile entry)
        if (profile.bpTrend === 'high' || (vitals.motion && vitals.motion > 1.2)) {
            focus = "Blood Pressure Management";
            recommendations.push("Incorporate potassium-rich foods like bananas and sweet potatoes.");
            limits.push("High-sodium processed foods");
        }

        // Low BMI logic
        if (profile.bmi === 'low') {
            recommendations.push("Include nutrient-dense healthy fats: avocados, nuts, and olive oil.");
        }

        return {
            focus: focus,
            recommendations: recommendations,
            limits: limits,
            hydration: hydration
        };
    }
};

window.MomCareAI = MomCareAI;
