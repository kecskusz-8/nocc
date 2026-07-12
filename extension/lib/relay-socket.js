// Minimal Engine.IO/Socket.IO v4 client, speaking just enough of the wire
// protocol over a plain WebSocket to talk to the relay. No socket.io-client
// dependency, no ack/callback support (not needed by register/handshake).

function connectToRelay(url) {
  const wsUrl = `${url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(wsUrl);

  const listeners = {};
  const queue = [];
  let connected = false;

  function fire(event, ...args) {
    for (const cb of listeners[event] || []) cb(...args);
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

    if (msg.startsWith('42')) {
      const [event, payload] = JSON.parse(msg.slice(2));
      fire(event, payload);
      return;
    }

    if (msg.startsWith('41') || msg[0] === '1') {
      connected = false;
      fire('disconnect');
    }
  });

  ws.addEventListener('close', () => {
    connected = false;
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
    close() {
      ws.close();
    },
  };
}
