const express = require('express');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();


const { formatWhatsappNumber, saveMessageToDb, updateMessageStatusAndId, getClientInfo } = require('./utils');
const { processCsvAndSendBulk } = require('./csv-processor');

const app = express();
const port = 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const operatorNumberRaw = process.env.OPERATOR_NUMBER; 

if (!supabaseUrl || !supabaseKey) {
    console.error("Erro: URL ou Chave do Supabase não encontradas no arquivo .env.");
    process.exit(1);
}
if (!operatorNumberRaw) {
    console.warn("Atenção: OPERATOR_NUMBER não definido no arquivo .env. Mensagens recebidas não serão encaminhadas.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const operatorNumberFormatted = operatorNumberRaw ? formatWhatsappNumber(operatorNumberRaw) : null; 

const SESSION_FILE_PATH = './.wwebjs_auth';

app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 

app.use((req, res, next) => {
    const allowedOrigins = ['http://localhost:8080', 'http://127.0.0.1:8080']; 
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin) || origin === 'null' || origin === 'file://' || (process.env.NODE_ENV !== 'production' && origin && origin.startsWith('http://localhost:'))) {
         res.setHeader('Access-Control-Allow-Origin', origin || '*'); 
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization'); 
    res.setHeader('Access-Control-Allow-Credentials', true);

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

const storage = multer.memoryStorage(); 
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, 
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv') || file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo inválido. Apenas arquivos CSV e imagens são permitidos.'), false);
        }
    }
});

const uploadSingle = upload.single('image');
const uploadBulk = upload.fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'imageFile', maxCount: 1 }
]);

console.log('Inicializando cliente WhatsApp...');
let qrCodeData = null;
let clientStatus = 'INITIALIZING'; 
let connectedClientNumber = null; 

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_FILE_PATH }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    },
});

function updateClientStatus(newStatus, wsServer, clientInstance = null) {
    const oldStatus = clientStatus;
    clientStatus = newStatus;
    const clientInfo = getClientInfo(clientInstance); 
    connectedClientNumber = clientInfo.number; 

    console.log(`Status do Cliente alterado: ${oldStatus} -> ${newStatus}${connectedClientNumber ? ` (Número: ${connectedClientNumber})` : ''}`);

    wsServer?.broadcast({ type: 'client_status', payload: { status: newStatus, clientNumber: connectedClientNumber } });
}

client.on('qr', (qr) => {
    console.log('QR Code Recebido, por favor escaneie!');
    qrCodeData = qr;
    connectedClientNumber = null; 
    updateClientStatus('WAITING_QR', wss); 
    wss.broadcast({ type: 'qr', payload: qr });
});

client.on('authenticated', () => {
    console.log('Cliente WhatsApp Autenticado!');
    qrCodeData = null; 
    updateClientStatus('AUTHENTICATED', wss, client); 
});

client.on('auth_failure', (msg) => {
    console.error('Falha na Autenticação do WhatsApp:', msg);
    qrCodeData = null;
    connectedClientNumber = null; 
    updateClientStatus('DISCONNECTED', wss); 
    wss.broadcast({ type: 'auth_failure', payload: msg });
});

client.on('ready', () => {
    console.log('Cliente WhatsApp Pronto!');
    qrCodeData = null;
    updateClientStatus('READY', wss, client); 
    console.log("Informações do Cliente:", getClientInfo(client)); 
    if (!operatorNumberRaw) {
        console.warn("AVISO: Número do operador não configurado. Encaminhamento desabilitado.");
    } else {
        console.log(`Mensagens recebidas serão encaminhadas para: ${operatorNumberRaw}`);
    }
});

