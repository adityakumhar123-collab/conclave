import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import styles from './styles';

const ContactsTab = React.memo(({
  contacts,
  templates,
  setEditingContact,
  setShowContactModal,
  handleDeleteContact
}) => {
  return (
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>👥 Emergency Contacts</Text>
        <TouchableOpacity
          delayPressIn={0}
          style={[styles.bleDeviceConnectBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]}
          onPress={() => {
            setEditingContact({
              name: '',
              phone: '',
              email: '',
              whatsapp: '',
              whatsapp_method: 'NATIVE',
              callmebot_key: '',
              sms_enabled: 1,
              whatsapp_enabled: 1,
              email_enabled: 1,
              template_id: 0
            });
            setShowContactModal(true);
          }}
        >
          <Text style={[styles.bleDeviceConnectText, { color: '#FFFFFF' }]}>+ Add Contact</Text>
        </TouchableOpacity>
      </View>

      {contacts.length === 0 ? (
        <View style={[styles.card, { alignItems: 'center', paddingVertical: 32 }]}>
          <Text style={styles.noDevicesText}>No emergency contacts added yet.</Text>
        </View>
      ) : (
        contacts.map((contact) => (
          <View key={contact.id} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={[styles.titleText, { fontSize: 16 }]}>{contact.name}</Text>
              <View style={styles.row}>
                <TouchableOpacity
                  delayPressIn={0}
                  style={[styles.bleDeviceConnectBtn, { marginRight: 8 }]}
                  onPress={() => {
                    setEditingContact({ ...contact });
                    setShowContactModal(true);
                  }}
                >
                  <Text style={styles.bleDeviceConnectText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  delayPressIn={0}
                  style={[styles.bleDeviceConnectBtn, { borderColor: '#EF4444' }]}
                  onPress={() => handleDeleteContact(contact.id, contact.name)}
                >
                  <Text style={[styles.bleDeviceConnectText, { color: '#EF4444' }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={{ marginTop: 8, gap: 4 }}>
              {contact.phone ? <Text style={styles.miniStat}>📞 Phone: {contact.phone}</Text> : null}
              {contact.email ? <Text style={styles.miniStat}>📧 Email: {contact.email}</Text> : null}
              {contact.whatsapp ? (
                <Text style={styles.miniStat}>
                  💬 WhatsApp: {contact.whatsapp} ({contact.whatsapp_method === 'NATIVE' ? 'Native App' : contact.whatsapp_method === 'CALLMEBOT' ? 'CallMeBot' : 'Twilio Sandbox'})
                </Text>
              ) : null}
              <Text style={styles.miniStat}>
                📝 Template: {contact.template_id === 0 ? 'System Default' : templates.find(t => t.id === contact.template_id)?.name || 'Unknown'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
              <View style={[styles.notifyBadge, { backgroundColor: contact.sms_enabled ? '#3B82F633' : 'rgba(255,255,255,0.03)', borderColor: contact.sms_enabled ? '#3B82F6' : 'rgba(255,255,255,0.06)', borderWidth: 1 }]}>
                <Text style={{ color: contact.sms_enabled ? '#3B82F6' : '#64748B', fontSize: 10 }}>SMS {contact.sms_enabled ? 'ON' : 'OFF'}</Text>
              </View>
              <View style={[styles.notifyBadge, { backgroundColor: contact.whatsapp_enabled ? '#25D36633' : 'rgba(255,255,255,0.03)', borderColor: contact.whatsapp_enabled ? '#25D366' : 'rgba(255,255,255,0.06)', borderWidth: 1 }]}>
                <Text style={{ color: contact.whatsapp_enabled ? '#25D366' : '#64748B', fontSize: 10 }}>WhatsApp {contact.whatsapp_enabled ? 'ON' : 'OFF'}</Text>
              </View>
              <View style={[styles.notifyBadge, { backgroundColor: contact.email_enabled ? '#10B98133' : 'rgba(255,255,255,0.03)', borderColor: contact.email_enabled ? '#10B981' : 'rgba(255,255,255,0.06)', borderWidth: 1 }]}>
                <Text style={{ color: contact.email_enabled ? '#10B981' : '#64748B', fontSize: 10 }}>Email {contact.email_enabled ? 'ON' : 'OFF'}</Text>
              </View>
            </View>
          </View>
        ))
      )}
    </View>
  );
});

export default ContactsTab;
