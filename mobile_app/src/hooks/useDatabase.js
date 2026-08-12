// =============================================================================
// hooks/useDatabase.js — SQLite Data Access & UI Action Handler Hook
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// useDatabase is a React hook that wraps Database.js (the raw SQLite API)
// and provides clean, UI-friendly action handlers for managing contacts,
// message templates, and app settings.
//
// WHO CALLS THIS:
//   → App.js instantiates this hook once and passes its return values to
//     ContactsTab, SettingsTab, TemplatesTab, and useEmergency as props.
//
// WHAT IT DOES:
//   1. Initializes the SQLite database on mount (creates tables, seeds defaults)
//   2. Loads contacts, templates, and settings from SQLite into React state
//   3. Checks Twilio account balance (if credentials are configured)
//   4. Provides CRUD action handlers for contacts and templates that call the
//      raw DB functions and then reload data to keep UI in sync
//   5. Enforces the "minimum 1 contact" safety constraint on deletion
//   6. Enforces the "at least 1 active dispatch channel" constraint on toggle
//
// FILES USED:
//   → Database.js for: initDatabase, getSettings, saveSetting, getContacts,
//                       saveContact, deleteContact, getTemplates, saveTemplate,
//                       deleteTemplate
//
// OUTPUT (what this hook returns):
//   → contacts: array of contact objects (name, phone, email, whatsapp, etc.)
//   → templates: array of message template objects (name, content)
//   → dbSettings: key-value dict of all app settings
//   → twilioBalance: Twilio account balance (or null if no credentials)
//   → CRUD handlers for contacts and templates
//   → handleToggleGlobalChannel: toggling SMS/WhatsApp/Email globally
//
// BUGS / NOTES:
//   ⚠ base64Encode() is defined TWICE in this codebase:
//     - Once here in useDatabase.js (for Twilio balance check)
//     - Once in useEmergency.js (for Twilio API calls)
//     This is code duplication that could be extracted to a shared utility file.
//   ⚠ checkTwilioBalance() is an async network call. If the user has no internet
//     connection, it silently sets twilioBalanceError = 'Network error' but the
//     app will still work. This is correct behavior.
//   ⚠ loadDatabaseData() is called every time a contact or template is saved,
//     which reloads ALL contacts, templates, and settings from SQLite. For a
//     large contact list this is fine, but it triggers a full React re-render
//     of all consumers every time. A more surgical update could be used instead.
// =============================================================================

import { useState, useEffect } from 'react';
import { Alert } from 'react-native';
import {
  initDatabase,    // Creates all SQLite tables and seeds default data on first run
  getSettings,     // Returns { key: value } dict of all settings rows
  saveSetting,     // Upsert a single setting by key
  getContacts,     // Returns all contacts ordered by id
  saveContact,     // Insert or update a contact (by contact.id presence)
  deleteContact,   // Delete a contact by id
  getTemplates,    // Returns all message templates ordered by id
  saveTemplate,    // Insert or update a template (by template.id presence)
  deleteTemplate   // Delete a template by id
} from '../Database';

