import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createApp} from './lib/app.js';
import {MemoryStore} from './lib/store.js';
import {Rooms,hash} from './lib/rooms.js';
import {randomBytes} from 'node:crypto';
const token=()=>randomBytes(32).toString('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function inbox(ws){
 const messages=[];ws.on('message',data=>messages.push(JSON.parse(data)));
 return async(type,predicate=()=>true)=>{const until=Date.now()+4000;while(Date.now()<until){const i=messages.findIndex(m=>m.type===type&&predicate(m));if(i>=0)return messages.splice(i,1)[0];await sleep(5);}throw Error('Timed out waiting for '+type);};
}
async function fixture(t){
 const store=new MemoryStore(),apps=[createApp({store,pollMs:20,lead:100}),createApp({store,pollMs:20,lead:100})],peers=[];
 for(const app of apps)await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const p of peers)p.terminate();for(const app of apps)await app.close();});
 return {store,apps,async open(index=0,options){const url=`ws://127.0.0.1:${apps[index].server.address().port}/api/socket`;const ws=new WebSocket(url,options);peers.push(ws);const next=inbox(ws);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return {ws,next,send:m=>ws.send(JSON.stringify(m))};}};
}
const track={hash:'a'.repeat(64),duration:90};

test('real clients on separate server instances share readiness, revisions and playback',async t=>{
 const f=await fixture(t),a=await f.open(),b=await f.open(1);
 a.send({type:'join',token:token()});const joined=await a.next('joined');assert.match(joined.code,/^[a-f0-9]{32}$/);
 b.send({type:'join',code:joined.code,token:token()});await b.next('joined');
 a.send({type:'ping',sent:123});assert.equal((await a.next('pong')).sent,123);
 a.send({type:'control',playing:true,position:0,revision:0});assert.match((await a.next('error')).message,/matching/);
 a.send({type:'track',track});b.send({type:'track',track:{...track,hash:'b'.repeat(64)}});
 await a.next('snapshot',m=>m.room.members.every(p=>p.hasTrack));
 a.send({type:'ready',ready:true});b.send({type:'ready',ready:true});
 await b.next('snapshot',m=>m.room.members.every(p=>p.ready));
 b.send({type:'control',playing:true,position:0,revision:0});assert.match((await b.next('error')).message,/matching/);
 b.send({type:'track',track});await b.next('snapshot',m=>m.room.matching&&!m.room.canPlay);
 b.send({type:'ready',ready:true});const ready=await b.next('snapshot',m=>m.room.canPlay);
 a.send({type:'control',playing:true,position:12,revision:ready.room.state.revision});
 const playingA=await a.next('snapshot',m=>m.room.state.playing),playingB=await b.next('snapshot',m=>m.room.state.playing);
 assert.deepEqual(playingA.room.state,playingB.room.state);assert.equal(playingA.room.state.position,12);
 b.send({type:'control',playing:false,position:1,revision:ready.room.state.revision});assert.match((await b.next('error')).message,/changed/);
 b.send({type:'control',playing:false,position:20,revision:playingB.room.state.revision});
 assert.equal((await a.next('snapshot',m=>!m.room.state.playing&&m.room.state.position===20)).room.state.position,20);
 const c=await f.open();c.send({type:'join',code:joined.code,token:token()});assert.match((await c.next('error')).message,/two listeners/);
 a.send({type:'leave'});await a.next('left');assert.equal((await b.next('snapshot',m=>m.room.ended)).room.ended,true);
 c.send({type:'join',code:joined.code,token:token()});assert.match((await c.next('error')).message,/ended/);
 // A room can be created on the same socket after ending the previous room.
 a.send({type:'join',token:token()});await a.next('joined');
});

