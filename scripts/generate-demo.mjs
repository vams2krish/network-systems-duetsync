import {writeFileSync} from 'node:fs';
// Original procedural ambient melody, CC0. No third-party music or samples.
const rate=22050, seconds=90, n=rate*seconds, buffer=Buffer.alloc(44+n*2);
buffer.write('RIFF');buffer.writeUInt32LE(36+n*2,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(n*2,40);
const notes=[261.626,329.628,391.995,493.883,440,391.995,329.628,293.665];
for(let i=0;i<n;i++){
 const t=i/rate, beat=t%0.75, f=notes[Math.floor(t/.75)%notes.length];
 const env=Math.exp(-beat*3)*(1-Math.exp(-beat*60));
 const melody=(Math.sin(2*Math.PI*f*t)+.2*Math.sin(2*Math.PI*f*2*t))*.13*env;
 const pad=(Math.sin(2*Math.PI*130.813*t)+Math.sin(2*Math.PI*195.998*t))*.035;
 const fade=Math.min(1,t/3,(seconds-t)/4);
 buffer.writeInt16LE(Math.round((melody+pad)*fade*32767),44+i*2);
}
writeFileSync(new URL('../public/demo.wav',import.meta.url),buffer);
console.log('Generated 90 seconds of original demo audio');
