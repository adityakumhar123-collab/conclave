import { useState, useRef, useEffect } from 'react';
import { Vibration, Linking } from 'react-native';
import * as Location from 'expo-location';

// Pure JS Base64 encoder for basic auth headers (e.g. Twilio API requests)
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

// Compiles a template by substituting tags with current incident variables
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

export default function useEmergency({
  dbSettings,
  contacts,
  templates,
  sendBleCommand,
  currentPacket,
  setCurrentPacket,
  wearConfidence,
  setWearConfidence,
  setBatteryPct,
  setUptime,
  addLog,
  addLogs,
  checkTwilioBalance,
  connectionState,
}) {
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertCountdown, setAlertCountdown] = useState(15);
  const [isDispatched, setIsDispatched] = useState(false);
  const [beepingFlash, setBeepingFlash] = useState(false);
  const [dispatchStatuses, setDispatchStatuses] = useState([]);
  
  const [cooldownActive, setCooldownActive] = useState(false);
  const [cooldownTime, setCooldownTime] = useState(0);

  const [pinEntryMode, setPinEntryMode] = useState(false);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState(null);

  const alertIntervalRef = useRef(null);

  // Sync references to avoid closures in setInterval
  const dbSettingsRef = useRef(dbSettings);
  const contactsRef = useRef(contacts);
  const templatesRef = useRef(templates);
  const currentPacketRef = useRef(currentPacket);
  const wearConfidenceRef = useRef(wearConfidence);

  useEffect(() => { dbSettingsRef.current = dbSettings; }, [dbSettings]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { templatesRef.current = templates; }, [templates]);
  useEffect(() => { currentPacketRef.current = currentPacket; }, [currentPacket]);
  useEffect(() => { wearConfidenceRef.current = wearConfidence; }, [wearConfidence]);

  const triggerEmergencyPreAlert = () => {
    setShowAlertModal(true);
    setAlertCountdown(15);
    setIsDispatched(false);
    setPinEntryMode(false);
    setEnteredPin('');
    setPinError(null);

    const isSilent = dbSettingsRef.current.silent_beacon === '1';

    alertIntervalRef.current = setInterval(() => {
      if (!isSilent) {
        setBeepingFlash((prev) => !prev);
        Vibration.vibrate(400);
      }

      setAlertCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(alertIntervalRef.current);
          executeEmergencyDispatch(false); // Normal dispatch
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const executeEmergencyDispatch = async (isDuress = false) => {
    clearInterval(alertIntervalRef.current);
    setIsDispatched(true);
    setBeepingFlash(false);
    if (dbSettingsRef.current.silent_beacon !== '1') {
      Vibration.vibrate([100, 500, 100, 500]);
    }
    
    addLog(`Emergency alert dispatched! ${isDuress ? '(DURESS MODE)' : '(NORMAL MODE)'}`, 'SYSTEM');

    const activeContacts = contactsRef.current.filter(c => c.sms_enabled || c.whatsapp_enabled || c.email_enabled);
    const initialStatuses = activeContacts.map(c => ({
      contactId: c.id,
      name: c.name,
      channels: [
        ...(c.sms_enabled && dbSettingsRef.current.sms_alerts_enabled === '1' ? [{ type: 'SMS', status: 'Queued', error: null }] : []),
        ...(c.whatsapp_enabled && dbSettingsRef.current.whatsapp_alerts_enabled === '1' ? [{ type: 'WhatsApp', status: 'Queued', error: null }] : []),
        ...(c.email_enabled && dbSettingsRef.current.email_alerts_enabled === '1' ? [{ type: 'Email', status: 'Queued', error: null }] : [])
      ]
    })).filter(c => c.channels.length > 0);

    setDispatchStatuses(initialStatuses);

    if (initialStatuses.length === 0) {
      addLog('No contacts are configured for active dispatch channels.', 'SYSTEM');
      return;
    }

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
        const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.latitude}&lon=${coords.longitude}&zoom=18&addressdetails=1`, {
          headers: { 'User-Agent': 'SafeBandApp/1.0' }
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

    const inferenceStr = `anomaly: ${currentPacketRef.current.anomalyScore}/255, duration: ${(currentPacketRef.current.anomalyDuration * 0.1).toFixed(1)}s, peak accel: ${currentPacketRef.current.peakAccel}mg`;
    const medicalStr = `${dbSettingsRef.current.user_name || 'User'} | Blood Group: ${dbSettingsRef.current.medical_blood_group || 'Unknown'} | Conditions: ${dbSettingsRef.current.medical_conditions || 'None'} | Allergies: ${dbSettingsRef.current.medical_allergies || 'None'} | Instructions: ${dbSettingsRef.current.medical_instructions || 'None'}`;
    const duressFlagStr = isDuress ? '[WARNING: ALERT DISPATCHED UNDER DURESS / COERCION]' : '';

    const updateChannel = (contactId, type, status, error = null) => {
      setDispatchStatuses((prev) =>
        prev.map((c) =>
          c.contactId === contactId
            ? { ...c, channels: c.channels.map((ch) => (ch.type === type ? { ...ch, status, error } : ch)) }
            : c
        )
      );
    };

    initialStatuses.forEach(async (cStatus) => {
      const contact = contactsRef.current.find(con => con.id === cStatus.contactId);
      if (!contact) return;

      let templateContent = `🚨 SafeBand Alert: Physical emergency detected!\nName: {name}\nInference: {inference}\nTime: {time}\nLocation: {maps_link} ({gps})\nAddress: {address}\nMedical Info: {medical_info}\n{duress_flag}`;
      if (contact.template_id > 0) {
        const customTemp = templatesRef.current.find(t => t.id === contact.template_id);
        if (customTemp) {
          templateContent = customTemp.content;
          if (isDuress && !templateContent.includes('{duress_flag}')) {
            templateContent += '\n\n⚠️ {duress_flag}';
          }
        }
      }

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

      // A. Send SMS
      if (contact.sms_enabled && dbSettingsRef.current.sms_alerts_enabled === '1') {
        updateChannel(contact.id, 'SMS', 'Sending');
        const sid = dbSettingsRef.current.twilio_account_sid;
        const token = dbSettingsRef.current.twilio_auth_token;
        const fromNum = dbSettingsRef.current.twilio_sms_from;
        if (!sid || !token || !fromNum) {
          updateChannel(contact.id, 'SMS', 'Failed', 'Credentials Missing');
          addLog(`[SMS] Twilio credentials missing for ${contact.name}`, 'SYSTEM');
        } else {
          try {
            const params = new URLSearchParams();
            params.append('From', fromNum);
            params.append('To', contact.phone);
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

      // B. Send WhatsApp
      if (contact.whatsapp_enabled && dbSettingsRef.current.whatsapp_alerts_enabled === '1') {
        updateChannel(contact.id, 'WhatsApp', 'Sending');
        const method = contact.whatsapp_method || 'NATIVE';

        if (method === 'NATIVE') {
          updateChannel(contact.id, 'WhatsApp', 'Handed-off');
          addLog(`[WhatsApp] Native WhatsApp client launched for ${contact.name}`, 'SYSTEM');
          try {
            const url = `whatsapp://send?phone=${contact.whatsapp}&text=${encodeURIComponent(compiledMsg)}`;
            const supported = await Linking.canOpenURL(url);
            if (supported) {
              await Linking.openURL(url);
            } else {
              await Linking.openURL(`https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(compiledMsg)}`);
            }
          } catch (e) {
            console.warn('[WhatsApp] Link launch failed:', e.message);
          }
        } else if (method === 'CALLMEBOT') {
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
          const sid = dbSettingsRef.current.twilio_account_sid;
          const token = dbSettingsRef.current.twilio_auth_token;
          const fromWh = dbSettingsRef.current.twilio_whatsapp_from;
          if (!sid || !token || !fromWh) {
            updateChannel(contact.id, 'WhatsApp', 'Failed', 'Twilio Credentials Missing');
            addLog(`[WhatsApp] Twilio credentials missing for ${contact.name}`, 'SYSTEM');
          } else {
            try {
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

      // C. Send Email
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
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: fromEmail,
                to: contact.email,
                subject: '🚨 SafeBand Emergency Alert',
                text: compiledMsg
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

    setTimeout(() => {
      checkTwilioBalance();
    }, 2000);
  };

  const cancelEmergency = async () => {
    clearInterval(alertIntervalRef.current);
    setShowAlertModal(false);
    setIsDispatched(false);
    setBeepingFlash(false);
    setPinEntryMode(false);
    setEnteredPin('');
    setPinError(null);
    
    if (connectionState === 'CONNECTED') {
      await sendBleCommand(0xFF); // Cancel emergency command
      await sendBleCommand(0x04); // Acknowledge alert command
    }

    setCurrentPacket({
      anomalyScore: 20,
      anomalyDuration: 0,
      motionState: (1 << 1), // Periodic (normal walk)
      peakAccel: 1020,
      dominantFreq: 1.5,
      eigenvalueRatio: 500,
      zcr: 30,
      spectralEntropy: 110,
      wearConfidence: wearConfidenceRef.current,
    });

    addLog('Alert cancelled by user. Packet metrics reset to NORMAL. Cooldown started (20s).', 'SYSTEM');

    setCooldownActive(true);
    setCooldownTime(20);

    const timer = setInterval(() => {
      setCooldownTime((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setCooldownActive(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  return {
    showAlertModal,
    alertCountdown,
    isDispatched,
    beepingFlash,
    dispatchStatuses,
    cooldownActive,
    cooldownTime,
    pinEntryMode,
    enteredPin,
    pinError,
    setPinEntryMode,
    setEnteredPin,
    setPinError,
    triggerEmergencyPreAlert,
    executeEmergencyDispatch,
    cancelEmergency,
    setCooldownActive,
    setCooldownTime,
  };
}