client.on('message', async (message) => {
    console.log(`Mensagem recebida de: ${message.from}, Corpo: ${message.body.substring(0, 50)}...`);

    if (message.from === 'status@broadcast' || message.fromMe) {
        console.log('Ignorando mensagem de status ou própria.');
        return;
    }

    if (operatorNumberFormatted && message.from === operatorNumberFormatted) {
        console.log('Ignorando mensagem do número do operador.');
        return;
    }

    const senderInfo = getClientInfo(client); 
    const senderNumber = message.from; 
    const senderName = message._data.notifyName || senderNumber.split('@')[0]; 
    const messageBody = message.body;
    const messageTimestamp = new Date(message.timestamp * 1000);
    const hasMedia = message.hasMedia || false;
    const mediaMimeType = hasMedia ? message.type : null; 

    try {
        const incomingDbMessage = await saveMessageToDb(supabase, senderInfo, wss, {
            message_id: message.id.id,
            sender_number: senderNumber,
            recipient_number: senderInfo.number, 
            recipient_name: senderName, 
            body: messageBody,
            is_outgoing: false, 
            status: 'received', 
            timestamp: messageTimestamp,
            has_media: hasMedia,
            media_mime_type: mediaMimeType,
            message_type: 'incoming' 
        });
        if (!incomingDbMessage) {
            console.error(`Falha ao salvar mensagem recebida de ${senderNumber} no banco.`);
        }
    } catch (dbError) {
        console.error('Erro ao salvar mensagem recebida no DB:', dbError);
    }

    const autoResponseMessage = `Olá ${senderName}! Recebemos sua mensagem. Entraremos em contato em breve, aguarde um momento.`;

    try {
        const sentAutoResponse = await client.sendMessage(senderNumber, autoResponseMessage);
        console.log(`Auto-resposta enviada para ${senderNumber}. WA ID: ${sentAutoResponse.id.id}`);

        await saveMessageToDb(supabase, senderInfo, wss, {
            recipient_number: senderNumber,
            recipient_name: senderName,
            body: autoResponseMessage,
            is_outgoing: true, 
            status: 'pending', 
            timestamp: new Date(),
            has_media: false,
            message_type: 'auto_response', 
            message_id: sentAutoResponse.id.id 
        });
    } catch (error) {
        console.error(`Erro ao enviar auto-resposta para ${senderNumber}:`, error.message);
        await saveMessageToDb(supabase, senderInfo, wss, {
            recipient_number: senderNumber,
            recipient_name: senderName,
            body: autoResponseMessage, 
            is_outgoing: true,
            status: 'error',
            timestamp: new Date(),
            has_media: false,
            message_type: 'auto_response',
            error_message: `Falha ao enviar: ${error.message}`
        });
    }

    if (operatorNumberFormatted) {
        const forwardHeader = `*Nova Mensagem Recebida*\n*De:* ${senderName} (${senderNumber.split('@')[0]})`;
        let forwardedMessageContent = `${forwardHeader}\n*Mensagem:* ${messageBody}`;
        let mediaToForward = null;

        if (hasMedia) {
            try {
                mediaToForward = await message.downloadMedia(); 
                if (mediaToForward) {
                    if (!messageBody) {
                        forwardedMessageContent = `${forwardHeader}\n*Mídia:* (Veja anexo)`;
                    } else {
                        forwardedMessageContent = messageBody; 
                    }
                } else {
                    forwardedMessageContent += '\n*(Falha ao encaminhar mídia)*';
                }
            } catch (mediaError) {
                console.error("Erro ao baixar mídia para encaminhamento:", mediaError);
                forwardedMessageContent += '\n*(Erro ao processar mídia para encaminhamento)*';
            }
        }

        try {
            let sentForwardedMessage;
            if (mediaToForward) {
                sentForwardedMessage = await client.sendMessage(operatorNumberFormatted, mediaToForward, { caption: forwardedMessageContent });
                console.log(`Mídia encaminhada para o operador (${operatorNumberRaw}). WA ID: ${sentForwardedMessage.id.id}`);
            } else {
                sentForwardedMessage = await client.sendMessage(operatorNumberFormatted, forwardedMessageContent);
                console.log(`Mensagem de texto encaminhada para o operador (${operatorNumberRaw}). WA ID: ${sentForwardedMessage.id.id}`);
            }

            await saveMessageToDb(supabase, senderInfo, wss, {
                recipient_number: operatorNumberFormatted, 
                body: forwardedMessageContent, 
                is_outgoing: true, 
                status: 'pending', 
                timestamp: new Date(),
                has_media: !!mediaToForward, 
                media_mime_type: mediaToForward ? mediaToForward.mimetype : null,
                message_type: 'forwarded', 
                message_id: sentForwardedMessage.id.id 
            });
        } catch (error) {
            console.error(`Erro ao encaminhar mensagem para o operador (${operatorNumberRaw}):`, error.message);
            await saveMessageToDb(supabase, senderInfo, wss, {
                recipient_number: operatorNumberFormatted,
                body: forwardedMessageContent, 
                is_outgoing: true,
                status: 'error',
                timestamp: new Date(),
                has_media: !!mediaToForward,
                media_mime_type: mediaToForward ? mediaToForward.mimetype : null,
                message_type: 'forwarded',
                error_message: `Falha ao encaminhar: ${error.message}`
            });
        }
    } else {
        console.log("Número do operador não configurado, mensagem não encaminhada.");
    }
});

