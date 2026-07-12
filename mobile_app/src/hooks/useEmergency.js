// =============================================================================
// hooks/useEmergency.js — Emergency Alert Dispatch State Machine
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// useEmergency manages the full lifecycle of a physical safety emergency from
// the moment the firmware triggers an alert to the moment messages are sent to
// emergency contacts. It is a pure React hook — no BLE or DB logic of its own.
//
// WHO CALLS THIS:
//   → App.js instantiates this hook and passes it the current BLE state, DB
//     settings, contacts, templates, and the sendBleCommand function from useBle.
//
// WHAT IT DOES (Step-by-step state machine):
//   TRIGGER → triggerEmergencyPreAlert()
//     ↓ Shows modal with 15-second countdown
//     ↓ Vibrates device every second (unless silent_beacon = '1')
//     ↓ Alternates beepingFlash state for pulsing red UI effect
//     ↓ If user does nothing for 15 seconds → executeEmergencyDispatch(false)
//   CANCEL → cancelEmergency()
//     ↓ User taps Cancel button (or enters real PIN) → stops countdown
//     ↓ Sends 0xFF (cancel alert) + 0x04 (acknowledge) commands to ESP32
//     ↓ Resets currentPacket to normal values to clear dashboard gauges
//     ↓ Starts 20-second cooldown to suppress re-triggering
//   DURESS → executeEmergencyDispatch(isDuress=true)
//     ↓ User enters the FAKE PIN → appears to cancel but actually dispatches
//     ↓ Adds "[WARNING: ALERT DISPATCHED UNDER DURESS / COERCION]" to messages
//   DISPATCH → executeEmergencyDispatch(isDuress)
//     ↓ Gets current GPS position (High accuracy) → reverse geocodes to address
//     ↓ Compiles template message for each contact (fills {name}, {gps}, etc.)
//     ↓ Sends SMS via Twilio REST API
//     ↓ Sends WhatsApp via: NATIVE app link | CallMeBot API | Twilio WhatsApp
//     ↓ Sends Email via Resend API
//     ↓ Updates dispatchStatuses per contact/channel for the result UI
//
// COMMUNICATION CHANNELS (per contact, independently configurable):
//   A. SMS       — via Twilio REST API (requires account SID + auth token)
//   B. WhatsApp  — 3 methods (per contact setting):
//       - NATIVE: opens the WhatsApp app with a pre-filled message (no API needed)
//       - CALLMEBOT: uses the free CallMeBot API (requires personal API key)
//       - TWILIO: uses the Twilio WhatsApp Business API (requires Twilio sandbox/number)
//   C. Email     — via Resend API (requires API key)
//
// MESSAGE TEMPLATE SYSTEM:
//   Each contact can be assigned a template (or uses the default hardcoded one).
//   compileTemplate() substitutes these placeholders:
//     {name}         → User's name (from settings)
//     {inference}    → anomaly score + duration + peak accel summary
//     {time}         → Current timestamp
//     {maps_link}    → Google Maps link with coordinates
//     {gps}          → "lat, lon" string
//     {address}      → Reverse-geocoded street address from Nominatim/OSM
//     {medical_info} → Blood group, conditions, allergies from settings
//     {duress_flag}  → DURESS warning string (empty for normal dispatch)
//
// PIN SYSTEM:
//   - real_pin: cancels the alert genuinely
//   - fake_pin: appears to cancel but dispatches (duress / coercion mode)
//   PIN comparison logic is handled in App.js (DashboardTab.js), not here.
//   This hook only tracks pinEntryMode and enteredPin state.
//
// COOLDOWN:
//   After cancelEmergency() or executeEmergencyDispatch(), a 20-second cooldown
//   is started. During cooldown, alertTriggeredRef.current is kept true so the
//   App.js ContextEngine threat score won't re-trigger another alert.
//
// FILES USED:
//   → None from the src/ folder directly (all data comes in via props)
//   → expo-location for GPS fix during dispatch
//   → Linking (react-native) for native WhatsApp URL launch
//   → Vibration (react-native) for haptic feedback
//   → Network: Twilio API, Resend API, Nominatim geocoding, CallMeBot API
//
// BUGS / NOTES:
//   ⚠ base64Encode() is duplicated here and in useDatabase.js. Should be a
//     shared utility. Not a functional bug — just maintenance overhead.
//   ⚠ The dispatch loop uses forEach with async callbacks (forEach async anti-pattern).
//     This means all contacts are dispatched CONCURRENTLY (fire-and-forget), which
//     is actually desirable here for speed, but it means errors in one contact's
//     dispatch don't block others. This is intentional but should be documented.
//   ⚠ cancelEmergency() calls setCurrentPacket with hardcoded "normal" values
//     (anomalyScore: 20, motionState: periodic, etc.). This resets the dashboard
//     to a calm state visually, but the real device will override these as soon
//     as the next FEATURE packet arrives (within 500ms if connected).
//   ⚠ The 20-second cooldown uses cooldownActiveRef for the timeout closure AND
//     setCooldownActive state for the UI. Both must be kept in sync manually.
//     If the component unmounts during cooldown, the setInterval leak could cause
//     a "setState on unmounted component" warning.
// =============================================================================

