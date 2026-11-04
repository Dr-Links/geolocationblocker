import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { editorHtml } from './editorHtml';
import { EditorFrame, FRAME_EXTRAS, type EditorFrameHandle } from './frames';
import { Button, Field, useTheme } from './ui';

export interface RichEditorHandle {
  insertImage(dataUrl: string, uploadId: string): void;
  insertText(text: string): void;
}

/**
 * Rich-text email editor: a contenteditable page in a WebView. It only runs its own inline script, cannot
 * navigate anywhere, and pastes as plain text (no foreign HTML or scripts enter the message).
 */
export const RichEditor = forwardRef<RichEditorHandle, { initialHtml: string; onChange(html: string, text: string): void; placeholder?: string }>(
  function RichEditor({ initialHtml, onChange, placeholder }, ref) {
    const t = useTheme();
    const web = useRef<EditorFrameHandle>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [link, setLink] = useState('https://');
    const dark = t.bg === '#0f1720';
    // Rendered once; later updates are pushed with injectJavaScript so the cursor is not lost.
    const html = useMemo(() => editorHtml(initialHtml, placeholder ?? 'Write your message…', dark, FRAME_EXTRAS.editorBridge), []); // eslint-disable-line react-hooks/exhaustive-deps

    const run = (fn: string, ...args: unknown[]) => web.current?.call(fn, ...args);
    useImperativeHandle(ref, () => ({
      insertImage: (dataUrl, id) => run('addImage', dataUrl, id),
      insertText: (text) => run('addText', text),
    }));

    const tool = (label: string, args: unknown[], a11y: string) => (
      <Pressable key={a11y} accessibilityRole="button" accessibilityLabel={a11y} onPress={() => run('cmd', ...args)} style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8, overflow: 'hidden' }}>
        <ScrollView horizontal keyboardShouldPersistTaps="always" style={{ backgroundColor: t.bg, borderBottomWidth: 1, borderColor: t.border }}>
          {tool('B', ['bold'], 'Bold')}
          {tool('I', ['italic'], 'Italic')}
          {tool('U', ['underline'], 'Underline')}
          {tool('•', ['insertUnorderedList'], 'Bulleted list')}
          {tool('1.', ['insertOrderedList'], 'Numbered list')}
          {tool('A-', ['fontSize', '2'], 'Smaller text')}
          {tool('A', ['fontSize', '3'], 'Normal text')}
          {tool('A+', ['fontSize', '5'], 'Larger text')}
          <Pressable accessibilityRole="button" accessibilityLabel="Insert link" onPress={() => setLinkOpen(true)} style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
            <Text style={{ color: t.primary, fontWeight: '700' }}>Link</Text>
          </Pressable>
          {tool('⌫', ['removeFormat'], 'Clear formatting')}
        </ScrollView>
        <EditorFrame
          ref={web}
          style={{ height: 260, backgroundColor: t.surface }}
          html={html}
          onMessage={(data) => {
            try {
              const m = JSON.parse(data) as { html: string; text: string };
              onChange(m.html, m.text);
            } catch {
              // ignore malformed messages
            }
          }}
        />
        <Modal visible={linkOpen} transparent animationType="fade" onRequestClose={() => setLinkOpen(false)}>
          <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0007' }}>
            <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: 16 }}>
              <Field label="Link address" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Button title="Insert link" disabled={!/^(https?:\/\/\S+|mailto:\S+)$/i.test(link)} onPress={() => { run('addLink', link); setLinkOpen(false); setLink('https://'); }} />
              <Button title="Cancel" variant="link" onPress={() => setLinkOpen(false)} />
            </View>
          </View>
        </Modal>
      </View>
    );
  });
