// The editor page that runs inside the composer's WebView. Kept free of React Native imports so it can be
// tested in a normal browser.
import { EDITOR_SCRIPT } from '@app/shared';
export function editorHtml(initialHtml: string, placeholder: string, dark: boolean, extraScript = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<style>body{margin:0;padding:12px;font-family:-apple-system,Roboto,sans-serif;font-size:16px;line-height:1.45;${dark ? 'background:#17212b;color:#e4e7eb;' : 'background:#fff;color:#1f2933;'}}
#e{min-height:220px;outline:none}#e:empty:before{content:attr(data-ph);color:#9aa5b1}img{max-width:100%;height:auto}a{color:#3b82f6}</style></head>
<body><div id="e" contenteditable="true" data-ph="${placeholder.replace(/"/g, '')}">${initialHtml}</div>
${extraScript ? `<script>${extraScript}</script>` : ''}<script>${EDITOR_SCRIPT}</script></body></html>`;
}
