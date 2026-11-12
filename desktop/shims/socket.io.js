/* eslint-env browser */
/*
 * Stand-in for the socket.io client that Overleaf's editor loads from its
 * real-time service (/socket.io/socket.io.js).
 *
 * The editor talks to `io.connect(...)` exactly as it does on the web; here
 * the "connection" is Electron IPC to the local backend in the main process
 * (see desktop/preload/preload.js and desktop/main/project/ProjectSession.js).
 * It presents itself as socket.io 0.9 so that the editor's SocketShimV0 is
 * used unchanged.
 */
(function () {
  "use strict";

  var bridge = window.localleafBridge;
  if (!bridge) {
    // Not running inside the desktop app; the editor falls back to its no-op
    // socket and reports that the connection is unavailable.
    return;
  }

  function connect(_url, options) {
    var projectId = new URLSearchParams((options && options.query) || "").get(
      "projectId",
    );
    var listeners = new Map();
    var generation = 0; // bumped on every (dis)connect to drop stale replies
    var queued = []; // events that arrive while the handshake is in flight

    function fire(eventName, args) {
      var handlers = listeners.get(eventName);
      if (!handlers) return;
      handlers.slice().forEach(function (handler) {
        try {
          handler.apply(null, args);
        } catch (error) {
          console.error("[localleaf] socket handler failed", eventName, error);
        }
      });
    }

    var inner = {
      connected: false,
      connecting: false,
      sessionid: undefined,
      transports: ["local"],
      heartbeatTimeoutTimer: undefined,
      connect: function () {
        var mine = ++generation;
        inner.connected = false;
        inner.connecting = true;
        queued = [];
        bridge.socketConnect(projectId).then(
          function (result) {
            if (mine !== generation) return;
            inner.connecting = false;
            inner.connected = true;
            inner.sessionid = result.clientId;
            fire("connect", []);
            fire("joinProjectResponse", [result.joinProjectResponse]);
            var pending = queued;
            queued = [];
            pending.forEach(function (event) {
              fire(event.name, event.args);
            });
          },
          function (error) {
            if (mine !== generation) return;
            inner.connecting = false;
            fire("connect_failed", [error]);
          },
        );
      },
      disconnect: function (reason) {
        var wasActive = inner.connected || inner.connecting;
        generation++;
        inner.connected = false;
        inner.connecting = false;
        queued = [];
        bridge.socketDisconnect();
        if (wasActive) fire("disconnect", [reason || "booted"]);
      },
    };

    bridge.onSocketEvent(function (eventName, args) {
      if (inner.connecting) {
        queued.push({ name: eventName, args: args });
      } else if (inner.connected) {
        fire(eventName, args);
      }
    });

    return {
      socket: inner,
      on: function (eventName, handler) {
        if (!listeners.has(eventName)) listeners.set(eventName, []);
        listeners.get(eventName).push(handler);
      },
      removeListener: function (eventName, handler) {
        var handlers = listeners.get(eventName);
        if (!handlers) return;
        var index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      },
      emit: function (eventName) {
        var args = Array.prototype.slice.call(arguments, 1);
        var callback =
          typeof args[args.length - 1] === "function" ? args.pop() : null;
        if (!inner.connected) return;
        var mine = generation;
        // Same (de)serialisation a network hop would apply.
        var payload = JSON.parse(JSON.stringify(args));
        bridge.socketEmit(eventName, payload).then(
          function (result) {
            if (callback && Array.isArray(result) && mine === generation) {
              callback.apply(null, result);
            }
          },
          function (error) {
            if (callback && mine === generation) {
              callback({ message: String((error && error.message) || error) });
            }
          },
        );
      },
      connect: function () {
        inner.connect();
      },
      disconnect: function (reason) {
        inner.disconnect(reason);
      },
    };
  }

  window.io = {
    version: "0.9.19-localleaf",
    connect: connect,
    // The editor only uses these for instanceof checks on real transports.
    Transport: { websocket: function () {}, "xhr-polling": function () {} },
  };
})();
