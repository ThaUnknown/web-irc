import EventEmitter from 'events'

const serverConnections = {}
const createdChannels = {}
const controlChannel = '0'

const extraEscapable = /[\x00-\x1f\ud800-\udfff\ufffe\uffff\u0300-\u0333\u033d-\u0346\u034a-\u034c\u0350-\u0352\u0357-\u0358\u035c-\u0362\u0374\u037e\u0387\u0591-\u05af\u05c4\u0610-\u0617\u0653-\u0654\u0657-\u065b\u065d-\u065e\u06df-\u06e2\u06eb-\u06ec\u0730\u0732-\u0733\u0735-\u0736\u073a\u073d\u073f-\u0741\u0743\u0745\u0747\u07eb-\u07f1\u0951\u0958-\u095f\u09dc-\u09dd\u09df\u0a33\u0a36\u0a59-\u0a5b\u0a5e\u0b5c-\u0b5d\u0e38-\u0e39\u0f43\u0f4d\u0f52\u0f57\u0f5c\u0f69\u0f72-\u0f76\u0f78\u0f80-\u0f83\u0f93\u0f9d\u0fa2\u0fa7\u0fac\u0fb9\u1939-\u193a\u1a17\u1b6b\u1cda-\u1cdb\u1dc0-\u1dcf\u1dfc\u1dfe\u1f71\u1f73\u1f75\u1f77\u1f79\u1f7b\u1f7d\u1fbb\u1fbe\u1fc9\u1fcb\u1fd3\u1fdb\u1fe3\u1feb\u1fee-\u1fef\u1ff9\u1ffb\u1ffd\u2000-\u2001\u20d0-\u20d1\u20d4-\u20d7\u20e7-\u20e9\u2126\u212a-\u212b\u2329-\u232a\u2adc\u302b-\u302c\uaab2-\uaab3\uf900-\ufa0d\ufa10\ufa12\ufa15-\ufa1e\ufa20\ufa22\ufa25-\ufa26\ufa2a-\ufa2d\ufa30-\ufa6d\ufa70-\ufad9\ufb1d\ufb1f\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40-\ufb41\ufb43-\ufb44\ufb46-\ufb4e\ufff0-\uffff]/g
let extraLookup

// This may be quite slow, so let's delay until user actually uses bad
// characters.
const unrollLookup = function (escapable) {
  let i
  const unrolled = {}
  const c = []
  for (i = 0; i < 65536; i++) {
    c.push(String.fromCharCode(i))
  }
  escapable.lastIndex = 0
  c.join('').replace(escapable, function (a) {
    unrolled[a] = '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4)
    return ''
  })
  escapable.lastIndex = 0
  return unrolled
}

// Quote string, also taking care of unicode characters that browsers
// often break. Especially, take care of unicode surrogates:
// http://en.wikipedia.org/wiki/Mapping_of_Unicode_characters#Surrogates
const escape = {
  quote: function (string) {
    const quoted = JSON.stringify(string)

    // In most cases this should be very fast and good enough.
    extraEscapable.lastIndex = 0
    if (!extraEscapable.test(quoted)) {
      return '[' + quoted + ']'
    }

    if (!extraLookup) {
      extraLookup = unrollLookup(extraEscapable)
    }

    return '[' + quoted.replace(extraEscapable, function (a) {
      return extraLookup[a]
    }) + ']'
  }
}

/**
 *
 * @param {String} _addr Sockjs endpoint
 * @param {String} sessionId Optional session ID to continue
 * @param {String} _socketChannel The optional multiplexed channel ID. Autogenerated if not provided
 */
export function createChannelConstructor (_addr: string, sessionId: string, _socketChannel: string) {
  const addr = _addr.toLowerCase()

  if (!serverConnections[addr]) {
    serverConnections[addr] = createNewConnection(addr, sessionId)
  }

  // If a channel ID hasn't been specified, create a new one
  let socketChannel = _socketChannel
  if (!socketChannel) {
    socketChannel = '' + serverConnections[addr].nextChannelId++
  }

  return createChannelOnConnection(
    serverConnections[addr],
    socketChannel
  )
}

/*
 * Creates a new socket connection to a kiwi server.
 * Channels will be created on this connection to send data back and forth.
 */
