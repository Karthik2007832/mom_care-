// ============================================================================
//   Mom Care: Full Unified Passive Surveillance & Fall Detection Array
//   BLE Edition — Streams data over Bluetooth Low Energy (UART Service)
//   Connect via a BLE Terminal app using the UART Service UUIDs.
// ============================================================================
//
//   HARDWARE WIRING CONNECTIONS (ESP32-C3 / ESP32 Standard):
//   --------------------------------------------------------------------------
//   1. MPU-6050 Accelerometer & Gyroscope (Fall & Impact Detection):
//        • VCC  → ESP32 3.3V
//        • GND  → ESP32 GND
//        • SCL  → ESP32 GPIO 21  (I2C Clock)
//        • SDA  → ESP32 GPIO 20  (I2C Data)
//
//   2. AD8232 ECG Sensor (Maternal Heart Rate & ECG Waveform):
//        • 3.3V → ESP32 3.3V
//        • GND  → ESP32 GND
//        • OUT  → ESP32 GPIO 2   (ADC Channel)
//
//   3. Piezoelectric Vibration Sensor (Fetal Kick Counter):
//        • Positive (+) → ESP32 GPIO 1 (ADC Channel)
//        • Negative (-) → ESP32 GND
//
//   4. LM35D Temperature Sensor (Core Body Temperature):
//        • VCC  → ESP32 3.3V / 5V
//        • GND  → ESP32 GND
//        • VOUT → ESP32 GPIO 0   (ADC Channel)
//
//   5. Emergency SOS Push Button:
//        • Terminal 1 → ESP32 GPIO 8 (Active-LOW, Internal Pull-up)
//        • Terminal 2 → ESP32 GND
//        (Onboard BOOT Button on GPIO 9 serves as secondary backup)
// ============================================================================
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

BLEServer *pServer = NULL;
BLECharacteristic *pTxCharacteristic;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// See the following for generating UUIDs:
// https://www.uuidgenerator.net/
#define SERVICE_UUID           "6E400001-B5A3-F393-E0A9-E50E24DCCA9E" // UART service UUID
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
    }
};

Adafruit_MPU6050 mpu;
bool mpuOK = false;              // Tracks whether MPU6050 successfully initialized
bool fallDetected = false;       // Sticky fall flag cleared after reporting

// Hardware Pin Definitions
// ── MPU6050 6-Axis Motion Array (I2C) ──
const int MPU_SDA_PIN      = 20; // MPU6050 SDA (Data)  → ESP32 GPIO 20
const int MPU_SCL_PIN      = 21; // MPU6050 SCL (Clock) → ESP32 GPIO 21

// ── Physical & Biometric Sensors ──
const int PUSH_BUTTON_PIN  = 8;  // External Push Button → GPIO 8 (Active-LOW with Internal Pull-up)
const int ONBOARD_BOOT_PIN = 9;  // Onboard BOOT Button → GPIO 9 (Universal ESP32-C3 Fallback)
const int ECG_OUTPUT_PIN   = 2;  // AD8232 Analog Out → GPIO 2
const int PIEZO_PIN        = 1;  // Piezo Positive → GPIO 1
const int TEMP_INPUT_PIN   = 0;  // LM35D Analog Out → GPIO 0

// Emergency SOS Configuration (+91 9994684450)
const char* EMERGENCY_PHONE_NUMBER = "+919994684450";
const unsigned long BUTTON_DEBOUNCE_MS = 40;     // 40ms mechanical debounce
const unsigned long MULTI_PRESS_WINDOW  = 5000;   // 5.0-second window to register 3 presses
const int REQUIRED_PRESSES_FOR_SOS     = 3;      // 3 presses to trigger emergency SOS call

// Standalone WiFi & Direct Telegram Bot Configuration
const char* WIFI_SSID           = "YOUR_WIFI_NAME";     // Change to your WiFi or Hotspot SSID
const char* WIFI_PASSWORD       = "YOUR_WIFI_PASSWORD"; // Change to your WiFi or Hotspot Password
const char* TELEGRAM_BOT_TOKEN  = "8694243360:AAFXCsgiBvjJcgqKdl2delbTLU4u7RaocDo";
const char* TELEGRAM_CHAT_ID    = "7953529788";         // Karthik's Telegram Chat ID

