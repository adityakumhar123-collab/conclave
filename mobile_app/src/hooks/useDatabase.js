import { useState, useEffect } from 'react';
import { Alert } from 'react-native';
import {
  initDatabase,
  getSettings,
  saveSetting,
  getContacts,
  saveContact,
  deleteContact,
  getTemplates,
  saveTemplate,
  deleteTemplate
} from '../Database';

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

export default function useDatabase(addLog) {
  const [contacts, setContacts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [dbSettings, setDbSettings] = useState({});
  const [twilioBalance, setTwilioBalance] = useState(null);
  const [twilioBalanceError, setTwilioBalanceError] = useState(null);
  const [globalConstraintWarning, setGlobalConstraintWarning] = useState(false);

  const loadDatabaseData = () => {
    try {
      const dbSettingsObj = getSettings();
      setDbSettings(dbSettingsObj);
      const dbContacts = getContacts();
      setContacts(dbContacts);
      const dbTemplates = getTemplates();
      setTemplates(dbTemplates);
      
      if (dbSettingsObj.twilio_account_sid && dbSettingsObj.twilio_auth_token) {
        checkTwilioBalance(dbSettingsObj.twilio_account_sid, dbSettingsObj.twilio_auth_token);
      }
    } catch (e) {
      console.warn('[DB] Failed to load SQLite tables:', e);
    }
  };

  const checkTwilioBalance = async (sid, token) => {
    const accountSid = sid || dbSettings.twilio_account_sid;
    const authToken = token || dbSettings.twilio_auth_token;
    if (!accountSid || !authToken) {
      setTwilioBalance(null);
      setTwilioBalanceError(null);
      return;
    }
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`, {
        headers: {
          'Authorization': `Basic ${base64Encode(accountSid + ':' + authToken)}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setTwilioBalance(data.balance);
        setTwilioBalanceError(null);
      } else {
        setTwilioBalanceError('Invalid credentials');
      }
    } catch (err) {
      setTwilioBalanceError('Network error');
    }
  };

  const handleSaveContact = (editingContact, setEditingContact, setShowContactModal) => {
    if (!editingContact.name) {
      Alert.alert('Error', 'Contact Name is required');
      return;
    }
    const isNew = !editingContact.id;
    try {
      saveContact(editingContact);
      loadDatabaseData();
      setShowContactModal(false);
      if (isNew) {
        Alert.alert(
          'Success',
          `Successfully added ${editingContact.name} to the contact list.`
        );
      }
      setEditingContact(null);
      addLog(`Contact '${editingContact.name}' saved to database.`, 'SYSTEM');
    } catch (e) {
      console.warn('[DB] Save contact error:', e);
    }
  };

  const handleDeleteContact = (id, name) => {
    if (contacts.length <= 1) {
      Alert.alert(
        '⚠️ Safety Constraint',
        'You must keep at least one emergency contact to ensure you can dispatch alerts.'
      );
      return;
    }
    Alert.alert(
      'Delete Contact',
      `Are you sure you want to delete '${name}' from your emergency contact list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            try {
              deleteContact(id);
              loadDatabaseData();
              addLog(`Contact '${name}' deleted from database.`, 'SYSTEM');
            } catch (e) {
              console.warn('[DB] Delete contact error:', e);
            }
          }
        }
      ]
    );
  };

  const handleSaveTemplate = (editingTemplate, setEditingTemplate, setShowTemplateModal) => {
    if (!editingTemplate.name || !editingTemplate.content) {
      Alert.alert('Error', 'Template Name and Content are required');
      return;
    }
    try {
      saveTemplate(editingTemplate);
      loadDatabaseData();
      setShowTemplateModal(false);
      setEditingTemplate(null);
      addLog(`Template '${editingTemplate.name}' saved to database.`, 'SYSTEM');
    } catch (e) {
      console.warn('[DB] Save template error:', e);
    }
  };

  const handleDeleteTemplate = (id, name) => {
    try {
      deleteTemplate(id);
      loadDatabaseData();
      addLog(`Template '${name}' deleted from database.`, 'SYSTEM');
    } catch (e) {
      console.warn('[DB] Delete template error:', e);
    }
  };

  const handleToggleGlobalChannel = (key, currentVal) => {
    const newVal = currentVal === '1' ? '0' : '1';
    
    let activeSMS = key === 'sms_alerts_enabled' ? (newVal === '1') : (dbSettings.sms_alerts_enabled === '1');
    let activeWhatsApp = key === 'whatsapp_alerts_enabled' ? (newVal === '1') : (dbSettings.whatsapp_alerts_enabled === '1');
    let activeEmail = key === 'email_alerts_enabled' ? (newVal === '1') : (dbSettings.email_alerts_enabled === '1');

    if (!activeSMS && !activeWhatsApp && !activeEmail) {
      setGlobalConstraintWarning(true);
      setTimeout(() => setGlobalConstraintWarning(false), 4000);
      return;
    }

    saveSetting(key, newVal);
    loadDatabaseData();
  };

  // Initialize DB tables and load data on mount
  useEffect(() => {
    try {
      initDatabase();
      loadDatabaseData();
    } catch (e) {
      console.warn('[DB] DB initialization failed:', e);
    }
  }, []);

  return {
    contacts,
    templates,
    dbSettings,
    twilioBalance,
    twilioBalanceError,
    globalConstraintWarning,
    loadDatabaseData,
    checkTwilioBalance,
    handleSaveContact,
    handleDeleteContact,
    handleSaveTemplate,
    handleDeleteTemplate,
    handleToggleGlobalChannel,
    setDbSettings,
  };
}
