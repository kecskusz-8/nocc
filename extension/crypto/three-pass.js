// Shamir's three-pass key exchange, as specified in ARCHITECTURE.md.
//
// Delivering a key is always the same 3-step dance regardless of direction:
// the sender masks it with their own one-time pad and sends pass 1; the
// receiver layers their own pad on top and sends pass 2; the sender strips
// their own layer (XOR is self-inverse) and sends pass 3; the receiver
// strips their own layer and is left with the plain key. Every step here is
// the same operation, `xorBytes(incoming, ownPad)` — only what happens to
// the result (forward it as the next pass, or keep it as the peer's key)
// depends on which pass number just arrived.
//
// A full handshake is two such deliveries back to back (leg A: whoever
// clicked "start" delivers their key; leg B: the other side delivers theirs
// right after, reusing the pads already derived for leg A) — six passes
// total, matching the doc. This module knows nothing about sockets; the
// caller supplies `send` to actually put a pass on the wire.

import { randomBytes, hexToBytes, bytesToHex, xorBytes, sha256, concatBytes } from './random.js';

export function createHandshakeSession({ myId, peerId, channel, send, onLog = () => {}, onComplete = () => {}, providedOwnKey = null }) {
  const ownKey = providedOwnKey ? hexToBytes(providedOwnKey) : randomBytes(32);
  const ready = sha256(concatBytes(hexToBytes(myId), ownKey));

  let ownPad = null;
  let stage = 'idle';
  let peerKey = null;

  async function pad() {
    if (!ownPad) ownPad = await ready;
    return ownPad;
  }

  function sendPass(pass, data) {
    send({ to: peerId, channel, pass, data: bytesToHex(data) });
    onLog(`sent pass ${pass}/3 (${stage})`);
  }

  async function start() {
    if (stage !== 'idle') return; // already in progress or done — don't restart
    stage = 'A-initiator-waiting-pass2'; // claim stage before await to close the race window
    const ownPadBytes = await pad();
    sendPass(1, xorBytes(ownKey, ownPadBytes));
  }

  async function startLegB() {
    const ownPadBytes = await pad();
    sendPass(1, xorBytes(ownKey, ownPadBytes));
    stage = 'B-initiator-waiting-pass2';
  }

  async function handleIncoming(payload) {
    if (stage === 'done') return; // ignore stale relay traffic after completion
    if (payload.sent_from !== peerId || payload.channel !== channel) return;

    const ownPadBytes = await pad();
    const incoming = hexToBytes(payload.data);
    const layered = xorBytes(incoming, ownPadBytes);

    onLog(`received pass ${payload.pass}/3 (${stage})`);

    if (payload.pass === 1) {
      // Someone is delivering a key to us: layer our pad, bounce it back.
      sendPass(2, layered);
      stage = stage === 'idle' ? 'A-responder-waiting-pass3' : 'B-responder-waiting-pass3';
      return;
    }

    if (payload.pass === 2) {
      // We're delivering a key: strip our layer, send the final pass.
      sendPass(3, layered);
      if (stage === 'A-initiator-waiting-pass2') {
        stage = 'A-done-awaiting-legB';
      } else if (stage === 'B-initiator-waiting-pass2') {
        stage = 'done';
        onComplete({ ownKey: bytesToHex(ownKey), peerKey });
      }
      return;
    }

    if (payload.pass === 3) {
      // Final unwrap: `layered` is now the peer's plain key.
      if (stage === 'A-responder-waiting-pass3') {
        peerKey = bytesToHex(layered);
        onLog(`leg A complete, learned peer key; starting leg B`);
        await startLegB();
      } else if (stage === 'B-responder-waiting-pass3') {
        peerKey = bytesToHex(layered);
        stage = 'done';
        onComplete({ ownKey: bytesToHex(ownKey), peerKey });
      }
    }
  }

  return { start, handleIncoming };
}