import { useState, useRef, useEffect } from 'react';
import { Vibration, Linking } from 'react-native';
import * as Location from 'expo-location';

// Pure-JS Base64 encoder for Twilio HTTP Basic Auth headers.
// NOTE: Duplicated from useDatabase.js — candidate for shared utility refactoring.
function base64Encode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  while (i < str.length) {
    const char1 = str.charCodeAt(i++);
    const char2 = i < str.length ? str.charCodeAt(i++) : NaN;
    const char3 = i < str.length ? str.charCodeAt(i++) : NaN;

    const byte1 = char1 >> 2;
    const byte2 = ((char1 & 3) << 4) | (isNaN(char2) ? 0 : char2 >> 4);
    const byte3 = isNaN(char2) ? 64 : ((char2 & 15) << 2) | (isNaN(char3) ? 0 : char3 >> 6);
    const byte4 = isNaN(char3) ? 64 : char3 & 63;

    result += chars.charAt(byte1) + chars.charAt(byte2) + 
              (byte3 === 64 ? '=' : chars.charAt(byte3)) + 
              (byte4 === 64 ? '=' : chars.charAt(byte4));
  }
  return result;
}

// Substitutes template placeholders with actual incident data.
// The template uses {placeholder} syntax. All fields are replaced globally (g flag).
// If a field is missing from `data`, it is replaced with an empty string (safe default).
function compileTemplate(templateContent, data) {
  let message = templateContent || '';
  message = message.replace(/{name}/g, data.name || '');
  message = message.replace(/{inference}/g, data.inference || '');
  message = message.replace(/{time}/g, data.time || '');
  message = message.replace(/{maps_link}/g, data.maps_link || '');
  message = message.replace(/{gps}/g, data.gps || '');
  message = message.replace(/{address}/g, data.address || '');
  message = message.replace(/{medical_info}/g, data.medical_info || '');
  message = message.replace(/{duress_flag}/g, data.duress_flag || '');
  return message;
}

