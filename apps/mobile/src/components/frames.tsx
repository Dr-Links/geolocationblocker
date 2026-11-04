import { forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewProps } from 'react-native-webview/lib/WebView';
import type { ShouldStartLoadRequest, WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

// The WebView forwards a ref with injectJavaScript() on Android and iOS; the shared type declaration omits it.
interface WebViewHandle { injectJavaScript(js: string): void }
const RefWebView = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

/** A received email (already sanitised): scripts off, nothing loads except what its own CSP allows; links go to onLink. */
export function MailFrame({ html, onLink, style }: { html: string; onLink(url: string): void; style?: StyleProp<ViewStyle> }) {
  return (
    <WebView
      style={style}
      originWhitelist={['about:*']}
      source={{ html }}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(req: ShouldStartLoadRequest) => {
        if (req.url.startsWith('about:')) return true;
        onLink(req.url);
        return false;
      }}
    />
  );
}

export interface EditorFrameHandle { call(fn: string, ...args: unknown[]): void }

/** The composer's editor page. Only the page's own script runs; it cannot navigate anywhere. */
export const EditorFrame = forwardRef<EditorFrameHandle, { html: string; onMessage(data: string): void; style?: StyleProp<ViewStyle> }>(
  function EditorFrame({ html, onMessage, style }, ref) {
    const web = useRef<WebViewHandle>(null);
    useImperativeHandle(ref, () => ({
      call: (fn, ...args) => web.current?.injectJavaScript(`${fn}(${args.map((a) => JSON.stringify(a)).join(',')});true;`),
    }));
    return (
      <RefWebView
        ref={web}
        style={style}
        originWhitelist={['about:*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(r: ShouldStartLoadRequest) => r.url.startsWith('about:')}
        onMessage={(ev: WebViewMessageEvent) => onMessage(ev.nativeEvent.data)}
      />
    );
  });

/** Native builds add nothing to the frame documents. */
export const FRAME_EXTRAS = { editorBridge: '', mailLink: '' };
