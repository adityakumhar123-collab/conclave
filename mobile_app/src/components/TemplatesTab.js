import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import styles from './styles';

const TemplatesTab = React.memo(({
  templates,
  setEditingTemplate,
  setShowTemplateModal,
  handleDeleteTemplate
}) => {
  return (
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>📝 Message Templates</Text>
        <TouchableOpacity
          delayPressIn={0}
          style={[styles.bleDeviceConnectBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]}
          onPress={() => {
            setEditingTemplate({
              name: '',
              content: ''
            });
            setShowTemplateModal(true);
          }}
        >
          <Text style={[styles.bleDeviceConnectText, { color: '#FFFFFF' }]}>+ Create Template</Text>
        </TouchableOpacity>
      </View>

      {/* System Default Template (Read-Only) */}
      <View style={[styles.card, { borderColor: 'rgba(255,255,255,0.1)' }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.titleText, { fontSize: 15, color: '#94A3B8' }]}>System Default (Read-Only)</Text>
          <View style={[styles.notifyBadge, { backgroundColor: 'rgba(255,255,255,0.05)' }]}>
            <Text style={{ fontSize: 10, color: '#94A3B8' }}>SYSTEM</Text>
          </View>
        </View>
        <Text style={[styles.multiplierItem, { marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 11, color: '#CBD5E1', padding: 8, backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 6 }]}>
          🚨 SafeBand Alert: Physical emergency detected!{'\n'}
          Name: {"{name}"}{'\n'}
          Inference: {"{inference}"}{'\n'}
          Time: {"{time}"}{'\n'}
          Location: {"{maps_link}"} ({"{gps}"}){'\n'}
          Address: {"{address}"}{'\n'}
          Medical Info: {"{medical_info}"}{'\n'}
          {"{duress_flag}"}
        </Text>
      </View>

      {templates.map((temp) => (
        <View key={temp.id} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={[styles.titleText, { fontSize: 15 }]}>{temp.name}</Text>
            <View style={styles.row}>
              <TouchableOpacity
                delayPressIn={0}
                style={[styles.bleDeviceConnectBtn, { marginRight: 8 }]}
                onPress={() => {
                  setEditingTemplate({ ...temp });
                  setShowTemplateModal(true);
                }}
              >
                <Text style={styles.bleDeviceConnectText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                delayPressIn={0}
                style={[styles.bleDeviceConnectBtn, { borderColor: '#EF4444' }]}
                onPress={() => handleDeleteTemplate(temp.id, temp.name)}
              >
                <Text style={[styles.bleDeviceConnectText, { color: '#EF4444' }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={[styles.multiplierItem, { marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 11, color: '#94A3B8', padding: 8, backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 6 }]}>
            {temp.content}
          </Text>
        </View>
      ))}
    </View>
  );
});

export default TemplatesTab;
