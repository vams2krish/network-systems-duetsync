import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
const out=new URL('../dist/',import.meta.url);mkdirSync(out,{recursive:true});
const endpoint=process.env.DUET_SOCKET_URL || 'wss://wweuhpqsuwwcbgheckve.supabase.co/functions/v1/duet-sync';
if(new URL(endpoint).protocol!=='wss:')throw Error('Production WebSocket URL must use WSS');
let html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
html=html.replace('</head>',`<meta name="duet-socket" content="${endpoint.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></head>`);
writeFileSync(new URL('index.html',out),html);
for(const file of ['app.js','style.css','demo.wav','favicon.svg'])copyFileSync(new URL('../public/'+file,import.meta.url),new URL(file,out));
console.log('Built static frontend with a public WSS endpoint; no credentials included');
