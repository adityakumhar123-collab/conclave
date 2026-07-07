import React from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Animated,
  Platform
} from 'react-native';
import styles from './styles';

export default function TemplateFormModal({
  showTemplateModal,
  setShowTemplateModal,
  editingTemplate,
  setEditingTemplate,
  handleSaveTemplate,
  templateSelection,
  setTemplateSelection,
  keyboardOffset
}) {
  if (!showTemplateModal) return null;

  // Helper to handle Tag clicks in template editor
  const handleInsertTag = (tag) => {
    if (!editingTemplate) return;
    const currentContent = editingTemplate.content || '';
    const start = templateSelection.start;
    const end = templateSelection.end;
    const newContent = currentContent.substring(0, start) + tag + currentContent.substring(end);
    setEditingTemplate({
      ...editingTemplate,
      content: newContent
    });
    // Reposition cursor right after the tag
    const newCursorPos = start + tag.length;
    setTemplateSelection({ start: newCursorPos, end: newCursorPos });
  };

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
        <ScrollView showsVerticalScrollIndicator={false} style={{ width: '100%' }}>
          <Text style={styles.modalTitle}>
            {editingTemplate && editingTemplate.id ? '📝 Edit Custom Template' : '📝 Create Custom Template'}
          </Text>

          <Text style={styles.label}>Template Name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Minimalist Text Alert"
            placeholderTextColor="#475569"
            value={editingTemplate ? editingTemplate.name : ''}
            onChangeText={(val) => setEditingTemplate(prev => ({ ...prev, name: val }))}
          />

          <Text style={styles.label}>Tap to Insert Incident Tags</Text>
          <View style={styles.chipContainer}>
            {[
              { tag: '{name}', label: '👤 Name' },
              { tag: '{gps}', label: '📍 GPS' },
              { tag: '{maps_link}', label: '🗺️ Maps' },
              { tag: '{address}', label: '🏠 Address' },
              { tag: '{inference}', label: '⚡ Sensor' },
              { tag: '{time}', label: '⏰ Time' },
              { tag: '{medical_info}', label: '⚕️ Meds' },
              { tag: '{duress_flag}', label: '⚠️ Duress' },
            ].map(({ tag, label }) => (
              <TouchableOpacity
                delayPressIn={0}
                key={tag}
                style={styles.tagChip}
                onPress={() => handleInsertTag(tag)}
              >
                <Text style={styles.tagChipText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Message Body</Text>
          <TextInput
            style={[styles.input, { height: 120, textAlignVertical: 'top' }]}
            placeholder="Write your emergency message here..."
            placeholderTextColor="#475569"
            multiline
            onSelectionChange={(e) => setTemplateSelection(e.nativeEvent.selection)}
            value={editingTemplate ? editingTemplate.content : ''}
            onChangeText={(val) => setEditingTemplate(prev => ({ ...prev, content: val }))}
          />

          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <TouchableOpacity
              delayPressIn={0}
              style={[styles.bleDeviceConnectBtn, { borderColor: '#64748B' }]}
              onPress={() => {
                setShowTemplateModal(false);
                setEditingTemplate(null);
              }}
            >
              <Text style={[styles.bleDeviceConnectText, { color: '#64748B' }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              delayPressIn={0}
              style={[styles.bleDeviceConnectBtn, { backgroundColor: '#10B981', borderColor: '#10B981' }]}
              onPress={handleSaveTemplate}
            >
              <Text style={[styles.bleDeviceConnectText, { color: '#FFFFFF' }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}
