import * as SQLite from 'expo-sqlite';

let db = null;

export function initDatabase() {
  if (db) return db;
  try {
    db = SQLite.openDatabaseSync('safeband.db');
    
    // Create settings table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    
    // Create contacts table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        whatsapp TEXT,
        whatsapp_method TEXT DEFAULT 'NATIVE', -- 'NATIVE', 'CALLMEBOT', 'TWILIO'
        callmebot_key TEXT,
        sms_enabled INTEGER DEFAULT 1,
        whatsapp_enabled INTEGER DEFAULT 1,
        email_enabled INTEGER DEFAULT 1,
        template_id INTEGER DEFAULT 0 -- 0 means default template
      );
    `);
    
    // Create templates table
    db.execSync(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL
      );
    `);
    
    // Insert default settings if they don't exist
    const defaultSettings = [
      { key: 'user_name', value: 'Jane Smith' },
      { key: 'medical_blood_group', value: 'O+' },
      { key: 'medical_conditions', value: '' },
      { key: 'medical_allergies', value: '' },
      { key: 'medical_instructions', value: '' },
      { key: 'real_pin', value: '1234' },
      { key: 'fake_pin', value: '9999' },
      { key: 'pin_enabled', value: '1' },
      { key: 'silent_beacon', value: '0' },
      { key: 'twilio_account_sid', value: '' },
      { key: 'twilio_auth_token', value: '' },
      { key: 'twilio_sms_from', value: '' },
      { key: 'twilio_whatsapp_from', value: '' },
      { key: 'resend_api_key', value: '' },
      { key: 'resend_from_email', value: 'onboarding@resend.dev' },
      { key: 'email_alerts_enabled', value: '1' },
      { key: 'whatsapp_alerts_enabled', value: '1' },
      { key: 'sms_alerts_enabled', value: '1' }
    ];

    for (const setting of defaultSettings) {
      const row = db.getFirstSync('SELECT * FROM settings WHERE key = ?;', [setting.key]);
      if (!row) {
        db.runSync('INSERT INTO settings (key, value) VALUES (?, ?);', [setting.key, setting.value]);
      }
    }

    // Insert default contacts if empty
    const contactsCount = db.getFirstSync('SELECT COUNT(*) as count FROM contacts;');
    if (contactsCount.count === 0) {
      db.runSync(`
        INSERT INTO contacts (name, phone, email, whatsapp, whatsapp_method, sms_enabled, whatsapp_enabled, email_enabled)
        VALUES ('Jane Doe (Primary)', '+15550192831', 'jane.doe@example.com', '+15550192831', 'NATIVE', 1, 1, 1);
      `);
      db.runSync(`
        INSERT INTO contacts (name, phone, email, whatsapp, whatsapp_method, sms_enabled, whatsapp_enabled, email_enabled)
        VALUES ('John Smith', '+15550129844', 'john.smith@example.com', '+15550129844', 'TWILIO', 1, 1, 1);
      `);
    }

    console.log('[DB] Database initialized successfully.');
    return db;
  } catch (error) {
    console.error('[DB] Database initialization failed:', error);
    throw error;
  }
}

export function getSettings() {
  const database = initDatabase();
  const rows = database.getAllSync('SELECT * FROM settings;');
  const settingsObj = {};
  for (const row of rows) {
    settingsObj[row.key] = row.value;
  }
  return settingsObj;
}

export async function saveSetting(key, value) {
  const database = initDatabase();
  await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);', [key, String(value)]);
}

export function getContacts() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM contacts ORDER BY id ASC;');
}

export function saveContact(contact) {
  const database = initDatabase();
  if (contact.id) {
    database.runSync(`
      UPDATE contacts SET 
        name = ?, phone = ?, email = ?, whatsapp = ?, 
        whatsapp_method = ?, callmebot_key = ?, 
        sms_enabled = ?, whatsapp_enabled = ?, email_enabled = ?,
        template_id = ?
      WHERE id = ?;
    `, [
      contact.name, contact.phone, contact.email, contact.whatsapp,
      contact.whatsapp_method, contact.callmebot_key,
      contact.sms_enabled ? 1 : 0, contact.whatsapp_enabled ? 1 : 0, contact.email_enabled ? 1 : 0,
      contact.template_id || 0,
      contact.id
    ]);
  } else {
    database.runSync(`
      INSERT INTO contacts (
        name, phone, email, whatsapp, whatsapp_method, callmebot_key, 
        sms_enabled, whatsapp_enabled, email_enabled, template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, [
      contact.name, contact.phone, contact.email, contact.whatsapp,
      contact.whatsapp_method, contact.callmebot_key,
      contact.sms_enabled ? 1 : 0, contact.whatsapp_enabled ? 1 : 0, contact.email_enabled ? 1 : 0,
      contact.template_id || 0
    ]);
  }
}

export function deleteContact(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM contacts WHERE id = ?;', [id]);
}

export function getTemplates() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM templates ORDER BY id ASC;');
}

export function saveTemplate(template) {
  const database = initDatabase();
  if (template.id) {
    database.runSync('UPDATE templates SET name = ?, content = ? WHERE id = ?;', [template.name, template.content, template.id]);
  } else {
    database.runSync('INSERT INTO templates (name, content) VALUES (?, ?);', [template.name, template.content]);
  }
}

export function deleteTemplate(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM templates WHERE id = ?;', [id]);
}
