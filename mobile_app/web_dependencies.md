# SafeBand - Web Portal & Dashboard Integration Dependencies

For a seamless integration of the SafeBand ESP32 firmware and the mobile app with a web-based monitoring dashboard/portal, the web application must account for several key communication, mapping, visualization, and notification dependencies.

---

## 1. Web-to-Device Communication (Direct Web Bluetooth)
If the web portal supports direct configuration of the band, OTA firmware updates, or debugging (e.g., from a web browser), it should leverage the **Web Bluetooth API** (supported in Chrome, Edge, and Opera).
- **No external npm packages required** for basic Web BLE (native `navigator.bluetooth` APIs).
- **TypeScript Typings**: `@types/web-bluetooth` — provides full static typing for Web Bluetooth APIs.

---

## 2. API & Real-time Telemetry (WebSockets / WebRTC)
To receive real-time location snapshots, heartbeat status packets, and emergency alerts uploaded by the mobile app.
- **REST Client**: `axios` or native `fetch` — for uploading/downloading encrypted sensor logs and emergency contact registers.
- **WebSocket Client**: `socket.io-client` or native `WebSocket` — for streaming live coordinates or active alert status directly to emergency dashboards.

---

## 3. Sensor Data Visualization (Live & Historical Graphs)
For rendering live or historical 25 Hz raw sensor streams (X/Y/Z Accel, Gyro, Jerk) and highlighting anomaly scores.
- **Charting Engine**: `recharts` or `chart.js` with `react-chartjs-2` — highly optimized for rendering fast-scrolling line charts.
- **Radar Charts**: `recharts` or `d3-scale` — for rendering the 144-dimensional feature footprint radar charts.
- **Smooth Animations**: `framer-motion` or `react-spring` — for micro-animations of dashboard alert cards.

---

## 4. Geolocation & Interactive Mapping
For displaying geofenced areas (Home, Known Safe) and tracking the user's live position during an emergency.
- **Maps Renderer**: `react-map-gl` (Mapbox) or `google-map-react` — for high-performance interactive maps.
- **Open-Source Maps**: `leaflet` with `react-leaflet` — a lighter, open-source alternative to Google Maps/Mapbox.
- **Address Resolution**: `@googlemaps/google-maps-services-js` — for reverse geocoding raw coordinates to human-readable addresses.

---

## 5. Security & Cryptography (End-to-End Encryption)
Since sensor logs are uploaded encrypted for privacy compliance (GDPR/HIPAA), the web portal must decrypt them on-device before rendering.
- **Web Crypto API**: Native browser support for AES-GCM decryption.
- **Crypto Library**: `crypto-js` or `libsodium-wrappers` — for secure key exchanges and derived decryption keys.

---

## 6. Emergency Notifications & Dispatch Gateways
For dispatching automated phone calls and text alerts when a high/critical threat event is received.
- **SMS & Voice Gateway**: `twilio` (Node.js SDK) or similar service APIs (e.g., Plivo, MessageBird) — to send formatted text alerts and automate VOIP voice calls.
- **Push Notification Dispatcher**: `firebase-admin` — to send rich push alerts containing map previews directly to responder devices.
