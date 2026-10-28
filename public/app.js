const $=id=>document.getElementById(id),audio=$('audio');
let ws,joined=false,state=null,offset=0,bestRTT=Infinity,objectURL,timer,lastRevision=-1;
const status=text=>$('status').textContent=text;
function connect(){ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);ws.onopen=()=>{$('connection').textContent='● Connected';ping();};ws.onclose=()=>{joined=false;$('connection').textContent='○ Disconnected';audio.pause();status('Connection lost. Reconnect and rejoin your room to continue.');};ws.onmessage=event=>{
 const m=JSON.parse(event.data);
 if(m.type==='pong'){const rtt=Date.now()-m.sent;if(rtt<bestRTT){bestRTT=rtt;offset=m.server-(m.sent+rtt/2);}$('latency').textContent=Math.round(rtt)+' ms';}
 if(m.type==='error')status(m.message);
 if(m.type==='joined'){joined=true;$('code').value=m.code;$('copy').hidden=false;lastRevision=-1;receive(m.state);status('Room ready. Share your invite and choose the same song.');}
 if(m.type==='presence')$('presence').textContent=m.count===2?'Your person is here. Make a moment.':'You’re here. Waiting for your person…';
 if(m.type==='state')receive(m.state);
};}
function ping(){if(ws.readyState===1)ws.send(JSON.stringify({type:'ping',sent:Date.now()}));}
function receive(s){if(s.revision<lastRevision)return;lastRevision=s.revision;state=s;clearTimeout(timer);timer=setTimeout(apply,Math.max(0,s.at-(Date.now()+offset)));}
function expected(){return Math.max(0,state.position+(state.playing?(Date.now()+offset-state.at)/1000:0));}
function apply(){if(!state||!audio.src||!Number.isFinite(audio.duration))return;const position=Math.min(audio.duration,expected());audio.currentTime=position;if(state.playing&&position<audio.duration)audio.play().catch(()=>status('Tap Play once to allow audio playback on this device.'));else audio.pause();}
function control(playing,position=audio.currentTime){if(!joined)return status('Create or join a room first.');if(!audio.src)return status('Choose the same audio file on both devices first.');ws.send(JSON.stringify({type:'control',playing,position}));}
$('create').onclick=()=>join('');$('join').onclick=()=>{if(!$('code').value.trim())return status('Enter your partner’s room code.');join($('code').value.trim());};
function join(code){if(ws.readyState!==1){connect();return status('Connecting. Try joining again in a moment.');}if(joined)return status('You are already in a room. Reload to join another.');ws.send(JSON.stringify({type:'join',code}));}
$('copy').onclick=async()=>{const url=new URL(location.href);url.searchParams.set('room',$('code').value);try{await navigator.clipboard.writeText(url.href);status('Invite copied. Send it to your person.');}catch{status('Share this room code: '+$('code').value);}};
$('file').onchange=()=>{const file=$('file').files[0];if(!file)return;audio.pause();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(file);audio.src=objectURL;$('title').textContent=file.name.replace(/\.[^.]+$/,'');$('subtitle').textContent='Local audio · Make sure your partner chose the same version';};
audio.onloadedmetadata=()=>{$('seek').max=audio.duration;$('duration').textContent=format(audio.duration);apply();};
$('play').onclick=()=>control(audio.paused);$('back').onclick=()=>control(!audio.paused,Math.max(0,audio.currentTime-10));$('forward').onclick=()=>control(!audio.paused,Math.min(audio.duration||0,audio.currentTime+10));$('seek').onchange=()=>control(!audio.paused,Number($('seek').value));
function format(n){return Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');}
audio.ontimeupdate=()=>{$('elapsed').textContent=format(audio.currentTime);$('seek').value=audio.currentTime;};audio.onplay=()=>$('play').textContent='Ⅱ';audio.onpause=()=>$('play').textContent='▶';audio.onerror=()=>status('This audio format could not be loaded. Try an MP3 or WAV file.');
setInterval(()=>{if(!state||!audio.src||!joined||!Number.isFinite(audio.duration))return;const drift=expected()-audio.currentTime;$('drift').textContent=Math.round(Math.abs(drift)*1000)+' ms';if(state.playing&&Date.now()+offset>=state.at&&!audio.paused&&expected()<audio.duration&&Math.abs(drift)>.15)audio.currentTime=Math.min(audio.duration,expected());},1000);
setInterval(ping,5000);const invite=new URL(location.href).searchParams.get('room');if(invite)$('code').value=invite;connect();