// Telegram Cooldown Mechanism
const unsigned long TELEGRAM_COOLDOWN_MS = 15000;       // 15 seconds cooldown between alerts
unsigned long lastTelegramSendTime       = 0;

int buttonPressCount = 0;
bool wasButtonPressed = false;
unsigned long lastPressTime  = 0;
unsigned long firstPressTime = 0;
unsigned long sosActiveUntil = 0;   // Latched SOS alert duration
bool sosCallTriggered = false;

// Calibration Thresholds
const int SIGNAL_THRESHOLD = 2400;   // ECG Peak threshold
const int KICK_SENSITIVITY = 350;    // Piezo kick sensitivity threshold
const unsigned long DEBOUNCE = 1200; // Vibration echo debounce window (1.2s)

// Fall Detection Algorithmic Limits
const float FALL_THRESHOLD     = 2.0;    // Temporary TEST threshold: 2.0G (2.0 * 9.81 = 19.62 m/s²)
const float AMBIENT_G          = 9.81;   // Earth's base gravity reference
const int   FALL_CONFIRM_COUNT = 3;      // Must see >2.0G for this many consecutive samples
const unsigned long FALL_DEBOUNCE_MS = 2000; // Min 2s between successive fall alerts

int   fallConsecutive  = 0;           // Counter for consecutive high-G samples
unsigned long lastFallAlertTime = 0;  // Timestamp of last confirmed fall alert

// Telemetry Streaming Intervals
unsigned long lastTelemetryStream = 0;
unsigned long lastCsvStreamTime   = 0;
const unsigned long STREAM_INTERVAL = 1000;  // Temperature calculation pace (1s)
const unsigned long CSV_STREAM_INTERVAL = 50; // 20 Hz telemetry stream (50ms)

// Analytics Reporting Variables
unsigned long lastBeatTime = 0;
unsigned long currentBeatTime = 0;
float ecgHeartRateBPM = 0;
bool peakDetected = false;

float dynamicBaseline = 0.0;
unsigned long lastKickTime = 0;
int kickCount = 0;
float bodyTemperatureC = 35.0;
// ── Standalone Self-Contained URL Encoding (No External Dependency) ──────────
String urlEncode(const String& str) {
  String encoded = "";
  char c;
  char code0;
  char code1;
  for (unsigned int i = 0; i < str.length(); i++) {
    c = str.charAt(i);
    if (isalnum(c)) {
      encoded += c;
    } else if (c == ' ') {
      encoded += "%20";
    } else {
      code1 = (c & 0xf) + '0';
      if ((c & 0xf) > 9) {
        code1 = (c & 0xf) - 10 + 'A';
      }
      c = (c >> 4) & 0xf;
      code0 = c + '0';
      if (c > 9) {
        code0 = c - 10 + 'A';
      }
      encoded += '%';
      encoded += code0;
      encoded += code1;
    }
  }
  return encoded;
}

