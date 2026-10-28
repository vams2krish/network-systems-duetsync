import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
const queue=ws=>{const messages=[];ws.on('message',data=>messages.push(JSON.parse(data)));return async type=>{const until=Date.now()+3000;while(Date.now()<until){const i=messages.findIndex(m=>m.type===type);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+type);};};
test('two peers share ordered playback, late join state, capacity and room cleanup',async()=>{
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'3099'}});const peers=[];
 try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 const page=await fetch('http://localhost:3099');assert.equal(page.status,200);assert.match(await page.text(),/DuetSync/);
 const open=async()=>{const ws=new WebSocket('ws://localhost:3099');peers.push(ws);const next=queue(ws);await new Promise(r=>ws.once('open',r));return {ws,next};};
 const a=await open();a.ws.send(JSON.stringify({type:'join'}));const joined=await a.next('joined');assert.match(joined.code,/^[a-f0-9]{12}$/);
 a.ws.send(JSON.stringify({type:'ping',sent:123}));const pong=await a.next('pong');assert.equal(pong.sent,123);assert.ok(pong.server>0);
 a.ws.send(JSON.stringify({type:'control',playing:true,position:12}));const first=await a.next('state');assert.equal(first.state.revision,1);
 const b=await open();b.ws.send(JSON.stringify({type:'join',code:joined.code}));assert.deepEqual((await b.next('joined')).state,first.state);
 b.ws.send(JSON.stringify({type:'control',playing:false,position:20}));assert.deepEqual((await a.next('state')).state,(await b.next('state')).state);
 const c=await open();c.ws.send(JSON.stringify({type:'join',code:joined.code}));assert.match((await c.next('error')).message,/two listeners/);
 a.ws.close();b.ws.close();await new Promise(r=>setTimeout(r,100));c.ws.send(JSON.stringify({type:'join',code:joined.code}));assert.equal((await c.next('joined')).state.revision,0);
 }finally{for(const ws of peers)ws.terminate();child.kill();}
});
