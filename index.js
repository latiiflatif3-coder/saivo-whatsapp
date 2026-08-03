import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import Groq from 'groq-sdk';
import express from 'express';
import qrcode from 'qrcode';
import http from 'http';
import { Server } from 'socket.io';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>WhatsApp Saivo Bot - QR Scanner</title>
                <script src="/socket.io/socket.io.js"></script>
                <style>
                    body { font-family: sans-serif; text-align: center; background: #111; color: #eee; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    h1 { color: #22c55e; }
                    #qr-container { background: #fff; padding: 20px; border-radius: 10px; margin-top: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
                    #status { margin-top: 20px; font-size: 1.2em; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Scan QR Code to activate Saivo Bot</h1>
                <div id="qr-container"><img id="qr-img" src="" alt="QR Code" width="300" height="300"></div>
                <div id="status">Connecting...</div>
                <script>
                    const socket = io();
                    const qrImg = document.getElementById('qr-img');
                    const statusDiv = document.getElementById('status');
                    socket.on('qr', (qrUrl) => { qrImg.src = qrUrl; statusDiv.innerText = 'Scan this QR'; });
                    socket.on('connected', () => { qrImg.style.display = 'none'; statusDiv.innerText = '✅ Connected!'; statusDiv.style.color = '#22c55e'; });
                    socket.on('disconnected', () => { statusDiv.innerText = '🔴 Disconnected'; statusDiv.style.color = '#ef4444'; });
                </script>
            </body>
        </html>
    `);
});

server.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

const memory = {};

// دالة مساعدة لإحداث تأخير زمني (بالمللي ثانية)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Saivo Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Generated');
            io.emit('qr', await qrcode.toDataURL(qr));
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            io.emit('disconnected');
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Bot Connected to WhatsApp!');
            io.emit('connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        console.log(`📥 Received message from ${senderJid}: "${userMessage}"`);
        if (!userMessage) return;

        if (!memory[senderJid]) {
            memory[senderJid] = { history: [] };
        }
        const user = memory[senderJid];
        user.history.push({ role: "user", content: userMessage });

        try {
            // محاكاة حالة "جاري الكتابة..." (Typing) لتبدو طبيعية أكثر
            await sock.presenceSubscribe(senderJid);
            await delay(500);
            await sock.sendPresenceUpdate('composing', senderJid);

            // استدعاء ذكاء Groq
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: "أنت الصديق الرقمي Saivo، رد باختصار شديد وبلغة المستخدم مع إيموجي لطيف." },
                    ...user.history
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 50,
            });

            let replyText = completion.choices[0]?.message?.content || "هلا بيك 💡";
            user.history.push({ role: "assistant", content: replyText });
            
            // تأخير زمني إضافي (مثلاً 2 ثواني) قبل إرسال الرد الفعلي لكي لا يبدو البوت كأنه آلة فورية
            await delay(2000);

            await sock.sendMessage(senderJid, { text: replyText });
            await sock.sendPresenceUpdate('paused', senderJid);
            console.log(`📤 Replied successfully to ${senderJid}`);
        } catch (error) {
            console.error('❌ Error in AI or Sending:', error);
        }
    });
}

connectToWhatsApp();