client.on('message_ack', async (message, ack) => {
    const statusMap = {
        '-1': 'error', 0: 'pending', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' 
    };
    let newStatus = statusMap[ack] || 'unknown';
    if (newStatus === 'played') newStatus = 'read'; 

    console.log(`Atualização ACK Mensagem: WA_ID=${message.id.id}, Status=${newStatus} (${ack})`);

    if (!message.fromMe) {
        return;
    }

    try {
        const { data: existingMsg, error: findError } = await supabase
            .from('messages')
            .select('id, status') 
            .eq('message_id', message.id.id)
            .maybeSingle(); 

        if (findError) {
            console.error(`Erro Supabase ao encontrar mensagem pelo WA ID ${message.id.id} para atualização ACK:`, findError);
        } else if (existingMsg) {
            const currentStatus = existingMsg.status;
            const statusHierarchy = ['pending', 'sent', 'delivered', 'read', 'error']; 
            const currentIndex = statusHierarchy.indexOf(currentStatus);
            const newIndex = statusHierarchy.indexOf(newStatus);

            if (newStatus === 'error' || currentIndex < newIndex || !['read', 'error'].includes(currentStatus)) {
                await updateMessageStatusAndId(supabase, wss, existingMsg.id, message.id.id, newStatus);
            } else {
            }
        } else {
            console.warn(`Mensagem com WA ID ${message.id.id} não encontrada no DB para atualização ACK. Pode ser uma mensagem antiga ou falha no salvamento inicial.`);
        }
    } catch (dbError) {
        console.error(`Erro ao processar atualização ACK para WA ID ${message.id.id}:`, dbError);
    }
});

client.on('disconnected', (reason) => {
    console.log('Cliente WhatsApp foi desconectado:', reason);
    qrCodeData = null;
    connectedClientNumber = null; 
    updateClientStatus('DISCONNECTED', wss); 
    wss.broadcast({ type: 'disconnected', payload: reason });
    console.log('Tentando destruir e reinicializar o cliente...');
    setTimeout(() => {
        client.destroy().then(() => {
            console.log('Cliente destruído. Reinicializando...');
            return client.initialize(); 
        }).catch(err => {
            console.error('Falha ao destruir ou reinicializar cliente após desconexão:', err);
        });
    }, 5000); 
});

client.initialize().catch(err => {
    console.error("Falha fatal ao inicializar cliente WhatsApp:", err);
    updateClientStatus('FATAL_ERROR', wss); 
});

app.post('/send-message', uploadSingle, async (req, res) => {
    if (clientStatus !== 'READY') {
        return res.status(400).json({ status: 'error', message: `Cliente WhatsApp não está pronto. Status atual: ${clientStatus}` });
    }

    const { number, message, name } = req.body; 
    const imageFile = req.file; 

    if (!number || (!message && !imageFile)) { 
        return res.status(400).json({ status: 'error', message: 'Número do destinatário e (mensagem ou imagem) são obrigatórios.' });
    }

    const recipientId = formatWhatsappNumber(number);

    if (!/^\d+@c\.us$/.test(recipientId)) {
        return res.status(400).json({ status: 'error', message: 'Formato inválido de número do destinatário para envio.' });
    }

    let media = null;
    let mediaMimeType = null;
    if (imageFile) {
        try {
            media = new MessageMedia(imageFile.mimetype, imageFile.buffer.toString('base64'), imageFile.originalname);
            mediaMimeType = imageFile.mimetype;
        } catch (mediaError) {
            console.error("Erro ao criar MessageMedia:", mediaError);
            return res.status(500).json({ status: 'error', message: 'Falha ao processar imagem enviada.' });
        }
    }

    const senderInfo = getClientInfo(client);

    const dbMessage = await saveMessageToDb(supabase, senderInfo, wss, {
        recipient_number: number,
        recipient_name: name || null, 
        body: message || '', 
        status: 'pending',
        is_outgoing: true,
        has_media: !!media,
        media_mime_type: mediaMimeType,
        message_type: 'manual_single' 
    });

    if (!dbMessage) {
        return res.status(500).json({ status: 'error', message: 'Falha ao salvar estado inicial da mensagem no banco de dados.' });
    }

    try {
        let sentMessage;
        if (media) {
            sentMessage = await client.sendMessage(recipientId, media, { caption: message || '' });
        } else {
            sentMessage = await client.sendMessage(recipientId, message);
        }
        console.log(`Mensagem enviada com sucesso para ${number}. WA ID: ${sentMessage.id.id}`);

        await updateMessageStatusAndId(supabase, wss, dbMessage.id, sentMessage.id.id, 'sent');

        res.status(200).json({ status: 'Envio da mensagem iniciado.', messageId: sentMessage.id.id, dbId: dbMessage.id });

    } catch (error) {
        console.error(`Erro ao enviar mensagem para ${number}:`, error);
        await updateMessageStatusAndId(supabase, wss, dbMessage.id, null, 'error', error.message || 'Erro desconhecido no envio');
        res.status(500).json({ status: 'error', message: `Falha ao enviar mensagem: ${error.message}` });
    }
});

