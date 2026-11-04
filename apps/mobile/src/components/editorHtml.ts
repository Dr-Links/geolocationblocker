// The editor page that runs inside the composer's WebView. Kept free of React Native imports so it can be
// tested in a normal browser.
export function editorHtml(initialHtml: string, placeholder: string, dark: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
<style>body{margin:0;padding:12px;font-family:-apple-system,Roboto,sans-serif;font-size:16px;line-height:1.45;${dark ? 'background:#17212b;color:#e4e7eb;' : 'background:#fff;color:#1f2933;'}}
#e{min-height:220px;outline:none}#e:empty:before{content:attr(data-ph);color:#9aa5b1}img{max-width:100%;height:auto}a{color:#3b82f6}</style></head>
<body><div id="e" contenteditable="true" data-ph="${placeholder.replace(/"/g, '')}">${initialHtml}</div>
<script>
var e=document.getElementById('e');
function send(){if(typeof keep==='function')keep();window.ReactNativeWebView.postMessage(JSON.stringify({html:e.innerHTML,text:e.innerText}));}
e.addEventListener('input',send);
e.addEventListener('paste',function(ev){ev.preventDefault();var t=(ev.clipboardData||window.clipboardData).getData('text/plain');document.execCommand('insertText',false,t);});
e.addEventListener('drop',function(ev){ev.preventDefault();});
// Remember where the cursor was, so toolbar buttons (which take focus away) act at the right place.
var saved=null;
function keep(){var s=window.getSelection();if(s&&s.rangeCount&&e.contains(s.anchorNode))saved=s.getRangeAt(0).cloneRange();}
document.addEventListener('selectionchange',keep);
['input','keyup','mouseup','touchend'].forEach(function(n){e.addEventListener(n,keep);});
function restore(){e.focus();if(saved){var s=window.getSelection();s.removeAllRanges();s.addRange(saved);}}
window.cmd=function(c,a){restore();document.execCommand(c,false,a||null);
if(c==='insertUnorderedList'||c==='insertOrderedList'){var s=window.getSelection();var n=s&&s.anchorNode;while(n&&n!==e&&n.nodeName!=='LI')n=n.parentNode;
if(n&&n.nodeName==='LI'){var r=document.createRange();r.selectNodeContents(n);r.collapse(false);s.removeAllRanges();s.addRange(r);}}
send();};
window.addLink=function(u){if(!/^(https?:|mailto:)/i.test(u))return;restore();var s=window.getSelection();if(s&&s.isCollapsed){document.execCommand('insertHTML',false,'<a href="'+u.replace(/"/g,'%22')+'">'+u.replace(/</g,'&lt;')+'</a>');}else{document.execCommand('createLink',false,u);}send();};
window.addImage=function(d,id){restore();document.execCommand('insertHTML',false,'<img src="'+d+'" data-upload-id="'+id+'">');send();};
window.addText=function(t){restore();document.execCommand('insertText',false,t);send();};
send();
</script></body></html>`;
}