test('owner lock, reserved seat recovery, old-session rejection and private snapshots',async()=>{
 const store=new MemoryStore(),rooms=new Rooms(store),aToken=token(),bToken=token();
 const a=await rooms.join({token:aToken,connection:'a'});a.connection='a';
 await rooms.action(a,{type:'lock',locked:true});
 await assert.rejects(rooms.join({token:bToken,code:a.code,connection:'b'}),/locked/);
 await rooms.action(a,{type:'lock',locked:false});
 const b=await rooms.join({token:bToken,code:a.code,connection:'b'});b.connection='b';
 await assert.rejects(rooms.action(b,{type:'lock',locked:false}),/creator/);
 await rooms.action(b,{type:'disconnect'});
 const recovered=await rooms.join({token:bToken,code:a.code,connection:'new'});
 assert.equal(recovered.room.members.length,2);assert.equal(recovered.room.members.find(m=>m.id===b.id).ready,false);
 await assert.rejects(rooms.action(b,{type:'heartbeat'}),/replaced/);
 const snapshot=JSON.stringify(rooms.snapshot(recovered.room,a.id));
 assert.ok(!snapshot.includes(aToken)&&!snapshot.includes(hash(aToken))&&!snapshot.includes(bToken));
});

test('atomic compare-and-swap prevents simultaneous claims and stale updates',async()=>{
 const store=new MemoryStore(),rooms=new Rooms(store),a=await rooms.join({token:token(),connection:'a'});
 const results=await Promise.allSettled([rooms.join({token:token(),code:a.code,connection:'b'}),rooms.join({token:token(),code:a.code,connection:'c'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await store.load(a.key)).data.members.length,2);
});

test('expired rooms cannot be resurrected and unauthorized mutations fail',async()=>{
 const store=new MemoryStore(),rooms=new Rooms(store),a=await rooms.join({token:token(),connection:'a'});
 await assert.rejects(rooms.action({...a,connection:'attacker'},{type:'leave'}),/replaced/);
 store.rooms.get(a.key).expires=Date.now()-1;
 await assert.rejects(rooms.join({token:token(),code:a.code,connection:'b'}),/expired/);
});

test('HTTP hardening, origin checks, invalid JSON and payload bounds',async t=>{
 const f=await fixture(t),port=f.apps[0].server.address().port;
 const page=await fetch(`http://127.0.0.1:${port}`);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await fetch(`http://127.0.0.1:${port}/.env.local`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${port}`,{method:'POST'})).status,405);
 const bad=new WebSocket(`ws://127.0.0.1:${port}/api/socket`,{origin:'https://evil.example'});
 const rejected=await new Promise(r=>{bad.once('unexpected-response',(_,res)=>{res.resume();r(res.statusCode);});bad.once('error',()=>{});});assert.equal(rejected,403);bad.terminate();
 const a=await f.open();a.ws.send('not json');assert.match((await a.next('error')).message,/Invalid message/);
 const closed=new Promise(r=>a.ws.once('close',r));a.ws.send('x'.repeat(5000));assert.equal(await closed,1009);
});

test('fixed-window quotas bound repeated attempts',async()=>{
 const store=new MemoryStore();assert.equal(await store.limit('ip',2,60000),true);assert.equal(await store.limit('ip',2,60000),true);assert.equal(await store.limit('ip',2,60000),false);
});

test('readiness acknowledges the current file selection and rejects delayed readiness',async()=>{
 const rooms=new Rooms(new MemoryStore()),a=await rooms.join({token:token(),connection:'a'});a.connection='a';
 const first={...track,selection:'1'.repeat(32)},second={...track,selection:'2'.repeat(32)};
 await rooms.action(a,{type:'track',track:first});
 await rooms.action(a,{type:'ready',ready:true,selection:first.selection});
 await rooms.action(a,{type:'track',track:second});
 await assert.rejects(rooms.action(a,{type:'ready',ready:true,selection:first.selection}),/audio changed/);
 const updated=await rooms.action(a,{type:'ready',ready:true,selection:second.selection});
 assert.equal(rooms.snapshot(updated,a.id).members[0].selection,second.selection);
});
