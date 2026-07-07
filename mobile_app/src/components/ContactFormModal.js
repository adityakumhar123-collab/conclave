import React from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Switch,
  KeyboardAvoidingView,
  Animated,
  Platform
} from 'react-native';
import styles from './styles';

export default function ContactFormModal({
  showContactModal,
  setShowContactModal,
  editingContact,
  setEditingContact,
  handleSaveContact,
  templates,
  keyboardOffset
}) {
  if (!showContactModal) return null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.absoluteOverlay}
    >
      <Animated.View style={[
        styles.modalContent,
        {
          transform: [{
            translateY: keyboardOffset.interpolate({
              inputRange: [0, 100],
              outputRange: [0, -100]
            })
          }]
        }
      ]}>
        <Text style={styles.modalTitle}>
          {editingContact && editingContact.id ? '👤 Edit Emergency Contact' : '👤 Add Emergency Contact'}
        </Text>

        <ScrollView contentContainerStyle={{ gap: 10 }}>
          <Text style={styles.label}>Contact Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Name"
            placeholderTextColor="#475569"
            value={editingContact ? editingContact.name : ''}
            onChangeText={(val) => setEditingContact(prev => ({ ...prev, name: val }))}
          />

          <Text style={styles.label}>Phone Number (SMS)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. +15550192831"
            placeholderTextColor="#475569"
            value={editingContact ? editingContact.phone : ''}
            onChangeText={(val) => setEditingContact(prev => ({ ...prev, phone: val }))}
          />

          <Text style={styles.label}>Email Address</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. contact@example.com"
            placeholderTextColor="#475569"
            value={editingContact ? editingContact.email : ''}
            onChangeText={(val) => setEditingContact(prev => ({ ...prev, email: val }))}
          />

          <Text style={styles.label}>WhatsApp Number</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. +15550192831"
            placeholderTextColor="#475569"
            value={editingContact ? editingContact.whatsapp : ''}
            onChangeText={(val) => setEditingContact(prev => ({ ...prev, whatsapp: val }))}
          />

          <Text style={styles.label}>WhatsApp Method</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
            {['NATIVE', 'CALLMEBOT', 'TWILIO'].map((method) => (
              <TouchableOpacity
                key={method}
                style={[
                  styles.segmentBtn,
                  editingContact && editingContact.whatsapp_method === method && styles.segmentBtnActive
                ]}
                onPress={() => setEditingContact(prev => ({ ...prev, whatsapp_method: method }))}
              >
                <Text style={[
                  styles.segmentBtnText,
                  editingContact && editingContact.whatsapp_method === method && styles.segmentBtnTextActive,
                  { fontSize: 10 }
                ]}>
                  {method === 'NATIVE' ? 'Native' : method === 'CALLMEBOT' ? 'CallMeBot' : 'Twilio'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {editingContact && editingContact.whatsapp_method === 'CALLMEBOT' && (
            <View>
              <Text style={styles.label}>CallMeBot API Key</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter bot key"
                placeholderTextColor="#475569"
                value={editingContact.callmebot_key || ''}
                onChangeText={(val) => setEditingContact(prev => ({ ...prev, callmebot_key: val }))}
              />
            </View>
          )}

          <Text style={styles.label}>Binding Message Template</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }} contentContainerStyle={{ paddingRight: 10 }}>
            <TouchableOpacity
              delayPressIn={0}
              style={[
                styles.segmentBtn,
                { paddingHorizontal: 12, minWidth: 100 },
                editingContact && editingContact.template_id === 0 && styles.segmentBtnActive
              ]}
              onPress={() => setEditingContact(prev => ({ ...prev, template_id: 0 }))}
            >
              <Text style={[
                styles.segmentBtnText,
                editingContact && editingContact.template_id === 0 && styles.segmentBtnTextActive
              ]}>
                Default
              </Text>
            </TouchableOpacity>
            {templates.map((temp) => (
              <TouchableOpacity
                delayPressIn={0}
                key={temp.id}
                style={[
                  styles.segmentBtn,
                  { paddingHorizontal: 12, minWidth: 100 },
                  editingContact && editingContact.template_id === temp.id && styles.segmentBtnActive
                ]}
                onPress={() => setEditingContact(prev => ({ ...prev, template_id: temp.id }))}
              >
                <Text style={[
                  styles.segmentBtnText,
                  editingContact && editingContact.template_id === temp.id && styles.segmentBtnTextActive
                ]}>
                  {temp.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <Text style={styles.label}>Selected Alert Channels</Text>
          <View style={[styles.rowBetween, { paddingVertical: 4 }]}>
            <Text style={{ color: '#F8FAFC', fontSize: 13 }}>Send SMS</Text>
            <Switch
              value={editingContact ? editingContact.sms_enabled === 1 : true}
              onValueChange={(val) => setEditingContact(prev => ({ ...prev, sms_enabled: val ? 1 : 0 }))}
            />
          </View>
          <View style={[styles.rowBetween, { paddingVertical: 4 }]}>
            <Text style={{ color: '#F8FAFC', fontSize: 13 }}>Send WhatsApp</Text>
            <Switch
              value={editingContact ? editingContact.whatsapp_enabled === 1 : true}
              onValueChange={(val) => setEditingContact(prev => ({ ...prev, whatsapp_enabled: val ? 1 : 0 }))}
            />
          </View>
          <View style={[styles.rowBetween, { paddingVertical: 4 }]}>
            <Text style={{ color: '#F8FAFC', fontSize: 13 }}>Send Email</Text>
            <Switch
              value={editingContact ? editingContact.email_enabled === 1 : true}
              onValueChange={(val) => setEditingContact(prev => ({ ...prev, email_enabled: val ? 1 : 0 }))}
            />
          </View>
        </ScrollView>

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
          <TouchableOpacity
            delayPressIn={0}
            style={[styles.bleDeviceConnectBtn, { borderColor: '#64748B' }]}
            onPress={() => {
              setShowContactModal(false);
              setEditingContact(null);
            }}
          >
            <Text style={[styles.bleDeviceConnectText, { color: '#64748B' }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            delayPressIn={0}
            style={[styles.bleDeviceConnectBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]}
            onPress={handleSaveContact}
          >
            <Text style={[styles.bleDeviceConnectText, { color: '#FFFFFF' }]}>Save</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}
