require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

// ⚙️ === CONFIGURAÇÕES — PREENCHA DEPOIS ===
const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';
const ASAAS_ENV = 'sandbox'; // depois mude para 'production'
const SEU_WHATSAPP = '5582991859592'; // só números + DDD
const VALOR_COTA = 1.20;

const BASE_URL = ASAAS_ENV === 'sandbox' 
    ? 'https://sandbox.asaas.com/api/v3' 
    : 'https://api.asaas.com/v3';

// Banco de dados temporário (para produção → PostgreSQL)
let vendas = [];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // serve os arquivos index.html e painel.html

// 🔹 Gerar 6 números aleatórios por cota
function gerarNumeros(qtd) {
    const nums = [];
    for(let i=0;i<qtd;i++){
        const bloco = [];
        for(let j=0;j<6;j++) bloco.push(String(Math.floor(Math.random()*10)));
        nums.push(bloco.join(' - '));
    }
    return nums;
}

// 🔹 Mensagem automática para o CLIENTE
function msgClienteTexto(venda) {
    return `🎉 *PAGAMENTO CONFIRMADO — RIFA DO GÊMEOS!* 🎉

Olá ${venda.nome}! Seu pagamento de R$ ${venda.valorTotal.toFixed(2).replace('.', ',')} foi confirmado ✅

🎟️ *Seus números da sorte:*
${venda.numeros.map((n,i) => `${i+1}. ${n}`).join('\n')}

📋 *Resumo:*
• Quantidade: ${venda.quantidade} cota(s)
• Valor: R$ ${VALOR_COTA.toFixed(2).replace('.', ',')} cada
• Sorteio: pela Loteria Federal

🍀 Boa sorte! Que a sorte esteja com você!
Rifa do Gêmeos — 4x T-Cross + 4x CG 160`;
}

// 🔹 Mensagem automática para VOCÊ
function msgAdminTexto(venda) {
    return `🔔 *NOVA VENDA CONFIRMADA!* 🔔

👤 *Cliente:* ${venda.nome}
📱 *WhatsApp:* ${venda.whatsapp}
📄 *CPF:* ${venda.cpf}
🎟️ *Cotas:* ${venda.quantidade}
💰 *Valor:* R$ ${venda.valorTotal.toFixed(2).replace('.', ',')}

🎯 *Números gerados:*
${venda.numeros.join(' | ')}

---
✅ Pagamento confirmado via Asaas!`;
}

// 🔹 Enviar WhatsApp automático via Fonnte
async function enviarWhatsApp(numero, mensagem) {
    if(!FONNTE_TOKEN) {
        console.log('⚠️ Token Fonnte não configurado — mensagem não enviada');
        return;
    }
    try {
        const resposta = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: {
                'Authorization': FONNTE_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target: numero.replace(/\D/g, ''),
                message: mensagem,
                delay: 1,
                typing: true
            })
        });
        const resultado = await resposta.json();
        console.log(`📲 WhatsApp enviado para ${numero}:`, resultado);
        return resultado;
    } catch (erro) {
        console.error('❌ Erro ao enviar WhatsApp:', erro);
    }
}

// 🔹 Criar pagamento Pix no Asaas
app.post('/api/criar-pagamento', async (req, res) => {
    try {
        const { nome, cpf, whatsapp, quantidade, valorTotal } = req.body;
        
        if(!ASAAS_API_KEY) return res.status(500).json({error: 'Chave Asaas não configurada! Preencha no arquivo .env'});

        // 1. Criar cliente no Asaas
        const clienteRes = await fetch(`${BASE_URL}/customers`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY},
            body: JSON.stringify({
                name: nome,
                cpfCnpj: cpf.replace(/\D/g, ''),
                mobilePhone: whatsapp.replace(/\D/g, '')
            })
        });
        const cliente = await clienteRes.json();
        if(cliente.errors) return res.status(400).json({error: cliente.errors[0].description});

        // 2. Criar cobrança Pix
        const pagamentoRes = await fetch(`${BASE_URL}/payments`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY},
            body: JSON.stringify({
                customer: cliente.id,
                billingType: 'PIX',
                value: valorTotal,
                dueDate: new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0],
                description: `Rifa do Gêmeos — ${quantidade} cota(s)`
            })
        });
        const pagamento = await pagamentoRes.json();
        if(pagamento.errors) return res.status(400).json({error: pagamento.errors[0].description});

        // 3. Pegar QR Code do Pix
        const pixRes = await fetch(`${BASE_URL}/payments/${pagamento.id}/pixQrCode`, {
            headers: { 'access_token': ASAAS_API_KEY }
        });
        const pix = await pixRes.json();

        // 4. Gerar números e salvar venda
        const numeros = gerarNumeros(quantidade);
        const venda = {
            id: pagamento.id, nome, cpf, whatsapp, quantidade, valorTotal, numeros,
            status: 'PENDING', createdAt: new Date().toISOString()
        };
        vendas.push(venda);

        res.json({
            paymentId: pagamento.id,
            qrCodeImage: `data:image/png;base64,${pix.encodedImage}`,
            qrCodePayload: pix.payload
        });
    } catch(e) {
        console.error(e);
        res.status(500).json({error: 'Erro ao criar pagamento: ' + e.message});
    }
});

// 🔹 Webhook — CONFIRMAÇÃO AUTOMÁTICA DO ASAAS
app.post('/api/webhook-asaas', async (req, res) => {
    const { event, payment } = req.body;
    
    // Só processa quando o pagamento for confirmado
    if(event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
        const venda = vendas.find(v => v.id === payment.id);
        
        // Só envia mensagens UMA vez!
        if(venda && venda.status !== 'CONFIRMED' && venda.status !== 'RECEIVED') {
            venda.status = payment.status;
            console.log(`✅ PAGAMENTO CONFIRMADO: ${venda.nome} — R$ ${venda.valorTotal}`);
            
            // 📲 Envia para o CLIENTE automaticamente
            await enviarWhatsApp(venda.whatsapp, msgClienteTexto(venda));
            
            // 🔔 Envia notificação para VOCÊ
            await enviarWhatsApp(SEU_WHATSAPP, msgAdminTexto(venda));
        }
    }
    
    res.sendStatus(200);
});

// 🔹 Verificar status do pagamento
app.get('/api/status/:id', async (req, res) => {
    const venda = vendas.find(v => v.id === req.params.id);
    if(!venda) return res.status(404).json({error: 'Não encontrado'});
    
    try {
        const r = await fetch(`${BASE_URL}/payments/${req.params.id}`, {
            headers: { 'access_token': ASAAS_API_KEY }
        });
        const p = await r.json();
        venda.status = p.status;
        res.json({ status: p.status });
    } catch {
        res.json({ status: venda.status });
    }
});

// 🔹 Listar todas as vendas (painel)
app.get('/api/vendas', (req, res) => res.json(vendas));

// 🔹 Iniciar servidor
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`🚀 Servidor rodando na porta ${PORTA}`));
