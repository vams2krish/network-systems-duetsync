import {randomBytes} from 'node:crypto';
import {Rooms, RoomError, LEASE_MS} from './rooms.js';

export function createHub({store,lead=1200,pollMs=400}) {
  const rooms=new Rooms(store,{lead});
  const sessions=new Map(),refreshing=new Map(),clients=new Set();
  const send = (ws, value) => {
    if (ws.readyState === 1 && ws.bufferedAmount < 65536) ws.send(JSON.stringify(value));
    else if (ws.bufferedAmount >= 65536) ws.close(1008,'Slow consumer');
  };
  function log(event) { console.log(JSON.stringify({event, at:new Date().toISOString()})); }
  async function refresh(key) {
    if (refreshing.has(key)) return refreshing.get(key);
    const work = (async () => {
      let row = await store.load(key);
      let room = row?.data;
      if (room?.state.playing && room.members.some(m => Date.now()-m.lastSeen >= LEASE_MS)) {
        await rooms.mutate(key, current => {
          if (!current) throw new RoomError('Room expired.');
          if (current.state.playing && current.members.some(m => Date.now()-m.lastSeen >= LEASE_MS)) {
            for (const m of current.members) if (Date.now()-m.lastSeen >= LEASE_MS) m.ready=false;
            rooms.pause(current);
          }
          return current;
        });
        row = await store.load(key); room = row?.data;
      }
      for (const [ws,s] of sessions) if (s.key === key) {
        const member = room?.members.find(m=>m.id===s.id);
        if (member && member.connection !== s.connection) { send(ws,{type:'replaced'}); ws.close(4001,'Session replaced'); continue; }
        const snapshot = rooms.snapshot(room,s.id);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== s.last) { s.last=serialized; send(ws,{type:'snapshot',room:snapshot}); }
        if (snapshot.ended) sessions.delete(ws);
      }
    })().finally(()=>refreshing.delete(key));
    refreshing.set(key,work); return work;
  }
  function accept(ws,ipKey){
    clients.add(ws); ws.on('close',()=>clients.delete(ws));
    let session, queue=Promise.resolve(), queued=0, count=0, window=Date.now();
    let heartbeatAt=0;
    const joinDeadline=setTimeout(()=>{if(!session)ws.close(4008,'Join timeout');},15000);
    joinDeadline.unref?.();
    ws.alive=true;
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('error',()=>log('socket_error'));
    ws.on('message',raw=>{
      ws.alive=true;
      if((typeof raw==='string'?new TextEncoder().encode(raw).length:raw.byteLength)>4096){ws.close(1009,'Payload too large');return;}
      if (Date.now()-window>10000) {count=0; window=Date.now();}
      if (++count>35 || queued>=8) {ws.close(1008,'Too many messages'); return;}
      queued++;
      queue=queue.then(async()=>{
        const m=JSON.parse(raw);
        if (session && !sessions.has(ws)) session=null;
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new RoomError('Invalid message.');
        if (m.type==='ping') {if(Number.isFinite(m.sent))send(ws,{type:'pong',sent:m.sent,server:Date.now()}); return;}
        if (m.type==='join') {
          if(session)throw new RoomError('Leave this room before joining another.');
          if (!await store.limit(`join:${ipKey}`,30,60000)) throw new RoomError('Too many room attempts. Try again in a minute.');
          if (!m.code && !await store.limit(`create:${ipKey}`,10,3600000)) throw new RoomError('Room creation limit reached. Try again later.');
          const connection=randomBytes(16).toString('hex');
          const result=await rooms.join({code:m.code,token:m.token,connection});
          session={...result,connection,last:null};
          delete session.room;
          sessions.set(ws,session);
          clearTimeout(joinDeadline);
          send(ws,{type:'joined',code:result.code,room:rooms.snapshot(result.room,result.id)});
          await refresh(session.key); return;
        }
        if(!session)throw new RoomError('Join a room first.');
        if(m.type==='heartbeat'){
          if(Date.now()-heartbeatAt<4000)return;
          heartbeatAt=Date.now();
        } else if(!await store.limit(`action:${session.id}`,120,60000)) throw new RoomError('Slow down and try again.');
        if(!['heartbeat','track','ready','control','lock','leave'].includes(m.type))throw new RoomError('Unknown action.');
        await rooms.action(session,m);
        await refresh(session.key);
        if(m.type==='leave'){sessions.delete(ws);session=null;send(ws,{type:'left'});}
      }).catch(error=>{
        if(!(error instanceof RoomError) && !(error instanceof SyntaxError))log('room_storage_error');
        send(ws,{type:'error',message:error instanceof RoomError ? error.message : error instanceof SyntaxError ? 'Invalid message.' : 'Connection to room storage interrupted. Please try again.'});
      }).finally(()=>queued--);
    });
    ws.on('close',()=>{
      clearTimeout(joinDeadline);
      // Wait for an in-flight join/control before marking this exact connection offline.
      queue.finally(async()=>{
        sessions.delete(ws);
        if(session)try{await rooms.action(session,{type:'disconnect'});await refresh(session.key);}catch{}
      });
    });
  }
  let polling=false;
  const poll=setInterval(async()=>{
    if(polling || !sessions.size)return;
    polling=true;
    try { await Promise.all([...new Set([...sessions.values()].map(s=>s.key))].map(refresh)); }
    catch { log('snapshot_storage_error'); for(const ws of sessions.keys())send(ws,{type:'unavailable'}); }
    finally{polling=false;}
  },pollMs);
  const heartbeat=setInterval(()=>{
    for(const ws of clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}
  },10000);
  poll.unref?.();heartbeat.unref?.();
  function stop(){clearInterval(poll);clearInterval(heartbeat);for(const ws of clients)ws.close(1001,'Server restarting');}
  return {rooms,clients,accept,stop,log};
}
