import { FRAME_BRIDGE_SCRIPT, MAIL_LINK_SCRIPT } from '@app/shared';
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

/*
 * Web versions of the app's frames. Both are sandboxed iframes WITHOUT allow-same-origin: their content runs in
 * an opaque origin and can neither read the app (cookies, storage, DOM) nor navigate it. The app's CSP, which
 * these srcdoc documents inherit, allows only the fixed scripts listed by hash in @app/shared.
 */

const frameStyle = (style: StyleProp<ViewStyle>) => ({ border: 0, width: '100%', ...(StyleSheet.flatten(style) as object) });

type FrameMsg = { awm?: number; data?: unknown; link?: unknown };

function useFrameMessages(frame: React.RefObject<HTMLIFrameElement | null>, onMsg: (m: FrameMsg) => void) {
  const handler = useRef(onMsg);
  handler.current = onMsg;
  useEffect(() => {
    const listen = (ev: MessageEvent) => {
      // Only messages from our own frame (its origin is opaque, so the source window is what identifies it).
      if (!frame.current || ev.source !== frame.current.contentWindow) return;
      const m = ev.data as FrameMsg;
      if (m && m.awm === 1) handler.current(m);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [frame]);
}

export function MailFrame({ html, onLink, style }: { html: string; onLink(url: string): void; style?: StyleProp<ViewStyle> }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useFrameMessages(ref, (m) => { if (typeof m.link === 'string') onLink(m.link); });
  return createElement('iframe', {
    ref, title: 'Message', sandbox: 'allow-scripts', referrerPolicy: 'no-referrer',
    srcDoc: html, style: { ...frameStyle(style), flex: 1, height: '100%' },
  });
}

export interface EditorFrameHandle { call(fn: string, ...args: unknown[]): void }

export const EditorFrame = forwardRef<EditorFrameHandle, { html: string; onMessage(data: string): void; style?: StyleProp<ViewStyle> }>(
  function EditorFrame({ html, onMessage, style }, ref) {
    const frame = useRef<HTMLIFrameElement>(null);
    useFrameMessages(frame, (m) => { if (typeof m.data === 'string') onMessage(m.data); });
    useImperativeHandle(ref, () => ({
      call: (fn, ...args) => frame.current?.contentWindow?.postMessage({ awmCall: fn, args }, '*'),
    }));
    return createElement('iframe', { ref: frame, title: 'Message editor', sandbox: 'allow-scripts', srcDoc: html, style: frameStyle(style) });
  });

/** Extra scripts the web frames need (allowed by the CSP hashes). */
export const FRAME_EXTRAS = { editorBridge: FRAME_BRIDGE_SCRIPT, mailLink: MAIL_LINK_SCRIPT };
