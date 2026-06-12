Implementation Plan - Real-time Diagnostics, Dynamic Metrics & False-Alarm Suppression
This plan outlines changes to the ESP32-S3 firmware and the React Native Expo mobile app to:

Prevent false-alarm spamming when the band is sitting still on a table.
Expose raw and processed telemetry in a collapsible scrollable debug terminal log on the mobile app.
Resolve the "frozen" UI metrics by transmitting and displaying live 2 Hz TinyML features.
Fix firmware indexing bugs that caused the motion classifier to use the wrong feature indices.
User Review Required
IMPORTANT

BLE Characteristic Modification & Cache Invalidation To prevent transmission collisions of Status, Event, and Sensor stream packets, we are assigning dedicated GATT characteristics. Because this changes the BLE GATT layout, Android will cache the old layout. We will programmatically change the ESP32 MAC address to 90:70:69:11:69:22 to force the Android BLE stack to clear its cache and discover the new characteristics immediately.

Proposed Changes
1. Firmware Changes (ESP32-S3)
[MODIFY] 
Config.h
Declare new BLE characteristics UUIDs to isolate traffic:
CHAR_UUID_STATUS: "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9" (Notified every 30s)
CHAR_UUID_SENSOR: "c9298492-95b6-455f-8c3a-bb5a8e03e5ca" (Notified at 25 Hz for raw graphs)
CHAR_UUID_FEATURE: "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb" (Notified at 2 Hz for live UI metrics & TinyML logs)
[MODIFY] 
BLEManager.h
 & 
BLEManager.cpp
Add pointers for the new characteristics: pCharStatus, pCharSensor, and pCharFeature.
Update the base MAC address to 90:70:69:11:69:22 to trigger Android cache invalidation.
Register and configure pCharStatus, pCharSensor, and pCharFeature as notify characteristics with their standard BLE2902 descriptors.
Modify sendStatusPacket and sendSensorPacket to write/notify to their respective characteristics.
Implement sendFeaturePacket(uint8_t seq, uint8_t anomalyScore, uint8_t motionState, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t wearConfidence, uint16_t peakResultantAccelMg, uint8_t durationUnits) to serialize and notify real-time features on CHAR_UUID_FEATURE.
[MODIFY] 
main.cpp
Initialize g_wearConfidence = 0 at boot so the band starts as "unworn" rather than triggering immediate alerts on the table.
Fix Feature Index Mismatches inside ProcessingTask to read from the correct index offsets:
totalVariance: change from features[137] (sub-window 1) to features[1325] (Tier 3 total variance).
dominantFreq: change from features[90] (sub-window 0) to features[1278] (sub-window 9 dominant frequency of Ax).
zcr (Resultant): change from features[75] to features[1253] (sub-window 9 resultant ZCR).
spectralEntropy (Ax): change from features[95] to features[1283] (sub-window 9 Ax spectral entropy).
eigenvalueRatio (linearity): change from features[135] to features[1323] (Tier 3 linearity ratio).
Enforce Wear-Confidence Suppression: Inside ProcessingTask, suppress alarms (consecutiveAnomalyWindows incrementing and sendEventPacket execution) completely if g_wearConfidence < 40.
Stream Live 2 Hz Feature Updates: Every time a window completes processing (at 2 Hz), call BLEManager::getInstance().sendFeaturePacket(...) if a client is connected.
2. Mobile App Changes (React Native)
[MODIFY] 
BleService.js
Declare the new UUID constants matching the firmware.
Add parser for the FEATURE packet (Type 0x04) which decodes:
anomalyScore
motionState
dominantFreq
zcr
spectralEntropy
eigenvalueRatio
wearConfidence
peakAccel
anomalyDuration
[MODIFY] 
ContextEngine.js
Implement computeThreatScoreDetailed(packet, contextConfig) that returns:
{ score, explanation: string[] }
Explanations should include step-by-step logs of: base normalization, pattern weight selection, duration multiplier, geofence scaling, night/time multiplier, wear discounts, and final clamped value.
Completely suppress threat level (score = 0) when wearConfidence < 40.
[MODIFY] 
App.js
Modify the BLE manager implementation to search for the new characteristics and monitor notifications on:
CHAR_UUID_EVENT
CHAR_UUID_STATUS
CHAR_UUID_SENSOR
CHAR_UUID_FEATURE
Update currentPacket dynamically upon receiving FEATURE packets. This ensures the dashboard gauges and indicators update at 2 Hz in real BLE mode!
Add a logs state logs ({ id, time, message, category }) and helper addLog(message, category). Categories: RAW, TINYML, CONTEXT, SYSTEM.
Log the raw hexadecimal bytes for all incoming packets.
Log parsed TinyML feature metrics (ZCR, Entropy, Linearity, Dominant Frequency) in detail.
Log step-by-step math calculations from the ContextEngine detailed calculation report.
Add a Premium Collapsible Debug Terminal component at the bottom of the screen:
Toggle button to expand/collapse.
Scrollable view with monospace green/white text on dark background.
Filter chips to filter logs by Category (ALL, TINYML, CONTEXT, RAW, SYSTEM).
"Clear Logs" action button.
Reset Anomaly Score on Alert Cancel: Ensure that clicking "I'm Safe" resets currentPacket metrics to normal ranges to prevent re-triggering alarms when the cooldown timer expires.
Verification Plan
Automated Build Checks
Run compilation in PlatformIO: pio run
Run local Metro bundler check: npm run lint or inspect Expo CLI terminal outputs.
Manual Verification Steps
Table Still Rest (Unworn): Keep device completely flat on a table. Verify on console and App that g_wearConfidence decays, and no alarms trigger even if the raw MAE fluctuates.
Real-time Streaming: Connect device via BLE. Verify that numbers for ZCR, Linearity, Dominant Frequency, and Anomaly Score update live at 2 Hz on the App dashboard.
Debug Log Panel: Expand the terminal panel. Verify that:
Hex values are streaming under RAW filter.
TinyML feature extractions and model anomaly outputs stream under TINYML.
Context Engine calculations (weights, multipliers, wear adjustments) print under CONTEXT.
Triggering and Canceling Alerts:
Shake the device/trigger mock state FALL (or click simulator buttons).
Verify that threat score climbs past 72%, triggering the alarm overlays.
Cancel the alert and verify the cooldown timer counts down, and the alert does not re-trigger once the timer expires.