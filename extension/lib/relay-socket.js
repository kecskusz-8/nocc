// Minimal Engine.IO/Socket.IO v4 client, speaking just enough of the wire
// protocol over a plain WebSocket to talk to the relay. No socket.io-client
// dependency. Supports Socket.IO's ack-callback protocol (needed for
// request/response events like `config`/`verify`): an event packet with an
// ack id looks like `42<id>["event",data]`, and the server replies with
// `43<id>[response]`.

export function connectToRelay(url) {
  const wsUrl = `${url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(wsUrl);

  const listeners = {};
  const queue = [];
  let connected = false;

  let nextAckId = 0;
  const pendingAcks = new Map();

  function fire(event, ...args) {
    for (const cb of listeners[event] || []) cb(...args);
  }

  function rejectPendingAcks(reason) {
    for (const { reject } of pendingAcks.values()) reject(new Error(reason));
    pendingAcks.clear();
  }

  ws.addEventListener('message', (e) => {
    const msg = e.data;

    if (msg === '2') {
      ws.send('3'); // ping -> pong
      return;
    }

    if (msg[0] === '0') {
      ws.send('40'); // engine.io open -> connect default namespace
      return;
    }

    if (msg.startsWith('40')) {
      connected = true;
      for (const packet of queue.splice(0)) ws.send(packet);
      fire('connect');
      return;
    }

    const ackMatch = msg.match(/^43(\d+)(.*)$/);
    if (ackMatch) {
      const id = Number(ackMatch[1]);
      const pending = pendingAcks.get(id);
      if (pending) {
        pendingAcks.delete(id);
        const args = ackMatch[2] ? JSON.parse(ackMatch[2]) : [];
        pending.resolve(args[0]);
      }
      return;
    }

    if (msg.startsWith('42')) {
      const [event, payload] = JSON.parse(msg.slice(2));
      fire(event, payload);
      return;
    }

    if (msg.startsWith('41') || msg[0] === '1') {
      connected = false;
      rejectPendingAcks('disconnected');
      fire('disconnect');
    }
  });

  ws.addEventListener('close', () => {
    connected = false;
    rejectPendingAcks('disconnected');
    fire('disconnect');
  });

  ws.addEventListener('error', (e) => {
    fire('error', e);
  });

  return {
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event, payload) {
      const packet = `42${JSON.stringify([event, payload])}`;
      if (connected) ws.send(packet);
      else queue.push(packet);
    },
    emitWithAck(event, payload) {
      const id = nextAckId++;
      const packet = `42${id}${JSON.stringify([event, payload])}`;
      const promise = new Promise((resolve, reject) => pendingAcks.set(id, { resolve, reject }));
      if (connected) ws.send(packet);
      else queue.push(packet);
      return promise;
    },
    close() {
      ws.close();
    },
  };
}