// ── Standalone Direct Telegram Alert (WiFi HTTPS) ───────────────────────────
void sendTelegramEmergencyAlert(const char* reason = "MPU6050 Fall Detection") {
  unsigned long now = millis();
  if (now - lastTelegramSendTime < TELEGRAM_COOLDOWN_MS && lastTelegramSendTime != 0) {
    Serial.println("⏳ Telegram alert suppressed: cooldown active (15s).");
    return;
  }

  Serial.println("\n🚨 =========================================================");
  Serial.println("🚨 MOMCARE 360 EMERGENCY ALERT");
  Serial.print("🚨 ALERT REASON: "); Serial.println(reason);
  Serial.println("🚨 Dispatching Telegram Alert (@Momcareemergencyalarm_bot)...");
  Serial.println("=========================================================\n");

  if (String(WIFI_SSID) == "YOUR_WIFI_NAME") {
    Serial.println("⚠️  Note: Standalone WiFi Telegram is inactive (WIFI_SSID is set to default).");
    Serial.println("   Please set your WiFi SSID and password in sketch_may5a.ino.");
    lastTelegramSendTime = now;
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.print("📡 WiFi connecting to: ");
    Serial.println(WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt < 6000)) {
      delay(250);
      Serial.print(".");
    }
    Serial.println();
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("🌐 Connected to WiFi! Sending to Telegram API...");
    WiFiClientSecure client;
    client.setInsecure(); // Skip certificate validation for embedded microcontrollers

    HTTPClient https;
    String messageText = "🚨 *MOMCARE 360 EMERGENCY ALERT* 🚨\n\n"
                         "⚠️ *A possible fall has been detected for the pregnant mother.*\n\n"
                         "📋 *Trigger:* MPU6050 Fall Detection (Acceleration Test Threshold: 2.0G / 19.62 m/s²)\n"
                         "ℹ️ *Cause:* " + String(reason) + "\n\n"
                         "🩺 Please check her immediately and provide required assistance.\n"
                         "— MOMCARE 360 Autonomous Safety Array";

    String url = "https://api.telegram.org/bot" + String(TELEGRAM_BOT_TOKEN) +
                 "/sendMessage?chat_id=" + String(TELEGRAM_CHAT_ID) +
                 "&text=" + urlEncode(messageText) + "&parse_mode=Markdown";

    if (https.begin(client, url)) {
      int httpCode = https.GET();
      if (httpCode > 0) {
        Serial.printf("✅ TELEGRAM ALERT SENT DIRECTLY FROM ESP32! HTTP Code: %d\n", httpCode);
        lastTelegramSendTime = now;
      } else {
        Serial.printf("❌ Telegram Send Failed: %s\n", https.errorToString(httpCode).c_str());
      }
      https.end();
    } else {
      Serial.println("❌ Failed to initiate HTTPS connection to api.telegram.org");
    }
  } else {
    Serial.println("❌ Telegram Send Failed: WiFi not connected.");
  }
}

void setup() {
  Serial.begin(115200);

  // ── Start BLE ─────────────────────────────────────────────────────────────
  BLEDevice::init("MomCare");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID_TX,
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
                       CHARACTERISTIC_UUID_RX,
                       BLECharacteristic::PROPERTY_WRITE
                     );

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);

  // Set explicit complete local name in advertising & scan response
  BLEAdvertisementData advData;
  advData.setName("MomCare");
  advData.setCompleteServices(BLEUUID(SERVICE_UUID));
  advData.setFlags(0x06); // General Discoverable + BR/EDR Not Supported
  pAdvertising->setAdvertisementData(advData);

  BLEAdvertisementData scanData;
  scanData.setName("MomCare");
  pAdvertising->setScanResponseData(scanData);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("BLE started! Advertising as 'MomCare'...");

  // Configure ADC scale parameters for full 0V - 3.3V range
  analogSetAttenuation(ADC_11db);

  // I2C on GPIO20 (SDA) and GPIO21 (SCL)
  Wire.begin(MPU_SDA_PIN, MPU_SCL_PIN);

  Serial.println("\nInitializing MPU6050 Accelerometer Array...");
  Serial.printf("Connecting I2C Wire on SDA=GPIO%d, SCL=GPIO%d\n", MPU_SDA_PIN, MPU_SCL_PIN);
  if (!mpu.begin(0x68, &Wire)) {
    if (!mpu.begin(0x69, &Wire)) {
      Serial.printf("MPU6050_ERROR: Not found at 0x68 or 0x69 on SDA=%d/SCL=%d. Check wiring.\n", MPU_SDA_PIN, MPU_SCL_PIN);
      mpuOK = false;
    } else {
      mpuOK = true;
      Serial.printf("MPU6050_OK: Found at address 0x69 on SDA=%d/SCL=%d\n", MPU_SDA_PIN, MPU_SCL_PIN);
    }
  } else {
    mpuOK = true;
    Serial.printf("MPU6050_OK: Found at address 0x68 on SDA=%d/SCL=%d\n", MPU_SDA_PIN, MPU_SCL_PIN);
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);

  // Piezo Baseline
  long piezoSum = 0;
  for (int i = 0; i < 50; i++) {
    piezoSum += analogRead(PIEZO_PIN);
    delay(10);
  }
  dynamicBaseline = piezoSum / 50.0;

  // Configure Push Buttons with Internal Pull-Ups (Active-LOW)
  pinMode(PUSH_BUTTON_PIN, INPUT_PULLUP);
  pinMode(ONBOARD_BOOT_PIN, INPUT_PULLUP);

  Serial.println("=========================================================");
  Serial.println("     MOM CARE PASSIVE MONITORING SYSTEM: FULLY ACTIVE     ");
  Serial.println("=========================================================");
}