// =============================================================================
// MAIN HOOK
// All inputs come from App.js via props (dependency injection pattern).
// =============================================================================
export default function useEmergency({
  dbSettings,           // Key-value settings dict (from useDatabase)
  contacts,             // Emergency contacts array (from useDatabase)
  templates,            // Message templates array (from useDatabase)
  sendBleCommand,       // Function to write a BLE command byte (from useBle)
  currentPacket,        // Latest TinyML packet data (from useBle)
  setCurrentPacket,     // Setter to reset dashboard gauges after cancel (from useBle)
  wearConfidence,       // Current wear confidence % (from useBle)
  setWearConfidence,    // Setter for wear confidence (from useBle — not currently used here)
  setBatteryPct,        // Setter for battery % (from useBle — not currently used here)
  setUptime,            // Setter for uptime (from useBle — not currently used here)
  addLog,               // Log panel append function (from App.js)
  addLogs,              // Bulk log append (from App.js — declared but not used in dispatch)
  checkTwilioBalance,   // Trigger a fresh Twilio balance check (from useDatabase)
  connectionState,      // Current BLE state ('CONNECTED' | 'DISCONNECTED' | ...) (from useBle)
  alertTriggeredRef,    // Shared ref: true while alert is active or in cooldown (from App.js)
}) {
  // --- Alert Modal State ---
  // Controls the full-screen emergency alert overlay visibility
  const [showAlertModal, setShowAlertModal] = useState(false);

  // Countdown from 15 to 0 seconds before auto-dispatch
  const [alertCountdown, setAlertCountdown] = useState(15);

  // True once dispatch has been triggered (shows "Alert Sent" state in the modal)
  const [isDispatched, setIsDispatched] = useState(false);

  // Alternates true/false every second during countdown to create a pulsing red effect
  const [beepingFlash, setBeepingFlash] = useState(false);

  // Array of { contactId, name, channels: [{type, status, error}] }
  // Tracks the send status for each contact×channel combination
  const [dispatchStatuses, setDispatchStatuses] = useState([]);
  
  // --- Cooldown State ---
  // True for 20 seconds after cancel/dispatch to suppress re-triggering
  const [cooldownActive, setCooldownActive] = useState(false);
  const [cooldownTime, setCooldownTime] = useState(0); // Seconds remaining in cooldown

  // --- PIN Entry State (for the cancel confirmation dialog) ---
  const [pinEntryMode, setPinEntryMode] = useState(false);  // True = show PIN input
  const [enteredPin, setEnteredPin] = useState('');          // Current entered PIN string
  const [pinError, setPinError] = useState(null);            // Error message (or null)

  // Holds the setInterval handle for the countdown timer.
  // Stored as a ref (not state) to avoid re-renders and to allow cleanup
  // from within the interval callback itself.
  const alertIntervalRef = useRef(null);

  // --- "Mirror" Refs for setInterval Closure Safety ---
  // setInterval callbacks in JavaScript capture the values of variables AT THE TIME
  // they are created (closure capture). If the underlying state changes later,
  // the callback still sees the old values — a classic React stale closure problem.
  //
  // Solution: Keep refs that are always updated to the latest state values.
  // The setInterval callback then reads from the ref (always current) instead of
  // capturing the state directly (which would be stale).
  const dbSettingsRef = useRef(dbSettings);
  const contactsRef = useRef(contacts);
  const templatesRef = useRef(templates);
  const currentPacketRef = useRef(currentPacket);
  const wearConfidenceRef = useRef(wearConfidence);

  // Keep all refs synchronized with their corresponding prop/state values
  useEffect(() => { dbSettingsRef.current = dbSettings; }, [dbSettings]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { templatesRef.current = templates; }, [templates]);
  useEffect(() => { currentPacketRef.current = currentPacket; }, [currentPacket]);
  useEffect(() => { wearConfidenceRef.current = wearConfidence; }, [wearConfidence]);

  // =============================================================================
  // triggerEmergencyPreAlert()
  // Entry point of the emergency state machine. Called by App.js when:
  //   - A real firmware EVENT packet arrives with confirmed anomaly, OR
  //   - The user manually triggers a test alert from SettingsTab
  //
  // What it does:
  //   1. Sets alertTriggeredRef.current = true (prevents ContextEngine from
  //      re-triggering while the alert modal is open)
  //   2. Shows the alert modal (setShowAlertModal = true)
  //   3. Resets all state (countdown, dispatch, PIN) to initial values
  //   4. Starts a 1-second interval that:
  //      - Toggles beepingFlash (creates pulsing UI animation)
  //      - Vibrates the device for 400ms (unless silent_beacon is '1')
  //      - Decrements alertCountdown each tick
  //      - When countdown reaches 0: calls executeEmergencyDispatch(false)
  // =============================================================================
  const triggerEmergencyPreAlert = () => {
    if (alertTriggeredRef) {
      alertTriggeredRef.current = true; // Lock: prevent ContextEngine re-triggering
    }
    setShowAlertModal(true);
    setAlertCountdown(15);       // 15-second window for user to cancel
    setIsDispatched(false);
    setPinEntryMode(false);
    setEnteredPin('');
    setPinError(null);

    const isSilent = dbSettingsRef.current.silent_beacon === '1';

    // Start the countdown interval (fires every 1 second)
    alertIntervalRef.current = setInterval(() => {
      if (!isSilent) {
        setBeepingFlash((prev) => !prev); // Toggle flash state for pulsing red effect
        Vibration.vibrate(400);           // 400ms vibration every second
      }

      setAlertCountdown((prev) => {
        if (prev <= 1) {
          // Countdown expired — auto-dispatch without user intervention
          clearInterval(alertIntervalRef.current);
          executeEmergencyDispatch(false); // false = NOT duress (user didn't fake-cancel)
          return 0;
        }
        return prev - 1; // Decrement countdown
      });
    }, 1000);
  };

  // =============================================================================
  // executeEmergencyDispatch(isDuress)
  // The core dispatch function. Called after countdown expires OR when duress PIN entered.
  //
  // @param isDuress - true if the user entered the fake PIN (duress mode)
  //                   Adds a coercion warning to all messages.
  //
  // Step-by-step execution:
  //   1. Stop the countdown interval, mark as dispatched
  //   2. Build the initial dispatch status list for the UI result panel
  //   3. Get GPS coordinates at high accuracy (may take several seconds)
  //   4. Reverse-geocode to a human-readable street address via OSM Nominatim
  //   5. For each active contact:
  //      a. Look up their template (or use default)
  //      b. Compile the template with incident data
  //      c. Send via each enabled channel (SMS, WhatsApp, Email) in parallel
  //   6. After 2s, trigger a Twilio balance check to update the credit display
  // =============================================================================
  const executeEmergencyDispatch = async (isDuress = false) => {
    clearInterval(alertIntervalRef.current); // Stop the countdown
    setIsDispatched(true);                   // Switches modal to "Dispatching..." state
    setBeepingFlash(false);
    if (dbSettingsRef.current.silent_beacon !== '1') {
      // 3-pulse vibration pattern: 100ms on, 500ms off, 100ms on, 500ms off
      Vibration.vibrate([100, 500, 100, 500]);
    }
    
    addLog(`Emergency alert dispatched! ${isDuress ? '(DURESS MODE)' : '(NORMAL MODE)'}`, 'SYSTEM');

    // Build the initial status list: one entry per contact × enabled channel
    // Channels are filtered by both the contact's settings AND the global toggle
    const activeContacts = contactsRef.current.filter(c => c.sms_enabled || c.whatsapp_enabled || c.email_enabled);
    const initialStatuses = activeContacts.map(c => ({
      contactId: c.id,
      name: c.name,
      channels: [
        // Include SMS channel only if both the contact and global toggle are enabled
        ...(c.sms_enabled && dbSettingsRef.current.sms_alerts_enabled === '1' ? [{ type: 'SMS', status: 'Queued', error: null }] : []),
        ...(c.whatsapp_enabled && dbSettingsRef.current.whatsapp_alerts_enabled === '1' ? [{ type: 'WhatsApp', status: 'Queued', error: null }] : []),
        ...(c.email_enabled && dbSettingsRef.current.email_alerts_enabled === '1' ? [{ type: 'Email', status: 'Queued', error: null }] : [])
      ]
    })).filter(c => c.channels.length > 0); // Only include contacts with at least 1 active channel

    setDispatchStatuses(initialStatuses);

    if (initialStatuses.length === 0) {
      addLog('No contacts are configured for active dispatch channels.', 'SYSTEM');
      return;
    }

    // --- GPS Location Acquisition ---
    let gpsStr = 'Unknown';
    let mapsLinkStr = 'https://maps.google.com/?q=0,0';
    let addressStr = 'Fetching street address...';

    const getPosition = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          addLog('[GPS] Location permission denied by user.', 'SYSTEM');
          return null;
        }
        // Request high-accuracy GPS for the most precise location in the alert message
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        return pos.coords;
      } catch (err) {
        console.warn('[GPS] Error fetching coordinates:', err.message);
        return null;
      }
    };

    const coords = await getPosition();
    if (coords) {
      gpsStr = `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`;
      mapsLinkStr = `https://maps.google.com/?q=${coords.latitude},${coords.longitude}`;
      addLog(`Spot of Inference GPS coordinates: ${gpsStr}`, 'SYSTEM');

      try {
        // Reverse geocode via OpenStreetMap Nominatim (free, no API key required)
        // Returns a human-readable address like "123 Main St, City, Country"
        const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.latitude}&lon=${coords.longitude}&zoom=18&addressdetails=1`, {
          headers: { 'User-Agent': 'SafeBandApp/1.0' } // Required by Nominatim ToS
        });
        if (geoResp.ok) {
          const geoData = await geoResp.json();
          addressStr = geoData.display_name || 'Coordinates resolved, address empty';
          addLog(`Geocoded address: ${addressStr}`, 'SYSTEM');
        } else {
          addressStr = 'Address lookup failed';
        }
      } catch (err) {
        addressStr = 'Network error while geocoding';
      }
    } else {
      addressStr = 'GPS location unavailable';
    }

    // Build the incident summary string for the {inference} template placeholder
    const inferenceStr = `anomaly: ${currentPacketRef.current.anomalyScore}/255, duration: ${(currentPacketRef.current.anomalyDuration * 0.1).toFixed(1)}s, peak accel: ${currentPacketRef.current.peakAccel}mg`;

    // Build the medical info string for the {medical_info} placeholder
    const medicalStr = `${dbSettingsRef.current.user_name || 'User'} | Blood Group: ${dbSettingsRef.current.medical_blood_group || 'Unknown'} | Conditions: ${dbSettingsRef.current.medical_conditions || 'None'} | Allergies: ${dbSettingsRef.current.medical_allergies || 'None'} | Instructions: ${dbSettingsRef.current.medical_instructions || 'None'}`;

    // Duress flag text — included in messages when user force-cancelled (fake PIN)
    const duressFlagStr = isDuress ? '[WARNING: ALERT DISPATCHED UNDER DURESS / COERCION]' : '';

    // Helper: updates one channel's status in the dispatchStatuses array.
    // Uses functional setState to avoid race conditions from concurrent dispatches.
    const updateChannel = (contactId, type, status, error = null) => {
      setDispatchStatuses((prev) =>
        prev.map((c) =>
          c.contactId === contactId
            ? { ...c, channels: c.channels.map((ch) => (ch.type === type ? { ...ch, status, error } : ch)) }
            : c
        )
      );
    };

    // --- Per-Contact Dispatch (runs concurrently for all contacts via forEach+async) ---
    // NOTE: forEach with async callbacks runs all contacts in PARALLEL (fire-and-forget).
    // This is intentional for speed but means order of completion is non-deterministic.
    initialStatuses.forEach(async (cStatus) => {
      const contact = contactsRef.current.find(con => con.id === cStatus.contactId);
      if (!contact) return;

      // Start with the default template (hardcoded fallback)
      let templateContent = `🚨 SafeBand Alert: Physical emergency detected!\nName: {name}\nInference: {inference}\nTime: {time}\nLocation: {maps_link} ({gps})\nAddress: {address}\nMedical Info: {medical_info}\n{duress_flag}`;

      // Override with custom template if the contact has one assigned
      if (contact.template_id > 0) {
        const customTemp = templatesRef.current.find(t => t.id === contact.template_id);
        if (customTemp) {
          templateContent = customTemp.content;
          // If custom template doesn't include a duress_flag field, append one
          if (isDuress && !templateContent.includes('{duress_flag}')) {
            templateContent += '\n\n⚠️ {duress_flag}';
          }
        }
      }

      // Compile the template by substituting all placeholders with real values
      const compiledMsg = compileTemplate(templateContent, {
        name: dbSettingsRef.current.user_name || 'User',
        inference: inferenceStr,
        time: new Date().toLocaleString(),
        maps_link: mapsLinkStr,
        gps: gpsStr,
        address: addressStr,
        medical_info: medicalStr,
        duress_flag: duressFlagStr
      });

      // =========================================================================
      // CHANNEL A: SMS via Twilio REST API
      // Requires: twilio_account_sid, twilio_auth_token, twilio_sms_from (phone #)
      // =========================================================================
      if (contact.sms_enabled && dbSettingsRef.current.sms_alerts_enabled === '1') {
        updateChannel(contact.id, 'SMS', 'Sending');
        const sid = dbSettingsRef.current.twilio_account_sid;
        const token = dbSettingsRef.current.twilio_auth_token;
        const fromNum = dbSettingsRef.current.twilio_sms_from;

        if (!sid || !token || !fromNum) {
          // Credentials not configured — mark as failed immediately
          updateChannel(contact.id, 'SMS', 'Failed', 'Credentials Missing');
          addLog(`[SMS] Twilio credentials missing for ${contact.name}`, 'SYSTEM');
        } else {
          try {
            // Build the URL-encoded form body expected by the Twilio API
            const params = new URLSearchParams();
            params.append('From', fromNum);
            params.append('To', contact.phone);
            params.append('Body', compiledMsg);

            const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${base64Encode(sid + ':' + token)}`, // HTTP Basic Auth
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: params.toString()
            });

            if (resp.ok) {
              updateChannel(contact.id, 'SMS', 'Sent');
              addLog(`[SMS] Sent successfully to ${contact.name}`, 'SYSTEM');
            } else {
              const errData = await resp.json();
              updateChannel(contact.id, 'SMS', 'Failed', errData.message || 'Twilio Error');
              addLog(`[SMS] Twilio rejected for ${contact.name}: ${errData.message}`, 'SYSTEM');
            }
          } catch (err) {
            updateChannel(contact.id, 'SMS', 'Failed', 'Network Error');
            addLog(`[SMS] Network error for ${contact.name}`, 'SYSTEM');
          }
        }
      }

      // =========================================================================
      // CHANNEL B: WhatsApp (3 methods based on contact.whatsapp_method)
      // =========================================================================
      if (contact.whatsapp_enabled && dbSettingsRef.current.whatsapp_alerts_enabled === '1') {
        updateChannel(contact.id, 'WhatsApp', 'Sending');
        const method = contact.whatsapp_method || 'NATIVE';

        if (method === 'NATIVE') {
          // NATIVE method: opens the WhatsApp app with a pre-filled message.
          // Requires WhatsApp to be installed. No API key needed.
          // Status is "Handed-off" because we can't confirm the user sends it.
          updateChannel(contact.id, 'WhatsApp', 'Handed-off');
          addLog(`[WhatsApp] Native WhatsApp client launched for ${contact.name}`, 'SYSTEM');
          try {
            // Try the native WhatsApp app deeplink first
            const url = `whatsapp://send?phone=${contact.whatsapp}&text=${encodeURIComponent(compiledMsg)}`;
            const supported = await Linking.canOpenURL(url);
            if (supported) {
              await Linking.openURL(url); // Opens WhatsApp app
            } else {
              // Fallback: open wa.me in browser if WhatsApp app isn't installed
              await Linking.openURL(`https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(compiledMsg)}`);
            }
          } catch (e) {
            console.warn('[WhatsApp] Link launch failed:', e.message);
          }
        } else if (method === 'CALLMEBOT') {
          // CALLMEBOT method: free API for sending WhatsApp messages.
          // Requires the contact to have registered their own CallMeBot API key.
          const apikey = contact.callmebot_key;
          if (!apikey) {
            updateChannel(contact.id, 'WhatsApp', 'Failed', 'CallMeBot Key Missing');
            addLog(`[WhatsApp] CallMeBot key missing for ${contact.name}`, 'SYSTEM');
          } else {
            try {
              const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(contact.whatsapp)}&text=${encodeURIComponent(compiledMsg)}&apikey=${encodeURIComponent(apikey)}`;
              const resp = await fetch(url);
              if (resp.ok) {
                updateChannel(contact.id, 'WhatsApp', 'Sent');
                addLog(`[WhatsApp] CallMeBot delivered to ${contact.name}`, 'SYSTEM');
              } else {
                updateChannel(contact.id, 'WhatsApp', 'Failed', 'Gateway Error');
                addLog(`[WhatsApp] CallMeBot rejected for ${contact.name}`, 'SYSTEM');
              }
            } catch (err) {
              updateChannel(contact.id, 'WhatsApp', 'Failed', 'Network Error');
              addLog(`[WhatsApp] CallMeBot network error for ${contact.name}`, 'SYSTEM');
            }
          }
        } else if (method === 'TWILIO') {
          // TWILIO method: sends via Twilio WhatsApp Business API.
          // Requires: Twilio credentials AND a WhatsApp-enabled Twilio number.
          // The "From" number must be prefixed with "whatsapp:" per Twilio spec.
          const sid = dbSettingsRef.current.twilio_account_sid;
          const token = dbSettingsRef.current.twilio_auth_token;
          const fromWh = dbSettingsRef.current.twilio_whatsapp_from;
          if (!sid || !token || !fromWh) {
            updateChannel(contact.id, 'WhatsApp', 'Failed', 'Twilio Credentials Missing');
            addLog(`[WhatsApp] Twilio credentials missing for ${contact.name}`, 'SYSTEM');
          } else {
            try {
              // Twilio requires "whatsapp:+15551234567" format for both From and To
              const formattedFrom = fromWh.startsWith('whatsapp:') ? fromWh : `whatsapp:${fromWh}`;
              const formattedTo = contact.whatsapp.startsWith('whatsapp:') ? contact.whatsapp : `whatsapp:${contact.whatsapp}`;
              
              const params = new URLSearchParams();
              params.append('From', formattedFrom);
              params.append('To', formattedTo);
              params.append('Body', compiledMsg);

              const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${base64Encode(sid + ':' + token)}`,
                  'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
              });

              if (resp.ok) {
                updateChannel(contact.id, 'WhatsApp', 'Sent');
                addLog(`[WhatsApp] Twilio WhatsApp sent successfully to ${contact.name}`, 'SYSTEM');
              } else {
                const errData = await resp.json();
                updateChannel(contact.id, 'WhatsApp', 'Failed', errData.message || 'Twilio Error');
                addLog(`[WhatsApp] Twilio WhatsApp rejected for ${contact.name}: ${errData.message}`, 'SYSTEM');
              }
            } catch (err) {
              updateChannel(contact.id, 'WhatsApp', 'Failed', 'Network Error');
              addLog(`[WhatsApp] Twilio WhatsApp network error for ${contact.name}`, 'SYSTEM');
            }
          }
        }
      }

      // =========================================================================
      // CHANNEL C: Email via Resend API
      // Requires: resend_api_key, resend_from_email
      // =========================================================================
      if (contact.email_enabled && dbSettingsRef.current.email_alerts_enabled === '1') {
        updateChannel(contact.id, 'Email', 'Sending');
        const apiKey = dbSettingsRef.current.resend_api_key;
        const fromEmail = dbSettingsRef.current.resend_from_email || 'onboarding@resend.dev';

        if (!apiKey) {
          updateChannel(contact.id, 'Email', 'Failed', 'Resend API Key Missing');
          addLog(`[Email] Resend API key missing for ${contact.name}`, 'SYSTEM');
        } else {
          try {
            const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`, // Bearer token auth (not Basic)
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: fromEmail,
                to: contact.email,
                subject: '🚨 SafeBand Emergency Alert',
                text: compiledMsg // Plain text email body
              })
            });

            if (resp.ok) {
              updateChannel(contact.id, 'Email', 'Sent');
              addLog(`[Email] Email sent successfully to ${contact.name}`, 'SYSTEM');
            } else {
              const errData = await resp.json();
              updateChannel(contact.id, 'Email', 'Failed', errData.message || 'Resend Error');
              addLog(`[Email] Resend rejected for ${contact.name}: ${errData.message}`, 'SYSTEM');
            }
          } catch (err) {
            updateChannel(contact.id, 'Email', 'Failed', 'Network Error');
            addLog(`[Email] Resend network error for ${contact.name}`, 'SYSTEM');
          }
        }
      }
    });

    // After all dispatch calls fire (non-blocking), refresh the Twilio balance display
    setTimeout(() => {
      checkTwilioBalance();
    }, 2000);
  };

  // Ref version of cooldownActive — used inside the countdown setInterval closure
  // to avoid stale closure capture of the state variable.
  const cooldownActiveRef = useRef(false);

  // =============================================================================
  // cancelEmergency()
  // Called when the user taps "Cancel" or enters the REAL PIN during the countdown.
  // (If the user enters the FAKE PIN, App.js calls executeEmergencyDispatch(true) instead.)
  //
  // What it does:
  //   1. Stops the countdown interval
  //   2. Hides the modal and resets all alert state
  //   3. Sends 0xFF (cancel) + 0x04 (acknowledge) commands to the ESP32
  //   4. Resets currentPacket to calm/normal values to clear dashboard gauges
  //   5. Starts a 20-second cooldown to prevent immediate re-triggering
  // =============================================================================
  const cancelEmergency = async () => {
    clearInterval(alertIntervalRef.current); // Stop countdown beeping
    setShowAlertModal(false);
    if (alertTriggeredRef) {
      alertTriggeredRef.current = false; // Allow new alerts after cooldown ends
    }
    setIsDispatched(false);
    setBeepingFlash(false);
    setPinEntryMode(false);
    setEnteredPin('');
    setPinError(null);
    
    if (connectionState === 'CONNECTED') {
      // Tell the ESP32 the alert was cancelled so it resets its own alert state
      await sendBleCommand(0xFF); // 0xFF = Cancel emergency signal
      await sendBleCommand(0x04); // 0x04 = Acknowledge the alert (clear alert flag)
    }

    // Reset currentPacket to calm "normal walking" values to clear the dashboard.
    // The real device will overwrite these within 500ms on the next FEATURE packet.
    setCurrentPacket({
      anomalyScore: 0.0884,
      anomalyDuration: 0,
      motionState: (1 << 1), // Periodic walking (normal state)
      peakAccel: 1020,
      dominantFreq: 1.5,
      eigenvalueRatio: 500,
      zcr: 30,
      spectralEntropy: 110,
      wearConfidence: wearConfidenceRef.current, // Preserve actual wear confidence
    });

    addLog('Alert cancelled by user. Packet metrics reset to NORMAL. Cooldown started (20s).', 'SYSTEM');

    // Start 20-second cooldown: prevents ContextEngine from re-triggering immediately
    cooldownActiveRef.current = true;
    setCooldownActive(true);
    setCooldownTime(20);

    const timer = setInterval(() => {
      setCooldownTime((prev) => {
        if (prev <= 1) {
          // Cooldown expired — re-enable alert triggering
          clearInterval(timer);
          cooldownActiveRef.current = false;
          setCooldownActive(false);
          return 0;
        }
        return prev - 1; // Decrement cooldown display
      });
    }, 1000);
  };

  return {
    showAlertModal,          // Whether the emergency alert overlay is visible
    alertCountdown,          // Seconds remaining until auto-dispatch
    isDispatched,            // True once dispatch has been triggered
    beepingFlash,            // Alternates for pulsing red animation
    dispatchStatuses,        // Per-contact, per-channel dispatch status array
    cooldownActive,          // True during 20s post-cancel cooldown
    cooldownActiveRef,       // Ref version of cooldownActive (for interval closures)
    cooldownTime,            // Seconds remaining in cooldown
    pinEntryMode,            // True when PIN input is shown in modal
    enteredPin,              // The PIN string being typed
    pinError,                // Error message for wrong PIN (or null)
    setPinEntryMode,         // Show/hide the PIN entry UI
    setEnteredPin,           // Update the entered PIN string
    setPinError,             // Set a PIN error message
    triggerEmergencyPreAlert,   // Entry point: show modal + start countdown
    executeEmergencyDispatch,   // Core: send all alerts (SMS/WhatsApp/Email)
    cancelEmergency,            // Cancel: stop countdown, reset state, start cooldown
    setCooldownActive,       // Allow App.js to externally clear cooldown if needed
    setCooldownTime,         // Allow App.js to externally update cooldown display
  };
}