// Pure-JS Base64 encoder: needed for Twilio API authentication.
// Twilio uses HTTP Basic Auth, which requires base64("accountSid:authToken").
// NOTE: This is duplicated in useEmergency.js — a good candidate for refactoring
// into a shared utility module.
function base64Encode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  while (i < str.length) {
    // Process 3 input characters at a time, producing 4 Base64 characters
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

// =============================================================================
// MAIN HOOK
// @param addLog - function from App.js to append messages to the system log panel
// =============================================================================
export default function useDatabase(addLog) {
  // Array of contact objects from the `contacts` table.
  // Each contact has: id, name, phone, email, whatsapp, whatsapp_method,
  // callmebot_key, sms_enabled, whatsapp_enabled, email_enabled, template_id
  const [contacts, setContacts] = useState([]);

  // Array of message template objects from the `templates` table.
  // Each template has: id, name, content (with {name} {inference} etc. placeholders)
  const [templates, setTemplates] = useState([]);

  // Key-value dict of all settings from the `settings` table.
  // Includes: user_name, medical info, Twilio credentials, Resend API key,
  //           pin codes, silent_beacon, global channel enable/disable flags
  const [dbSettings, setDbSettings] = useState({});

  // Twilio account balance string (e.g. "12.34") or null if not configured
  const [twilioBalance, setTwilioBalance] = useState(null);

  // Error message if Twilio balance check failed ('Invalid credentials' | 'Network error')
  const [twilioBalanceError, setTwilioBalanceError] = useState(null);

  // True when the user tries to disable ALL dispatch channels simultaneously —
  // triggers a warning banner in SettingsTab for 4 seconds
  const [globalConstraintWarning, setGlobalConstraintWarning] = useState(false);

  // Reloads contacts, templates, and settings from SQLite into React state.
  // Called on mount and after any CRUD operation to keep UI in sync with DB.
  const loadDatabaseData = () => {
    try {
      const dbSettingsObj = getSettings();
      setDbSettings(dbSettingsObj);

      const dbContacts = getContacts();
      setContacts(dbContacts);

      const dbTemplates = getTemplates();
      setTemplates(dbTemplates);
      
      // Auto-check Twilio balance if credentials are already saved in settings
      if (dbSettingsObj.twilio_account_sid && dbSettingsObj.twilio_auth_token) {
        checkTwilioBalance(dbSettingsObj.twilio_account_sid, dbSettingsObj.twilio_auth_token);
      }
    } catch (e) {
      console.warn('[DB] Failed to load SQLite tables:', e);
    }
  };

  // Calls the Twilio Accounts Balance API to display the current SMS/WhatsApp credit.
  // Purely informational — shown in SettingsTab so the user knows if they're running low.
  // @param sid   - Twilio Account SID (overrides saved setting if provided)
  // @param token - Twilio Auth Token (overrides saved setting if provided)
  const checkTwilioBalance = async (sid, token) => {
    const accountSid = sid || dbSettings.twilio_account_sid;
    const authToken = token || dbSettings.twilio_auth_token;
    if (!accountSid || !authToken) {
      // No credentials saved yet — clear any previous balance/error display
      setTwilioBalance(null);
      setTwilioBalanceError(null);
      return;
    }
    try {
      // Twilio API uses HTTP Basic Auth: base64("accountSid:authToken")
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`, {
        headers: {
          'Authorization': `Basic ${base64Encode(accountSid + ':' + authToken)}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setTwilioBalance(data.balance); // e.g. "12.34" (USD string)
        setTwilioBalanceError(null);
      } else {
        setTwilioBalanceError('Invalid credentials');
      }
    } catch (err) {
      setTwilioBalanceError('Network error');
    }
  };

  // --- Contact CRUD Handlers ---

  // Validates and saves a contact (insert if new, update if existing by id).
  // After saving, reloads all data and shows a success alert for new contacts.
  // @param editingContact       - the contact object being edited
  // @param setEditingContact    - setter to clear the editing state
  // @param setShowContactModal  - setter to close the contact form modal
  const handleSaveContact = (editingContact, setEditingContact, setShowContactModal) => {
    if (!editingContact.name) {
      Alert.alert('Error', 'Contact Name is required');
      return;
    }
    const isNew = !editingContact.id; // id is undefined for new contacts
    try {
      saveContact(editingContact);   // Raw DB write (INSERT or UPDATE)
      loadDatabaseData();            // Reload all state from DB
      setShowContactModal(false);    // Close the form modal
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

  // Deletes a contact by id, with a safety constraint: at least 1 contact must remain.
  // Shows a confirmation dialog before deleting.
  // SAFETY: Cannot delete the last contact because emergency alerts need at least one recipient.
  const handleDeleteContact = (id, name) => {
    if (contacts.length <= 1) {
      // SAFETY CONSTRAINT: Block deletion if this is the only remaining contact
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
              deleteContact(id);     // Raw DB DELETE
              loadDatabaseData();    // Reload state
              addLog(`Contact '${name}' deleted from database.`, 'SYSTEM');
            } catch (e) {
              console.warn('[DB] Delete contact error:', e);
            }
          }
        }
      ]
    );
  };

  // --- Template CRUD Handlers ---

  // Validates and saves a message template. Both name and content are required.
  const handleSaveTemplate = (editingTemplate, setEditingTemplate, setShowTemplateModal) => {
    if (!editingTemplate.name || !editingTemplate.content) {
      Alert.alert('Error', 'Template Name and Content are required');
      return;
    }
    try {
      saveTemplate(editingTemplate);   // INSERT or UPDATE
      loadDatabaseData();
      setShowTemplateModal(false);
      setEditingTemplate(null);
      addLog(`Template '${editingTemplate.name}' saved to database.`, 'SYSTEM');
    } catch (e) {
      console.warn('[DB] Save template error:', e);
    }
  };

  // Deletes a template by id. No minimum constraint (unlike contacts).
  const handleDeleteTemplate = (id, name) => {
    try {
      deleteTemplate(id);
      loadDatabaseData();
      addLog(`Template '${name}' deleted from database.`, 'SYSTEM');
    } catch (e) {
      console.warn('[DB] Delete template error:', e);
    }
  };

  // --- Global Channel Toggle ---

  // Toggles a global dispatch channel (SMS/WhatsApp/Email) on/off for ALL contacts.
  // SAFETY CONSTRAINT: At least one global channel must remain enabled.
  // If the user tries to disable the last active channel, shows a warning and
  // blocks the toggle for 4 seconds.
  //
  // @param key        - the settings key being toggled (e.g. 'sms_alerts_enabled')
  // @param currentVal - the current value of that key ('0' or '1')
  const handleToggleGlobalChannel = (key, currentVal) => {
    const newVal = currentVal === '1' ? '0' : '1'; // Toggle between '0' and '1'
    
    // Compute the resulting state of all three channels after this toggle
    let activeSMS = key === 'sms_alerts_enabled' ? (newVal === '1') : (dbSettings.sms_alerts_enabled === '1');
    let activeWhatsApp = key === 'whatsapp_alerts_enabled' ? (newVal === '1') : (dbSettings.whatsapp_alerts_enabled === '1');
    let activeEmail = key === 'email_alerts_enabled' ? (newVal === '1') : (dbSettings.email_alerts_enabled === '1');

    // SAFETY: Block the toggle if it would disable ALL channels
    if (!activeSMS && !activeWhatsApp && !activeEmail) {
      setGlobalConstraintWarning(true);  // Show warning banner in UI
      setTimeout(() => setGlobalConstraintWarning(false), 4000); // Hide after 4s
      return; // DO NOT save the change
    }

    // Safe to toggle — persist and reload
    saveSetting(key, newVal);
    loadDatabaseData();
  };

  // --- DB Initialization Effect ---
  // Runs once on mount: initializes all SQLite tables (if not already created)
  // and loads initial data into React state.
  useEffect(() => {
    try {
      initDatabase();    // Creates tables, runs migrations, seeds default data
      loadDatabaseData(); // Loads contacts, templates, settings into state
    } catch (e) {
      console.warn('[DB] DB initialization failed:', e);
    }
  }, []); // Empty deps: runs only once on mount

  return {
    contacts,                   // Contact list for ContactsTab and useEmergency
    templates,                  // Template list for TemplatesTab and useEmergency
    dbSettings,                 // All app settings for SettingsTab and useEmergency
    twilioBalance,              // Twilio credit balance string (or null)
    twilioBalanceError,         // Twilio credential/network error (or null)
    globalConstraintWarning,    // True = show "can't disable all channels" warning
    loadDatabaseData,           // Manual reload trigger (used by SettingsTab on save)
    checkTwilioBalance,         // Manual balance refresh trigger (used by SettingsTab)
    handleSaveContact,          // Save contact + reload + show modal close
    handleDeleteContact,        // Delete contact with safety constraint + confirm dialog
    handleSaveTemplate,         // Save template + reload + close modal
    handleDeleteTemplate,       // Delete template + reload
    handleToggleGlobalChannel,  // Toggle SMS/WhatsApp/Email globally with safety check
    setDbSettings,              // Direct setter — used by SettingsTab for optimistic updates
  };
}
