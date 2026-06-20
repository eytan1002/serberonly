const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox'],
  },
});

let whatsappStatus = 'DISCONNECTED';

function formatMessageTime(timestamp) {
  return timestamp
    ? new Date(timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function getSenderName(msg) {
  if (msg.fromMe) {
    return 'אני';
  }

  return msg._data?.notifyName || msg._data?.pushname || msg._data?.sender?.pushname || '';
}

function getMediaPreview(message) {
  if (!message?.hasMedia) {
    return message?.body || '';
  }

  if (message.type === 'image') return message.body || 'Image';
  if (message.type === 'video') return message.body || 'Video';
  if (message.type === 'audio' || message.type === 'ptt') return 'Audio';
  if (message.type === 'document') return message.body || 'Document';
  if (message.type === 'sticker') return 'Sticker';

  return message.body || 'Media';
}

async function getMessageMedia(msg) {
  if (!msg.hasMedia) {
    return null;
  }

  try {
    const media = await msg.downloadMedia();

    if (!media) {
      return {
        unavailable: true,
        mimetype: msg.mimetype || '',
        filename: msg.filename || '',
      };
    }

    return {
      mimetype: media.mimetype || msg.mimetype || '',
      data: media.data || '',
      filename: media.filename || msg.filename || '',
      filesize: media.filesize || null,
    };
  } catch (error) {
    console.error('Failed to download message media:', error);
    return {
      unavailable: true,
      mimetype: msg.mimetype || '',
      filename: msg.filename || '',
    };
  }
}

async function mapWhatsappMessage(msg, chatId) {
  const media = await getMessageMedia(msg);

  return {
    id: msg.id?._serialized || `${chatId}-${Date.now()}`,
    chatId,
    sender: getSenderName(msg),
    senderId: msg.author || msg.from || '',
    text: msg.body,
    type: msg.type,
    hasMedia: Boolean(msg.hasMedia),
    media,
    timestamp: formatMessageTime(msg.timestamp),
    isOwn: Boolean(msg.fromMe),
  };
}

client.on('qr', (qr) => {
  console.log('QR Received, generating data URL...');
  whatsappStatus = 'QR_READY';
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Failed to generate QR image:', err);
      return;
    }
    io.emit('whatsapp-qr', url);
  });
});

client.on('ready', () => {
  console.log('WhatsApp Client is ready!');
  whatsappStatus = 'CONNECTED';
  io.emit('whatsapp-status', 'CONNECTED');
});

client.on('authenticated', () => {
  console.log('WhatsApp Authenticated!');
});

client.on('message', async (msg) => {
  console.log(`New message from ${msg.from}: ${msg.body}`);
  io.emit('whatsapp-message-received', await mapWhatsappMessage(msg, msg.from));
});

app.post('/api/send', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing "to" or "message" fields' });
  }

  try {
    const formattedNumber = to.includes('@c.us') ? to : `${to}@c.us`;
    await client.sendMessage(formattedNumber, message);
    res.status(200).json({ success: true, status: 'Message sent' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

io.on('connection', (socket) => {
  console.log('React Client connected to Socket.io');
  socket.emit('whatsapp-status', whatsappStatus);

  socket.on('fetch-whatsapp-chats', async () => {
    try {
      const chats = await client.getChats();
      const mapped = chats.map((chat) => ({
        id: chat.id._serialized,
        name: chat.name || chat.formattedTitle || chat.id.user,
        isGroup: Boolean(chat.isGroup),
        avatar: chat.isGroup ? '👥' : '👤',
        lastMessage: chat.lastMessage?.body || 'אין הודעות עדיין',
        lastMessage: getMediaPreview(chat.lastMessage) || 'No messages yet',
        lastMessageTime: chat.lastMessage?.timestamp
          ? new Date(chat.lastMessage.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
          : '',
      }));
      socket.emit('whatsapp-chats', mapped);
    } catch (error) {
      console.error('Error fetching chats:', error);
      socket.emit('whatsapp-chats', []);
    }
  });

  socket.on('fetch-whatsapp-messages', async ({ chatId }) => {
    try {
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 50 });
      const mapped = await Promise.all(messages.map((msg) => mapWhatsappMessage(msg, chatId)));
      /*
        id: msg.id._serialized,
        chatId: chatId,
        sender: msg.from || msg._data?.author || 'אני',
        text: msg.body,
        timestamp: msg.timestamp
          ? new Date(msg.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
          : '',
        isOwn: msg.from === client.info?.me?.user,
      }));
      */
      socket.emit('whatsapp-chat-messages', { chatId, messages: mapped });
    } catch (error) {
      console.error('Error fetching messages for chat', chatId, error);
      socket.emit('whatsapp-chat-messages', { chatId, messages: [] });
    }
  });

  socket.on('send-whatsapp-message', async ({ chatId, text }) => {
    try {
      const chat = await client.getChatById(chatId);
      const sentMessage = await chat.sendMessage(text);
      if (sentMessage) {
        io.emit('whatsapp-message-received', {
          id: sentMessage.id?._serialized || `${chatId}-${Date.now()}`,
          chatId,
          sender: client.info?.me?.user || 'אני',
          text,
          sender: 'אני',
          senderId: client.info?.me?._serialized || client.info?.me?.user || '',
          timestamp: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
          isOwn: true,
        });
      }
    } catch (error) {
      console.error('Error sending message over socket:', error);
    }
  });
});

client.initialize();

server.listen(5000, '0.0.0.0', () => {
  console.log('Server is running on port 5000');
});
