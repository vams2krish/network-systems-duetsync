import {createHash, randomBytes} from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const LEASE_MS = 20000;
const ROOM_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
export const tokenPattern = /^[a-f0-9]{64}$/;
export const codePattern = /^[a-f0-9]{32}$/;
export class RoomError extends Error {}

export class Rooms {
  constructor(store, {lead = 1200} = {}) { this.store = store; this.lead = lead; }
  async mutate(key, update) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.store.load(key);
      const result = update(row?.data ?? null);
      if (await this.store.save(key, row?.version ?? 0, result, Math.min(result.created + ROOM_MS, result.touched + IDLE_MS))) return result;
    }
    throw new RoomError('Room is busy. Try again.');
  }
  async join({code, token, connection}) {
    if (!tokenPattern.test(token || '')) throw new RoomError('Invalid listener session.');
    const id = hash(token), creating = !code;
    if (!creating && !codePattern.test(code)) throw new RoomError('Use the complete invitation code.');
    code ||= randomBytes(16).toString('hex');
    const key = hash(code);
    const room = await this.mutate(key, current => {
      const now = Date.now();
      if (!current && !creating) throw new RoomError('This room has ended or expired. Create a new one.');
      const room = current || {created: now, touched: now, owner: id, locked: false, ended: false, members: [], state: {playing: false, position: 0, at: now, revision: 0}};
      if (room.ended) throw new RoomError('This room has ended.');
      let member = room.members.find(m => m.id === id);
      if (!member) {
        if (room.members.length >= 2) throw new RoomError('This room already has two listeners.');
        if (room.locked) throw new RoomError('This room is locked. Ask your partner to unlock it.');
        member = {id, track: null, ready: false, lastSeen: now, connection};
        room.members.push(member);
      }
      member.connection = connection;
      member.lastSeen = now;
      member.ready = false;
      this.pause(room);
      room.touched = now;
      if (room.members.length === 2) room.locked = true;
      return room;
    });
    return {code, key, id, room};
  }
  pause(room) {
    const s = room.state;
    const duration = room.members.find(m => m.track)?.track.duration ?? 86400;
    room.state = {playing: false, position: Math.min(duration, s.position + (s.playing ? Math.max(0, Date.now() - s.at) / 1000 : 0)), at: Date.now(), revision: s.revision + 1};
  }
  matching(room) {
    const [a, b] = room.members;
    return !!(a?.track && b?.track && a.track.hash === b.track.hash && Math.abs(a.track.duration - b.track.duration) < .1);
  }
  ready(room) {
    return this.matching(room) && room.members.every(m => m.ready && Date.now() - m.lastSeen < LEASE_MS);
  }
  async action(session, message) {
    return this.mutate(session.key, room => {
      if (!room || room.ended) throw new RoomError('This room has ended or expired.');
      const member = room.members.find(m => m.id === session.id);
      if (!member || member.connection !== session.connection) throw new RoomError('This listener session was replaced.');
      const now = Date.now();
      if (message.type === 'heartbeat') { member.lastSeen = now; }
      else if (message.type === 'track') {
        const t = message.track;
        if (t !== null && (!t || !tokenPattern.test(t.hash || '') || !Number.isFinite(t.duration) || t.duration <= 0 || t.duration > 86400)) throw new RoomError('Invalid audio file.');
        if (t?.selection && !codePattern.test(t.selection)) throw new RoomError('Invalid audio selection.');
        member.track = t ? {hash: t.hash, duration: t.duration, selection: t.selection || null} : null;
        member.ready = false;
        this.pause(room);
      } else if (message.type === 'ready') {
        if (!member.track) throw new RoomError('Choose audio first.');
        if (member.track.selection && message.selection !== member.track.selection) throw new RoomError('Your audio changed. Wait for it to finish loading.');
        member.ready = message.ready === true;
        if (!member.ready) this.pause(room);
      } else if (message.type === 'control') {
        if (!this.ready(room)) throw new RoomError('Both listeners must choose matching audio and tap Ready.');
        if (typeof message.playing !== 'boolean' || !Number.isFinite(message.position) || message.position < 0 || message.position > member.track.duration) throw new RoomError('Invalid playback command.');
        if (message.revision !== room.state.revision) throw new RoomError('Playback changed. Try your control again.');
        const at = now + this.lead;
        const position = message.intent === 'toggle'
          ? Math.min(member.track.duration, room.state.position + (room.state.playing ? Math.max(0, at-room.state.at)/1000 : 0))
          : message.position;
        room.state = {playing: message.playing, position, at, revision: room.state.revision + 1};
      } else if (message.type === 'lock') {
        if (room.owner !== member.id) throw new RoomError('Only the room creator can change the lock.');
        room.locked = message.locked === true;
      } else if (message.type === 'leave') {
        this.pause(room);
        if (room.owner === member.id) room.ended = true;
        else { room.members = room.members.filter(m => m.id !== member.id); room.locked = false; }
      } else if (message.type === 'disconnect') {
        member.lastSeen = 0;
        member.ready = false;
        this.pause(room);
      } else throw new RoomError('Unknown room action.');
      room.touched = now;
      return room;
    });
  }
  snapshot(room, id) {
    if (!room || room.ended) return {ended: true};
    return {
      ended: false, owner: room.owner === id, locked: room.locked,
      expires: Math.min(room.created + ROOM_MS, room.touched + IDLE_MS),
      matching: this.matching(room), canPlay: this.ready(room), state: room.state,
      members: room.members.map(m => ({you: m.id === id, ready: m.ready, online: Date.now() - m.lastSeen < LEASE_MS, hasTrack: !!m.track, selection: m.id === id ? m.track?.selection || null : undefined})),
    };
  }
}
