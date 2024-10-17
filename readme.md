# @thaunknown/web-irc

A TypeScript port of irc-framework's WebIRC client, without the bloat of unnceessary packages.

This port reduces the bundle size from over 500KB to just under 100KB, while increasing speed and reducing resource usage.

Example usage:

```ts
import client, { createChannelConstructor } from '@thaunknown/web-irc'

client.connect({
  version: null,
  enable_chghost: true,
  enable_setname: true,
  message_max_length: 350,
  host: hostname,
  port: 5004,
  tls: true,
  path: '',
  password: '',
  account: {},
  nick: ident,
  username: ident,
  gecos: url,
  encoding: 'utf8',
  auto_reconnect: false,
  transport: createChannelConstructor(channelURL, '', 1)
})

client.once('connected', () => {
  const channel = client.channel('name')
  client.once('join', () => {
    channel.say('hello world')
  })
})
```

Function calls and events are the same as irc-frameworks's.
