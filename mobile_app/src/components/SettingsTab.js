import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Switch, TouchableOpacity, Platform } from 'react-native';
import styles from './styles';

const SettingsTab = React.memo(({
  dbSettings,
  saveSetting,
  setDbSettings,
  twilioBalance,
  twilioBalanceError,
  checkTwilioBalance,
  handleToggleGlobalChannel,
  handleRunReclustering,
  handleRunCleanup
}) => {
  // Local state for settings to avoid app-wide lag during typing
  const [userName, setUserName] = useState(dbSettings.user_name || '');
  const [bloodGroup, setBloodGroup] = useState(dbSettings.medical_blood_group || '');
  const [conditions, setConditions] = useState(dbSettings.medical_conditions || '');
  const [allergies, setAllergies] = useState(dbSettings.medical_allergies || '');
  const [instructions, setInstructions] = useState(dbSettings.medical_instructions || '');
  const [realPin, setRealPin] = useState(dbSettings.real_pin || '');
  const [fakePin, setFakePin] = useState(dbSettings.fake_pin || '');
  const [twilioSid, setTwilioSid] = useState(dbSettings.twilio_account_sid || '');
  const [twilioToken, setTwilioToken] = useState(dbSettings.twilio_auth_token || '');
  const [twilioSmsFrom, setTwilioSmsFrom] = useState(dbSettings.twilio_sms_from || '');
  const [twilioWhatsappFrom, setTwilioWhatsappFrom] = useState(dbSettings.twilio_whatsapp_from || '');
  const [resendKey, setResendKey] = useState(dbSettings.resend_api_key || '');
  const [resendEmail, setResendEmail] = useState(dbSettings.resend_from_email || '');

  // Keep local states in sync when dbSettings changes from external sources (e.g. database load)
  useEffect(() => {
    setUserName(dbSettings.user_name || '');
    setBloodGroup(dbSettings.medical_blood_group || '');
    setConditions(dbSettings.medical_conditions || '');
    setAllergies(dbSettings.medical_allergies || '');
    setInstructions(dbSettings.medical_instructions || '');
    setRealPin(dbSettings.real_pin || '');
    setFakePin(dbSettings.fake_pin || '');
    setTwilioSid(dbSettings.twilio_account_sid || '');
    setTwilioToken(dbSettings.twilio_auth_token || '');
    setTwilioSmsFrom(dbSettings.twilio_sms_from || '');
    setTwilioWhatsappFrom(dbSettings.twilio_whatsapp_from || '');
    setResendKey(dbSettings.resend_api_key || '');
    setResendEmail(dbSettings.resend_from_email || '');
  }, [dbSettings]);

  const handleBlurSetting = (key, value) => {
    if (dbSettings[key] !== value) {
      saveSetting(key, value);
      setDbSettings(prev => ({ ...prev, [key]: value }));
      
      // Perform balance check ONLY on focus loss of credentials rather than on every keypress
      if (key === 'twilio_account_sid' || key === 'twilio_auth_token') {
        const currentSid = key === 'twilio_account_sid' ? value : twilioSid;
        const currentToken = key === 'twilio_auth_token' ? value : twilioToken;
        if (currentSid && currentToken) {
          checkTwilioBalance(currentSid, currentToken);
        }
      }
    }
  };

  return (
    <View>
      {/* User Profile and Medical Info */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>👤 Personal Profile & Medical Info</Text>
        <Text style={styles.label}>Full Name</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Jane Smith"
          placeholderTextColor="#475569"
          value={userName}
          onChangeText={setUserName}
          onBlur={() => handleBlurSetting('user_name', userName)}
        />

        <Text style={styles.label}>Blood Group</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. O+, A-, etc."
          placeholderTextColor="#475569"
          value={bloodGroup}
          onChangeText={setBloodGroup}
          onBlur={() => handleBlurSetting('medical_blood_group', bloodGroup)}
        />

        <Text style={styles.label}>Medical Conditions</Text>
        <TextInput
          style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
          placeholder="e.g. Epilepsy, Diabetes, Heart condition"
          placeholderTextColor="#475569"
          multiline
          value={conditions}
          onChangeText={setConditions}
          onBlur={() => handleBlurSetting('medical_conditions', conditions)}
        />

        <Text style={styles.label}>Known Allergies</Text>
        <TextInput
          style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
          placeholder="e.g. Penicillin, Latex, Peanuts"
          placeholderTextColor="#475569"
          multiline
          value={allergies}
          onChangeText={setAllergies}
          onBlur={() => handleBlurSetting('medical_allergies', allergies)}
        />

        <Text style={styles.label}>Emergency Instructions</Text>
        <TextInput
          style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
          placeholder="e.g. Carries inhaler in backpack side pocket."
          placeholderTextColor="#475569"
          multiline
          value={instructions}
          onChangeText={setInstructions}
          onBlur={() => handleBlurSetting('medical_instructions', instructions)}
        />
      </View>

      {/* Global Channel Enable switches */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📢 Global Alert Channels</Text>
        
        <View style={[styles.rowBetween, { paddingVertical: 6 }]}>
          <Text style={{ color: '#F8FAFC', fontSize: 14 }}>Enable SMS Alerts</Text>
          <Switch
            value={dbSettings.sms_alerts_enabled === '1'}
            onValueChange={() => handleToggleGlobalChannel('sms_alerts_enabled', dbSettings.sms_alerts_enabled)}
          />
        </View>

        <View style={[styles.rowBetween, { paddingVertical: 6 }]}>
          <Text style={{ color: '#F8FAFC', fontSize: 14 }}>Enable WhatsApp Alerts</Text>
          <Switch
            value={dbSettings.whatsapp_alerts_enabled === '1'}
            onValueChange={() => handleToggleGlobalChannel('whatsapp_alerts_enabled', dbSettings.whatsapp_alerts_enabled)}
          />
        </View>

        <View style={[styles.rowBetween, { paddingVertical: 6 }]}>
          <Text style={{ color: '#F8FAFC', fontSize: 14 }}>Enable Email Alerts</Text>
          <Switch
            value={dbSettings.email_alerts_enabled === '1'}
            onValueChange={() => handleToggleGlobalChannel('email_alerts_enabled', dbSettings.email_alerts_enabled)}
          />
        </View>
      </View>

      {/* Security PINs and Safety configurations */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔒 Lock & Security Settings</Text>

        <View style={[styles.rowBetween, { paddingVertical: 6, marginBottom: 12 }]}>
          <Text style={{ color: '#F8FAFC', fontSize: 14 }}>Enable PIN Lock to Cancel Alerts</Text>
          <Switch
            value={dbSettings.pin_enabled === '1'}
            onValueChange={(val) => {
              const strVal = val ? '1' : '0';
              saveSetting('pin_enabled', strVal);
              setDbSettings(prev => ({ ...prev, pin_enabled: strVal }));
            }}
          />
        </View>

        {dbSettings.pin_enabled === '1' && (
          <View>
            <Text style={styles.label}>Real PIN (4 Digits)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 1234"
              placeholderTextColor="#475569"
              maxLength={4}
              keyboardType="numeric"
              secureTextEntry
              value={realPin}
              onChangeText={setRealPin}
              onBlur={() => handleBlurSetting('real_pin', realPin)}
            />

            <Text style={styles.label}>Fake PIN / Duress PIN (4 Digits)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 9999"
              placeholderTextColor="#475569"
              maxLength={4}
              keyboardType="numeric"
              secureTextEntry
              value={fakePin}
              onChangeText={setFakePin}
              onBlur={() => handleBlurSetting('fake_pin', fakePin)}
            />
          </View>
        )}

        <View style={[styles.rowBetween, { paddingVertical: 6 }]}>
          <Text style={{ color: '#F8FAFC', fontSize: 14 }}>Silent Beacon Mode (Mute Buzzer)</Text>
          <Switch
            value={dbSettings.silent_beacon === '1'}
            onValueChange={(val) => {
              const strVal = val ? '1' : '0';
              saveSetting('silent_beacon', strVal);
              setDbSettings(prev => ({ ...prev, silent_beacon: strVal }));
            }}
          />
        </View>
      </View>

      {/* Gateway API Credentials settings */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔑 API Credentials & Gateways</Text>

        <Text style={styles.label}>Twilio Account SID</Text>
        <TextInput
          style={styles.input}
          placeholder="AC..."
          placeholderTextColor="#475569"
          value={twilioSid}
          onChangeText={setTwilioSid}
          onBlur={() => handleBlurSetting('twilio_account_sid', twilioSid)}
        />

        <Text style={styles.label}>Twilio Auth Token</Text>
        <TextInput
          style={styles.input}
          placeholder="Auth Token"
          placeholderTextColor="#475569"
          secureTextEntry
          value={twilioToken}
          onChangeText={twilioToken => setTwilioToken(twilioToken)}
          onBlur={() => handleBlurSetting('twilio_auth_token', twilioToken)}
        />

        <Text style={styles.label}>Twilio SMS From Phone Number</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. +1415xxxxxxx"
          placeholderTextColor="#475569"
          value={twilioSmsFrom}
          onChangeText={setTwilioSmsFrom}
          onBlur={() => handleBlurSetting('twilio_sms_from', twilioSmsFrom)}
        />

        <Text style={styles.label}>Twilio WhatsApp From Number</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. whatsapp:+14155238886"
          placeholderTextColor="#475569"
          value={twilioWhatsappFrom}
          onChangeText={setTwilioWhatsappFrom}
          onBlur={() => handleBlurSetting('twilio_whatsapp_from', twilioWhatsappFrom)}
        />

        <Text style={styles.label}>Resend API Key</Text>
        <TextInput
          style={styles.input}
          placeholder="re_..."
          placeholderTextColor="#475569"
          value={resendKey}
          onChangeText={setResendKey}
          onBlur={() => handleBlurSetting('resend_api_key', resendKey)}
        />

        <Text style={styles.label}>Resend From Email</Text>
        <TextInput
          style={styles.input}
          placeholder="onboarding@resend.dev"
          placeholderTextColor="#475569"
          value={resendEmail}
          onChangeText={setResendEmail}
          onBlur={() => handleBlurSetting('resend_from_email', resendEmail)}
        />

        <View style={styles.rowBetween}>
          <Text style={{ color: '#94A3B8', fontSize: 13 }}>
            Twilio Balance:{' '}
            {twilioBalanceError ? (
              <Text style={{ color: '#EF4444' }}>{twilioBalanceError}</Text>
            ) : twilioBalance !== null ? (
              <Text style={{ color: parseFloat(twilioBalance) < 0.50 ? '#EF4444' : '#10B981', fontWeight: 'bold' }}>
                ${parseFloat(twilioBalance).toFixed(2)}
              </Text>
            ) : (
              <Text style={{ color: '#64748B' }}>Not checked</Text>
            )}
          </Text>
          <TouchableOpacity
            delayPressIn={0}
            style={styles.bleDeviceConnectBtn}
            onPress={() => checkTwilioBalance(dbSettings.twilio_account_sid, dbSettings.twilio_auth_token)}
          >
            <Text style={styles.bleDeviceConnectText}>Refresh Credit</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Background Services Control Panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Background Services & ML Tasks</Text>
        <Text style={styles.multiplierItem}>
          Trigger background clustering, historical reassignment, and database retention cleanups manually.
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <TouchableOpacity
            style={styles.bleDeviceConnectBtn}
            onPress={handleRunReclustering}
          >
            <Text style={styles.bleDeviceConnectText}>Run Reclustering</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.bleDeviceConnectBtn, { backgroundColor: '#475569' }]}
            onPress={handleRunCleanup}
          >
            <Text style={styles.bleDeviceConnectText}>Database Cleanup</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Whitelist DND info reminder */}
      <View style={[styles.card, { borderColor: 'rgba(59, 130, 246, 0.15)' }]}>
        <Text style={[styles.cardTitle, { color: '#60A5FA' }]}>ℹ️ Do Not Disturb Whitelisting</Text>
        <Text style={styles.multiplierItem}>
          To make sure the SafeBand buzzer triggers in silent/DND mode, do the following:
        </Text>
        <Text style={[styles.multiplierItem, { color: '#CBD5E1', paddingLeft: 8 }]}>
          • Android: Go to Settings &gt; Apps &gt; SafeBand &gt; Notifications &gt; Allow Do Not Disturb override.{'\n'}
          • iOS: Go to Settings &gt; Focus &gt; Do Not Disturb &gt; Allowed Apps &gt; Add SafeBand app to allowed list.
        </Text>
      </View>
    </View>
  );
});

export default SettingsTab;