function createNewConnection (wsAddr: string, sessionId: string) {
  const connection = new EventEmitter()
  connection.sessionId = ''

  serverConnections[wsAddr] = connection

  connection.nextChannelId = 1
  connection.connected = false

  connection.reconnect =
    connection.connect = function connect () {
      if (connection.ws) {
        try {
          connection.ws.close()
        } catch (err) {
          // Ignore any closing errors. Most likely due to not
          // being connected yet.
        }

        connection.ws = null
      }
      // https://do-e.clients.kiwiirc.com/webirc/kiwiirc/074/3vlzxfg0/websocket
      connection.ws = new WebSocket(wsAddr.replace('https', 'wss') + ('' + (Math.random() * 999 | 0)).padStart(3, '0') + '/' + crypto.randomUUID().slice(0, 8) + '/websocket')
      const onopen = () => {
        const connectStr = sessionId
          ? 'CONTROL SESSION ' + sessionId
          : 'CONTROL START'
        connection.ws.send(escape.quote(`:${controlChannel} ${connectStr}`))
        connection.connected = true
        connection.emit('open')
      }
      connection.ws.onclose = (err) => {
        connection.connected = false
        connection.ws = null
        connection.emit('close', err)
      }
      function dispatchMessage (event) {
        connection.emit('message', event)

        // If the message starts with ":channel " then extract that channel and emit
        // an event for it.
        if (event.data[0] === ':') {
          const message = event.data
          const spacePos = message.indexOf(' ')

          // If no space, ie. ":1", this is the server acknowledging this channel
          // is now open and ready to be used.
          if (spacePos === -1) {
            connection.emit('open.' + message.substr(1))
            return
          }

          const channelId = message.substr(1, spacePos - 1)
          event.data = message.substr(spacePos + 1)
          connection.emit('message.' + channelId, event)
        } else {
          // Core messages. Used for session handling and session syncing
          const parts = event.data.split(' ')

          if (parts[0] === 'SESSION') {
            connection.sessionId = parts[1]
          }
        }
      }
      connection.ws.onmessage = (event) => {
        const msg = event.data
        const type = msg.slice(0, 1)
        const content = msg.slice(1)
        let payload

        // first check for messages that don't need a payload
        switch (type) {
          case 'o':
            return onopen()
        }

        if (content) {
          try {
            payload = JSON.parse(content)
          } catch (e) {}
        }

        if (typeof payload === 'undefined') {
          return
        }

        switch (type) {
          case 'a':
            if (Array.isArray(payload)) {
              payload.forEach(function (data) {
                dispatchMessage({ data })
              })
            }
            break
          case 'm':
            dispatchMessage({ data: payload })
            break
          case 'c':
            if (Array.isArray(payload) && payload.length === 2) {
              connection.ws.close()
            }
            break
        }
      }
    }

  connection.connect()
  return connection
}

/*
 * Create a channel on a server connection.
 * The ConnectionChannel implements an IrcFramework transport
 */
function createChannelOnConnection (connection, channelId) {
  // Only allow 1 ConnectionChannel instance per channel
  return function ConnectionChannelWrapper (options) {
    if (!createdChannels[channelId]) {
      createdChannels[channelId] = new ConnectionChannel(options)
    } else if (connection.connected) {
      createdChannels[channelId].initChannel()
    }

    return createdChannels[channelId]
  }

  function ConnectionChannel (options) {
    let sendControlBuffer = []
    let encoding = 'utf8'
    const channel = new EventEmitter()
    channel.id = channelId
    channel.isOpen = false
    channel.state = 0 // TODO: Is this used anywhere?
    // 0 = disconnected, 1 = connected
    channel.remoteState = 0

    // When the websocket opens, open this channel on it
    connection.on('open', () => {
      connection.ws.send(escape.quote(':' + channelId))
    })
    // When we get confirmation of this channel being opened, send any control
    // messages that were buffered
    connection.on('open.' + channelId, () => {
      channel.isOpen = true
      // channel.emit('open');
      if (sendControlBuffer.length) {
        sendControlBuffer.forEach((line) => {
          channel.sendControl(line)
        })
        sendControlBuffer = []
      }

      channel.setEncoding(encoding)

      // This channel is now open and can start sending data to the server
      channel.remoteState = 1
      channel.emit('open')
    })
    connection.on('close', (err) => {
      channel.state = 3
      channel.remoteState = 0
      channel.isOpen = false
      channel.emit('close', err)
    })
    connection.on('message.' + channelId, (event) => {
      if (event.data.indexOf('control ') === 0) {
        // When we get the signal that the connection to the IRC server
        // has connected, start proxying all data
        if (event.data.indexOf('control connected') === 0) {
          channel.remoteState = 1
        }

        if (event.data.indexOf('control closed') === 0) {
          const err = event.data.split(' ')[2]
          channel.remoteState = 0
          channel.emit('close', err)
        }
      }

      if (channel.remoteState === 1) {
        channel.emit('line', event.data)
      }
    })

    // Send a control message to the server (not relayed to an IRC network)
    channel.sendControl = function writeTarget (data) {
      if (channel.isOpen) {
        connection.ws.send(escape.quote(':' + channelId + ' ' + data))
      } else {
        sendControlBuffer.push(data)
      }
    }

    channel.writeLine = function writeTarget (data, cb) {
      // Buffer the data if the socket has not yet been sent
      if (channel.remoteState >= 1) {
        connection.ws.send(escape.quote(':' + channelId + ' ' + data))
      }

      // Websocket.send() does not support callbacks
      // call the callback in the next tick instead
      if (cb) {
        setTimeout(cb, 0)
      }
    }

    // Tell the server to connect to an IRC network
    channel.connect = function connect () {
      // Clear any buffered control messages so we have a clean slate
      sendControlBuffer = []

      // If the websocket is not connected, try to reconnect it
      if (!connection.ws) {
        connection.reconnect()
      }

      const host = options.host
      const port = options.port
      const tls = options.tls || options.ssl
      channel.sendControl('HOST ' + host + ':' + (tls ? '+' : '') + port)
    }

    channel.close = function close () {
      if (channel.remoteState >= 1) {
        connection.ws.send(escape.quote(':' + channelId))
      }
    }

    // This is not supported but irc-framework transports need it, so just noop it
    channel.setEncoding = function setEncoding (newEncoding) {
      encoding = newEncoding
      if (connection.connected) {
        connection.ws.send(escape.quote(':' + channelId + ' ENCODING ' + newEncoding))
      }
      return true
    }

    channel.disposeSocket = function disposeSocket () {
      // noop
    }

    channel.initChannel = function initChannel () {
      connection.ws.send(escape.quote(':' + channelId))
    }
    // Let the server know of this new channel if we're already connected
    if (connection.connected) {
      channel.initChannel()
    }

    return channel
  }
}
