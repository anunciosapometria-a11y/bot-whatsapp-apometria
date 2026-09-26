/**
 * Webhook Server — Instituto Apometria Brasil
 * WhatsApp Cloud API + Claude API
 *
 * Dependências: npm install express axios @anthropic-ai/sdk dotenv
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,          // Token de acesso permanente (System User Token)
  WHATSAPP_PHONE_ID,       // Phone Number ID do número do bot (novo chip)
  WEBHOOK_VERIFY_TOKEN,    // Token que você define pra verificação do webhook
  ANTHROPIC_API_KEY,       // Chave da API da Anthropic (Claude)
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── MEMÓRIA DE SESSÕES ────────────────────────────────────────────────────────
// Guarda o histórico de mensagens por número de telefone (em memória, persiste enquanto o server rodar)
// Para produção: substituir por banco de dados (Redis, Postgres, etc.)
const sessions = new Map();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos sem mensagem → reinicia sessão
const MAX_HISTORY_MESSAGES = 20; // máximo de mensagens no histórico

function getSession(phone) {
  const now = Date.now();
  const session = sessions.get(phone);

  if (session && (now - session.lastActivity) < SESSION_TIMEOUT_MS) {
    session.lastActivity = now;
    return session;
  }

  // Sessão nova ou expirada
  const newSession = {
    history: [],
    lastActivity: now,
    state: 'menu', // estados: menu | agendamento_nome | agendamento_data | agendamento_tipo
    agendamento: {}
  };
  sessions.set(phone, newSession);
  return newSession;
}

// ─── SYSTEM PROMPT DO BOT ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente virtual do Instituto Apometria Brasil, responsável pelo primeiro atendimento dos nossos clientes pelo WhatsApp.

## Quem somos
O Instituto Apometria Brasil oferece sessões de apometria — uma técnica de terapia energética que trabalha com a harmonização dos campos energéticos, removendo bloqueios emocionais e espirituais. As sessões são realizadas à distância pelo terapeuta Paulo Rodrigues.

## Suas responsabilidades
- Recepcionar clientes com cordialidade e calor humano
- Apresentar os serviços disponíveis
- Esclarecer dúvidas frequentes
- Coletar dados para agendamento
- Informar preços e formas de pagamento
- Para assuntos pessoais, resultados de sessões ou questões que precisam da presença do Paulo: orientar o cliente a entrar em contato pelo número pessoal do Paulo (+55 17 98827-1998)

## Serviços e preços
- **Sessão de Apometria a Distância**: R$ 150,00
  - Duração: o trabalho energético é realizado remotamente, em horário combinado
  - O terapeuta Paulo envia o relatório completo da sessão após o atendimento
  - Funciona para: limpeza energética, desbloqueio emocional, harmonização, proteção energética
- **Pacote 3 Sessões**: R$ 400,00 (economia de R$ 50,00)
- **Pacote 5 Sessões**: R$ 600,00 (economia de R$ 150,00)

## Formas de pagamento
- Pix (chave: informar que será enviada após confirmação do agendamento)
- Cartão de crédito (link de pagamento enviado por email ou WhatsApp)

## Horários disponíveis
- Segunda a sexta: 9h às 18h
- Sábado: 9h às 13h
- Domingo: fechado

## Processo de agendamento
1. Cliente informa nome completo
2. Cliente informa data e horário desejado (o Paulo confirma disponibilidade)
3. Cliente escolhe tipo de serviço
4. Dados são registrados e Paulo entrará em contato para confirmação e envio do link de pagamento

## Perguntas frequentes
**O que é apometria?**
Apometria é uma técnica terapêutica desenvolvida pelo Dr. José Lacerda de Azevedo que trabalha com a desvinculação e harmonização de energias espirituais. É realizada por um médium treinado que, em estado de dissociação controlada, trabalha nos campos energéticos do paciente.

**Como funciona a sessão à distância?**
A sessão à distância é tão eficaz quanto a presencial. No horário combinado, o terapeuta Paulo realiza o trabalho energético focado em você, onde quer que você esteja. Após a sessão, você receberá um relatório detalhado pelo WhatsApp.

**Preciso fazer alguma coisa durante a sessão?**
É recomendado que você esteja em um lugar tranquilo, de preferência deitado ou sentado confortavelmente. Tente evitar atividades que demandem atenção (dirigir, reuniões, etc.) no horário da sessão.

**Para quem é indicada?**
Para pessoas que buscam equilíbrio emocional, espiritual e energético. Ajuda com ansiedade, medos, bloqueios emocionais, questões espirituais, relacionamentos, e bem-estar geral.

**É religioso?**
Não. A apometria é uma técnica terapêutica que independe de religião. Pode ser realizada e aproveitada por pessoas de qualquer crença.

## Regras de comunicação
- Tom: acolhedor, profissional, empático — como um instituto sério mas humano
- Respostas curtas e diretas — O WhatsApp não é lugar para textos longos
- Use emojis com moderação (1-2 por mensagem, no máximo)
- Nunca faça promessas de cura ou resultados garantidos
- Se não souber algo, diga que vai verificar com o Paulo e peça que aguarde
- Para questões sensíveis de saúde, sempre orientar a procurar um médico além da terapia
- NUNCA fique inventando informações sobre a empresa — apenas use o que está neste prompt
- Se o cliente pedir para falar com o Paulo diretamente, informe o número +55 17 98827-1998

## Formato das respostas
- Máximo de 3-4 parágrafos curtos
- Quando apresentar menu ou opções, use numeração simples (1, 2, 3...)
- Sempre termine com uma pergunta ou chamada para ação quando apropriado`;

// ─── MENU INICIAL ──────────────────────────────────────────────────────────────
const MENU_BOAS_VINDAS = `Olá! 👋 Bem-vindo ao *Instituto Apometria Brasil*!

Sou o assistente virtual do Instituto. Como posso te ajudar hoje?

*1.* 📋 Conhecer nossos serviços e preços
*2.* 📅 Agendar uma sessão
*3.* ❓ Tirar dúvidas sobre apometria
*4.* 💬 Falar com o terapeuta Paulo

Digite o número da opção desejada ou escreva sua dúvida livremente.`;

// ─── ENVIAR MENSAGEM VIA WHATSAPP API ─────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Mensagem enviada para ${to}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar mensagem para ${to}:`, err.response?.data || err.message);
  }
}

// ─── PROCESSAR MENSAGEM COM CLAUDE ────────────────────────────────────────────
async function processWithClaude(session, userMessage) {
  // Adiciona mensagem do usuário ao histórico
  session.history.push({ role: 'user', content: userMessage });

  // Mantém histórico no limite
  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // modelo rápido e barato para atendimento
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: session.history
    });

    const assistantMessage = response.content[0].text;

    // Adiciona resposta do assistente ao histórico
    session.history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (err) {
    console.error('❌ Erro na API do Claude:', err.message);
    return 'Desculpe, tive um problema técnico. Por favor, tente novamente em instantes ou entre em contato com o Paulo diretamente pelo +55 17 98827-1998. 🙏';
  }
}

// ─── LÓGICA DE ROTEAMENTO DE MENSAGENS ───────────────────────────────────────
async function handleMessage(from, messageText) {
  const session = getSession(from);
  const text = messageText.trim();

  console.log(`📩 Mensagem de ${from}: "${text}" | Estado: ${session.state}`);

  // Primeiro contato → envia menu de boas-vindas
  if (session.history.length === 0) {
    await sendMessage(from, MENU_BOAS_VINDAS);
    // Registra no histórico sem chamar Claude
    session.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: MENU_BOAS_VINDAS }
    );
    return;
  }

  // Atalho rápido: opção 4 → encaminha para Paulo sem Claude
  if (text === '4' && session.history.length <= 3) {
    const msg = `Para falar diretamente com o terapeuta Paulo Rodrigues, entre em contato pelo número:\n\n📱 *+55 17 98827-1998*\n\nEle poderá te atender com toda a atenção que você merece! 😊`;
    await sendMessage(from, msg);
    session.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: msg }
    );
    return;
  }

  // Para todas as demais mensagens → processa com Claude
  const response = await processWithClaude(session, text);
  await sendMessage(from, response);
}

// ─── ROTAS DO WEBHOOK ─────────────────────────────────────────────────────────

// Verificação do webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    console.warn('⚠️ Falha na verificação do webhook');
    res.sendStatus(403);
  }
});

// Recebimento de mensagens (POST)
app.post('/webhook', async (req, res) => {
  // Responde imediatamente com 200 (obrigatório — WhatsApp exige resposta rápida)
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          // Só processa mensagens de texto por agora
          if (message.type !== 'text') {
            await sendMessage(
              message.from,
              'No momento processo apenas mensagens de texto. Por favor, escreva sua dúvida ou escolha uma opção do menu! 😊'
            );
            continue;
          }

          const from = message.from;
          const text = message.text.body;

          // Processa de forma assíncrona (não bloqueia o webhook)
          handleMessage(from, text).catch(err => {
            console.error(`❌ Erro ao processar mensagem de ${from}:`, err);
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro no processamento do webhook:', err);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// ─── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Webhook em: http://localhost:${PORT}/webhook`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
