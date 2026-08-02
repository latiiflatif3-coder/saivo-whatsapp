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
                <p>Please wait, generating QR code...</p>
                <div id="qr-container"><img id="qr-img" src="" alt="QR Code will appear here" width="300" height="300"></div>
                <div id="status">Connecting...</div>
                <script>
                    const socket = io();
                    const qrImg = document.getElementById('qr-img');
                    const statusDiv = document.getElementById('status');

                    socket.on('qr', (qrUrl) => {
                        qrImg.src = qrUrl;
                        statusDiv.innerText = 'Waiting for scan...';
                        statusDiv.style.color = '#facc15';
                    });

                    socket.on('connected', () => {
                        qrImg.style.display = 'none';
                        statusDiv.innerText = '✅ Bot Connected Successfully!';
                        statusDiv.style.color = '#22c55e';
                    });

                    socket.on('disconnected', () => {
                        statusDiv.innerText = '🔴 Bot Disconnected. Restarting...';
                        statusDiv.style.color = '#ef4444';
                    });
                </script>
            </body>
        </html>
    `);
});

server.listen(PORT, () => {
    console.log(`Web server for QR is running on port ${PORT}`);
});

const memory = {};

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
            console.log('QR code generated, sending to web interface...');
            io.emit('qr', await qrcode.toDataURL(qr));
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            io.emit('disconnected');
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot connected to WhatsApp successfully!');
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
        if (!userMessage) return;

        if (!memory[senderJid]) {
            memory[senderJid] = { history: [], greeted: false };
        }
        const user = memory[senderJid];

        user.history.push({ role: "user", content: userMessage });
        if (user.history.length > 10) {
            user.history = user.history.slice(-10);
        }

        let nameInstruction = user.greeted ? "لا تكرر التحية المفرطة." : "في أول رسالة فقط، رحب بالمستخدم بشكل عفوي.";
        user.greeted = true;

        const systemInstruction = `أنت الصديق الرقمي "Saivo"، شاب عمرك 23 سنة بالرباط. 
قواعد صارمة جداً:
1. تطابق اللغة حصرياً: رد دائماً وبدقة تامة بنفس لغة آخر رسالة كتبها المستخدم.
2. الاختصار الشديد: اجعل ردك قصيرًا جداً (جملة واحدة أو سطر واحد) لكي لا تتقطع الكلمات أبداً.
3. ${nameInstruction}
4. قدم معلومات ذكية ومفيدة واقترح أفكاراً عندما يطلبها المستخدم، مع إنهاء الرد بسؤال قصير جداً ومفتوح.
5. تنوع الإيموجي: استخدم إيموجيز متنوعة (مثل: ✨، 💡، ☕، 🚀، 🎯) بشكل طبيعي ولائق.`;

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemInstruction },
                    ...user.history
                ],
                model: "llama-3.3-70b-versatile",
                max_tokens: 55,
                temperature: 0.7,
            });

            let replyText = completion.choices[0]?.message?.content || "I'm listening 💡";
            replyText = replyText.replace(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u4E00-\u9FFF\u3400-\u4DBF]/g, '').trim();

            user.history.push({ role: "assistant", content: replyText });
            await sock.sendMessage(senderJid, { text: replyText });
        } catch (error) {
            console.error('Groq API Error:', error);
        }
    });
}

connectToWhatsApp();
