// Ephemeral ECDH (P-256) key exchange.
//
// Replaces Shamir's three-pass XOR protocol. The relay sees only public keys
// and AES-GCM ciphertexts;
//
// Protocol — 3 messages (same wire count as before):
//   pass 1  initiator → responder  65-byte raw P-256 public key
//   pass 2  responder → initiator  65-byte raw P-256 public key
//                                  || AES-GCM(wrapKey, ownKeyResponder)  [60 B]
//   pass 3  initiator → responder  AES-GCM(wrapKey, ownKeyInitiator)    [60 B]
//
// wrapKey = HKDF-SHA-256(ECDH_shared_secret, salt=channelId, info="nocc-key-wrap")
//
// Simultaneous-start race: both sides may send pass 1 before receiving the
// other's. The side with the lexicographically lower uid hash stays initiator;
// the other yields and becomes responder.

import { randomBytes, hexToBytes, bytesToHex, concatBytes, aesGcmEncrypt, aesGcmDecrypt } from './random.js';

const CURVE = 'P-256';
const PUB_KEY_LEN = 65;    // uncompressed P-256 point: 0x04 || x || y
const SIGN_PUB_LEN = 32;   // raw Ed25519 public key

async function genKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
}

async function importPub(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'ECDH', namedCurve: CURVE }, false, []);
}

async function deriveWrapKey(privateKey, peerPublicKey, channel) {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256);
  const mat = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(channel),
      info: new TextEncoder().encode('nocc-key-wrap'),
    },
    mat,
    256
  );
  return new Uint8Array(bits);
}

export function createHandshakeSession({ myId, peerId, channel, send, onLog = () => {}, onComplete = () => {}, providedOwnKey = null, mySigningPubKeyHex = null }) {
  const ownKeyBytes = providedOwnKey ? hexToBytes(providedOwnKey) : randomBytes(32);
  const mySigningPubBytes = mySigningPubKeyHex ? hexToBytes(mySigningPubKeyHex) : new Uint8Array(SIGN_PUB_LEN);

  let kp = null;              // ephemeral ECDH CryptoKeyPair
  let wrapKey = null;         // Uint8Array[32], stored by responder between pass 1 and pass 3
  let peerSigningPubHex = null;
  let stage = 'idle';

  function sendPass(pass, data) {
    send({ to: peerId, channel, pass, data: bytesToHex(data) });
    onLog(`sent pass ${pass}/3 (${stage})`);
  }

  async function start() {
    if (stage !== 'idle') return;
    stage = 'init-waiting-pass2';
    kp = await genKeyPair();
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    // pass 1 payload: ECDH pubkey (65 B) || Ed25519 signing pubkey (32 B)
    sendPass(1, concatBytes(pubRaw, mySigningPubBytes));
  }

  async function handleIncoming(payload) {
    if (stage === 'done') return;
    if (payload.sent_from !== peerId || payload.channel !== channel) return;

    onLog(`received pass ${payload.pass}/3 (${stage})`);
    const data = hexToBytes(payload.data);

    if (payload.pass === 1) {
      if (stage !== 'idle') {
        // Both sides started simultaneously — lower uid hash stays initiator.
        if (myId < peerId) return;
        stage = 'idle';
        kp = null;
      }

      // pass 1 payload: ECDH pubkey (65 B) || signing pubkey (32 B)
      const peerEcdhPubRaw = data.slice(0, PUB_KEY_LEN);
      peerSigningPubHex = bytesToHex(data.slice(PUB_KEY_LEN, PUB_KEY_LEN + SIGN_PUB_LEN));

      kp = await genKeyPair();
      const peerPub = await importPub(peerEcdhPubRaw);
      wrapKey = await deriveWrapKey(kp.privateKey, peerPub, channel);

      const wrappedOwn = await aesGcmEncrypt(ownKeyBytes, wrapKey);
      const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      // pass 2 payload: ECDH pubkey (65 B) || signing pubkey (32 B) || wrapped key (60 B)
      sendPass(2, concatBytes(concatBytes(pubRaw, mySigningPubBytes), wrappedOwn));
      stage = 'resp-waiting-pass3';
      return;
    }

    if (payload.pass === 2) {
      if (stage !== 'init-waiting-pass2') return;

      // pass 2 payload: ECDH pubkey (65 B) || signing pubkey (32 B) || wrapped key (60 B)
      const respEcdhPubRaw = data.slice(0, PUB_KEY_LEN);
      peerSigningPubHex = bytesToHex(data.slice(PUB_KEY_LEN, PUB_KEY_LEN + SIGN_PUB_LEN));
      const wrappedPeerKey = data.slice(PUB_KEY_LEN + SIGN_PUB_LEN);

      const respPub = await importPub(respEcdhPubRaw);
      wrapKey = await deriveWrapKey(kp.privateKey, respPub, channel);

      const peerKeyBytes = await aesGcmDecrypt(wrappedPeerKey, wrapKey);
      const wrappedOwn = await aesGcmEncrypt(ownKeyBytes, wrapKey);
      sendPass(3, wrappedOwn);

      stage = 'done';
      onComplete({ ownKey: bytesToHex(ownKeyBytes), peerKey: bytesToHex(peerKeyBytes), peerSigningPubKey: peerSigningPubHex });
      return;
    }

    if (payload.pass === 3) {
      if (stage !== 'resp-waiting-pass3') return;

      const initKeyBytes = await aesGcmDecrypt(data, wrapKey);
      stage = 'done';
      onComplete({ ownKey: bytesToHex(ownKeyBytes), peerKey: bytesToHex(initKeyBytes), peerSigningPubKey: peerSigningPubHex });
    }
  }

  return { start, handleIncoming };
}
