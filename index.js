import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import Groq from 'groq-sdk';
import express from 'express';
import qrcode from 'qrcode'; // استبدلنا مكتبة terminal بمكتبة qrcode العادية

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Saivo Bot is running 24/7! 🚀');
});

app.listen(PORT, () => {
    console.log(`Web server is listening on port ${PORT}`);
});

const memory = {};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('--- SCAN THIS QR CODE ---');
            // سيقوم بطباعة رابط QR كصورة في اللوغات لسهولة فتحه ومسحه
            console.log(await qrcode.toString(qr, { type: 'terminal', small: true }));
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot connected to WhatsApp successfully! 🚀');
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

        let nameInstruction = user.greeted ? "لا تكرر التحية." : "في أول رسالة فقط، رحب بالمستخدم بشكل عفوي.";
        user.greeted = true;

        const systemInstruction = `أنت الصديق الرقمي "Saivo"، شاب عمرك 23 سنة بالرباط. 
قواعد صارمة جداً:
1. تطابق اللغة حصرياً: رد دائماً وبدقة تامة بنفس لغة آخر رسالة كتبها المستخدم.
2. الاختصار الشديد: اجعل ردك قصيرًا جداً (جملة واحدة أو سطر واحد) لكي لا تتقطع الكلمات أبداً.
3. ${nameInstruction}
4. قدم معلومات ذكية ومفيدة واقترح أفكاراً عندما يطلبها المستخدم، مع إنهاء الرد بسؤال قصير جداً ومفتوح.
5. تنوع الإيموجي: استخدم إيموجيز متنوعة (مثل: ✨، 💡، ☕، 🚀، 🎯).`;

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
