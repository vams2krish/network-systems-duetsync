const $ = id => document.getElementById(id);
const audio = $('audio');
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key,value) { try { sessionStorage.setItem(key,value); } catch {} },
  remove(key) { try { sessionStorage.removeItem(key); } catch {} },
};
const token = storage.get('duet.token') || Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
storage.set('duet.token',token);
let ws, joined=false, room=null, state=null, objectURL, track=null, timer, retryTimer;
let code=storage.get('duet.room') || '', offset=0, bestRTT=Infinity, retry=0, lastRevision=-1, lastPong=0;
let reconnect=true, loading=false, clockSamples=0, fileGeneration=0, commandsPending=false;
const status = text => $('status').textContent=text;
const now = () => Date.now()+offset;
const format = n => `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
const invite = new URLSearchParams(location.hash.slice(1)).get('room') || new URL(location.href).searchParams.get('room');
if(invite && /^[a-f0-9]{32}$/.test(invite)) { if(invite!==code) code=''; $('code').value=invite; }
// Room invitations stay in the fragment, so they are not sent in HTTP requests or referrers.
if(location.search) history.replaceState(null,'',location.pathname+location.hash);
function send(message){if(ws?.readyState===WebSocket.OPEN) {ws.send(JSON.stringify(message));return true;}return false;}
function render(){
  $('create').hidden=joined; $('join-fields').hidden=joined; $('room-actions').hidden=!joined;
  $('create').disabled=ws?.readyState!==WebSocket.OPEN; $('join').disabled=$('create').disabled;
  $('copy').disabled=!joined; $('lock').hidden=!room?.owner;
  $('lock').textContent=room?.locked?'Unlock room':'Lock room'; $('leave').textContent=room?.owner?'End our room':'Leave room';
  const me=room?.members.find(m=>m.you), partner=room?.members.find(m=>!m.you);
  $('presence').textContent=!joined?'Create a room to get closer.':partner?.online?'Your person is here. Make a moment.':partner?'Your person is reconnecting…':'You’re here. Waiting for your person…';
  const confirmed=!!track && me?.selection===track.selection;
  const canPlay=joined && room?.canPlay && confirmed && clockSamples>0 && !commandsPending;
  for(const id of ['play','back','forward','seek'])$(id).disabled=!canPlay;
  $('ready').disabled=!joined || !confirmed || loading;
  $('ready').textContent=me?.ready?'✓ Ready · tap to unready':"I'm ready to listen";
  $('ready').classList.toggle('is-ready',!!me?.ready);
  const chips=$('readiness');chips.replaceChildren();
  for(const [label,m] of [['You',me],['Partner',partner]]){
    const el=document.createElement('span');
    el.textContent=`${label} · ${!m?'waiting':!m.online?'offline':m.ready?'ready':m.hasTrack?'audio selected':'choose audio'}`;
    if(m?.ready&&m.online)el.className='good';else if(m&&!m.online)el.className='warn';chips.append(el);
  }
  $('match').textContent=!joined?'Create or join a room to listen together.':room?.matching?'✓ Same audio verified on both devices':me?.hasTrack&&partner?.hasTrack?'Audio doesn’t match. Choose the same file or both use the demo.':'Pick the same audio on both devices.';
  $('live').textContent=room?.canPlay?'● READY TOGETHER':joined?'● ROOM CONNECTED':'○ YOUR MOMENT AWAITS';
}
function expected(){return Math.max(0,state.position+(state.playing?Math.max(0,now()-state.at)/1000:0));}
function apply(){
  if(!joined||!state||!track||!Number.isFinite(audio.duration))return;
  if(now()<state.at){clearTimeout(timer);timer=setTimeout(apply,state.at-now());return;}
  if(state.playing&&(!room?.canPlay || room?.members.find(m=>m.you)?.selection!==track.selection)){audio.pause();return;}
  const position=Math.min(audio.duration,expected());audio.currentTime=position;
  audio.playbackRate=1;
  if(state.playing&&position<audio.duration)audio.play().catch(()=>{status('Tap Ready again on this device to enable audio.');send({type:'ready',ready:false,selection:track.selection});});
  else audio.pause();
}
function receive(snapshot){
  room=snapshot; commandsPending=false;
  if(snapshot.ended){resetRoom();status('This room has ended or expired. Create another moment together.');return;}
  if(!snapshot.canPlay && state?.playing)audio.pause();
  if(snapshot.state.revision>lastRevision){
    state=snapshot.state;lastRevision=state.revision;clearTimeout(timer);
    timer=setTimeout(apply,Math.max(0,state.at-now()));
  }
  render();
}
function resetRoom(){
  clearTimeout(timer);audio.pause();audio.playbackRate=1;joined=false;room=null;state=null;lastRevision=-1;code='';storage.remove('duet.room');$('code').value='';history.replaceState(null,'',location.pathname);render();
}
function ping(){send({type:'ping',sent:Date.now()});}
async function connect(){
  if(!reconnect)return;
  clearTimeout(retryTimer);$('connection').textContent=retry?'Reconnecting…':'Connecting…';render();
  const endpoint = document.querySelector('meta[name="duet-socket"]')?.content;
  ws=new WebSocket(endpoint || `${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/socket`);
  ws.onopen=()=>{retry=0;bestRTT=Infinity;clockSamples=0;lastPong=Date.now();$('connection').textContent='● Connected';ping();setTimeout(ping,200);setTimeout(ping,500);render();if(code)send({type:'join',code,token});};
  ws.onmessage=event=>{
    const m=JSON.parse(event.data);
    if(m.type==='check'){ping();if(joined)send({type:'heartbeat'});}
    if(m.type==='pong'){
      lastPong=Date.now();const rtt=Date.now()-m.sent;
      if(rtt<bestRTT){bestRTT=rtt;offset=m.server-(m.sent+rtt/2);}
      clockSamples++;$('latency').textContent=Math.round(rtt)+' ms';render();
    }
    if(m.type==='joined'){
      code=m.code;storage.set('duet.room',code);joined=true;lastRevision=-1;$('code').value=code;receive(m.room);
      if(track)send({type:'track',track});
      status('Your room is ready. Share the invite, choose matching audio, then both tap Ready.');
    }
    if(m.type==='snapshot')receive(m.room);
    if(m.type==='left'){resetRoom();status('You left the room.');}
    if(m.type==='replaced'){reconnect=false;resetRoom();status('This listening session was opened elsewhere. Reload to reconnect here.');}
    if(m.type==='unavailable'){audio.pause();status('Room storage is temporarily unavailable. Playback paused.');}
    if(m.type==='error'){commandsPending=false;render();status(m.message);if(!joined&&code&&/expired|ended|replaced/.test(m.message))resetRoom();}
  };
  ws.onerror=()=>status('Unable to reach your room. Checking the connection…');
  ws.onclose=event=>{
    clearTimeout(timer);joined=false;room=null;audio.pause();audio.playbackRate=1;commandsPending=false;
    $('connection').textContent='○ Disconnected';render();
    if(event.code===4001)reconnect=false;
    if(reconnect){const delay=Math.min(30000,750*2**retry++)+Math.random()*300;status('Connection interrupted. Reconnecting to your reserved seat…');retryTimer=setTimeout(connect,delay);}
  };
}
function join(value){
  if(joined)return;
  if(value&&!/^[a-f0-9]{32}$/.test(value))return status('Paste the complete 32-character invitation code.');
  if(!send({type:'join',code:value,token}))return status('Waiting for a connection. Try again in a moment.');
  $('create').disabled=true;$('join').disabled=true;
}
function control(playing,position){
  if(!room?.canPlay||!track)return status('Both listeners need matching audio and must tap Ready.');
  const intent=position===undefined?'toggle':'seek';
  position=Math.max(0,Math.min(audio.duration,position??audio.currentTime));
  if(send({type:'control',playing,position,intent,revision:state.revision})){
    commandsPending=true;render();status(playing?'Starting together…':'Pausing together…');
    setTimeout(()=>{commandsPending=false;render();},3000);
  }
}
async function loadAudio(file,name){
  const generation=++fileGeneration;
  if(file.size>100*1024*1024)return status('Choose an audio file smaller than 100 MB.');
  loading=true;track=null;audio.pause();render();send({type:'track',track:null});status('Checking your audio fingerprint…');
  try{
    const bytes=await file.arrayBuffer();
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    if(generation!==fileGeneration)return;
    const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(objectURL)URL.revokeObjectURL(objectURL);
    objectURL=URL.createObjectURL(file);audio.src=objectURL;
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{cleanup();reject(Error('Audio metadata timed out.'));},15000);
      const cleanup=()=>{clearTimeout(timeout);audio.removeEventListener('loadedmetadata',loaded);audio.removeEventListener('error',failed);};
      const loaded=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(Error('This audio format could not be loaded. Try MP3 or WAV.'));};
      audio.addEventListener('loadedmetadata',loaded);audio.addEventListener('error',failed);
    });
    if(generation!==fileGeneration)return;
    if(!Number.isFinite(audio.duration)||audio.duration<=0||audio.duration>86400)throw Error('Choose a playable audio file under 24 hours.');
    track={hash:fingerprint,duration:audio.duration,selection:crypto.randomUUID().replaceAll('-','')};
    $('title').textContent=name;$('subtitle').textContent='Audio stays local · SHA-256 matching enabled';
    $('seek').max=audio.duration;$('duration').textContent=format(audio.duration);$('elapsed').textContent='0:00';
    if(joined)send({type:'track',track});
    status('Audio selected. Both listeners can tap Ready when their files match.');
  }catch(error){status(error.message);track=null;}finally{loading=false;render();}
}
$('create').onclick=()=>join('');$('join').onclick=()=>join($('code').value.trim().toLowerCase());
$('code').addEventListener('keydown',e=>{if(e.key==='Enter')$('join').click();});
$('copy').onclick=async()=>{const url=new URL(location.origin+location.pathname);url.hash='room='+code;try{await navigator.clipboard.writeText(url.href);status('Invitation copied. Send it to your person.');}catch{status('Copy this invitation code: '+code);}};
$('lock').onclick=()=>send({type:'lock',locked:!room.locked});
$('leave').onclick=()=>send({type:'leave'});
$('choose').onclick=()=>$('file').click();
$('file').onchange=()=>{const file=$('file').files[0];if(file)loadAudio(file,file.name.replace(/\.[^.]+$/,''));};
$('demo').onclick=async()=>{if(loading)return;try{status('Loading your shared demo song…');const response=await fetch('/demo.wav');if(!response.ok)throw Error('Demo song unavailable. Try again.');await loadAudio(await response.blob(),'A Little Closer');}catch(error){status(error.message);}};
$('ready').onclick=async()=>{
  const me=room?.members.find(m=>m.you);if(!track)return;
  if(me?.selection!==track.selection)return;
  if(me?.ready){send({type:'ready',ready:false,selection:track.selection});return;}
  // Unlock media inside the user's gesture, then stop until the shared start time.
  const position=audio.currentTime;audio.muted=true;
  try{await audio.play();audio.pause();audio.currentTime=position;send({type:'ready',ready:true,selection:track.selection});status('You’re ready. When your person is ready too, press Play.');}
  catch{status('Your browser blocked playback. Tap Ready again.');}
  finally{audio.muted=false;}
};
$('play').onclick=()=>control(!state?.playing);$('back').onclick=()=>control(!!state?.playing,audio.currentTime-10);$('forward').onclick=()=>control(!!state?.playing,audio.currentTime+10);$('seek').onchange=()=>control(!!state?.playing,Number($('seek').value));
audio.ontimeupdate=()=>{$('elapsed').textContent=format(audio.currentTime);if(document.activeElement!==$('seek'))$('seek').value=audio.currentTime;};
audio.onplay=()=>{$('play').textContent='Ⅱ';$('play').setAttribute('aria-label','Pause together');document.querySelector('.disc').classList.add('spinning');};
audio.onpause=()=>{$('play').textContent='▶';$('play').setAttribute('aria-label','Play together');document.querySelector('.disc').classList.remove('spinning');};
audio.onended=()=>{audio.playbackRate=1;if(room?.canPlay&&state?.playing)control(false,audio.duration);};
setInterval(()=>{
  if(!joined||!state||!track||!Number.isFinite(audio.duration))return;
  if(!room?.canPlay){audio.pause();return;}
  const drift=expected()-audio.currentTime;$('drift').textContent=Math.round(Math.abs(drift)*1000)+' ms';
  if(state.playing&&now()>=state.at&&!audio.paused&&expected()<audio.duration){
    if(Math.abs(drift)>.25){audio.currentTime=Math.min(audio.duration,expected());audio.playbackRate=1;}
    else audio.playbackRate=Math.abs(drift)>.04?Math.max(.97,Math.min(1.03,1+drift*.15)):1;
  }
},500);
setInterval(()=>{ping();if(joined)send({type:'heartbeat'});if(ws?.readyState===WebSocket.OPEN&&Date.now()-lastPong>20000)ws.close(4000,'Heartbeat timeout');},5000);
window.addEventListener('online',()=>{if(ws?.readyState===WebSocket.CLOSED&&reconnect)connect();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){ping();if(joined)send({type:'heartbeat'});if(state)apply();}});
render();connect();