void loop() {
  unsigned long now = millis();

  // --------------------------------------------------------------------------
  // LAYER 1: MPU6050 ACCELEROMETER FALL DETECTION
  // --------------------------------------------------------------------------
  float totalAcceleration = 0.0;

  if (mpuOK) {
    sensors_event_t a, g, temp_event;
    mpu.getEvent(&a, &g, &temp_event);

    totalAcceleration = sqrt(pow(a.acceleration.x, 2) +
                             pow(a.acceleration.y, 2) +
                             pow(a.acceleration.z, 2));

    if (totalAcceleration > (FALL_THRESHOLD * AMBIENT_G)) {
      fallConsecutive++;
      if (fallConsecutive >= FALL_CONFIRM_COUNT) {
        if ((now - lastFallAlertTime) > FALL_DEBOUNCE_MS) {
          fallDetected = true;
          lastFallAlertTime = now;
          Serial.println("FALL CONFIRMED (MPU6050 test threshold > 2.0G / 19.62 m/s²)");
          sendTelegramEmergencyAlert("MPU6050 Fall Detection (Acceleration > 2.0G / 19.62 m/s²)");
        }
        fallConsecutive = 0;
      }
    } else {
      fallConsecutive = 0;
    }
  }

  // --------------------------------------------------------------------------
  // LAYER 2: HIGH-SPEED ECG WAVEFORM SAMPLING
  // --------------------------------------------------------------------------
  int ecgValue = analogRead(ECG_OUTPUT_PIN);
  if (ecgValue > SIGNAL_THRESHOLD) {
    if (!peakDetected) {
      currentBeatTime = now;
      unsigned long duration = currentBeatTime - lastBeatTime;
      if (duration >= 375 && duration <= 1500) {
        ecgHeartRateBPM = 60000.0 / duration;
        lastBeatTime = currentBeatTime;
      } else if (duration > 1500) {
        lastBeatTime = currentBeatTime;
      }
      peakDetected = true;
    }
  } else {
    if (ecgValue < (SIGNAL_THRESHOLD - 150)) {
      peakDetected = false;
    }
  }

  // --------------------------------------------------------------------------
  // LAYER 3: FETAL KICK MONITORING ENGINE
  // --------------------------------------------------------------------------
  int rawPiezo = analogRead(PIEZO_PIN);
  float impactMagnitude = abs(rawPiezo - dynamicBaseline);

  if (impactMagnitude > KICK_SENSITIVITY) {
    if (now - lastKickTime > DEBOUNCE) {
      kickCount++;
      lastKickTime = now;
      Serial.print("\nALERT: Fetal Movement Logged! Force: ");
      Serial.print(impactMagnitude);
      Serial.print(" | Total Kicks: ");
      Serial.println(kickCount);
    }
  }

  if (impactMagnitude < 150) {
    dynamicBaseline = (dynamicBaseline * 0.995) + (rawPiezo * 0.005);
  }

  // --------------------------------------------------------------------------
  // LAYER 4: PERIODIC CORE TEMPERATURE AVERAGING (EMA smoothing)
  // --------------------------------------------------------------------------
  if (now - lastTelemetryStream >= STREAM_INTERVAL) {
    lastTelemetryStream = now;

    long totalRawTemp = 0;
    int validSamples = 0;
    for (int i = 0; i < 200; i++) {
      int raw = analogRead(TEMP_INPUT_PIN);
      if (raw > 300 && raw < 700) {
        totalRawTemp += raw;
        validSamples++;
      }
      delay(1);
    }

    if (validSamples > 10) {
      float avgRawTemp = (float)totalRawTemp / validSamples;
      float milliVolts = (avgRawTemp / 4095.0) * 3300.0;
      float newTempC   = (milliVolts / 10.0) - 1.0;

      if (newTempC >= 30.0 && newTempC <= 45.0) {
        if (bodyTemperatureC < 30.0) {
          bodyTemperatureC = newTempC;
        } else {
          bodyTemperatureC = (bodyTemperatureC * 0.70) + (newTempC * 0.30);
        }
      }
    } else {
      if (bodyTemperatureC < 30.0) {
        bodyTemperatureC = 35.0;
      }
    }
  }

  // --------------------------------------------------------------------------
  // LAYER 4B: PUSH BUTTON MULTI-PRESS SOS ENGINE (GPIO 8 + GPIO 9 BOOT Button)
  // --------------------------------------------------------------------------
  int extBtnRaw  = digitalRead(PUSH_BUTTON_PIN);
  int bootBtnRaw = digitalRead(ONBOARD_BOOT_PIN);

  // Either button pulled LOW = button is currently pressed
  bool isCurrentlyPressed = (extBtnRaw == LOW || bootBtnRaw == LOW);

  // Detect leading edge of press
  if (!wasButtonPressed && isCurrentlyPressed) {
    if (now - lastPressTime > BUTTON_DEBOUNCE_MS) {
      lastPressTime = now;

      if (buttonPressCount == 0) {
        firstPressTime = now;
      }

      buttonPressCount++;
      Serial.print("\n🔘 [PUSH BUTTON] Press detected on Pin ");
      Serial.print(extBtnRaw == LOW ? "GPIO 8 (External)" : "GPIO 9 (BOOT)");
      Serial.print("! Count: ");
      Serial.print(buttonPressCount);
      Serial.println(" / 3");

      if (buttonPressCount >= REQUIRED_PRESSES_FOR_SOS) {
        sosActiveUntil = now + 3000; // Latch SOS alert for 3 seconds
        Serial.println("\n🚨 =========================================================");
        Serial.println("🚨 EMERGENCY ALERT: 3 PUSH BUTTON PRESSES CONFIRMED!");
        Serial.print("📞 INITIATING EMERGENCY CALL TO: ");
        Serial.println(EMERGENCY_PHONE_NUMBER);
        Serial.println("🚨 =========================================================\n");
        sendTelegramEmergencyAlert("Push Button SOS Triggered (3 Clicks)");

        buttonPressCount = 0;
      }
    }
  }
  wasButtonPressed = isCurrentlyPressed;

  // Reset multi-press counter if time window expires before reaching 3 presses
  if (buttonPressCount > 0 && (now - firstPressTime > MULTI_PRESS_WINDOW)) {
    Serial.println("⏳ [PUSH BUTTON] Multi-press window expired. Resetting click counter.");
    buttonPressCount = 0;
  }

  sosCallTriggered = (now < sosActiveUntil);

  // --------------------------------------------------------------------------
  // LAYER 5: BUILD & TRANSMIT CSV TELEMETRY (Only When Bluetooth Connected)
  // --------------------------------------------------------------------------
  if (now - lastCsvStreamTime >= CSV_STREAM_INTERVAL) {
    lastCsvStreamTime = now;

    // Send sensor values ONLY when Bluetooth device is connected
    if (deviceConnected) {
      char csvLine[260];
      snprintf(csvLine, sizeof(csvLine),
        "ECG:%d,Maternal_BPM:%.1f,Piezo_Force:%.1f,Kicks_Total:%d,"
        "Motion_Total_G:%.3f,Temp_C:%.2f,MPU_OK:%d,Fall_Alert:%d,SOS_Call:%d,Press_Count:%d",
        ecgValue,
        ecgHeartRateBPM,
        impactMagnitude,
        kickCount,
        totalAcceleration / AMBIENT_G,
        bodyTemperatureC,
        mpuOK ? 1 : 0,
        fallDetected ? 1 : 0,
        sosCallTriggered ? 1 : 0,
        buttonPressCount
      );

      Serial.println(csvLine);

      // Transmit over BLE Notification
      char payload[270];
      snprintf(payload, sizeof(payload), "%s\n", csvLine);
      pTxCharacteristic->setValue((uint8_t*)payload, strlen(payload));
      pTxCharacteristic->notify();
    }

    fallDetected = false;
  }

  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println("Client disconnected. Restarting BLE advertising as 'MomCare'...");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
    Serial.println("BLE Client Connected successfully!");
  }

  delay(5); // Ultra-fast 5ms polling loop
}