app.post('/upload-mailing', uploadBulk, async (req, res) => {
    if (clientStatus !== 'READY') {
        return res.status(400).json({ status: 'error', message: `Cliente WhatsApp não está pronto. Status: ${clientStatus}` });
    }

    const csvFile = req.files?.csvFile?.[0];
    const imageFile = req.files?.imageFile?.[0]; 
    const messageTemplate = req.body.message; 

    if (!csvFile) {
        return res.status(400).json({ status: 'error', message: 'Nenhum arquivo CSV enviado.' });
    }
    if (!messageTemplate && !imageFile) { 
        return res.status(400).json({ status: 'error', message: 'Modelo de mensagem ou imagem é obrigatório para envio em massa.' });
    }

    let imageBuffer = null;
    let imageMimeType = null;
    if (imageFile) {
        imageBuffer = imageFile.buffer;
        imageMimeType = imageFile.mimetype;
        console.log(`Envio em massa iniciado com imagem: ${imageFile.originalname} (${imageMimeType})`);
    } else {
        console.log("Envio em massa iniciado sem imagem.");
    }

    res.status(202).json({ status: 'CSV recebido. Processando e enviando mensagens em segundo plano.' }); 

    processCsvAndSendBulk(client, supabase, wss, csvFile.buffer, messageTemplate || '', imageBuffer, imageMimeType)
        .catch(error => {
            console.error("Erro durante o processo de envio em massa:", error);
            wss.broadcast({ type: 'error', payload: `Erro fatal no envio em massa: ${error.message}` });
            wss.broadcast({ type: 'bulk_complete', payload: { total: '?', sent: 0, failed: 'Todos', error: error.message } });
        });
});

app.get('/messages', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false }) 
            .limit(100); 

        if (error) {
            console.error('Erro Supabase ao buscar mensagens:', error);
            return res.status(500).json({ status: 'error', message: 'Falha ao buscar mensagens do banco de dados.' });
        }

        res.status(200).json(data || []);
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error);
        res.status(500).json({ status: 'error', message: 'Ocorreu um erro inesperado.' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Cliente WebSocket Conectado');
    const currentClientInfo = getClientInfo(client);
    ws.send(JSON.stringify({ type: 'client_status', payload: { status: clientStatus, clientNumber: currentClientInfo.number } }));

    if (clientStatus === 'WAITING_QR' && qrCodeData) {
        ws.send(JSON.stringify({ type: 'qr', payload: qrCodeData }));
    }

    ws.on('message', (message) => {
        console.log('Mensagem WS recebida:', message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'getStatus') {
                const currentInfo = getClientInfo(client);
                ws.send(JSON.stringify({ type: 'client_status', payload: { status: clientStatus, clientNumber: currentInfo.number } }));
            }
        } catch (e) {
            console.error("Falha ao parsear mensagem WS ou formato inválido:", message.toString());
        }
    });
    ws.on('close', () => console.log('Cliente WebSocket Desconectado'));
    ws.on('error', (error) => console.error('Erro WebSocket:', error));
});

wss.broadcast = (data) => {
    const jsonData = JSON.stringify(data);
    wss.clients.forEach((wsClient) => {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(jsonData, (err) => {
                if (err) console.error('Erro ao enviar mensagem para cliente WebSocket:', err);
            });
        }
    });
};

server.listen(port, () => {
    console.log(`Servidor backend rodando em http://localhost:${port}`);
    console.log(`Servidor WebSocket rodando em ws://localhost:${port}`);
});

process.on('SIGINT', async () => {
    console.log("\nRecebido SIGINT (Ctrl+C). Encerrando graciosamente...");
    console.log("Fechando servidor HTTP/WebSocket...");
    server.close(() => {
        console.log("Servidor HTTP/WebSocket fechado.");
    });
    wss.close(); 

    if (client) {
        console.log("Destruindo cliente WhatsApp...");
        try {
            await client.destroy();
            console.log("Cliente WhatsApp destruído.");
        } catch (e) {
            console.error("Erro ao destruir cliente WhatsApp:", e);
        }
    }
    console.log("Saindo do processo.");
    setTimeout(() => process.exit(0), 1000);
});