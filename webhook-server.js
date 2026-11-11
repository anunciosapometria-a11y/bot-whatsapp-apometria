/**
 * Webhook Server — Instituto Apometria Brasil
 * WhatsApp Cloud API + Claude API
 *
 * Dependências: npm install express axios @anthropic-ai/sdk dotenv pg
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,          // Token de acesso permanente (System User Token)
  WHATSAPP_PHONE_ID,       // Phone Number ID do número do bot
  WEBHOOK_VERIFY_TOKEN,    // Token que você define pra verificação do webhook
  ANTHROPIC_API_KEY,       // Chave da API da Anthropic (Claude)
  LOGO_URL,                // URL pública da imagem do logo (enviada na abertura)
  DATABASE_URL,            // Criada automaticamente pelo Railway ao adicionar o Postgres
  DASHBOARD_USER,          // Usuário do painel de conversas
  DASHBOARD_PASSWORD,      // Senha do painel de conversas
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── BANCO DE DADOS (histórico de conversas + comprovantes) ──────────────────
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('⚠️ DATABASE_URL não configurada — painel/histórico permanente desativados.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      client_name TEXT,
      stage TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,       -- 'in' (cliente) ou 'out' (bot/Paulo)
      content TEXT,
      media_base64 TEXT,
      media_mime TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await initCrm();
  console.log('🗄️  Banco de dados pronto.');
}

async function upsertConversation(phone, clientName, stage) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO conversations (phone, client_name, stage, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (phone) DO UPDATE SET
         client_name = COALESCE(EXCLUDED.client_name, conversations.client_name),
         stage = EXCLUDED.stage,
         updated_at = now()`,
      [phone, clientName, stage]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar conversa no banco:', err.message);
  }
  await crmAtualizarFunil(phone, sessions.get(phone));
  salvarSnapshot(phone);
}

// Guarda o estado da conversa no banco: se a sessão em memória sumir (reinício, 7 dias), o cliente continua de onde parou, sem nova introdução
function salvarSnapshot(phone) {
  const s = sessions.get(phone);
  if (!pool || !s) return;
  try {
    const snap = {};
    for (const [k, v] of Object.entries(s)) {
      if (['lastActivity', 'pausado', 'pausadoEm', 'pausadoPor', 'askedAt', 'valoresEmAndamento', 'ultimoAudio', '_restaurado'].includes(k)) continue;
      if (typeof v === 'function') continue;
      snap[k] = v;
    }
    if (typeof snap.etapa === 'string') snap.etapa = snap.etapa.replace(/_andamento$/, '');
    if (Array.isArray(snap.history)) snap.history = snap.history.slice(-MAX_HISTORY_MESSAGES);
    pool.query('INSERT INTO crm_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['sess_' + phone, JSON.stringify(snap)]).catch(() => {});
  } catch (e) {}
}

async function restaurarSessao(phone, session) {
  if (!pool || session._restaurado) return;
  session._restaurado = true;
  if (session.stage !== 'abertura' || (session.history && session.history.length)) return;
  try {
    const sn = await pool.query('SELECT value FROM crm_config WHERE key = $1', ['sess_' + phone]);
    if (sn.rows[0]) {
      const dados = JSON.parse(sn.rows[0].value);
      if (dados.stage && dados.stage !== 'abertura') {
        Object.assign(session, dados);
        console.log(`♻️ Sessão de ${phone} restaurada (estágio ${session.stage}, etapa ${session.etapa || '-'}).`);
        return;
      }
    }
    const cv = await pool.query('SELECT stage, client_name FROM conversations WHERE phone = $1', [phone]);
    if (cv.rows[0] && cv.rows[0].stage && cv.rows[0].stage !== 'abertura') {
      const { rows } = await pool.query(`SELECT direction, content FROM messages WHERE phone = $1 AND content IS NOT NULL ORDER BY created_at DESC LIMIT 12`, [phone]);
      session.history = rows.reverse().filter(r => r.content && !/^\[(documento|imagem|áudio)/.test(r.content)).map(r => ({ role: r.direction === 'in' ? 'user' : 'assistant', content: r.content }));
      while (session.history.length && session.history[0].role !== 'user') session.history.shift();
      session.stage = 'conversa';
      session.pediuNome = true;
      session.clientName = cv.rows[0].client_name || null;
      console.log(`♻️ Cliente de volta ${phone}: segue a conversa sem nova introdução.`);
    }
  } catch (e) { console.error('❌ Restaurar sessão:', e.message); }
}

async function saveMessage(phone, direction, content, mediaBase64 = null, mediaMime = null) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO messages (phone, direction, content, media_base64, media_mime)
       VALUES ($1, $2, $3, $4, $5)`,
      [phone, direction, content, mediaBase64, mediaMime]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar mensagem no banco:', err.message);
  }
}

// ─── BAIXAR MÍDIA (comprovante) ENVIADA PELO CLIENTE ──────────────────────────
async function baixarMidiaWhatsapp(mediaId) {
  try {
    const infoRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const { url, mime_type } = infoRes.data;

    const fileRes = await axios.get(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });

    return {
      base64: Buffer.from(fileRes.data).toString('base64'),
      mime: mime_type
    };
  } catch (err) {
    console.error('❌ Erro ao baixar mídia do WhatsApp:', err.response?.data || err.message);
    return null;
  }
}

// ─── MEMÓRIA DE SESSÕES ────────────────────────────────────────────────────────
const sessions = new Map();

// A conversa continua de onde parou mesmo depois de horas ou dias sem resposta (antes reiniciava em 30 min)
const SESSION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20;
const PAUSE_TTL_MS = 4 * 60 * 60 * 1000; // pausa do bot expira sozinha se ninguém assumir

function getSession(phone) {
  const now = Date.now();
  const session = sessions.get(phone);

  // Conversa pausada não expira por inatividade: o histórico fica até a retomada
  if (session && (session.pausado || (now - session.lastActivity) < SESSION_TIMEOUT_MS)) {
    session.lastActivity = now;
    return session;
  }

  const newSession = {
    history: [],
    lastActivity: now,
    stage: 'abertura',
    etapa: null,
    clientName: null,
    ref: null,
    pausado: false,
    pausadoEm: null,
    pausadoPor: null
  };
  sessions.set(phone, newSession);
  return newSession;
}

// ─── SYSTEM PROMPT DO BOT ─────────────────────────────────────────────────────
const REGRA_DESVIO = 'Analise o que a pessoa respondeu e responda com acolhimento em no máximo 2 mensagens curtas. Nunca explique as etapas por conta própria, nunca escreva "Etapa 1/2/3" nem envie vários textos seguidos. Não pergunte o motivo do atendimento. Termine repetindo a pergunta pendente de forma curta.';
function hintEtapa(etapa) {
  if (etapa === 'oferta') return 'ETAPA ATUAL: a pessoa ainda não respondeu à oferta de explicar outras partes do trabalho (procedimento, o que recebe, agendamento). ' + REGRA_DESVIO;
  if (etapa === 'modalidade') return 'ETAPA ATUAL: a pessoa recebeu a lista de modalidades (1 Individual, 2 Emergencial, 3 Pacote de 4 sessões, 4 Familiar, 5 Presencial) e perguntamos qual prefere. A resposta dela (número ou nome) é a escolha: siga o passo ESCOLHA E PAGAMENTO e as REGRAS PRIORITÁRIAS de pagamento (Pix e link do cartão juntos). Presencial não está disponível: ofereça o trabalho à distância.';
  if (etapa === 'aguarda1') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 1. Pergunta pendente: "' + PERGUNTA1 + '". ' + REGRA_DESVIO;
  if (etapa === 'aguarda2') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 2. Pergunta pendente: "' + PERGUNTA2 + '". ' + REGRA_DESVIO;
  if (etapa === 'aguarda3') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 3. Pergunta pendente: "' + PERGUNTA3 + '". ' + REGRA_DESVIO;
  if (etapa === 'nome') return 'ETAPA ATUAL: a pessoa ainda não disse o nome (pergunte uma única vez; se ela não disser, siga sem insistir). Ela respondeu algo que não é um nome. Responda de forma condizente ao que ela disse, em uma ou duas frases, sem tratar nenhuma palavra como nome, e peça o nome com gentileza no final. Não explique o trabalho nem envie valores ainda.';
  if (etapa === 'para_quem' || etapa === 'para_quem_andamento' || etapa === 'queixa') return 'ETAPA ATUAL: a pessoa acabou de responder para quem quer solicitar a apometria (e pode ter descrito o caso ou a queixa). Responda em uma ou duas frases curtas, com as palavras dela: se descreveu um problema ou queixa, explique brevemente como a apometria pode ser positiva para o caso dela (investigar a causa, tratar, trazer mais leveza e clareza, sem prometer cura); se disse só para quem é, acolha em uma frase (para outra pessoa, lembre que pode solicitar mesmo sem a permissão e a consciência dela). Não faça perguntas, não explique o procedimento nem fale de valores: o sistema envia as etapas logo em seguida.';
  return 'ETAPA ATUAL: etapas concluídas. Siga o passo 2 do fluxo.';
}

function buildSystemPrompt(clientName, etapa) {
  return `Você atende pelo WhatsApp em nome da equipe do Instituto Terapias Brasil, conduzido pelo terapeuta Paulo Rodrigues. Seu objetivo é acolher a pessoa, explicar com clareza e levá-la, sem pressão, até a decisão e o pagamento da sessão de apometria. Vendemos somente apometria. Se perguntarem por outra terapia, diga que no momento o atendimento é de apometria.

## REGRAS PRIORITÁRIAS (valem acima de qualquer outra instrução abaixo)
- TOM SÉRIO E DIRETO. Nunca use "Que bom", "Prazer", "Fico feliz", "Maravilha", "Show", "Adorei", exclamações nem frases animadas. Quando precisar confirmar, use: "Ok, entendo perfeitamente.", "Ok, perfeito.", "Ok, combinado.". No máximo um emoji, e só o 🙏 ao encerrar.
- ANUNCIE ANTES DE ENVIAR. Antes de cada envio diga em uma frase curta o que vai enviar: "Vou lhe enviar os dados bancários, segue abaixo.", "Vou lhe enviar o link, segue abaixo.", "Vou lhe enviar as opções de agendamento, segue abaixo.", "Vou lhe enviar o informativo, segue abaixo." (mensagem separada por "|||" antes do conteúdo).
- NUNCA peça áudio, nunca ofereça receber áudio e nunca diga que a pessoa pode mandar áudio. Este canal não ouve áudios. Se a pessoa mencionar áudio, diga que este canal de atendimento não consegue ouvir áudios e peça, se possível, que escreva.
- NÃO pergunte o motivo do atendimento, a queixa nem o objetivo da pessoa. Se ela contar por conta própria, reconheça em uma frase curta e siga o fluxo. Nunca faça perguntas fora das previstas no fluxo.
- Responda UMA vez a tudo o que a pessoa enviou. Se a mensagem trouxer vários assuntos, leia o contexto inteiro e dê uma única resposta coerente, sem repetir informações já enviadas na conversa.
- PAGAMENTO: quando a pessoa escolher a modalidade, envie na MESMA resposta, em mensagens separadas por "|||": 1) "Vou lhe enviar os dados bancários para o Pix e o link para pagamento no cartão, segue abaixo." 2) os dados do Pix no formato indicado, com o valor e o nome da opção 3) "Se preferir pagar no cartão, em 2x sem juros (nos pacotes, em até 4x sem juros), segue o link:" com o link da opção escolhida (lista em FATOS). Assim ela escolhe a forma que preferir. Só omita o link se a opção não tiver link (presencial).
- CONTEXTO DA OPÇÃO: se a pessoa já falou, perguntou ou demonstrou interesse por uma opção ao longo da conversa (pacote, familiar, individual, emergencial, empresa, imóveis, animais), essa é a opção dela. Quando ela quiser agendar ou disser sim, NUNCA pergunte de novo qual opção prefere: siga direto com essa opção, enviando o Pix e o link do cartão. Só liste as modalidades se ela não tiver demonstrado nenhuma preferência. Reduza o atrito até o pagamento.
- PARCELAMENTO: sempre que enviar o link do cartão, diga que o parcelamento é em 2x sem juros (nos pacotes de 4 sessões e familiar, em até 4x sem juros).
- NÃO fale em prazo de 2 dias úteis para avaliar as informações nem em estudo do caso com prazo próprio. Os únicos prazos são 15 dias úteis (individual) e 08 dias úteis (emergencial), sempre sem a palavra "até".
- MODALIDADES: quando precisar listar as modalidades, liste TODAS as da foto de valores: Individual R$ 289,00 (15 dias úteis), Emergencial R$ 339,00 (08 dias úteis), Pacote de 4 sessões R$ 800,00 (R$ 200,00 cada), Familiar R$ 600,00 (até 5 pessoas da mesma família) e Presencial R$ 720,00 (indisponível no momento por falta de agenda).
- PACOTE E FAMILIAR: se a pessoa contratar o pacote de 4 sessões ou o familiar, depois do comprovante peça, na mensagem do nome e endereço, que informe também o nome completo de cada pessoa que será incluída no pacote, para a equipe adicionar cada uma no questionário. Aceite do jeito que vier.
- Se a pessoa disser que não quer continuar, não quer mais o atendimento ou não tem interesse, não insista e não argumente: apenas "Ok, entendemos perfeitamente. Agradecemos o seu contato e ficamos à disposição sempre que precisar. 🙏".

Nome do cliente nesta conversa: ${clientName || '(não informado)'}. Use o nome com naturalidade, sem repetir em toda mensagem.

${hintEtapa(etapa)}

## COMO VOCÊ FALA
- Sempre em nome da equipe, na primeira pessoa do plural: "recomendamos", "fazemos", "vamos verificar". Nunca use "eu", "recomendo", "faço", "posso".
- Mensagens curtas, uma ideia por mensagem, linguagem simples e direta, como uma pessoa que atende bem.
- Nunca use travessão. Nunca use frases prontas como "Que bom ter você aqui" ou "Fico feliz em ajudar".
- No máximo um emoji por mensagem, e só quando natural. Os textos das etapas, enviados pelo sistema, já trazem os emojis deles. O 🙏 serve para encerrar.
- Regra de conduta (não é uma frase para enviar): a apometria é um trabalho complementar. Nunca diga nem sugira que ela substitui o acompanhamento médico ou psicológico, e nunca incentive a pessoa a parar ou reduzir um tratamento, remédio ou terapia em curso. Não fale por conta própria de acompanhamento ou tratamento em curso, nem use avisos formais ou linguagem de contrato nas mensagens. A única exceção é quando a pessoa perguntar se a apometria cura (veja RESPOSTAS RÁPIDAS). Se a pessoa perguntar se pode parar ou reduzir um tratamento ou remédio, não incentive e passe para o Paulo.
- Negrito no WhatsApp usa um único asterisco de cada lado (*assim*). Nunca use dois asteriscos, títulos com # nem outro markdown.
- É terapia: fale de valores e de pagamento com sutileza e acolhimento. Nunca cobre depósito nem pagamento, não pressione, não lembre de pagar e não crie urgência.
- Mantenha-se no roteiro: não faça perguntas por conta própria nem puxe assuntos novos (só as perguntas previstas no fluxo). Responda apenas ao que a pessoa perguntou, com base nos textos e informações fornecidos, mantenha o mesmo padrão e vocabulário deles e conduza de volta ao próximo passo de forma leve.
- Nunca force a pessoa a dar respostas que você precisa saber (nome, para quem é, endereço, questionário). Se ela não responder ou sair do assunto, responda ao que ela disse e conduza de volta ao fluxo de forma leve, uma única vez, sem cobrar nem insistir. A exceção é a modalidade: pergunte qual ela prefere (individual, emergencial ou pacote) no momento certo, quando ela quiser agendar ou falar de pagamento e você ainda não souber qual escolheu, pois sem isso não dá para passar o valor do Pix. Peça o endereço da pessoa somente depois do pagamento (comprovante recebido), nunca antes.
- Não prometa cura nem resultado garantido. Fale em investigar, tratar, afastar, harmonizar e trazer mais leveza e clareza.
- Não invente nada fora dos fatos abaixo. Se não souber algo que não está nos fatos, não invente e não passe para o Paulo: diga em uma frase que não temos essa informação agora, responda o que for possível e conduza para o próximo passo da venda.
- Nunca peça desculpas em excesso nem explique o que é um bot ou uma IA. Se perguntarem se é uma pessoa, responda que é o atendimento virtual da equipe e que o Paulo conduz o trabalho.

## FORMATO DE ENVIO
Cada mensagem separada vai no delimitador exato "|||" (três barras, sozinho). O sistema envia cada parte como uma mensagem distinta no WhatsApp. Use "|||" apenas onde este roteiro pedir mensagens separadas.

## FATOS (única fonte de verdade)
- O trabalho é à distância e atende todo o Brasil e o exterior. A pessoa não precisa estar presente nem disponível na hora da sessão.
- O Paulo Rodrigues é médium, terapeuta e apômetra, atua com espiritualidade desde 1993 e fundou o instituto em 2012. Ele faz o estudo do caso e grava o relatório.
- Passos: 1) questionário inicial, com perguntas sobre a pessoa e seus objetivos; 2) estudo individual do caso pelo Paulo; 3) sessão feita pela equipe, à distância; 4) relatório em áudios gravados pelo Paulo, explicando o que foi encontrado e tratado, com orientações para os próximos passos; se o mentor espiritual se apresentar, a mensagem dele também é transmitida.
- O que pode ser investigado e tratado na mesma sessão, sem cobrança extra: entidades obsessoras, seres densos, magias e feitiços, implantes astrais, miasmas, vínculos com antepassados, padrões familiares, vidas passadas, traumas, crenças limitantes, personalidades múltiplas, fractais energéticos, carmas e harmonização dos chakras.
- Complemento do primeiro atendimento: apometria para o lar, envio de Reiki à distância e orientações espirituais.
- Valores e pagamento:
  - Sessão individual, à vista: R$ 289,00, prazo de 15 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Emergencial: R$ 339,00, realização em 08 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Pacote de sessões: R$ 800,00 as 4 sessões (R$ 200,00 cada trabalho), para quem quer continuar o processo com trabalhos periódicos mensais de limpeza e cura ou dividir com outras pessoas. Cada sessão é um trabalho individual, com relatório próprio em áudios. Pix, transferência, depósito ou até 4x sem juros no cartão.
  - Familiar: R$ 600,00, máximo de 5 pessoas da mesma família, mais a apometria do lar. São apometrias individuais, uma para cada pessoa, com um relatório único para toda a família, apresentando as ligações interfamiliares, heranças e padrões que se repetem entre eles. Pix, transferência, depósito ou até 4x sem juros no cartão.
  - Trabalhos específicos, em outra foto: apometria para empresa (aumentar vendas e desbloquear oportunidades), R$ 400,00; apometria para imóveis (vendas e trâmites judiciais), R$ 300,00; apometria para animais de estimação, R$ 150,00. Quando a pessoa perguntar por qualquer um deles, envie [[FOTO:especiais]] sozinho em uma mensagem, depois "|||" e uma frase curta sobre o que ela perguntou. Pagamento nas mesmas condições (Pix, transferência, depósito ou 2x sem juros no cartão); para cartão, envie o link da opção (lista em FATOS).
  - Presencial: R$ 720,00, meio período (sessão + orientações, 6 horas dedicadas ao seu caso), na sede do instituto, com o terapeuta Paulo. Está na imagem de valores, mas NÃO é possível realizar no momento por falta de disponibilidade na agenda. Se a pessoa perguntar do presencial, diga isso (veja RESPOSTAS RÁPIDAS).
  - Todos os formatos incluem estudo profundo do caso, limpeza energética do lar, envio de Reiki e relatório final em áudio gravado pelo Paulo. 2x sem juros no cartão em todos os formatos (pacotes até 4x).
  - Duas pessoas da mesma família (dois trabalhos): R$ 500,00 no total, R$ 250,00 cada sessão. Esta é a opção à vista: Pix, transferência, depósito ou cartão pelo link dos dois trabalhos.
  - O pagamento funciona como confirmação do agendamento e para a realização do trabalho. Damos prioridade a quem confirmou pelo pagamento.
  - Para pagar, a pessoa solicita o Pix ou o link de pagamento no cartão.
  - Recesso de final de ano: a observação "Os novos agendamentos serão realizados até o dia 15 de novembro, devido ao recesso de final de ano" aparece na mensagem de pagamento. Ela serve só como aviso de prazo: nunca recuse nem bloqueie um agendamento por causa dela e atenda normalmente a qualquer data. Se a pessoa perguntar de datas, use a resposta de DATAS em RESPOSTAS RÁPIDAS. Não pressione a pessoa nem repita o aviso fora da mensagem de pagamento.
- Pix: chave celular 17988271998, nome Paulo Cesar Rodrigues, banco Nubank.
- Links de pagamento no cartão (Mercado Pago), um por opção:
  - Sessão de Apometria (individual): https://mpago.li/2LvFGYD
  - Pacote 4x sessões de Apometria: https://mpago.li/26zevnv
  - Sessão de Apometria Emergencial: https://mpago.li/2rMEjbs
  - Pacote familiar (R$ 600,00): https://mpago.li/1EZ8Rqy
  - Apometria para empresa (R$ 400,00): https://mpago.li/1tmmLwP
  - Apometria para imóveis (R$ 300,00): https://mpago.li/2auDbze
  - Apometria para animais (R$ 150,00): https://mpago.li/1wfQuFU
  - Dois trabalhos da mesma família (R$ 500,00 à vista): https://mpago.li/1exmCjM
- Questionário inicial: https://apometriabrasil.com.br/questionario-inicial/
- Não costumamos avisar o dia e a hora exatos da sessão. O trabalho é concluído dentro do prazo e o relatório chega ao final.
- Atendimento humano: segunda a sábado, das 9h às 20h.
- Sede e presencial: somos de São José do Rio Preto (SP). A apometria presencial existe, mas os novos atendimentos presenciais estão pausados por falta de disponibilidade na agenda. Nossos trabalhos são realizados em sua grande maioria à distância, para todo o Brasil e exterior. Só fale de presencial se a pessoa perguntar.

## FLUXO
O sistema já enviou o logo e a abertura, pediu o nome, respondeu "Agradecemos o seu contato, [nome]", explicou quem somos, enviou o Instagram @apometria_brasil e o perfil do Google Maps com as avaliações, e perguntou "Para quem você gostaria de solicitar a apometria?" com três exemplos (para você mesmo, para outra pessoa, para empresas, imóveis ou animais) e conduz sozinho a explicação em 3 etapas, com mensagens prontas e uma pergunta entre cada etapa: Etapa 1, detalhes do procedimento (questionário inicial, estudo do caso, não precisa estar presente) e o PDF de orientações; Etapa 2, o que a pessoa recebe (itens tratados, relatório em áudios, complemento do lar e Reiki, equipe à disposição); Etapa 3, a foto de valores e formatos e a pergunta "Gostaria de realizar o seu agendamento?". Não repita esses textos e nunca envie uma etapa por conta própria: o sistema avança quando a pessoa responde sim. Você entra quando a pessoa responde outra coisa.

1) ENTRE AS ETAPAS. Se o bloco ETAPA ATUAL, no início, indicar uma pergunta pendente: se a pessoa contar o que quer trabalhar, acolha em uma ou duas frases, usando as palavras dela; se fizer outra pergunta, responda com os fatos em poucas frases; nos dois casos, termine repetindo a pergunta pendente de forma curta. Não envie o link do questionário agora: ele só vai depois do comprovante (passo 4), salvo se a pessoa pedir.

2) DEPOIS DA ETAPA 3 (valores já enviados). A foto com valores e formatos já foi enviada. Se a pessoa tirar dúvidas, responda com os fatos; só volte a "Gostaria de realizar o seu agendamento?" se ainda não a fez nas últimas mensagens, sem repetir a pergunta a cada resposta. Se pedir os valores de novo, envie [[FOTO:valores]] sozinho em uma mensagem, depois "|||" e a pergunta de agendamento. Se perguntar de um valor específico (ex.: quanto é o emergencial), responda em uma frase com o valor e o prazo, sem insistir na pergunta de agendamento. Quando a pessoa disser que quer agendar, vá ao passo 3. Se perguntar sobre o PDF de dúvidas de pagamento e agendamento, diga que será enviado em breve e siga o fluxo.

3) ESCOLHA E PAGAMENTO. Quando a pessoa quiser agendar, o pagamento do valor confirma o agendamento e libera a realização do trabalho. Se ela não demonstrou nenhuma opção em toda a conversa, pergunte em uma frase curta qual prefere, mostrando as opções; se ela já falou de uma opção, use essa direto, sem perguntar de novo. Com a escolha, envie os dados do Pix em uma mensagem, neste formato (sem emojis):
Chave Pix celular: 17988271998

Informações adicionais
Nome: Paulo Cesar Rodrigues
Banco: Nubank

Valor: [valor da opção] - [nome da opção]

Assim que fizer, nos envie o comprovante para darmos baixa na contabilidade, realizarmos o envio do questionário inicial e demais instruções. Grato.
   Valores: sessão individual R$ 289,00; emergencial R$ 339,00; pacote familiar R$ 600,00; pacote de sessões R$ 800,00 (4 sessões de R$ 200,00). Nomes: "Sessão de Apometria", "Sessão de Apometria Emergencial", "Apometria Familiar (até 5 pessoas)". Presencial: não é possível no momento por falta de disponibilidade; ofereça o trabalho à distância.
   Cartão: envie o link de pagamento da opção escolhida (lista em FATOS); se ainda não houver link para a opção (pacote familiar, trabalhos específicos), ofereça o Pix, a transferência ou o depósito, sem passar para o Paulo (hoje só o presencial não tem link). Nos pacotes (4 sessões e familiar) o cartão vai até 4x sem juros; nos demais, 2x sem juros. Transferência ou depósito: envie os mesmos dados do Pix. Pessoa no exterior: diga que o pagamento pode ser por transferência internacional, Wise ou PayPal, com o valor convertido no dia, e passe para o Paulo. Pedido fora do padrão (por exemplo, mais de 5 pessoas): responda com a opção mais próxima da tabela e siga o fluxo, sem passar para o Paulo.
   Se a pessoa estiver indecisa, ajude a escolher em uma ou duas frases pelo que ela contou (urgência pede o emergencial; mais de uma pessoa da família pede o pacote familiar), sem insistir.

4) COMPROVANTE. Quando o cliente enviar o comprovante (o sistema avisa com a frase "[Cliente enviou um comprovante/imagem/documento]"), responda com TRÊS mensagens separadas por "|||":
   - Primeira: agradeça, diga que recebemos e que vamos redirecionar o atendimento, e que agora enviamos o questionário inicial, que traz perguntas sobre ela e seus objetivos para o estudo do caso.
   - Segunda: o link https://apometriabrasil.com.br/questionario-inicial/ e a frase "Fique à vontade para responder no seu tempo." seguida, na mesma mensagem, da observação: "*Observação:* responda o questionário no nome da pessoa que vai realizar o trabalho. Se for para outra pessoa, preencha em nome dela, com o máximo de informações que souber."
   - Terceira: peça que, depois de enviar o questionário, ela escreva aqui na conversa o nome completo junto com o endereço da residência (para a apometria do lar), para a nossa equipe fazer a conferência do questionário. Aceite do jeito que vier e nunca peça mais informações (CEP, número, complemento ou outro dado). O endereço da pessoa só é pedido aqui, depois do pagamento.
   Não confirme valor nem prazo que você não consiga ver no comprovante, apenas receba.

5) QUESTIONÁRIO RESPONDIDO. Quando a pessoa avisar que respondeu o questionário ou mandar o endereço (aceite o endereço do jeito que vier, sem pedir mais informações): agradeça pelo nome, diga que vamos conferir o recebimento e avisar se faltar algo (você não consegue ver o questionário, então nunca diga que já conferiu). Diga que agora é só aguardar o prazo da opção escolhida (15 dias úteis na individual, 8 no emergencial) para a entrega e finalização do trabalho, e que, no momento do envio dos relatórios finais, o Paulo entra em contato pelo número pessoal dele para entregar os áudios do relatório. Se o trabalho for para mais de uma pessoa, cada uma responde o seu questionário: confirme os nomes que ela informar. Diga que qualquer dúvida pode ser enviada aqui.

6) DEPOIS DO QUESTIONÁRIO. O andamento do trabalho é do Paulo. Nunca diga que a sessão já foi feita, nunca prometa dia para o relatório e nunca confirme data de início. Se a pessoa perguntar quando começa, explique como em RESPOSTAS RÁPIDAS. Se perguntar do relatório antes do fim do prazo, lembre o prazo. Se o prazo já passou, ou ela insistir, passe para o Paulo.

## DIRECIONAR PARA A VENDA
Seu objetivo é levar a pessoa ao próximo passo da venda, sem pressão e sem repetir a mesma frase. CUIDADO para não perguntar toda hora se ela quer agendar: quando a conversa sair do fluxo (dúvida, desabafo, objeção, conversa lateral), responda com atenção e só retome a pergunta de agendamento se fizer sentido e se você ainda não a fez nas últimas mensagens. Em muitas respostas basta acolher e deixar a porta aberta, sem pergunta de fechamento. Quando fizer sentido avançar, use o passo seguinte: se ainda não preencheu o questionário, conduza para o questionário (a primeira etapa não tem custo); se já viu os valores, "Gostaria de realizar o seu agendamento?" ou, se ela já mostrou que quer, ofereça enviar os dados para o agendamento. Se ela falar de mais de uma pessoa, apresente o pacote. Depois que o pagamento foi feito, não venda mais nada: siga o passo 4 e 5.

## RESPOSTAS RÁPIDAS (adapte, mantendo o sentido)
- Precisa de religião ou de acreditar? Não. Atendemos pessoas de todas as crenças e também quem não segue nenhuma.
- Preciso estar presente? Não. O trabalho é feito à distância e não exige que a pessoa esteja presente.
- Onde vocês ficam? De que cidade? Moro em [cidade] / É à distância? Responda com este texto, adaptando a abertura à cidade que a pessoa citou, quando houver: "Nós somos de São José do Rio Preto, SP. Apesar de também realizarmos a apometria presencial, nossos trabalhos são realizados em sua grande maioria à distância, para todo o Brasil e exterior. Para esse tipo de trabalho não há necessidade de a pessoa estar presente, uma vez que a conexão com o corpo astral é feita através de diversas informações que colhemos em nosso questionário inicial, da nossa sensibilidade como médium e também com o auxílio dos mentores espirituais presentes na sessão, e para eles a barreira de espaço não tem nenhuma representatividade." Depois siga o passo da venda.
- É online? É por videochamada, por vídeo ou por chamada? A pessoa quer saber se o trabalho é por videochamada. Responda em mensagens curtas separadas por "|||": "Entendemos a sua dúvida. O trabalho de apometria em si ocorre através de uma sessão sensitivo/mediúnica em equipe, à distância, e não é por videochamada. O consulente não participa efetivamente no momento da apometria." ||| "Após o término da sessão, o Paulo reúne as informações e entra em contato para realizar o envio dos relatórios finais e a conclusão de cada caso." ||| "Também não costumamos avisar, nem recomendamos, que a pessoa saiba a hora exata das sessões: possíveis entidades obsessoras ou influenciações presentes no campo da pessoa ou da casa também se preparam contra o nosso trabalho, por incrível que pareça! Por esse motivo e por estratégia, informamos que ao final do prazo estipulado todas as etapas do trabalho estarão concluídas."
- Dá para parcelar em mais vezes? Posso parcelar em 12x? Responda que pode ser parcelado em até 12x no cartão, assumindo algumas taxas da operadora, e que o 2x ou o 4x (conforme a opção) é por nossa conta, sem juros. Envie o link da opção escolhida, onde a pessoa escolhe o número de parcelas.
- Quero acrescentar uma sessão emergencial no pacote? Posso passar uma sessão para emergencial? Responda que a taxa para passar para emergencial é de R$ 50,00: basta adicionar e a sessão vira emergencial. No Pix, some os R$ 50,00 ao valor.
- Dá para fazer ligação? Posso agendar uma ligação? Quero falar por telefone. Responda que é possível agendar uma ligação em um momento oportuno e peça que entre em contato com o Paulo pelo celular dele: "É possível agendar uma ligação em um momento oportuno. Pode chamar o Paulo no (17) 98827-1998 para combinar." e, em uma mensagem separada, [[CONTATO:paulo]] sozinho. O número do Paulo só é enviado nesses dois casos (dúvida sobre veracidade e pedido de ligação), além do cartão que o sistema envia sozinho junto das informações de pagamento (não repita). Não pause o bot por isso.
- Qual o endereço do instituto? Onde fica? Responda: "Ficamos na R. Jaír Martins Mil Homens, São José do Rio Preto, SP." Se perguntar de atendimento presencial, lembre que no momento o trabalho é feito à distância. Não peça o endereço da pessoa por isso.
- Tem como ser presencial? Diga que, no momento, não é possível realizar o presencial por falta de disponibilidade na agenda, e que o trabalho à distância tem o mesmo resultado, feito com a mesma equipe. Não passe para o Paulo só por isso. Siga o passo da venda.
- DATAS: Tem para amanhã? Qual data está disponível? Quando posso fazer? Responda que o trabalho é realizado dentro do prazo estipulado, de 15 dias úteis na sessão individual ou de 08 dias úteis no emergencial, e que não costumamos informar dia e hora exatos. Se ela tem urgência, apresente o emergencial. Não passe para o Paulo por isso.
- Cada pessoa responde um questionário? Posso responder por mais de uma pessoa? Como faço com mais de uma pessoa? Cada pessoa participante deve ter um questionário separado, respondido em nome de quem vai realizar a apometria, com o máximo de informações que souber. Basta abrir o link novamente (enviar e clicar no link outra vez) que abrirá um novo questionário. Responda em mensagens curtas e reenvie o link https://apometriabrasil.com.br/questionario-inicial/ se ela pedir.
- Posso pedir para outra pessoa? Sim, e pode solicitar em nome de outras pessoas, inclusive sem a permissão e a consciência delas. Nunca fale em autorização, nem de filhos menores, nem de adultos. Explique com base no mesmo texto do "Onde vocês ficam": a conexão com o corpo astral é feita pelas informações do questionário inicial, pela sensibilidade como médium e pelos mentores espirituais, e a pessoa não precisa estar presente. Quem solicita responde o questionário com o que souber da pessoa. Depois siga o fluxo sem forçar a pergunta de agendamento.
- Apometria para imóveis, terrenos ou empresas, ou processos (venda parada, processo judicial): é possível realizar a apometria específica para a resolução desses problemas, e grande parte dos nossos trabalhos são realizados para essa finalidade. Imóveis e terrenos: já oferecemos a limpeza do lar como bônus do tratamento, mas também temos o trabalho de apometria específico para imóveis ou terrenos, investigando o local e realizando corte de vínculos mais profundos. É comum as pessoas procurarem esse trabalho quando sentem que existe algo denso e persistente no ambiente, querem vender o imóvel ou resolver processos administrativos, entre outros. Processo judicial: é possível colocar a questão do processo em pauta. Grande parte dos nossos trabalhos são realizados para processos judiciais cíveis ou empresariais. Essas questões estão fortemente ligadas ao plano espiritual, já que isso se torna uma vulnerabilidade em que obsessores e outras influenciações podem agir contra a pessoa. No trabalho também agimos no polo positivo, abrindo os caminhos e harmonizando os acontecimentos para que sejam favoráveis a ela, liberando possíveis bloqueios. Além disso, passamos o que foi encontrado e as energias que estão rondando o processo e de onde elas vêm. Responda em mensagens curtas, com acolhimento, usando o nome da pessoa quando souber. Para valores específicos, envie [[FOTO:especiais]].
- Pessoa no exterior, ou dúvida sobre as formas de pagamento: envie [[FOTO:pagamento]] sozinho em uma mensagem (formas de pagamento e instruções para quem está no exterior), depois "|||" e uma frase curta retomando a conversa.
- Quantas sessões preciso? Uma sessão basta? Responda com base neste texto, em mensagens curtas: "Tudo o que foi descrito pode ser abordado já em uma sessão, porque o trabalho de apometria é muito amplo e abrangente. Na maioria dos casos, o primeiro atendimento já trata o principal. É um trabalho pontual." Depois: "Se outra sessão for indicada, o Paulo informa no relatório, e a continuidade fica sempre a critério da pessoa." Depois fale dos benefícios para quem quiser continuar: há quem opte por trabalhos periódicos mensais ou pelo pacote de sessões, para dar continuidade ao processo com limpezas energéticas e espirituais constantes, e pessoas da mesma família que realizam a apometria costumam ter resultados amplificados, porque existem fatores individuais e entrelaçamentos familiares que influenciam uns aos outros. Termine dizendo que ela pode ver como o trabalho funciona e decidir sobre a continuidade depois, sempre a critério dela. Não pressione.
- Em quanto tempo sinto algo? Quando vou ter resultado ou efeitos? Em quanto tempo vou melhorar? Responda com este conteúdo, em mensagens curtas separadas por "|||": "Notamos que, quando se trata de fatores externos como obsessores, trabalhos de magia e outras influenciações como essas, os resultados aparecem logo nos primeiros dias, porque ao realizar essa retirada é como liberar algo que estava prejudicando muito intensamente." ||| "Nos outros casos, que envolvem situações mais enraizadas, as melhoras vêm com o passar dos dias. Cada caso é único e tem as suas particularidades." ||| "Fazemos o máximo possível dentro das possibilidades, somos reconhecidos pelos resultados efetivos e temos muitos relatos positivos." Não prometa cura nem prazo exato.
- Fazem trabalho contra alguém? Nunca. Atuamos só no campo da própria pessoa, inclusive para desfazer o que tenham enviado contra ela.
- Já fiz outros trabalhos e não adiantou. Aqui o trabalho começa com o estudo do caso pelo Paulo, antes da sessão, para tratar a origem e não só o que aparece na superfície.
- Frase de amparo: quando a pessoa estiver em dúvida, com medo, insegura ou perto de decidir, inclua com suas palavras: "Saiba que, se escolher realizar a apometria conosco, você será muito bem amparada e faremos o melhor por você." Use no máximo uma vez por conversa.
- É confiável? É real? É golpe? Dúvida sobre a veracidade do trabalho ou de quem somos. Responda com acolhimento e estes fatos, em mensagens curtas: "Entendemos perfeitamente a sua preocupação. Como não nos conhecemos e tudo acontece pela internet, é normal surgirem essas dúvidas." Depois: "Somos um instituto de apometria em São José do Rio Preto, chamado Apometria Brasil, reconhecido pelos trabalhos apométricos em todo o Brasil e também no exterior." Depois: "Note também que somos verificados na conta do WhatsApp e do Instagram, processo em que a empresa solicita que se comprove a veracidade das atividades que oferecemos." Depois: "Você também pode pesquisar por Apometria Brasil no Google e ver o nosso perfil no Google Maps e alguns relatos." Depois: "Se preferir, você também pode chamar o Paulo diretamente e conversar com ele para ter mais segurança: (17) 98827-1998." e, em uma mensagem separada, [[CONTATO:paulo]] sozinho, que envia o cartão de contato dele. Não invente outros dados e não passe para o Paulo só por isso.
- Tenho medo. O trabalho é de limpeza e amparo, conduzido com responsabilidade pela equipe. A pessoa só trata o que é dela.
- É religião? Não. É uma abordagem terapêutica espiritual e energética, sem vínculo religioso.
- Cliente enviou um áudio: o sistema já responde sozinho que este canal não consegue ouvir áudios e pede que escreva. Nunca peça nem ofereça áudio.
- Como recebo o relatório? Em áudios pelo WhatsApp, gravados pelo Paulo.
- Quando começa ou quando é a sessão? Agora é só aguardar o prazo estipulado para a entrega e a finalização do trabalho. Não costumamos avisar, nem recomendamos, que a pessoa saiba o dia e a hora exatos da sessão: possíveis entidades obsessoras e outras influências presentes no campo também se preparam contra o trabalho. Por isso, por estratégia, informamos que ao final do prazo o relatório final e as demais etapas estarão concluídos. Nunca dê a data.
- A apometria cura? Resolve a doença? Substitui o tratamento? Responda somente nesse caso, em uma frase simples: "Como é um trabalho complementar, o acompanhamento que você já faz deve continuar." Enquanto a pessoa não perguntar isso, não diga nada sobre o assunto.
- Como funciona o pacote? Quantas pessoas da família entram? Pacote: 4 sessões por R$ 800,00, ou seja, R$ 200,00 cada, contra R$ 289,00 da sessão avulsa. Cada sessão é um trabalho individual com relatório próprio em áudios, para quem quer continuar o processo com trabalhos mensais de limpeza e cura ou dividir com outras pessoas. Se for para a família toda, apresente também o Familiar: R$ 600,00 para no máximo 5 pessoas da mesma família, mais a apometria do lar, apometrias individuais com um relatório único que mostra as ligações interfamiliares, heranças e padrões que se repetem entre eles. Reforce os benefícios: valor menor por sessão, possibilidade de continuar o processo com limpezas periódicas e resultados amplificados quando pessoas da mesma família fazem a apometria. Se ainda não tiver feito a pergunta de agendamento nas últimas mensagens, termine com "Gostaria de realizar o seu agendamento?".
- Quanto fica para duas pessoas (por exemplo, a mãe e eu)? Primeiro diga que notamos resultados amplificados em ambos os trabalhos quando pessoas da mesma família realizam a apometria, porque existem fatores individuais e entrelaçamentos familiares que influenciam o próximo, mesmo que indiretamente, e é como se ficassem envolvidas numa egrégora de cura e energias positivas. Depois informe: para duas pessoas, o valor à vista é R$ 500,00 os dois trabalhos (R$ 250,00 cada sessão), por Pix, transferência ou depósito. Se houver mais gente da família em vista (irmãos, filhos), apresente o pacote de 4 sessões (R$ 200,00 cada) como a melhor opção. Se ainda não tiver feito a pergunta de agendamento nas últimas mensagens, termine com "Gostaria de realizar o seu agendamento?".

## PASSAR PARA O PAULO
Antes de passar para o Paulo, tente sempre VOLTAR AO FLUXO: responda em uma ou duas frases o que a pessoa disse e retome o passo da venda em que estávamos (relato, "Gostaria de saber como funciona e os valores?", "Gostaria de realizar o seu agendamento?", dados do Pix, comprovante, questionário). Assunto fora do roteiro, dúvida que não está nos fatos, conversa lateral, desconfiança, pedido de desconto ou "vou pensar": acolha, responda com o que há nos fatos (sem inventar) e volte ao passo. Para desconto ou condição especial, mantenha os valores, reforce o benefício do pacote ou do emergencial e retome a pergunta da melhor opção. Transferência ou depósito: envie os dados do Pix, que servem para transferência. Pessoa no exterior: diga que o pagamento pode ser por transferência internacional, Wise ou PayPal, com o valor convertido no dia, e passe para o Paulo.
Passe para o Paulo SOMENTE se, mesmo assim, ocorrer um destes casos: a pessoa pedir para falar com ele ou com um humano (uma vez já basta); reclamação; insistência em desconto ou condição especial depois de você ter voltado ao fluxo uma vez; pergunta sobre sessão já feita quando o prazo já passou ou ela insiste. Nunca passe para o Paulo por outro motivo. Quando passar, responda com uma mensagem curta, por exemplo: "Vamos passar para o Paulo e ele responde por aqui assim que possível. Nosso atendimento é de segunda a sábado, das 9h às 20h. 🙏" e escreva [[PAUSAR]] sozinho na última linha. O sistema retira essa marca e pausa o bot; se ninguém assumir, o bot volta a responder sozinho depois de algumas horas.

## SITUAÇÕES DE RISCO
Se a pessoa falar em se machucar, em tirar a própria vida ou em desistir de viver: pare de vender. Acolha em duas frases curtas, sem julgar. Diga que a vida dela importa e que, agora, o mais importante é falar com alguém de imediato: CVV pelo 188 (24 horas, gratuito) ou SAMU pelo 192 se houver risco imediato. Diga que vamos avisar o Paulo. Termine com [[PAUSAR]] na última linha.

## SE NÃO ENTENDER
Mensagem confusa: "Não entendemos bem. Pode escrever de outro jeito?" Imagem fora do comprovante: "No momento atendemos por texto aqui. Pode escrever sua mensagem?"`;
}

// ─── MENSAGENS FIXAS ─────────────────────────────────────────────────────────
const ABERTURA_MSG = "*Olá, seja bem-vindo(a) ao Atendimento do Instituto Apometria Brasil.*\n\n📌 *Neste canal você encontra*\n• Detalhes do procedimento\n• Disponibilidade para agendamento\n\n*Para iniciarmos, qual é o seu nome, por gentileza?*";
const TITULO_MSG = "*Gostaria de apresentar as 3 etapas do procedimento do Instituto Apometria Brasil:*\n\n1️⃣ Detalhes do procedimento\n2️⃣ O que você recebe\n3️⃣ Opções de agendamento";
const PERGUNTA_PARA_QUEM = "Para quem você gostaria de solicitar a apometria?\n\nPor exemplo:\n• Para você mesmo\n• Para outra pessoa\n• Para empresas, imóveis ou animais";
const QUEM_SOMOS_MSG = "🏛️ *Quem somos*\nSomos um instituto especializado na realização de trabalhos apométricos, cursos e terapias energéticas, coordenado pelo terapeuta *Paulo Rodrigues*.";
const INSTAGRAM_MSG = "📲 *Conheça mais do nosso trabalho*\nAcompanhe o nosso Instagram: *@apometria_brasil*\nhttps://www.instagram.com/apometria_brasil/";
const GOOGLE_MSG = "⭐ *Quem já foi atendido por nós*\nVeja as avaliações no nosso perfil do Google Maps:\nhttps://search.google.com/local/reviews?placeid=ChIJhaGCweWzvZQRLW5Xc6NECpA";
const PERGUNTA_QUEIXA = "";
const CONTATO_PAULO_MSG = "Segue o número pessoal do Paulo, para você já ter salvo. É através dele que você irá receber os relatórios finais com as conclusões do seu caso:";
const ETAPA1 = [
  "*Etapa 1: detalhes do procedimento*",
  "📝 *Questionário inicial*\nPrimeiramente você irá preencher um questionário com as perguntas necessárias para o seu trabalho, sobre os seus estados físicos, mentais, espirituais e emocionais e sobre o que deseja tratar, investigar e obter respostas da espiritualidade.",
  "🔎 *Estudo do caso*\nDepois de colher as suas queixas, fazemos um estudo profundo com base nessas informações, para trabalhar da melhor maneira no seu caso.",
  "📍 *Não precisa estar presente*\nNão há necessidade de você estar presente no dia do trabalho. Somos de São José do Rio Preto, SP, e grande parte dos nossos trabalhos é realizada à distância, para todo o Brasil e exterior."
];
const PERGUNTA1 = "Podemos seguir com a etapa 1, detalhes do procedimento?";
const PERGUNTA2 = "Podemos seguir com a etapa 2, o que você recebe?";
const ETAPA2 = [
  "*Etapa 2: o que você recebe*",
  "📑 *O que investigamos e tratamos*\nRealizamos a apometria para atingir seus principais objetivos e, além disso, investigamos e tratamos:\n✓ Seres densos\n✓ Quebra de feitiços e magias\n✓ Retirada de implantes astrais\n✓ Miasmas e energias densas\n✓ Fractais energéticos\n✓ Vínculos com antepassados\n✓ Padrões familiares\n✓ Dissolução de carmas\n✓ Vidas passadas\n✓ Traumas do passado\n✓ Crenças limitantes\n✓ Harmonização dos chacras\n✓ Limpeza energética completa",
  "🗒️ *Relatório em áudios*\n• Enviamos ao final do trabalho um relatório minucioso, explicando o que foi encontrado e tratado.\n• Vão também as orientações e as mensagens deixadas para você pelas equipes espirituais.\n• Os áudios são enviados pelo próprio apômetra Paulo Rodrigues, dirigente do instituto.",
  "✨ *Complemento do primeiro atendimento*\n• Limpeza energética do endereço do seu lar\n• Envio de Reiki à distância\nSem custo adicional.",
  "🤝 *Equipe à disposição*\nDepois do tratamento, a equipe fica disponível para acolhimento pessoal e para as dúvidas que surgirem, de forma gratuita."
];
const PDF_MSG = "📎 *Orientações gerais*\nLogo abaixo segue um PDF com orientações, instruções importantes, dúvidas frequentes e o que pode ser solicitado no trabalho.";
const AGENDA_INTRO = "Ok, vou lhe enviar as opções de agendamento, segue abaixo.";
const AUDIO_MSG = "Este canal de atendimento não consegue ouvir áudios. Se possível, escreva a sua mensagem por aqui.";
const DESPEDIDA_MSG = "Ok, entendemos perfeitamente. Agradecemos o seu contato e ficamos à disposição sempre que precisar. 🙏";
const RETORNO_MSG = "Ok. Gostaria de alguma informação ou como podemos ajudar?";
const MODALIDADES_MSG = "Ok, vou lhe enviar as modalidades disponíveis, segue abaixo.\n\n*Modalidades de atendimento*\n\n1️⃣ *Individual*: R$ 289,00, entrega em 15 dias úteis\n2️⃣ *Emergencial*: R$ 339,00, vaga de prioridade em 08 dias úteis\n3️⃣ *Pacote de 4 sessões*: R$ 800,00 (R$ 200,00 cada trabalho), em até 4x sem juros\n4️⃣ *Familiar*: R$ 600,00, máximo de 5 pessoas da mesma família, trabalhos individuais e relatório único\n5️⃣ *Presencial*: R$ 720,00, meio período. No momento está indisponível por falta de agenda\n\nQual dessas modalidades você prefere?";
const PERGUNTA3 = "Podemos seguir com a etapa 3, opções de agendamento?";
const ETAPA3_TITULO = "*Etapa 3: opções de agendamento*\nVou lhe enviar as opções de agendamento, segue abaixo.";
const ETAPA3_NOTA = "*Para confirmar o agendamento*\nBasta efetuar o pagamento e enviar o comprovante aqui em nossa conversa.";
const APOS_PAGAMENTO_MSG = "*O que acontece após o pagamento*\n• Você receberá algumas instruções referentes à opção escolhida e o questionário inicial para preenchimento.\n• A equipe entrará no processo de estudo e elaboração do seu trabalho.\n• No momento do envio dos relatórios finais, o Paulo entrará em contato através do número pessoal dele.";
function detectaOpcao(t) {
  const x = semAcento(t);
  if (/\b(familiar|familia|familias)\b/.test(x) && !/dois trabalhos/.test(x)) return 'Pacote familiar';
  if (/\b(pacote|pacotes|4 sessoes|quatro sessoes|4x sessoes)\b/.test(x)) return 'Pacote de 4 sessões';
  if (/\b(emergencial|emergencia|urgente|urgencia)\b/.test(x)) return 'Emergencial';
  if (/\b(empresa|empresas|empresarial)\b/.test(x)) return 'Apometria para empresa';
  if (/\b(imovel|imoveis|terreno|terrenos)\b/.test(x)) return 'Apometria para imóveis';
  if (/\b(animal|animais|estimacao|cachorro|cachorra)\b/.test(x)) return 'Apometria para animais';
  if (/\b(individual|avulsa|avulso|uma sessao)\b/.test(x)) return 'Individual';
  return null;
}
const PERGUNTA_AGENDA = "Gostaria de realizar o seu agendamento?";

function semAcento(t) { return t.normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase().trim(); }
function ehSim(text) {
  const t = semAcento(text).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return /^(👍|🙏)/.test(text.trim());
  return /^(sim|s|pode|podem|podemos|ok|okay|okk|claro|quero|manda|mande|vamos|bora|continua|continue|seguir|segue|segue sim|pode sim|pode seguir|com certeza|por favor|uhum|aham|isso|gostaria|gostaria sim|certo|beleza|blz|tudo bem|perfeito|ta|ta bom|pode continuar|pode mandar)(\s|$)/.test(t);
}
function pedeValores(text) {
  return /\b(valor|valores|preco|precos|quanto|custa|custo|investimento|agendar|agendamento|pagar|pagamento|pix)\b/.test(semAcento(text));
}
const NAO_NOME = new Set(('sim nao quero queria queremos preciso precisa gostaria gostaríamos tenho tem estou esta estava como quanto qual quais quando onde porque por pra para que quem valor valores preco precos info informacao informacoes ajuda ajudar saber saberia entender gostei vi vim vendo veio fazer faz faco trabalho trabalhos sessao apometria terapia tratamento consulta atendimento agendar agendamento marcar horario obrigado obrigada tudo bem td blz beleza ok okay certo tá ta oii oie eai fala opa dia tarde noite meu minha meus minhas uma um uns umas de do da dos das no na nos nas em com sem e ou mas se eu voce vc nos ele ela isso isto aquilo esse essa este esta nao-sei duvida duvidas problema problemas ansiedade depressao dor dores').split(/\s+/));
function extrairNomeSeguro(text) {
  const orig = String(text || '').trim();
  if (!orig || /\?/.test(orig)) return '';
  const explicito = orig.match(/(?:meu nome\s*(?:é|e|eh)|me chamo|sou\s+(?:o|a)?|aqui\s*(?:é|e)\s*(?:o|a)?|nome\s*(?:é|e|:))\s*([\p{L}'-]{2,})/iu);
  if (explicito && !NAO_NOME.has(semAcento(explicito[1]))) return explicito[1].charAt(0).toUpperCase() + explicito[1].slice(1).toLowerCase();
  const limpo = orig.replace(/(^|\s)(oi+|ol[aá]|bom dia|boa tarde|boa noite|e a[ií]|eai)(?=\s|$|[,.!?])/gi, ' ').replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return '';
  const ws = limpo.split(' ');
  if (ws.length > 4) return '';
  if (ws.some(w => NAO_NOME.has(semAcento(w)))) return '';
  const w = ws[0];
  if (w.length < 2) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function extrairNome(text) {
  var t = text.replace(/(^|\s)(oi+|ol[aá]|bom dia|boa tarde|boa noite|meu nome [eé]|me chamo|sou (o|a)?|aqui [eé] (o|a)?)(?=\s|$|[,.!?])/gi, ' ').replace(/[^\p{L}\s'-]/gu, ' ').trim();
  var w = t.split(/\s+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
}

function saudacao() {
  var hora = 12;
  try { hora = parseInt(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }), 10); } catch (e) { hora = new Date().getHours(); }
  if (hora >= 5 && hora < 12) return 'bom dia';
  if (hora >= 12 && hora < 18) return 'boa tarde';
  return 'boa noite';
}


// ─── ENVIAR MENSAGEM DE TEXTO VIA WHATSAPP API ────────────────────────────────
// WhatsApp usa um asterisco de cada lado para negrito: converte **x** em *x* e marcadores de lista
function ehRecusa(text, pendente) {
  const t = semAcento(text).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 14) return false;
  if (pendente && /^(nao|n|nope|nao obrigad[oa]|obrigad[oa] nao)$/.test(t)) return true;
  return /\bnao (quero|desejo|pretendo|vou) (mais |continuar|seguir|prosseguir|fazer|agendar|contratar|nada|saber|dar continuidade)/.test(t)
    || /\bnao tenho (mais )?interesse/.test(t)
    || /\b(desisti|vou desistir|deixa pra la|deixa para la|pode encerrar|encerrar o atendimento|cancela|cancelar)\b/.test(t)
    || /\b(nao quero|nao desejo)$/.test(t)
    || /^nao obrigad[oa]/.test(t)
    || /\b(agora nao|por enquanto nao|no momento nao|nao por enquanto|nao no momento)\b/.test(t);
}
function normalizarNegrito(t) {
  return String(t == null ? '' : t)
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*\*[ \t]+/gm, '• ');
}

const envios = new Map();
async function sendMessage(to, text) {
  { const agora = Date.now(); const l = (envios.get(to) || []).filter(x => agora - x < 60000); if (l.length >= 30) { console.warn('⚠️ Trava de rajada: mensagem não enviada para ' + to); return; } l.push(agora); envios.set(to, l); }
  text = normalizarNegrito(text);
  { const ss0 = sessions.get(to); if (ss0 && /\?\s*$/.test(text.replace(/[\s🙏😊✨]+$/u, ''))) ss0.askedAt = Date.now(); }
  await saveMessage(to, 'out', text);
  crmSaida(to, text);
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: /instagram\.com|google\.com/.test(text) }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Mensagem enviada para ${to}`);
    if (/instagram\.com|google\.com|mpago\.li/.test(text)) await sleep(3000); // mensagens com link/pré-visualização: espera antes da próxima para manter a ordem
  } catch (err) {
    console.error(`❌ Erro ao enviar mensagem para ${to}:`, err.response?.data || err.message);
  }
}

// ─── ENVIAR IMAGEM VIA WHATSAPP API (logo na abertura) ────────────────────────
async function sendImage(to, imageUrl, caption) {
  if (!imageUrl) return;
  try {
    const rImg = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: caption ? { link: imageUrl, caption } : { link: imageUrl }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🖼️ Imagem enviada para ${to}`);
    await aguardarEntrega(rImg.data?.messages?.[0]?.id, 4000, 25000); // só segue depois que a Meta confirma a entrega da imagem
    return true;
  } catch (err) {
    console.error(`❌ Erro ao enviar imagem para ${to}:`, err.response?.data || err.message);
    return false;
  }
}

// Cartão de contato do Paulo (aparece no WhatsApp com o botão de conversar)
const PAULO_WA = '5517988271998';
async function sendContact(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'contacts',
        contacts: [{
          name: { formatted_name: 'Paulo Rodrigues - Apometria Brasil', first_name: 'Paulo', last_name: 'Rodrigues' },
          phones: [{ phone: '+55 17 98827-1998', type: 'CELL', wa_id: PAULO_WA }]
        }]
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    await saveMessage(to, 'out', '[contato: Paulo Rodrigues (17) 98827-1998]');
  } catch (err) {
    console.error(`❌ Erro ao enviar contato para ${to}:`, err.response?.data || err.message);
    await sendMessage(to, 'Contato do Paulo: (17) 98827-1998');
  }
}

async function sendDocument(to, link, filename) {
  try {
    const rDoc = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'document', document: { link, filename } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    await saveMessage(to, 'out', `[documento: ${filename}]`);
    await aguardarEntrega(rDoc.data?.messages?.[0]?.id, 4000, 30000); // idem: espera a entrega do PDF
  } catch (err) {
    console.error(`❌ Erro ao enviar documento para ${to}:`, err.response?.data || err.message);
  }
}

// ─── FOTOS (valores e pagamento) ─────────────────────────────────────────────
// As imagens ficam na pasta media/ do repositório (valores.jpg e pagamento.jpg) e são
// servidas em /media/<nome>.jpg. Se o arquivo ainda não existir, vai a versão em texto.
const fs = require('fs');
const path = require('path');
const MEDIA_DIR = path.join(__dirname, 'media');
const PUBLIC_BASE = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://bot-apometria-production.up.railway.app');

const FOTO_TEXTO = {
  especiais: 'Trabalhos específicos:\n\nApometria para empresa (aumentar vendas e desbloquear oportunidades): R$ 400,00\nApometria para imóveis (vendas e trâmites judiciais): R$ 300,00\nApometria para animais de estimação: R$ 150,00',
  valores: `Valores e formatos:

Apometria à distância, individual, entrega em 15 dias úteis: R$ 289,00
Emergencial, vaga de prioridade em 08 dias úteis: R$ 339,00
Pacote de 4 sessões: R$ 800,00 (R$ 200,00 cada trabalho), até 4x no cartão
Familiar, máximo de 5 pessoas da mesma família, trabalhos individuais e relatório único: R$ 600,00
Presencial, meio período (sessão + orientações, 6 horas dedicadas ao seu caso): R$ 720,00

Inclusos em todos: estudo profundo do caso, limpeza energética do lar, envio de Reiki e relatório final em áudio gravado pelo Paulo. Cartão em 2x sem juros em todos os formatos (pacotes em até 4x).`,
  pagamento: `Formas de pagamento: Pix, transferência, depósito ou cartão em 2x sem juros (nos pacotes, em até 4x sem juros). Basta solicitar o Pix ou o link para pagamento via cartão pelo WhatsApp.

Quem está no exterior: atendemos brasileiros em outros países. O pagamento pode ser feito por transferência internacional, Wise ou PayPal, com o valor convertido no dia. É só pedir as instruções pelo WhatsApp.

O pagamento funciona como a confirmação do agendamento e libera a realização do trabalho.`
};

// A imagem de valores sobe como texto base64 (media/valores.jpg.b64) e é decodificada na inicialização.
try {
  const b64Path = path.join(MEDIA_DIR, 'valores.jpg.b64');
  if (fs.existsSync(b64Path)) {
    fs.writeFileSync(path.join(MEDIA_DIR, 'valores.jpg'), Buffer.from(fs.readFileSync(b64Path, 'utf8').replace(/\s/g, ''), 'base64'));
    console.log('🖼️  media/valores.jpg gerada a partir de valores.jpg.b64');
  }
} catch (err) {
  console.error('❌ Erro ao gerar valores.jpg:', err.message);
}

// Acha o arquivo da foto (aceita nome.jpg, nome_1.jpg, nome-qualquer.png etc.)
function acharFoto(nome) {
  try {
    if (!/^\w+$/.test(nome)) return null;
    const re = new RegExp(`^${nome}([_-][\\w-]+)?\\.(jpg|jpeg|png)$`);
    const lista = fs.readdirSync(MEDIA_DIR).filter(f => re.test(f));
    // Com mais de uma versão, vale a de maior número no nome (valores_3.jpg vence valores_2.jpg)
    const num = f => { const m = f.match(/(\d+)\.\w+$/); return m ? parseInt(m[1], 10) : 0; };
    lista.sort((a, b) => num(b) - num(a));
    return lista[0] || null;
  } catch (e) { return null; }
}

async function enviarPdf(from, session) {
  if (session.pdfEnviado) return false;
  session.pdfEnviado = true;
  const pdfOk = fs.existsSync(path.join(MEDIA_DIR, 'Orientacoes-Apometria-Brasil.pdf'));
  await sleep(typingDelay(PDF_MSG)); await sendMessage(from, PDF_MSG);
  if (pdfOk) await sendDocument(from, PUBLIC_BASE + '/media/Orientacoes-Apometria-Brasil.pdf', 'Orientacoes-Apometria-Brasil.pdf');
  return true;
}
const RE_ESPECIAIS = /\b(empresa|empresas|empresarial|imovel|imoveis|terreno|terrenos|animal|animais|estimacao|cachorro|cachorra)\b/;
// Pessoa citou empresa, imóvel ou animal: envia o card dos trabalhos específicos (uma vez por conversa)
async function enviarEspeciais(to, session, text) {
  if (session.fotoEspeciaisEnviada || !RE_ESPECIAIS.test(semAcento(text))) return false;
  session.fotoEspeciaisEnviada = true;
  await sleep(2000); await sendMessage(to, 'Vou lhe enviar os valores dos trabalhos específicos, segue abaixo.');
  await sleep(1500); await enviarFoto(to, 'especiais');
  return true;
}
async function enviarFoto(to, nome) {
  const arq = acharFoto(nome);
  crmSaida(to);
  if (nome === 'valores') { const ss = sessions.get(to); if (ss) ss.viuValores = true; crmSet(to, { viu_valores: true }).catch(() => {}); }
  if (arq) {
    await saveMessage(to, 'out', `[imagem: ${nome}]`);
    await sendImage(to, `${PUBLIC_BASE}/media/${arq}`);
  } else if (FOTO_TEXTO[nome]) {
    await sendMessage(to, FOTO_TEXTO[nome]);
  }
}

// ─── DELAY REALISTA ENTRE MENSAGENS ───────────────────────────────────────────
function typingDelay(text) {
  // Ritmo mais calmo: a pessoa tem tempo de ler cada bloco
  let d = text.length > 500 ? 9000 : Math.min(2500 + text.length * 30, 6500);
  // Quebra de título: respiro maior antes de começar uma nova etapa
  if (/^\*(Etapa \d|Vamos explicar)/.test(text)) d += 3000;
  return d;
}

// Espera a confirmação de entrega (status delivered/read) de uma mensagem de mídia antes de seguir
const entregues = new Set();
const aguardando = new Map();
function marcarEntrega(id) {
  entregues.add(id);
  if (entregues.size > 500) entregues.delete(entregues.values().next().value);
  const r = aguardando.get(id);
  if (r) { aguardando.delete(id); r(); }
}
async function aguardarEntrega(id, minMs, maxMs) {
  await sleep(minMs);
  if (id && !entregues.has(id)) {
    await new Promise(resolve => {
      const t = setTimeout(() => { aguardando.delete(id); console.log(`⏱️ Sem confirmação de entrega (${id}), seguindo`); resolve(); }, Math.max(0, maxMs - minMs));
      aguardando.set(id, () => { clearTimeout(t); resolve(); });
    });
  }
  await sleep(1500);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pausarEAvisar(phone, session, motivo) {
  session.pausado = true;
  session.pausadoEm = Date.now();
  session.pausadoPor = 'bot';
  console.log(`⏸️  Conversa ${phone} pausada pelo bot (${motivo}). Paulo deve assumir.`);
  await upsertConversation(phone, session.clientName, session.stage);
  await crmAlertar('saiu_do_fluxo', phone, 'Motivo: ' + motivo, session.clientName);
}

async function sendClaudeResponse(to, rawText, session) {
  const pausar = /\[\[PAUSAR\]\]/.test(rawText);
  const clean = rawText.replace(/\[\[PAUSAR\]\]/g, '');
  const parts = clean.split('|||').map(p => p.trim()).filter(Boolean).slice(0, 6);
  for (let i = 0; i < parts.length; i++) {
    if (/\[\[CONTATO:\w+\]\]/.test(parts[i])) {
      const restoC = parts[i].replace(/\[\[CONTATO:\w+\]\]/g, '').trim();
      if (restoC) { await sleep(typingDelay(restoC)); await sendMessage(to, restoC); }
      await sleep(2000);
      await sendContact(to);
      continue;
    }
    const fm = parts[i].match(/\[\[FOTO:(\w+)\]\]/);
    if (fm && session && ((fm[1] === 'pagamento' && session.fotoPagEnviada) || (fm[1] === 'especiais' && session.fotoEspeciaisEnviada))) {
      const restoD = parts[i].replace(fm[0], '').trim();
      if (restoD) { await sleep(typingDelay(restoD)); await sendMessage(to, restoD); }
      continue;
    }
    if (fm) {
      if (session && fm[1] === 'pagamento') session.fotoPagEnviada = true;
      if (session && fm[1] === 'especiais') session.fotoEspeciaisEnviada = true;
      await sleep(3500);
      await enviarFoto(to, fm[1]);
      const resto = parts[i].replace(fm[0], '').trim();
      if (resto) { await sleep(typingDelay(resto)); await sendMessage(to, resto); }
      continue;
    }
    if (i > 0 && parts[i].length > 500) await sleep(5000);
    // Ao enviar o Pix, vai antes o card com as formas de pagamento (mostra o parcelamento em 2x sem juros)
    if (/17988271998/.test(parts[i]) && session && !session.fotoPagEnviada) {
      session.fotoPagEnviada = true;
      await sleep(2000);
      await enviarFoto(to, 'pagamento');
    }
    await sleep(typingDelay(parts[i]));
    await sendMessage(to, parts[i]);
  }
  if (pausar && session) await pausarEAvisar(to, session, 'pedido do bot');
}

// ─── PROCESSAR MENSAGEM COM CLAUDE ────────────────────────────────────────────
async function processWithClaude(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });

  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }
  // A API exige que o primeiro turno seja do usuário
  while (session.history.length && session.history[0].role !== 'user') session.history.shift();

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: buildSystemPrompt(session.clientName, session.etapa) + (session.ctxCliente ? '\n\n' + session.ctxCliente : ''),
      messages: session.history
    });

    const assistantMessage = response.content[0].text;
    session.history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (err) {
    console.error('❌ Erro na API do Claude:', err.message);
    session.history.pop();
    return 'Tivemos um problema técnico agora. Tente novamente em instantes ou aguarde o retorno do Paulo. 🙏';
  }
}

// ─── ENVIO MANUAL PELO PAINEL (humano assume a conversa) ─────────────────────
async function sendManual(phone, texto) {
  const session = getSession(phone);
  session.pausado = true; // ao responder manualmente, pausa as respostas automáticas
  session.pausadoEm = Date.now();
  session.pausadoPor = 'humano';
  session.history.push({ role: 'assistant', content: texto });
  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }
  await sendMessage(phone, texto);
  await upsertConversation(phone, session.clientName, session.stage);
}

function setPausado(phone, pausado) {
  const session = getSession(phone);
  session.pausado = pausado;
  session.pausadoEm = pausado ? Date.now() : null;
  session.pausadoPor = pausado ? 'humano' : null;
  return session;
}

// ─── LÓGICA DE ROTEAMENTO DE MENSAGENS ───────────────────────────────────────
const filas = new Map();
const lotes = new Map();
const BATCH_MS = parseInt(process.env.BATCH_MS || '4000', 10);
function enfileirar(from, messageText, mediaInfo, recebidoEm) {
  const anterior = filas.get(from) || Promise.resolve();
  const p = anterior.catch(() => {}).then(() => handleMessageInner(from, messageText, mediaInfo, recebidoEm));
  filas.set(from, p);
  p.catch(() => {}).then(() => { if (filas.get(from) === p) filas.delete(from); });
  return p;
}
function liberarLote(from) {
  const l = lotes.get(from);
  if (!l) return null;
  clearTimeout(l.t);
  lotes.delete(from);
  const textos = l.textos.filter((x, i) => i === 0 || x !== l.textos[i - 1]);
  return enfileirar(from, textos.join('\n'), null, l.ultimo);
}
// Mensagens de texto em sequência viram UMA só (espera BATCH_MS de silêncio): responde uma vez, com o contexto inteiro
function handleMessage(from, messageText, mediaInfo = null) {
  if (mediaInfo) { liberarLote(from); return enfileirar(from, messageText, mediaInfo, Date.now()); }
  let l = lotes.get(from);
  if (!l) { l = { textos: [], t: null, ultimo: 0 }; lotes.set(from, l); }
  l.textos.push(messageText);
  l.ultimo = Date.now();
  clearTimeout(l.t);
  l.t = setTimeout(() => {
    const p = liberarLote(from);
    if (p) p.catch(err => console.error(`❌ Erro ao processar mensagem de ${from}:`, err));
  }, BATCH_MS);
  return Promise.resolve();
}
const msgsVistas = new Map();
function jaProcessada(id) {
  if (!id) return false;
  const a = Date.now();
  for (const [k, t] of msgsVistas) if (a - t > 3600000) msgsVistas.delete(k);
  if (msgsVistas.has(id)) return true;
  msgsVistas.set(id, a);
  return false;
}
async function handleMessageInner(from, messageText, mediaInfo = null, recebidoEm = Date.now()) {
  const session = getSession(from);
  await restaurarSessao(from, session);
  let text = messageText.trim();
  if (!mediaInfo) { const op = detectaOpcao(text); if (op) session.opcaoCtx = op; }

  console.log(`📩 Mensagem de ${from}: "${text}" | Estágio: ${session.stage}`);

  if (mediaInfo) {
    const midia = await baixarMidiaWhatsapp(mediaInfo.id);
    await saveMessage(from, 'in', text, midia?.base64 || null, midia?.mime || mediaInfo.mimeType || null);
    if (midia && mediaInfo.tipo !== 'audio') encaminharComprovante(from, session.clientName, midia).catch(e => console.error('❌ Encaminhar comprovante:', e.message));
  } else {
    await saveMessage(from, 'in', text);
  }
  notificarPush();
  await upsertConversation(from, session.clientName, session.stage);
  await crmEntrada(from, mediaInfo, session, text);

  if (session.pausado && session.pausadoPor === 'bot' && session.pausadoEm && (Date.now() - session.pausadoEm) > PAUSE_TTL_MS) {
    session.pausado = false;
    session.pausadoEm = null;
    session.pausadoPor = null;
    console.log(`▶️  Conversa com ${from} retomada automaticamente (ninguém assumiu em 4h).`);
  }

  if (session.pausado) {
    console.log(`⏸️  Conversa com ${from} está pausada (atendimento manual). Bot não respondeu.`);
    return;
  }

  // Áudio: este canal não ouve áudios (responde uma vez por minuto)
  if (mediaInfo && mediaInfo.tipo === 'audio') {
    const ag = Date.now();
    if (!session.ultimoAudio || ag - session.ultimoAudio > 60000) { session.ultimoAudio = ag; await sleep(1500); await sendMessage(from, AUDIO_MSG); }
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  // Estágio travado ANTES de qualquer await (mensagens em rajada)
  if (session.stage === 'abertura') {
    session.stage = 'aguardando_nome';
    const m = text.match(/Ref\.?\s*:?\s*(\d{3,})/i);
    if (m) session.ref = m[1];
    // Logo do instituto com o texto de apresentação na legenda (usa media/logo.jpg se existir; senão o LOGO_URL)
    const logoArq = acharFoto('logo');
    const logoUrl = logoArq ? `${PUBLIC_BASE}/media/${logoArq}` : LOGO_URL;
    const imgOk = logoUrl ? await sendImage(from, logoUrl, ABERTURA_MSG) : false;
    if (imgOk) {
      await saveMessage(from, 'out', ABERTURA_MSG);
    } else {
      await sleep(typingDelay(ABERTURA_MSG));
      await sendMessage(from, ABERTURA_MSG);
    }
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  const ctxC = await contextoCliente(from, session);
  session.ctxCliente = ctxC.nota;
  if (session.encerrado && ctxC.pago) session.encerrado = false;
  // Depois de uma despedida: responde só com a pergunta de retomada
  if (session.encerrado && !mediaInfo) {
    session.encerrado = false; session.etapa = null; session.pediuNome = true;
    if (session.stage === 'aguardando_nome' || session.stage === 'aguardando_relato') session.stage = 'conversa';
    await sleep(1500); await sendMessage(from, RETORNO_MSG);
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: RETORNO_MSG });
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }
  const ETAPAS_PENDENTES = ['para_quem', 'aguarda1', 'aguarda2', 'aguarda3', 'oferta', 'agenda', 'mais_detalhes'];
  if (!mediaInfo && ehRecusa(text, ETAPAS_PENDENTES.includes(session.etapa))) {
    session.encerrado = true; session.etapa = null;
    await sleep(1500); await sendMessage(from, DESPEDIDA_MSG);
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: DESPEDIDA_MSG });
    crmSet(from, { followup_off: true }).catch(() => {});
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }
  // Trava de espera: um "sim/ok" digitado ANTES de a pergunta chegar não vale como resposta a ela
  if (!mediaInfo && ETAPAS_PENDENTES.includes(session.etapa) && session.askedAt && recebidoEm < session.askedAt && (ehSim(text) || ehLixoEtapa(text) || /^(nao|n)$/.test(semAcento(text)))) {
    console.log(`🛑 Trava de espera: resposta de ${from} chegou antes da pergunta ("${text}"); ignorada.`);
    return;
  }

  { const dv = await desvioFluxo(from, text, session); if (dv === true) return; if (dv === 'valores') text = 'quero ver os valores'; }
  // Quebra de fluxo: perguntou os valores antes da hora -> mostra os valores como se tivesse chegado lá, sem falar de etapa
  const pedeValoresFirme = pedeValores(text) && !/quanto tempo|quantos dias|quanto demora|prazo|demora/.test(semAcento(text));
  if (!session.viuValores && !session.valoresEmAndamento && pedeValoresFirme &&
      (session.stage === 'aguardando_nome' || session.etapa === 'para_quem' || session.etapa === 'queixa' || session.etapa === 'aguarda1' || session.etapa === 'aguarda2' || session.etapa === 'aguarda3' || session.etapa === 'oferta')) {
    session.valoresEmAndamento = true;
    session.stage = 'conversa';
    session.pediuNome = true;
    session.viuValores = true;
    session.etapa = 'mais_detalhes';
    try {
      await sleep(2500);
      const intro = 'Ok, vou lhe enviar os valores e as opções de atendimento, segue abaixo.';
      await sendMessage(from, intro);
      await sleep(2500);
      await enviarFoto(from, 'valores');
      for (const m of [APOS_PAGAMENTO_MSG, ETAPA3_NOTA, CONTATO_PAULO_MSG]) { await sleep(typingDelay(m)); await sendMessage(from, m); }
      await sleep(1200); await sendContact(from);
      const itens = [];
      if (!session.vistoProc) itens.push('🔎 *Detalhes do procedimento*');
      if (!session.vistoRecebe) itens.push('✨ *O que você recebe*');
      let fim;
      if (itens.length) {
        fim = 'Se quiser, podemos explicar também:\n\n' + itens.join('\n') + '\n\nOu, se preferir, já podemos seguir para o seu agendamento.';
      } else {
        fim = PERGUNTA_AGENDA;
        session.etapa = 'agenda';
      }
      await sleep(typingDelay(fim));
      await sendMessage(from, fim);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [intro, '[foto com os valores e formatos enviada]', APOS_PAGAMENTO_MSG, ETAPA3_NOTA, CONTATO_PAULO_MSG, '[cartão de contato do Paulo enviado]', fim].join('\n\n') }
      );
    } finally { session.valoresEmAndamento = false; }
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  // Depois dos valores: mostra os detalhes que a pessoa ainda não viu
  if (session.etapa === 'mais_detalhes') {
    const t = semAcento(text);
    const ambos = /\b(ambos|os dois|tudo|todos|as duas)\b/.test(t);
    const querProc = /procediment|detalhes|como funciona/.test(t);
    const querRecebe = /o que (eu )?(recebo|vou receber|ganho|receb)|inclui|incluso/.test(t);
    let mostrar = [];
    if (ambos || (querProc && querRecebe)) mostrar = ['proc', 'recebe'];
    else if (querProc) mostrar = ['proc'];
    else if (querRecebe) mostrar = ['recebe'];
    else if (ehSim(text)) mostrar = [!session.vistoProc ? 'proc' : 'recebe'];
    mostrar = mostrar.filter(k => (k === 'proc' ? !session.vistoProc : !session.vistoRecebe));
    if (mostrar.length) {
      session.etapa = 'mais_detalhes_andamento';
      const enviados = [];
      for (const k of mostrar) {
        const partes = (k === 'proc' ? ETAPA1 : ETAPA2).slice(1);
        for (const parte of partes) { await sleep(typingDelay(parte)); await sendMessage(from, parte); enviados.push(parte); }
        if (k === 'proc') {
          session.vistoProc = true;
          await enviarPdf(from, session);
        } else session.vistoRecebe = true;
      }
      let fim;
      if (!session.vistoProc) { fim = 'Quer ver também os *detalhes do procedimento*?'; session.etapa = 'mais_detalhes'; }
      else if (!session.vistoRecebe) { fim = 'Quer ver também o que você recebe?'; session.etapa = 'mais_detalhes'; }
      else { fim = PERGUNTA_AGENDA; session.etapa = 'agenda'; }
      await sleep(typingDelay(fim));
      await sendMessage(from, fim);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: [...enviados, fim].join('\n\n') });
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
  }

  if (session.stage === 'aguardando_nome') {
    let nome = extrairNomeSeguro(text);
    if (!nome && !session.pediuNome) {
      // Não é um nome: responde ao que a pessoa disse e pede o nome uma única vez
      session.pediuNome = true;
      session.etapa = 'nome';
      const resp = await processWithClaude(session, text);
      session.etapa = null;
      await sendClaudeResponse(from, resp, session);
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
    // Sem nome depois de pedir uma vez: segue o fluxo sem nome, sem insistir
    nome = nome || '';
    session.stage = 'conversa';
    session.etapa = 'para_quem';
    session.clientName = nome || null;
    const ok = nome ? `Agradecemos o seu contato, *${nome}*.` : 'Agradecemos o seu contato.';
    await sleep(2500);
    await sendMessage(from, ok);
    await sleep(typingDelay(QUEM_SOMOS_MSG));
    await sendMessage(from, QUEM_SOMOS_MSG);
    await sleep(typingDelay(INSTAGRAM_MSG));
    await sendMessage(from, INSTAGRAM_MSG);
    await sleep(typingDelay(GOOGLE_MSG));
    await sendMessage(from, GOOGLE_MSG);
    await sleep(typingDelay(PERGUNTA_PARA_QUEM));
    await sendMessage(from, PERGUNTA_PARA_QUEM);
    session.history.push(
      { role: 'user', content: nome ? `Meu nome é ${nome}` : text },
      { role: 'assistant', content: [ok, QUEM_SOMOS_MSG, INSTAGRAM_MSG, GOOGLE_MSG, PERGUNTA_PARA_QUEM].join('\n\n') }
    );
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.etapa === 'para_quem' || session.etapa === 'queixa') {
    session.etapa = 'para_quem_andamento'; // trava antes dos awaits (mensagens em rajada)
    await enviarEspeciais(from, session, text);
    if (text.split(/\s+/).filter(Boolean).length <= 6) {
      const ack = 'Ok, entendo perfeitamente.';
      await sleep(2000); await sendMessage(from, ack);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: ack });
    } else {
      const respQuem = await processWithClaude(session, text);
      await sendClaudeResponse(from, respQuem, session);
    }
    if (session.pausado) { session.etapa = 'aguarda1'; await upsertConversation(from, session.clientName, session.stage); return; }
    await sleep(typingDelay(TITULO_MSG)); await sendMessage(from, TITULO_MSG);
    await sleep(typingDelay(PERGUNTA1)); await sendMessage(from, PERGUNTA1);
    session.etapa = 'aguarda1';
    session.history.push({ role: 'assistant', content: [TITULO_MSG, PERGUNTA1].join('\n\n') });
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.etapa === 'aguarda1' || session.etapa === 'aguarda2' || session.etapa === 'aguarda3') {
    const querValores = pedeValores(text);
    if (session.etapa === 'aguarda1' && ehSim(text) && !querValores) {
      session.etapa = 'aguarda2'; // trava antes dos awaits (mensagens em rajada)
      session.vistoProc = true;
      for (const parte of ETAPA1) { await sleep(typingDelay(parte)); await sendMessage(from, parte); }
      await enviarPdf(from, session);
      await sleep(typingDelay(PERGUNTA2)); await sendMessage(from, PERGUNTA2);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: [...ETAPA1, PDF_MSG + ' [PDF enviado]', PERGUNTA2].join('\n\n') });
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
    if (session.etapa === 'aguarda2' && ehSim(text) && !querValores) {
      session.etapa = 'aguarda3'; // trava antes dos awaits (mensagens em rajada)
      session.vistoRecebe = true;
      for (const parte of ETAPA2) {
        await sleep(typingDelay(parte));
        await sendMessage(from, parte);
      }
      await sleep(typingDelay(PERGUNTA3));
      await sendMessage(from, PERGUNTA3);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [...ETAPA2, PERGUNTA3].join('\n\n') }
      );
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
    if ((session.etapa === 'aguarda3' && ehSim(text)) || querValores) {
      session.etapa = null; // trava antes dos awaits
      await sleep(typingDelay(ETAPA3_TITULO));
      await sendMessage(from, ETAPA3_TITULO);
      await sleep(2000);
      await enviarFoto(from, 'valores');
      await sleep(typingDelay(APOS_PAGAMENTO_MSG));
      await sendMessage(from, APOS_PAGAMENTO_MSG);
      await sleep(typingDelay(ETAPA3_NOTA));
      await sendMessage(from, ETAPA3_NOTA);
      await sleep(typingDelay(CONTATO_PAULO_MSG));
      await sendMessage(from, CONTATO_PAULO_MSG);
      await sleep(1200);
      await sendContact(from);
      await sleep(typingDelay(PERGUNTA_AGENDA));
      await sendMessage(from, PERGUNTA_AGENDA);
      session.etapa = 'agenda';
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [ETAPA3_TITULO, '[foto com os valores e formatos enviada]', APOS_PAGAMENTO_MSG, ETAPA3_NOTA, CONTATO_PAULO_MSG, '[cartão de contato do Paulo enviado]', PERGUNTA_AGENDA].join('\n\n') }
      );
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
  }

  if (session.etapa === 'agenda' && ehSim(text) && !/individual|emergencial|pacote|familiar|presencial|avulsa|sessoes|sessao/.test(semAcento(text))) {
    if (session.opcaoCtx) {
      // já falou de uma opção: segue direto para o pagamento dela, sem perguntar de novo
      session.etapa = 'modalidade';
      text = 'Sim, quero agendar. A opção escolhida é: ' + session.opcaoCtx + '.';
    } else {
    session.etapa = 'modalidade';
    await sleep(2000); await sendMessage(from, MODALIDADES_MSG);
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: MODALIDADES_MSG });
    await upsertConversation(from, session.clientName, session.stage);
    return;
    }
  }

  if (session.stage === 'aguardando_relato') session.stage = 'conversa';

  const etapaAntes = session.etapa;
  if (!mediaInfo && await enviarEspeciais(from, session, text)) text += '\n[Sistema: o card com os valores dos trabalhos específicos já foi enviado agora; não envie [[FOTO:especiais]] de novo, apenas responda de forma curta.]';
  const response = await processWithClaude(session, text);
  if (etapaAntes === 'modalidade' && session.etapa === 'modalidade') session.etapa = null;
  await sendClaudeResponse(from, response, session);
  await upsertConversation(from, session.clientName, session.stage);
}

// ─── ROTAS DO WEBHOOK ─────────────────────────────────────────────────────────

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        for (const st of value?.statuses || []) {
          if (st.status === 'delivered' || st.status === 'read' || st.status === 'failed') marcarEntrega(st.id);
        }
        if (!value?.messages) continue;

        for (const message of value.messages) {
          const from = message.from;
          if (jaProcessada(message.id)) { console.log(`🔁 Mensagem duplicada ignorada (${message.id})`); continue; }
          if (message.timestamp && (Date.now() / 1000 - Number(message.timestamp)) > 1200) { console.log(`⌛ Mensagem antiga ignorada (${message.id})`); continue; }

          if (message.type === 'text') {
            handleMessage(from, message.text.body).catch(err => {
              console.error(`❌ Erro ao processar mensagem de ${from}:`, err);
            });
          } else if (message.type === 'image' || message.type === 'document') {
            const media = message.image || message.document;
            handleMessage(
              from,
              '[Cliente enviou um comprovante/imagem/documento]',
              { id: media.id, mimeType: media.mime_type, tipo: message.type }
            ).catch(err => {
              console.error(`❌ Erro ao processar mídia de ${from}:`, err);
            });
          } else if (message.type === 'audio') {
            handleMessage(from, '[Cliente enviou um áudio]', { id: message.audio.id, mimeType: message.audio.mime_type, tipo: 'audio' }).catch(err => {
              console.error(`❌ Erro ao processar áudio de ${from}:`, err);
            });
          } else {
            sendMessage(from, 'No momento processo apenas texto. Por favor, escreva sua mensagem. 🙏');
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro no processamento do webhook:', err);
  }
});

app.get('/media/:nome', (req, res) => {
  const nome = req.params.nome.replace(/[^\w.-]/g, '');
  const arquivo = path.join(MEDIA_DIR, nome);
  if (!arquivo.startsWith(MEDIA_DIR) || !fs.existsSync(arquivo)) return res.sendStatus(404);
  res.sendFile(arquivo);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, banco: !!pool });
});

// ─── PAINEL DE CONVERSAS (protegido por usuário/senha) ────────────────────────
const authCrypto = require('crypto');
function painelChave() { return authCrypto.createHash('sha256').update('painel:' + DASHBOARD_USER + ':' + DASHBOARD_PASSWORD).digest(); }
function painelToken() {
  const corpo = Buffer.from(JSON.stringify({ u: DASHBOARD_USER, exp: Date.now() + 365 * 86400000 })).toString('base64url');
  return corpo + '.' + authCrypto.createHmac('sha256', painelChave()).update(corpo).digest('base64url');
}
function painelTokenOk(tok) {
  try {
    const partes = String(tok || '').split('.');
    if (partes.length !== 2) return false;
    const esp = authCrypto.createHmac('sha256', painelChave()).update(partes[0]).digest('base64url');
    if (partes[1].length !== esp.length || !authCrypto.timingSafeEqual(Buffer.from(partes[1]), Buffer.from(esp))) return false;
    const d = JSON.parse(Buffer.from(partes[0], 'base64url').toString());
    return d.u === DASHBOARD_USER && d.exp > Date.now();
  } catch (e) { return false; }
}
function lerCookie(req, nome) {
  const m = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(nome + '='));
  return m ? decodeURIComponent(m.slice(nome.length + 1)) : '';
}
function credIgual(a, b) {
  return authCrypto.timingSafeEqual(authCrypto.createHash('sha256').update(String(a)).digest(), authCrypto.createHash('sha256').update(String(b)).digest());
}
function gravarCookieLogin(res) {
  res.append('Set-Cookie', 'painel_sess=' + encodeURIComponent(painelToken()) + '; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax');
}
function autenticarPainel(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    return res.status(503).send('Painel não configurado. Defina DASHBOARD_USER e DASHBOARD_PASSWORD no Railway.');
  }
  if (req.path === '/login' || req.path === '/app-icon.png') return next();
  if (painelTokenOk(lerCookie(req, 'painel_sess'))) return next();
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const dec = Buffer.from(auth.slice(6), 'base64').toString();
    const i = dec.indexOf(':');
    if (i > 0 && credIgual(dec.slice(0, i), DASHBOARD_USER) && credIgual(dec.slice(i + 1), DASHBOARD_PASSWORD)) { gravarCookieLogin(res); return next(); }
  }
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) return res.redirect('/painel/login?next=' + encodeURIComponent(req.originalUrl));
  return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
}

app.use('/painel', autenticarPainel);

const LOGIN_HTML = [
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#12585C">',
  '<link rel="icon" href="/painel/app-icon.png"><title>Entrar — Apometria Brasil</title><style>',
  '*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'body{background:#12585C;display:flex;align-items:center;justify-content:center;padding:24px;min-height:100vh}',
  '.cx{background:#F5F1E8;border-radius:22px;padding:28px 24px;width:100%;max-width:380px;box-shadow:0 10px 40px rgba(0,0,0,.25)}',
  '.cx img{width:84px;height:84px;border-radius:20px;display:block;margin:0 auto 14px}',
  'h1{margin:0 0 4px;text-align:center;color:#08262A;font-size:22px}p{margin:0 0 20px;text-align:center;color:#5d7170;font-size:14px}',
  'label{display:block;font-weight:700;font-size:14px;color:#14302f;margin:12px 0 6px}',
  'input{width:100%;border:2px solid #d6d0c1;border-radius:12px;padding:13px 14px;font-size:17px;background:#fff;color:#14302f;outline:none}input:focus{border-color:#12585C}',
  'button{width:100%;margin-top:20px;background:#12585C;color:#fff;border:0;border-radius:14px;padding:15px;font-size:17px;font-weight:700;cursor:pointer}',
  '.er{background:#fde3df;color:#8f2a20;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:8px;text-align:center}',
  '.nt{margin-top:14px;text-align:center;font-size:12.5px;color:#5d7170}</style></head><body>',
  '<form class="cx" method="post" action="/painel/login"><img src="/painel/app-icon.png" alt=""><h1>Apometria Brasil</h1><p>Painel de atendimento</p>',
  '@@ERRO@@<input type="hidden" name="next" value="@@NEXT@@">',
  '<label for="u">Usuário</label><input id="u" name="usuario" autocomplete="username" autocapitalize="none" autocorrect="off" required>',
  '<label for="s">Senha</label><input id="s" name="senha" type="password" autocomplete="current-password" required>',
  '<button type="submit">Entrar</button><div class="nt">Este aparelho fica conectado, sem pedir senha de novo.</div></form></body></html>'
].join('\n');
const _loginTent = new Map();
app.get('/painel/login', (req, res) => {
  if (painelTokenOk(lerCookie(req, 'painel_sess'))) return res.redirect('/painel/app');
  const next = String(req.query.next || '/painel/app');
  const seguro = /^\/painel(\/|$|\?)/.test(next) && !next.startsWith('//') ? next : '/painel/app';
  res.set('Cache-Control', 'no-store').type('html').send(LOGIN_HTML.replace('@@ERRO@@', req.query.erro ? '<div class="er">Usuário ou senha incorretos.</div>' : '').replace('@@NEXT@@', seguro.replace(/"/g, '&quot;').replace(/</g, '&lt;')));
});
app.post('/painel/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip || 'x', t = _loginTent.get(ip) || { n: 0, desde: Date.now() };
  if (Date.now() - t.desde > 900000) { t.n = 0; t.desde = Date.now(); }
  if (t.n >= 10) return res.status(429).send('Muitas tentativas. Aguarde alguns minutos.');
  const b = req.body || {};
  const next = String(b.next || '/painel/app');
  const seguro = /^\/painel(\/|$|\?)/.test(next) && !next.startsWith('//') ? next : '/painel/app';
  if (b.usuario && b.senha && credIgual(b.usuario, DASHBOARD_USER) && credIgual(b.senha, DASHBOARD_PASSWORD)) {
    _loginTent.delete(ip);
    gravarCookieLogin(res);
    return res.redirect(303, seguro);
  }
  t.n++; _loginTent.set(ip, t);
  res.redirect(303, '/painel/login?erro=1&next=' + encodeURIComponent(seguro));
});
app.get('/painel/sair', (req, res) => {
  res.append('Set-Cookie', 'painel_sess=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
  res.redirect('/painel/login');
});

// Lista de conversas (mais recentes primeiro)
app.get('/painel/api/conversas', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(`
      SELECT c.phone, c.client_name, c.stage, c.updated_at,
        (SELECT content FROM messages m WHERE m.phone = c.phone ORDER BY m.created_at DESC LIMIT 1) AS ultima_mensagem
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 200
    `);
    const comEstado = rows.map(r => ({
      ...r,
      pausado: sessions.get(r.phone)?.pausado || false
    }));
    res.json(comEstado);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Mensagens de uma conversa específica
app.get('/painel/api/conversas/:phone', async (req, res) => {
  if (!pool) return res.json({ mensagens: [], pausado: false });
  try {
    const { rows } = await pool.query(
      `SELECT id, direction, content, media_base64, media_mime, created_at
       FROM messages WHERE phone = $1 ORDER BY created_at ASC`,
      [req.params.phone]
    );
    res.json({
      mensagens: rows,
      pausado: sessions.get(req.params.phone)?.pausado || false
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Enviar mensagem manualmente pelo painel (pausa o bot automaticamente nessa conversa)
app.post('/painel/api/conversas/:phone/enviar', async (req, res) => {
  const texto = (req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio.' });
  try {
    await sendManual(req.params.phone, texto);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Pausar ou retomar as respostas automáticas do bot para uma conversa
app.post('/painel/api/conversas/:phone/pausar', async (req, res) => {
  const pausado = !!req.body?.pausado;
  const session = setPausado(req.params.phone, pausado);
  await upsertConversation(req.params.phone, session.clientName, session.stage);
  res.json({ ok: true, pausado });
});

// Enviar áudio gravado no app (converte para OGG/Opus, formato de mensagem de voz do WhatsApp)
app.post('/painel/api/app/audio/:phone', express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
  const fsA = require('fs'), osA = require('os'), pathA = require('path'), { spawn } = require('child_process');
  const phone = req.params.phone;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 500) return res.status(400).json({ erro: 'Áudio vazio.' });
  const mime = String(req.headers['content-type'] || '');
  const ext = /mp4|aac|m4a/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
  const idA = Date.now() + '_' + Math.random().toString(36).slice(2);
  const inp = pathA.join(osA.tmpdir(), 'a_' + idA + '.' + ext), out = pathA.join(osA.tmpdir(), 'a_' + idA + '.out.ogg');
  try {
    fsA.writeFileSync(inp, buf);
    const ffmpegBin = require('ffmpeg-static');
    await new Promise((ok, ko) => {
      const p = spawn(ffmpegBin, ['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip', out]);
      let er = ''; p.stderr.on('data', x => { er += x; });
      p.on('close', cod => cod === 0 ? ok() : ko(new Error('ffmpeg ' + cod + ' ' + er.slice(-200))));
      p.on('error', ko);
    });
    const ogg = fsA.readFileSync(out);
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp'); fd.append('type', 'audio/ogg');
    fd.append('file', new Blob([ogg], { type: 'audio/ogg' }), 'audio.ogg');
    const up = await fetch('https://graph.facebook.com/v21.0/' + WHATSAPP_PHONE_ID + '/media', { method: 'POST', headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN }, body: fd });
    const uj = await up.json();
    if (!uj.id) throw new Error('upload: ' + JSON.stringify(uj));
    await axios.post('https://graph.facebook.com/v21.0/' + WHATSAPP_PHONE_ID + '/messages', { messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { id: uj.id } }, { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } });
    const session = getSession(phone);
    session.pausado = true; session.pausadoEm = Date.now(); session.pausadoPor = 'humano';
    session.history.push({ role: 'assistant', content: '[áudio enviado pela equipe]' });
    await saveMessage(phone, 'out', '[áudio]', ogg.toString('base64'), 'audio/ogg');
    crmSaida(phone, '[áudio]');
    await upsertConversation(phone, session.clientName, session.stage);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Áudio do app:', (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ erro: err.message });
  } finally {
    try { fsA.unlinkSync(inp); } catch (e) {} try { fsA.unlinkSync(out); } catch (e) {}
  }
});

// ─── APP DO CELULAR (PWA instalável, notificações push) ──────────────────────
// Abrir no Android: https://bot-apometria-production.up.railway.app/painel/app → "Instalar app"
const nodeCrypto = require('crypto');
const APP_ICON_MASK = 'eNrtlrFOHDEQhm1ZOjcntqVAWR6BkiJieZR7BEoKxC4VZR6BV1mUIiWvsBEvYDpLsXYyM947POMlSGkiReeTDvHpNDP+Z/zbxhzXcR3Xf7w6mNawB5hXfz6ZZqyxg8HYVPM20NdQ8X4w98ZVmTGExUi3VfiABY3mRHMspcH6vU7QYVLkVleaiGNJNyptJB3w67RKm/lWiTMt3KvdDgt3gy4HOSZXBd2TEsTNpMtETvrf6DJN7sulLnPhZ4JPBy6U8yNzyrJRalJeyuL0trJuxg5qW6yz2tgVB8tzNartIme0K/hdHjjm5YbjfrJwXSgZjMvjWXTMBv5zqznLgzvlOFslj/FuXOVLnSdKtv2+Nkq2RZ9yIpohn69cruZZf2OVzBYAjBS6Xc4jC6F5hzzUnMLkAzyKdjniUHPPfBD8indLa6x4y5yUuD7wr4LvRHszDxXv/sij4OlTniref8ovVvgsePwLDrAXWsZ/5+drfFB1chvh1wonQd+oMUI3x/znCqdGTjWfiY/9pLjPvKu5rzkea594Psntd+Wc+OT2/LrkTWTeBDVXTSBufCz5l3eeSo5z3k4fcUtdaZI6F8zBtLHkDcVn3gXBBwzMHPUpzi/eNm6m+Bb1lNzCA3KyrI30DewJpGYWvkHG0wec5jZW/tPFpS0Ft/hvm3qwoIw+0PntYpOk7xF38BT6oC4Mckh4eeVjWvgq/6Z//QHnyofpYHdvL1d3yrephjaenILyefLMJm0v6U1Q8o0F7LvdwbO6IPH0PsDj1sLGyVcCzSyctdDKe5MsoIPLfu7EvUm9Sg1E+sjHCS4Hr/hJFR/7b/Ao3zpshpN9osNU8WRg7lc4n8dsoZp//4A3imdzhtSBjL/w0Cue3YFGTr3Vsim5xeGEnhjGLw4q9MdK/OLExY3Ekf3i6MUNxr90qvxc6OHJIROHw7dMPHKacfVpauPxeX5cx/Xv1m8oXXyc';
let _iconPng = null;
function appIconPng() {
  if (_iconPng) return _iconPng;
  const zlib = require('zlib'), N = 192, S = 512;
  const bits = zlib.inflateSync(Buffer.from(APP_ICON_MASK, 'base64'));
  const m = (x, y) => (x < 0 || y < 0 || x >= N || y >= N) ? 0 : (bits[(y * N + x) >> 3] >> (7 - ((y * N + x) & 7))) & 1;
  const raw = Buffer.alloc(S * (S * 3 + 1));
  for (let y = 0; y < S; y++) {
    const sy = (y + 0.5) * N / S - 0.5, y0 = Math.floor(sy), fy = sy - y0;
    raw[y * (S * 3 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const sx = (x + 0.5) * N / S - 0.5, x0 = Math.floor(sx), fx = sx - x0;
      let a = m(x0, y0) * (1 - fx) * (1 - fy) + m(x0 + 1, y0) * fx * (1 - fy) + m(x0, y0 + 1) * (1 - fx) * fy + m(x0 + 1, y0 + 1) * fx * fy;
      a = Math.max(0, Math.min(1, (a - 0.5) * 1.6 + 0.5));
      const o = y * (S * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(18 + (245 - 18) * a); raw[o + 1] = Math.round(88 + (241 - 88) * a); raw[o + 2] = Math.round(92 + (232 - 92) * a);
    }
  }
  const tab = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tab[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = tab[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2;
  _iconPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  return _iconPng;
}
const APP_SW = String.raw`self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(){});
self.addEventListener('push',function(e){
  e.waitUntil((async function(){
    var d={titulo:'Apometria Brasil',corpo:'Nova mensagem no WhatsApp',phone:''};
    try{var r=await fetch('/painel/api/app/ultima',{credentials:'include'});if(r.ok)d=await r.json()}catch(x){}
    var cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    var aberto=cs.some(function(c){return c.visibilityState==='visible'});
    if(aberto)return;
    await self.registration.showNotification(d.titulo,{body:d.corpo,icon:'/painel/app-icon.png',badge:'/painel/app-icon.png',tag:'msg-'+(d.phone||'x'),renotify:true,vibrate:[120,60,120],data:{phone:d.phone}});
  })());
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var p=(e.notification.data&&e.notification.data.phone)||'';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){if('focus' in cs[i]){cs[i].postMessage({abrir:p});return cs[i].focus()}}
    return self.clients.openWindow('/painel/app'+(p?'#'+p:''));
  }));
});
`;
const APP_HTML = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#12585C"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/painel/app.webmanifest" crossorigin="use-credentials"><link rel="icon" href="/painel/app-icon.png"><link rel="apple-touch-icon" href="/painel/app-icon.png">
<title>Apometria Brasil — Conversas</title>
<style>
:root{--teal:#12585C;--deep:#08262A;--mint:#B0D6D0;--cream:#F5F1E8;--ink:#14302f;--mut:#5d7170;--verde:#1b8a4b;--ambar:#b86a00;--verm:#c43b2f;--linha:#e2ddd0}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--cream);color:var(--ink);overscroll-behavior:none}
.tela{position:fixed;inset:0;display:flex;flex-direction:column;background:var(--cream)}
.hide{display:none!important}
button{font:inherit;cursor:pointer}
.topo{background:var(--teal);color:#fff;padding:calc(8px + env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));display:flex;align-items:center;gap:10px;min-height:58px}
.topo img{width:34px;height:34px}
.topo h1{font-size:19px;margin:0;font-weight:700;flex:1;line-height:1.1}
.topo small{display:block;font-weight:400;font-size:12px;opacity:.85}
.ib{background:rgba(255,255,255,.14);border:0;color:#fff;width:42px;height:42px;border-radius:50%;font-size:20px;display:flex;align-items:center;justify-content:center}
.ib:active{background:rgba(255,255,255,.28)}
.abas{display:flex;gap:8px;padding:10px 12px 6px;background:var(--cream);overflow-x:auto}
.aba{flex:none;border:2px solid var(--teal);background:#fff;color:var(--teal);border-radius:20px;padding:8px 14px;font-weight:700;font-size:14px;min-height:40px}
.aba.on{background:var(--teal);color:#fff}
.aba b{margin-left:6px;background:var(--verm);color:#fff;border-radius:10px;padding:1px 7px;font-size:12px}
.busca{padding:4px 12px 10px;background:var(--cream)}
.busca input{width:100%;border:2px solid var(--linha);background:#fff;border-radius:14px;padding:11px 14px;font-size:16px;outline:none;color:var(--ink)}
.busca input:focus{border-color:var(--teal)}
#lista{flex:1;overflow-y:auto;background:#fff;-webkit-overflow-scrolling:touch}
.item{display:flex;gap:12px;padding:12px max(14px,env(safe-area-inset-right)) 12px max(14px,env(safe-area-inset-left));border-bottom:1px solid #eee9dd;align-items:center;border-left:6px solid transparent;min-height:72px}
.item:active{background:#eef4f2}
.item.v{border-left-color:var(--verde)}.item.a{border-left-color:var(--ambar)}
.item.nl{background:#f3faf7}
.av{width:48px;height:48px;border-radius:50%;background:var(--mint);color:var(--deep);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;flex:none}
.meio{flex:1;min-width:0}
.l1,.l2{display:flex;justify-content:space-between;gap:8px;align-items:center}
.nome{font-weight:700;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hora{font-size:12px;color:var(--mut);flex:none}
.nl .hora{color:var(--verde);font-weight:700}
.prev{font-size:14.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;margin-top:3px}
.nl .prev{color:var(--ink);font-weight:600}
.chip{font-size:11px;font-weight:800;border-radius:9px;padding:3px 8px;flex:none;letter-spacing:.2px}
.chip.v{background:#d9f1e3;color:#116236}.chip.a{background:#ffe5bd;color:#7a4500}
.bol{background:var(--verm);color:#fff;border-radius:11px;min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;padding:0 6px;flex:none}
.vazio{padding:40px 24px;text-align:center;color:var(--mut);font-size:16px;line-height:1.5}
.cab{background:var(--teal);color:#fff;padding:calc(6px + env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) 6px max(8px,env(safe-area-inset-left));display:flex;align-items:center;gap:8px;min-height:62px}
.cab .av{width:42px;height:42px;font-size:17px}
.cab .t{flex:1;min-width:0}.cab .t b{display:block;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cab .t span{font-size:12.5px;opacity:.9}
.modo{display:flex;align-items:center;gap:10px;padding:9px max(12px,env(safe-area-inset-left));font-size:14px;font-weight:600}
.modo.v{background:#d9f1e3;color:#0f5a31}.modo.a{background:#ffe5bd;color:#6b3d00}
.modo span{flex:1;line-height:1.3}
.modo button{border:0;border-radius:18px;padding:9px 16px;font-weight:800;font-size:14px;min-height:40px;color:#fff}
.modo.v button{background:var(--ambar)}.modo.a button{background:var(--verde)}
#msgs{flex:1;overflow-y:auto;padding:12px max(12px,env(safe-area-inset-left)) 12px;display:flex;flex-direction:column;gap:6px;background:#ebe6d9;-webkit-overflow-scrolling:touch}
.dia{align-self:center;background:#fff;color:var(--mut);font-size:12px;font-weight:700;border-radius:10px;padding:4px 12px;margin:8px 0}
.b{max-width:82%;padding:9px 12px 6px;border-radius:14px;font-size:16px;line-height:1.38;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.b.in{align-self:flex-start;background:#fff;border-top-left-radius:4px}
.b.out{align-self:flex-end;background:#c4e4dd;border-top-right-radius:4px}
.b .h{display:block;text-align:right;font-size:11px;color:var(--mut);margin-top:3px}
.b img{display:block;max-width:100%;border-radius:8px;margin-bottom:4px}
.b audio{max-width:100%;margin-bottom:4px}
.anx{display:inline-block;background:rgba(18,88,92,.12);color:var(--teal);font-weight:700;border-radius:8px;padding:6px 10px;font-size:14px}
.comp{display:flex;gap:8px;padding:8px max(10px,env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom));background:var(--cream);border-top:1px solid var(--linha);align-items:flex-end}
.comp textarea{flex:1;border:2px solid var(--linha);border-radius:22px;padding:11px 16px;font:inherit;font-size:16px;resize:none;max-height:120px;outline:none;background:#fff;color:var(--ink)}
.comp textarea:focus{border-color:var(--teal)}
.env{width:48px;height:48px;border-radius:50%;border:0;background:var(--teal);color:#fff;font-size:22px;flex:none}
.env:disabled{opacity:.45}
.env.mic{background:#fff;color:var(--teal);border:2px solid var(--teal);font-size:20px}
.env.cancel{background:#B5645C}
.aviso{background:#fff4d6;color:#6b4a00;padding:10px 14px;font-size:14px;display:flex;gap:10px;align-items:center}
.aviso button{border:0;background:var(--teal);color:#fff;border-radius:16px;padding:8px 14px;font-weight:700;flex:none}
.toast{position:fixed;left:50%;bottom:calc(90px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--deep);color:#fff;padding:11px 18px;border-radius:20px;font-size:14px;z-index:9;max-width:90%;text-align:center}
</style></head><body>
<div class="tela" id="tl">
 <div class="topo"><img src="/painel/app-icon.png" alt=""><h1>Apometria Brasil<small id="sub">Conversas do WhatsApp</small></h1><button class="ib" id="bn" title="Notificações" aria-label="Notificações">🔔</button><button class="ib" id="br" title="Atualizar" aria-label="Atualizar">⟳</button></div>
 <div class="aviso hide" id="av"><span id="avt"></span><button id="avb">Ativar</button></div>
 <div class="abas"><button class="aba on" data-f="todas">Todas</button><button class="aba" data-f="novas">Não lidas <b id="cn" class="hide">0</b></button><button class="aba" data-f="voce">Você atende</button><button class="aba" data-f="bot">Bot atende</button></div>
 <div class="busca"><input id="q" type="search" placeholder="Buscar nome ou telefone" autocomplete="off"></div>
 <div id="lista"></div>
</div>
<div class="tela hide" id="ch">
 <div class="cab"><button class="ib" id="vl" aria-label="Voltar">←</button><div class="av" id="cav"></div><div class="t"><b id="cnm"></b><span id="ctl"></span></div></div>
 <div class="modo v" id="md"><span id="mdt"></span><button id="mdb"></button></div>
 <div id="msgs"></div>
 <div class="comp"><textarea id="tx" rows="1" placeholder="Escreva uma mensagem"></textarea><button class="env mic" id="mic" aria-label="Gravar áudio">🎤</button><button class="env" id="en" aria-label="Enviar">➤</button><div id="rec" style="display:none;flex:1;align-items:center;gap:10px"><button class="env cancel" id="rc" aria-label="Cancelar">✕</button><span id="rt" style="flex:1;font-weight:700;color:#B5645C;font-size:18px">● 0:00</span><button class="env" id="rs" aria-label="Enviar áudio">➤</button></div></div>
</div>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var convs=[],filtro='todas',busca='',atual=null,ultimoId=0,vistas={},pausadoAtual=false,pollL=null,pollC=null;
try{vistas=JSON.parse(localStorage.getItem('vistas')||'{}')}catch(e){}
function salvaVistas(){try{localStorage.setItem('vistas',JSON.stringify(vistas))}catch(e){}}
function api(u,o){o=o||{};o.credentials='include';if(o.body&&typeof o.body!=='string'){o.body=JSON.stringify(o.body);o.headers={'Content-Type':'application/json'}}return fetch(u,o).then(function(r){if(!r.ok){if(r.status===401)location.href='/painel/login?next=/painel/app';throw new Error(r.status)}return r.json()})}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmtTel(p){p=String(p).replace(/\D/g,'');if(p.length===13)return '+'+p.slice(0,2)+' ('+p.slice(2,4)+') '+p.slice(4,9)+'-'+p.slice(9);if(p.length===12)return '+'+p.slice(0,2)+' ('+p.slice(2,4)+') '+p.slice(4,8)+'-'+p.slice(8);return '+'+p}
function nomeDe(c){return c.client_name&&c.client_name.trim()?c.client_name.trim():fmtTel(c.phone)}
function ini(c){var n=(c.client_name||'').trim();return n?n[0].toUpperCase():'#'}
function hora(t){var d=new Date(t),h=new Date(),ontem=new Date(h.getTime()-864e5);var hh=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);if(d.toDateString()===h.toDateString())return hh;if(d.toDateString()===ontem.toDateString())return 'Ontem';return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)}
function diaTxt(t){var d=new Date(t),h=new Date(),o=new Date(h.getTime()-864e5);if(d.toDateString()===h.toDateString())return 'Hoje';if(d.toDateString()===o.toDateString())return 'Ontem';return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+'/'+d.getFullYear()}
function naoLida(c){return c.ultima_dir==='in'&&new Date(c.updated_at).getTime()>(vistas[c.phone]||0)}
function toast(t){var e=document.createElement('div');e.className='toast';e.textContent=t;document.body.appendChild(e);setTimeout(function(){e.remove()},2600)}
function prevTxt(t){t=String(t||'');var m=t.match(/^\[(imagem|documento|áudio|audio|contato|Template)[^\]]*\]\s*(.*)$/i);if(m){var ic={imagem:'📷 Foto',documento:'📄 Documento','áudio':'🎤 Áudio',audio:'🎤 Áudio',contato:'👤 Contato',template:'💬 Mensagem'}[m[1].toLowerCase()];return ic+(m[2]?' · '+m[2]:'')}return t}

function desenhaLista(){
  var q=busca.toLowerCase(),nn=0,h='';
  convs.forEach(function(c){if(naoLida(c))nn++});
  var cn=$('cn');cn.textContent=nn;cn.classList.toggle('hide',!nn);
  var arr=convs.filter(function(c){
    if(filtro==='novas'&&!naoLida(c))return false;
    if(filtro==='voce'&&!c.pausado)return false;
    if(filtro==='bot'&&c.pausado)return false;
    if(q&&(nomeDe(c)+' '+c.phone).toLowerCase().indexOf(q)<0)return false;return true});
  if(!arr.length){$('lista').innerHTML='<div class="vazio">'+(convs.length?'Nenhuma conversa neste filtro.':'Nenhuma conversa ainda. Quando alguém chamar no WhatsApp, aparece aqui.')+'</div>';return}
  arr.forEach(function(c){var nl=naoLida(c);
    h+='<div class="item '+(c.pausado?'a':'v')+(nl?' nl':'')+'" data-p="'+esc(c.phone)+'"><div class="av">'+esc(ini(c))+'</div><div class="meio"><div class="l1"><span class="nome">'+esc(nomeDe(c))+'</span><span class="hora">'+hora(c.updated_at)+'</span></div><div class="l2"><span class="prev">'+(c.ultima_dir==='out'?'✓ ':'')+esc(prevTxt(c.ultima_mensagem))+'</span>'+(nl?'<span class="bol">●</span>':'')+'<span class="chip '+(c.pausado?'a':'v')+'">'+(c.pausado?'VOCÊ':'BOT')+'</span></div></div></div>'});
  $('lista').innerHTML=h;
}
function carregaLista(){return api('/painel/api/app/lista').then(function(d){var antes={};convs.forEach(function(c){antes[c.phone]=c.updated_at});convs=d;
  if(atual){var c=convs.filter(function(x){return x.phone===atual})[0];if(c){vistas[atual]=Date.now()+1e4;salvaVistas()}}
  desenhaLista();$('sub').textContent='Conversas do WhatsApp';var t=0;convs.forEach(function(c){if(naoLida(c))t++});try{if(navigator.setAppBadge){t?navigator.setAppBadge(t):navigator.clearAppBadge()}}catch(e){}
  }).catch(function(){$('sub').textContent='Sem conexão — tentando de novo…'})}

function bolha(m){var cl=m.direction==='in'?'in':'out',t=String(m.content||''),x='';
  var mt=t.match(/^\[(imagem|documento|áudio|audio|contato|Template)[^\]]*\]\s*(.*)$/i);
  if(m.media_base64&&m.media_mime){var u='data:'+m.media_mime+';base64,'+m.media_base64;
    if(/^image\//.test(m.media_mime))x+='<img src="'+u+'" alt="">';else if(/^audio\//.test(m.media_mime))x+='<audio controls src="'+u+'"></audio>';else x+='<span class="anx">📎 Arquivo</span>'}
  if(mt&&!m.media_base64){x+='<span class="anx">'+esc(prevTxt(t))+'</span>'}else if(t&&!(m.media_base64&&/^\[/.test(t)&&!mt)){x+=esc(t)}else if(t&&m.media_base64){x+=esc(t)}
  var d=new Date(m.created_at);return '<div class="b '+cl+'">'+x+'<span class="h">'+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+(cl==='out'?' ✓':'')+'</span></div>'}
var ultimoDia='';
function adiciona(ms,limpa){var box=$('msgs'),perto=box.scrollHeight-box.scrollTop-box.clientHeight<140,h='';if(limpa){ultimoDia=''}
  ms.forEach(function(m){var dk=new Date(m.created_at).toDateString();if(dk!==ultimoDia){h+='<div class="dia">'+diaTxt(m.created_at)+'</div>';ultimoDia=dk}h+=bolha(m);if(m.id>ultimoId)ultimoId=m.id});
  if(limpa)box.innerHTML=h;else box.insertAdjacentHTML('beforeend',h);
  if(limpa||perto||(ms.length&&ms[ms.length-1].direction==='out'))box.scrollTop=box.scrollHeight}
function modo(p){pausadoAtual=p;var m=$('md');m.className='modo '+(p?'a':'v');
  $('mdt').textContent=p?'Você está atendendo. O bot está pausado nesta conversa.':'O bot está atendendo. Ao enviar uma mensagem, ele pausa.';
  $('mdb').textContent=p?'Devolver ao bot':'Assumir';$('ctl').textContent=p?'Você atende':'Bot atende'}
function abre(p){atual=p;ultimoId=0;var c=convs.filter(function(x){return x.phone===p})[0]||{phone:p};
  $('cav').textContent=ini(c);$('cnm').textContent=nomeDe(c);$('msgs').innerHTML='<div class="vazio">Carregando…</div>';modo(!!c.pausado);
  $('tl').classList.add('hide');$('ch').classList.remove('hide');vistas[p]=Date.now()+1e4;salvaVistas();if(location.hash!=='#'+p)history.pushState(null,'','#'+p);
  api('/painel/api/app/conversa/'+p).then(function(d){if(atual!==p)return;modo(d.pausado);adiciona(d.mensagens,true)}).catch(function(){$('msgs').innerHTML='<div class="vazio">Não consegui abrir. Volte e tente de novo.</div>'});
  clearInterval(pollC);pollC=setInterval(function(){if(!atual||document.hidden)return;api('/painel/api/app/conversa/'+atual+'?depois='+ultimoId).then(function(d){if(d.mensagens.length){adiciona(d.mensagens,false);vistas[atual]=Date.now()+1e4;salvaVistas()}if(d.pausado!==pausadoAtual)modo(d.pausado)}).catch(function(){})},3500)}
function fecha(){atual=null;clearInterval(pollC);$('ch').classList.add('hide');$('tl').classList.remove('hide');if(location.hash)history.replaceState(null,'',location.pathname);carregaLista()}
$('lista').addEventListener('click',function(e){var it=e.target.closest('.item');if(it)abre(it.getAttribute('data-p'))});
$('vl').onclick=fecha;
window.addEventListener('popstate',function(){if(!location.hash&&atual)fecha();else if(location.hash.length>1&&!atual)abre(location.hash.slice(1))});
document.querySelectorAll('.aba').forEach(function(b){b.onclick=function(){document.querySelectorAll('.aba').forEach(function(x){x.classList.remove('on')});b.classList.add('on');filtro=b.getAttribute('data-f');desenhaLista()}});
$('q').oninput=function(){busca=this.value;desenhaLista()};
$('br').onclick=function(){carregaLista().then(function(){toast('Atualizado')})};
var mr=null,chunks=[],tmr=null,t0=0,cancelaRec=false;
function recUi(on){$('rec').style.display=on?'flex':'none';$('tx').style.display=on?'none':'';$('mic').style.display=on?'none':'';$('en').style.display=on?'none':''}
function recTempo(){var s=Math.floor((Date.now()-t0)/1000);$('rt').textContent='● '+Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
$('mic').onclick=function(){
 if(!navigator.mediaDevices||!window.MediaRecorder){toast('Este celular não permite gravar áudio no app.');return}
 navigator.mediaDevices.getUserMedia({audio:true}).then(function(st){
  var tipos=['audio/webm;codecs=opus','audio/mp4','audio/webm'],mt='';
  for(var i=0;i<tipos.length;i++){if(MediaRecorder.isTypeSupported(tipos[i])){mt=tipos[i];break}}
  mr=mt?new MediaRecorder(st,{mimeType:mt}):new MediaRecorder(st);chunks=[];cancelaRec=false;
  mr.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
  mr.onstop=function(){st.getTracks().forEach(function(t){t.stop()});clearInterval(tmr);recUi(false);var tipo=(mr.mimeType||mt||'audio/webm');if(cancelaRec||!chunks.length||Date.now()-t0<700)return;enviaAudio(new Blob(chunks,{type:tipo}))};
  mr.start();t0=Date.now();recTempo();tmr=setInterval(recTempo,500);recUi(true);
 }).catch(function(){toast('Permita o microfone para gravar áudio.')})};
$('rc').onclick=function(){cancelaRec=true;if(mr&&mr.state!=='inactive')mr.stop()};
$('rs').onclick=function(){if(mr&&mr.state!=='inactive')mr.stop()};
function enviaAudio(blob){
 var p=atual;toast('Enviando áudio…');
 fetch('/painel/api/app/audio/'+p,{method:'POST',credentials:'include',headers:{'Content-Type':blob.type.split(';')[0]},body:blob}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(){modo(true);if(atual===p)return api('/painel/api/app/conversa/'+p+'?depois='+ultimoId).then(function(dd){adiciona(dd.mensagens,false)})}).catch(function(){toast('Áudio não enviado. Tente de novo.')})}
$('mdb').onclick=function(){var p=!pausadoAtual;api('/painel/api/conversas/'+atual+'/pausar',{method:'POST',body:{pausado:p}}).then(function(){modo(p);toast(p?'Você assumiu a conversa':'Bot reativado')}).catch(function(){toast('Não consegui trocar. Tente de novo.')})};
var tx=$('tx');tx.oninput=function(){tx.style.height='auto';tx.style.height=Math.min(120,tx.scrollHeight)+'px'};
function envia(){var t=tx.value.trim();if(!t||!atual)return;$('en').disabled=true;
  api('/painel/api/conversas/'+atual+'/enviar',{method:'POST',body:{texto:t}}).then(function(){tx.value='';tx.style.height='auto';modo(true);return api('/painel/api/app/conversa/'+atual+'?depois='+ultimoId).then(function(d){adiciona(d.mensagens,false)})}).catch(function(){toast('Não enviou. Verifique a conexão e toque em ➤ de novo.')}).then(function(){$('en').disabled=false})}
$('en').onclick=envia;
tx.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&window.innerWidth>700){e.preventDefault();envia()}});

// notificações
function b64(s){var p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function avisoNotif(){var a=$('av'),perm=window.Notification?Notification.permission:'unsupported';
  if(perm==='granted'){inscreve(false);a.classList.add('hide');$('bn').textContent='🔔';return}
  if(perm==='denied'||perm==='unsupported'){a.classList.add('hide');$('bn').textContent='🔕';return}
  $('avt').textContent='Ative as notificações para saber na hora quando alguém escrever.';a.classList.remove('hide')}
function inscreve(pede){if(!('serviceWorker' in navigator)||!window.PushManager)return Promise.resolve();
  return navigator.serviceWorker.ready.then(function(reg){return api('/painel/api/app/pushkey').then(function(k){return reg.pushManager.getSubscription().then(function(s){return s||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(k.key)})})})}).then(function(s){return api('/painel/api/app/subscribe',{method:'POST',body:{subscription:s}})}).catch(function(e){if(pede)toast('Não consegui ativar as notificações neste aparelho.')})}
function pedeNotif(){if(!window.Notification){toast('Este navegador não suporta notificações.');return}
  Notification.requestPermission().then(function(p){avisoNotif();if(p==='granted'){toast('Notificações ativadas');inscreve(true)}else toast('Notificações bloqueadas. Libere nas configurações do site.')})}
$('avb').onclick=pedeNotif;$('bn').onclick=function(){if(Notification.permission==='granted')toast('Notificações já estão ativas');else pedeNotif()};
if('serviceWorker' in navigator){navigator.serviceWorker.register('/painel/app-sw.js',{scope:'/painel/'}).then(avisoNotif).catch(function(){});navigator.serviceWorker.addEventListener('message',function(e){if(e.data&&e.data.abrir){carregaLista().then(function(){abre(e.data.abrir)})}})}else avisoNotif();

// aviso sonoro/visual dentro do app quando chega mensagem nova na lista
var jaVi={};
function checaNovas(){api('/painel/api/app/lista').then(function(d){var novo=false;d.forEach(function(c){if(c.ultima_dir==='in'&&jaVi[c.phone]&&jaVi[c.phone]<new Date(c.updated_at).getTime()&&c.phone!==atual)novo=true;jaVi[c.phone]=new Date(c.updated_at).getTime()});convs=d;desenhaLista();if(novo){try{navigator.vibrate&&navigator.vibrate([100,50,100])}catch(e){}}}).catch(function(){})}
carregaLista().then(function(){convs.forEach(function(c){jaVi[c.phone]=new Date(c.updated_at).getTime()});if(location.hash.length>1)abre(location.hash.slice(1))});
pollL=setInterval(function(){if(!document.hidden&&!atual)checaNovas()},6000);
document.addEventListener('visibilitychange',function(){if(!document.hidden){carregaLista();avisoNotif()}});
})();
</script></body></html>
`;
app.get('/painel/app.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: 'Apometria Brasil — Conversas', short_name: 'Apometria', description: 'Conversas do WhatsApp do Instituto Apometria Brasil',
    start_url: '/painel/app', scope: '/painel/', display: 'standalone', orientation: 'portrait',
    background_color: '#12585C', theme_color: '#12585C', lang: 'pt-BR',
    icons: [
      { src: '/painel/app-icon.png', sizes: '192x192 512x512', type: 'image/png', purpose: 'any' },
      { src: '/painel/app-icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }));
});
app.get('/painel/app-icon.png', (req, res) => { res.set('Cache-Control', 'public, max-age=86400').type('image/png').send(appIconPng()); });
app.get('/painel/app-sw.js', (req, res) => { res.set('Service-Worker-Allowed', '/painel/').type('application/javascript').send(APP_SW); });
app.get('/painel/app', (req, res) => { res.set('Cache-Control', 'no-cache').type('html').send(APP_HTML); });

app.get('/painel/api/app/lista', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT c.phone, c.client_name, c.stage, c.updated_at, (SELECT content FROM messages m WHERE m.phone = c.phone ORDER BY m.id DESC LIMIT 1) AS ultima_mensagem, (SELECT direction FROM messages m WHERE m.phone = c.phone ORDER BY m.id DESC LIMIT 1) AS ultima_dir, (SELECT created_at FROM messages m WHERE m.phone = c.phone ORDER BY m.id DESC LIMIT 1) AS ultima_em FROM conversations c ORDER BY c.updated_at DESC LIMIT 300');
    res.json(rows.map(r => ({ ...r, updated_at: r.ultima_em || r.updated_at, pausado: sessions.get(r.phone)?.pausado || false })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/painel/api/app/conversa/:phone', async (req, res) => {
  if (!pool) return res.json({ mensagens: [], pausado: false });
  try {
    const depois = parseInt(req.query.depois, 10) || 0;
    const { rows } = depois
      ? await pool.query('SELECT id, direction, content, media_base64, media_mime, created_at FROM messages WHERE phone = $1 AND id > $2 ORDER BY id ASC', [req.params.phone, depois])
      : await pool.query('SELECT * FROM (SELECT id, direction, content, media_base64, media_mime, created_at FROM messages WHERE phone = $1 ORDER BY id DESC LIMIT 150) t ORDER BY id ASC', [req.params.phone]);
    res.json({ mensagens: rows, pausado: sessions.get(req.params.phone)?.pausado || false });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/painel/api/app/ultima', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT m.phone, m.content, c.client_name FROM messages m LEFT JOIN conversations c ON c.phone = m.phone WHERE m.direction = 'in' ORDER BY m.id DESC LIMIT 1");
    const r = rows[0];
    if (!r) return res.json({ titulo: 'Apometria Brasil', corpo: 'Nova mensagem no WhatsApp', phone: '' });
    let corpo = String(r.content || '').replace(/^\[(imagem|documento|áudio|audio)[^\]]*\]\s*/i, '📎 ').slice(0, 140) || 'Nova mensagem';
    res.json({ titulo: (r.client_name && r.client_name.trim()) || ('+' + r.phone), corpo, phone: r.phone });
  } catch (e) { res.json({ titulo: 'Apometria Brasil', corpo: 'Nova mensagem no WhatsApp', phone: '' }); }
});

let _vapid = null;
async function getVapid() {
  if (_vapid) return _vapid;
  let raw = await cfgGet('vapid_keys');
  if (raw) { try { _vapid = JSON.parse(raw); } catch (e) {} }
  if (!_vapid) {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    _vapid = { pub, priv: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
    await cfgSet('vapid_keys', JSON.stringify(_vapid));
  }
  return _vapid;
}
async function pushSubs() { try { return JSON.parse((await cfgGet('push_subs')) || '[]'); } catch (e) { return []; } }
app.get('/painel/api/app/pushkey', async (req, res) => { try { res.json({ key: (await getVapid()).pub }); } catch (e) { res.status(500).json({ erro: e.message }); } });
app.post('/painel/api/app/subscribe', async (req, res) => {
  const s = req.body && req.body.subscription;
  if (!s || !s.endpoint) return res.status(400).json({ erro: 'inscrição inválida' });
  const lista = (await pushSubs()).filter(x => x.endpoint !== s.endpoint);
  lista.push(s);
  await cfgSet('push_subs', JSON.stringify(lista.slice(-10)));
  res.json({ ok: true });
});
let _pushUlt = 0;
async function notificarPush() {
  try {
    if (Date.now() - _pushUlt < 2500) return;
    _pushUlt = Date.now();
    const subs = await pushSubs();
    if (!subs.length) return;
    const v = await getVapid();
    const key = nodeCrypto.createPrivateKey(v.priv);
    const vivos = [];
    for (const s of subs) {
      try {
        const aud = new URL(s.endpoint).origin;
        const h = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
        const c = Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:anunciosapometria@gmail.com' })).toString('base64url');
        const sig = nodeCrypto.sign('sha256', Buffer.from(h + '.' + c), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        await axios.post(s.endpoint, null, { headers: { Authorization: 'vapid t=' + h + '.' + c + '.' + sig + ', k=' + v.pub, TTL: '3600', Urgency: 'high', 'Content-Length': '0' }, timeout: 10000 });
        vivos.push(s);
      } catch (e) {
        const st = e.response && e.response.status;
        if (st !== 404 && st !== 410) vivos.push(s);
        console.error('⚠️ Push:', st || e.message);
      }
    }
    if (vivos.length !== subs.length) await cfgSet('push_subs', JSON.stringify(vivos));
  } catch (e) { console.error('⚠️ notificarPush:', e.message); }
}


// Página HTML do painel
app.get('/painel', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Painel — Instituto Apometria Brasil</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; font-family: system-ui, sans-serif; background:#f6f3ee; color:#2b2620; display:flex; height:100vh; }
  #lista { width:320px; border-right:1px solid #e0d8c9; overflow-y:auto; background:#fff; }
  #lista h2 { font-size:14px; padding:14px 16px; margin:0; border-bottom:1px solid #e0d8c9; }
  .conversa { padding:12px 16px; border-bottom:1px solid #f0ece3; cursor:pointer; }
  .conversa:hover { background:#f6f3ee; }
  .conversa.ativa { background:#efe6f2; }
  .conversa .nome { font-weight:600; font-size:14px; display:flex; align-items:center; gap:6px; }
  .conversa .nome .bolinha { width:7px; height:7px; border-radius:50%; background:#c9a63b; flex-shrink:0; }
  .conversa .stage { font-size:11px; color:#8a7f6d; text-transform:uppercase; }
  .conversa .preview { font-size:12px; color:#6b6153; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
  #chat { flex:1; display:flex; flex-direction:column; }
  #chatHeader { padding:14px 20px; border-bottom:1px solid #e0d8c9; background:#fff; font-weight:600; display:flex; align-items:center; justify-content:space-between; }
  #chatHeader .titulo { display:flex; flex-direction:column; }
  #chatHeader .subtitulo { font-size:12px; font-weight:400; color:#8a7f6d; margin-top:2px; }
  #btnPausar { border:1px solid #d8cdb8; background:#fff; color:#5a5142; padding:7px 14px; border-radius:8px; font-size:13px; cursor:pointer; }
  #btnPausar.ativo { background:#7a4d8c; color:#fff; border-color:#7a4d8c; }
  #msgs { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:60%; padding:8px 12px; border-radius:12px; font-size:14px; white-space:pre-wrap; }
  .msg.in { align-self:flex-start; background:#fff; border:1px solid #e0d8c9; }
  .msg.out { align-self:flex-end; background:#7a4d8c; color:#fff; }
  .msg img { max-width:220px; border-radius:8px; display:block; margin-top:6px; }
  .vazio { padding:40px; color:#8a7f6d; text-align:center; }
  #respostaBox { display:flex; gap:8px; padding:14px 20px; border-top:1px solid #e0d8c9; background:#fff; }
  #respostaTexto { flex:1; resize:none; border:1px solid #d8cdb8; border-radius:10px; padding:10px 12px; font-family:inherit; font-size:14px; min-height:20px; max-height:120px; }
  #respostaEnviar { background:#7a4d8c; color:#fff; border:none; border-radius:10px; padding:0 20px; font-size:14px; cursor:pointer; }
  #respostaEnviar:disabled { opacity:0.5; cursor:default; }
</style>
</head>
<body>
  <div id="lista"><h2>Conversas <a href="/painel/crm" style="float:right;font-weight:400;color:#7a4d8c;text-decoration:none">CRM →</a></h2><div id="listaConteudo" class="vazio">Carregando...</div></div>
  <div id="chat">
    <div id="chatHeader">
      <div class="titulo">
        <span id="chatTitulo">Selecione uma conversa</span>
        <span class="subtitulo" id="chatSubtitulo"></span>
      </div>
      <button id="btnPausar" style="display:none"></button>
    </div>
    <div id="msgs"></div>
    <div id="respostaBox" style="display:none">
      <textarea id="respostaTexto" placeholder="Escreva sua resposta..." rows="1"></textarea>
      <button id="respostaEnviar">Enviar</button>
    </div>
  </div>
<script>
  let ativo = null;
  let ativoPausado = false;

  async function carregarLista() {
    const res = await fetch('/painel/api/conversas');
    const dados = await res.json();
    const el = document.getElementById('listaConteudo');
    if (!dados.length) { el.className='vazio'; el.textContent='Nenhuma conversa ainda.'; return; }
    el.className = '';
    el.innerHTML = dados.map(c => \`
      <div class="conversa\${c.phone === ativo ? ' ativa' : ''}" data-phone="\${c.phone}">
        <div class="nome">\${c.pausado ? '<span class="bolinha" title="Atendimento manual"></span>' : ''}\${c.client_name || c.phone}</div>
        <div class="stage">\${c.stage}</div>
        <div class="preview">\${(c.ultima_mensagem || '').slice(0,60)}</div>
      </div>
    \`).join('');
    document.querySelectorAll('.conversa').forEach(div => {
      div.onclick = () => abrirConversa(div.dataset.phone, div);
    });
  }

  async function abrirConversa(phone, el) {
    document.querySelectorAll('.conversa').forEach(d => d.classList.remove('ativa'));
    if (el) el.classList.add('ativa');
    ativo = phone;
    document.getElementById('chatTitulo').textContent = phone;
    document.getElementById('respostaBox').style.display = 'flex';

    const res = await fetch('/painel/api/conversas/' + encodeURIComponent(phone));
    const dados = await res.json();
    const msgs = dados.mensagens || [];
    ativoPausado = !!dados.pausado;
    atualizarBotaoPausar();

    const el2 = document.getElementById('msgs');
    el2.innerHTML = msgs.map(m => \`
      <div class="msg \${m.direction}">
        \${m.content || ''}
        \${m.media_base64 ? (/^audio/.test(m.media_mime || '') ? '<audio controls src="data:' + m.media_mime + ';base64,' + m.media_base64 + '" style="width:100%;margin-top:6px"></audio>' : '<img src="data:' + m.media_mime + ';base64,' + m.media_base64 + '">') : ''}
      </div>
    \`).join('');
    el2.scrollTop = el2.scrollHeight;
  }

  function atualizarBotaoPausar() {
    const btn = document.getElementById('btnPausar');
    btn.style.display = 'inline-block';
    if (ativoPausado) {
      btn.textContent = '🙋 Atendimento manual (retomar bot)';
      btn.classList.add('ativo');
      document.getElementById('chatSubtitulo').textContent = 'Bot pausado — você está respondendo';
    } else {
      btn.textContent = '⏸️ Assumir conversa';
      btn.classList.remove('ativo');
      document.getElementById('chatSubtitulo').textContent = 'Bot respondendo automaticamente';
    }
  }

  document.getElementById('btnPausar').onclick = async () => {
    if (!ativo) return;
    const novoEstado = !ativoPausado;
    await fetch('/painel/api/conversas/' + encodeURIComponent(ativo) + '/pausar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pausado: novoEstado })
    });
    ativoPausado = novoEstado;
    atualizarBotaoPausar();
  };

  async function enviarResposta() {
    const textarea = document.getElementById('respostaTexto');
    const texto = textarea.value.trim();
    if (!texto || !ativo) return;
    const btn = document.getElementById('respostaEnviar');
    btn.disabled = true;
    try {
      await fetch('/painel/api/conversas/' + encodeURIComponent(ativo) + '/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto })
      });
      textarea.value = '';
      ativoPausado = true;
      atualizarBotaoPausar();
      await abrirConversa(ativo);
      await carregarLista();
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('respostaEnviar').onclick = enviarResposta;
  document.getElementById('respostaTexto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      enviarResposta();
    }
  });

  carregarLista();
  setInterval(() => { carregarLista(); if (ativo) abrirConversa(ativo); }, 15000);
</script>
</body>
</html>`);
});

// ─── CRM: FUNIL, FOLLOW-UP AUTOMÁTICO E AVISOS ───────────────────────────────
const CRM_TOKEN = process.env.CRM_TOKEN;
const RANK = { novo: 0, explicacao: 1, valores: 2, comprovante: 3, questionario: 4, pago: 5 };
const FUNIL_ROTULO = {
  novo: 'Novo contato', explicacao: 'Em explicação', valores: 'Viu os valores',
  comprovante: 'Comprovante recebido', questionario: 'Questionário respondido', pago: 'Pago / confirmado',
  paulo: 'Com o Paulo', sem_resposta: 'Sem resposta', perdido: 'Perdido'
};
const FOLLOWUP_HORAS = [1, 18, 52]; // horas desde a última mensagem da pessoa (1º em 1 h; 2º antes de fechar a janela de 24 h)
const FOLLOWUP_PADRAO = [
  'Olá, {nome}! Passando para ver se ficou alguma dúvida sobre a apometria. Podemos continuar de onde paramos, no seu tempo. 🙏',
  '{nome}, tudo bem? Seguimos à disposição por aqui. Se quiser retomar de onde paramos ou tirar alguma dúvida, é só responder esta mensagem.',
  '{nome}, esta é a nossa última mensagem por aqui, para não incomodar. Se em algum momento sentir que é hora de cuidar disso, é só nos chamar. Estaremos à disposição. 🙏'
];

async function initCrm() {
  if (!pool) return;
  const alt = [
    "funil TEXT DEFAULT 'novo'", "viu_valores BOOLEAN DEFAULT false", "last_in_at TIMESTAMPTZ", "last_out_at TIMESTAMPTZ",
    "followups_sent INT DEFAULT 0", "followup_off BOOLEAN DEFAULT false", "last_followup_at TIMESTAMPTZ",
    "comprovante_at TIMESTAMPTZ", "questionario_at TIMESTAMPTZ", "notas TEXT", "opcao TEXT", "pos_enviados INT DEFAULT 0", "pos_off BOOLEAN DEFAULT false"
  ];
  for (const c of alt) await pool.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ' + c);
  await pool.query(`CREATE TABLE IF NOT EXISTS eventos (
    id SERIAL PRIMARY KEY, phone TEXT, tipo TEXT, detalhe TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_config (key TEXT PRIMARY KEY, value TEXT)`);
  await pool.query(`UPDATE conversations c SET
    last_in_at = (SELECT max(created_at) FROM messages m WHERE m.phone = c.phone AND m.direction = 'in'),
    last_out_at = (SELECT max(created_at) FROM messages m WHERE m.phone = c.phone AND m.direction = 'out')
    WHERE last_in_at IS NULL AND last_out_at IS NULL`);
  console.log('📊 CRM pronto.');
}

async function cfgGet(key, padrao = null) {
  if (!pool) return padrao;
  try {
    const { rows } = await pool.query('SELECT value FROM crm_config WHERE key = $1', [key]);
    return rows[0] ? rows[0].value : padrao;
  } catch (e) { return padrao; }
}
async function cfgSet(key, value) {
  if (!pool) return;
  await pool.query('INSERT INTO crm_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
}

function funilDerivado(session, viuValores) {
  if (viuValores || session.viuValores) return 'valores';
  if (session.stage === 'abertura' || session.stage === 'aguardando_nome') return 'novo';
  return 'explicacao';
}

// Chamada a cada upsertConversation: mantém o funil atualizado sem nunca retroceder
async function crmAtualizarFunil(phone, session) {
  if (!pool || !session) return;
  try {
    const { rows } = await pool.query('SELECT funil, viu_valores FROM conversations WHERE phone = $1', [phone]);
    if (!rows[0]) return;
    const atual = rows[0].funil || 'novo';
    let novo;
    if ((RANK[atual] ?? -1) >= RANK.comprovante) novo = atual;
    // (o card não vai mais para o funil 'paulo' quando o bot pausa ou a equipe assume: continua a etapa normal)
    else {
      const der = funilDerivado(session, rows[0].viu_valores);
      const rAtual = (atual === 'paulo' || atual === 'sem_resposta' || atual === 'perdido') ? -1 : (RANK[atual] ?? 0);
      novo = RANK[der] >= rAtual ? der : atual;
    }
    if (novo !== atual) await pool.query('UPDATE conversations SET funil = $2 WHERE phone = $1', [phone, novo]);
  } catch (e) { console.error('❌ CRM funil:', e.message); }
}

async function crmEvento(phone, tipo, detalhe) {
  if (!pool) return;
  try { await pool.query('INSERT INTO eventos (phone, tipo, detalhe) VALUES ($1,$2,$3)', [phone, tipo, detalhe || null]); }
  catch (e) { console.error('❌ CRM evento:', e.message); }
}

async function enviarTemplate(to, nome, params) {
  const body = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: nome, language: { code: 'pt_BR' } }
  };
  if (params && params.length) body.template.components = [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }];
  await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`, body,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
}

// Comprovante/imagem recebido: guarda no banco (messages) e reenvia a cópia para os números de aviso da equipe
async function encaminharComprovante(phone, nome, midia) {
  const numeros = ((await cfgGet('alerta_numeros', process.env.ALERTA_NUMEROS || '')) || '').split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);
  if (!numeros.length || !midia || !midia.base64) return;
  const mime = midia.mime || 'image/jpeg';
  const ehImg = /^image\//.test(mime);
  const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg');
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([Buffer.from(midia.base64, 'base64')], { type: mime }), 'comprovante-' + phone + '.' + ext);
  const up = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/media`, { method: 'POST', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: fd });
  const upj = await up.json();
  if (!upj.id) throw new Error('upload: ' + JSON.stringify(upj));
  const legenda = '💰 Comprovante recebido\n' + (nome || 'Sem nome') + ' (+' + phone + ')\nPainel: ' + PUBLIC_BASE + '/painel/crm';
  for (const n of numeros) {
    try {
      await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
        ehImg ? { messaging_product: 'whatsapp', to: n, type: 'image', image: { id: upj.id, caption: legenda } }
              : { messaging_product: 'whatsapp', to: n, type: 'document', document: { id: upj.id, caption: legenda, filename: 'comprovante-' + phone + '.' + ext } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
      console.log('📎 Comprovante encaminhado para ' + n);
    } catch (e) { console.error('❌ Comprovante para ' + n + ':', e.response?.data || e.message); }
  }
}

const ALERTA_PADRAO = {
  novo_contato: '🆕 Novo contato\\n{pessoa}\\n{detalhe}\\nPainel: ' + PUBLIC_BASE + '/painel/crm',
  saiu_do_fluxo: '⚠️ Conversa precisa do Paulo\\n{pessoa}\\n{detalhe}\\nPainel: ' + PUBLIC_BASE + '/painel/crm',
  pagamento_solicitado: '💳 Pix ou cartão solicitado\\n{pessoa}\\n{detalhe}\\nPainel: ' + PUBLIC_BASE + '/painel/crm',
  comprovante: '💰 Comprovante recebido, conferir o pagamento\\n{pessoa}\\n{detalhe}\\nPainel: ' + PUBLIC_BASE + '/painel/crm',
  questionario: '📝 Questionário respondido\\n{pessoa}\\n{detalhe}\\nPainel: ' + PUBLIC_BASE + '/painel/crm'
};
const alertaRecente = new Map();
// Aviso para o(s) número(s) da equipe (config "alerta_numeros", separados por vírgula)
async function crmAlertar(tipo, phone, detalhe, nome) {
  await crmEvento(phone, tipo, detalhe);
  const chave = tipo + ':' + phone;
  const janela = (tipo === 'pagamento_solicitado' ? 60 : 10) * 60 * 1000;
  if (alertaRecente.get(chave) && Date.now() - alertaRecente.get(chave) < janela) return;
  alertaRecente.set(chave, Date.now());
  const numeros = ((await cfgGet('alerta_numeros', process.env.ALERTA_NUMEROS || '')) || '').split(',').map(n => n.replace(/\D/g, '')).filter(Boolean);
  if (!numeros.length) return;
  const rotulos = { novo_contato: '🆕 Novo contato', saiu_do_fluxo: '⚠️ Conversa precisa do Paulo', pagamento_solicitado: '💳 Pix ou cartão solicitado', comprovante: '💰 Comprovante recebido (conferir pagamento)', questionario: '📝 Questionário respondido' };
  const quem = (nome || 'Sem nome') + ' (+' + phone + ')';
  const texto = (rotulos[tipo] || tipo) + '\n' + quem + (detalhe ? '\n' + detalhe : '') + '\nPainel: ' + PUBLIC_BASE + '/painel/crm';
  // Campo do CRM: texto da mensagem com {pessoa} e {detalhe} (\\n = nova linha). Sem espaços = nome de modelo aprovado da Meta.
  const modelo = ((await cfgGet('alerta_template_' + tipo, '')) || '').trim() || ALERTA_PADRAO[tipo] || '';
  const ehTexto = /[\s{]/.test(modelo);
  const corpo = (modelo || texto).replace(/\\n/g, '\n').split('{pessoa}').join(quem).split('{detalhe}').join(detalhe || '-');
  for (const n of numeros) {
    try {
      if (modelo && !ehTexto) await enviarTemplate(n, modelo, [quem, detalhe || '-']);
      else await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', to: n, type: 'text', text: { body: corpo } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
      console.log('🔔 Aviso enviado para ' + n + ': ' + tipo);
    } catch (e) { console.error('❌ Aviso para ' + n + ':', e.response?.data || e.message); }
  }
}

// Mensagem recebida: zera o contador de follow-up e trata comprovante
async function crmEntrada(phone, mediaInfo, session, textoMsg) {
  if (!pool) return;
  try {
    const { rows } = await pool.query('SELECT funil FROM conversations WHERE phone = $1', [phone]);
    const atual = rows[0]?.funil || 'novo';
    await pool.query('UPDATE conversations SET last_in_at = now(), followups_sent = 0 WHERE phone = $1', [phone]);
    const qtd = await pool.query("SELECT count(*)::int AS n FROM messages WHERE phone = $1 AND direction = 'in'", [phone]);
    if (qtd.rows[0] && qtd.rows[0].n === 1) await crmAlertar('novo_contato', phone, 'Primeira mensagem recebida no WhatsApp do instituto.', session.clientName);
    if (atual === 'sem_resposta' || atual === 'perdido') {
      await pool.query('UPDATE conversations SET funil = $2 WHERE phone = $1', [phone, funilDerivado(session, false)]);
    }
    if (!mediaInfo && textoMsg && /paguei|fiz o pix|fiz o pagamento|efetuei o pagamento|ja transferi|ja fiz a transferencia|comprovante/.test(semAcento(textoMsg))) {
      await pool.query('UPDATE conversations SET followup_off = true WHERE phone = $1', [phone]);
    }
    if (mediaInfo && mediaInfo.tipo === 'audio') {
      await crmEvento(phone, 'audio', 'Áudio do cliente salvo (complemento do trabalho)');
    } else if (mediaInfo && (RANK[atual] ?? -1) < RANK.comprovante) {
      let op = session.opcaoCtx || '';
      if (!op) { const q = await pool.query("SELECT 1 FROM messages WHERE phone = $1 AND direction = 'out' AND content LIKE '%mpago.li/2rMEjbs%' LIMIT 1", [phone]); if (q.rows.length) op = 'Emergencial'; }
      await pool.query("UPDATE conversations SET funil = 'comprovante', comprovante_at = now(), followup_off = true, opcao = $2 WHERE phone = $1", [phone, op || null]);
      session.etapa = null; session.encerrado = false;
      await crmAlertar('comprovante', phone, 'Comprovante/imagem recebido. Conferir o pagamento.', session.clientName);
    }
  } catch (e) { console.error('❌ CRM entrada:', e.message); }
}
async function crmSaida(phone, texto) {
  if (!pool) return;
  if (texto && /17988271998|mpago\.li/i.test(texto) && !(sessions.get(phone)?.ultAlertaPag && Date.now() - sessions.get(phone).ultAlertaPag < 90000)) {
    { const sp = sessions.get(phone); if (sp) sp.ultAlertaPag = Date.now(); }
    const link = (texto.match(/https?:\/\/mpago\.li\/\S+/i) || [])[0];
    crmAlertar('pagamento_solicitado', phone, link ? 'Link de cartão enviado: ' + link : 'Chave Pix enviada.', sessions.get(phone)?.clientName).catch(() => {});
  }
  pool.query('UPDATE conversations SET last_out_at = now() WHERE phone = $1', [phone]).catch(() => {});
}
async function crmSet(phone, campos) {
  if (!pool) return;
  const ks = Object.keys(campos);
  if (!ks.length) return;
  await pool.query('UPDATE conversations SET ' + ks.map((k, i) => k + ' = $' + (i + 2)).join(', ') + ' WHERE phone = $1', [phone, ...ks.map(k => campos[k])]);
}

// ─── FOLLOW-UP AUTOMÁTICO ─────────────────────────────────────────────────────
function horaBrasilia() {
  return parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()), 10);
}
async function followupTextos() {
  try { const t = JSON.parse(await cfgGet('followup_textos', 'null')); if (Array.isArray(t) && t.length === 3) return t; } catch (e) {}
  return FOLLOWUP_PADRAO;
}
let followupRodando = false;
async function rodarFollowups() {
  if (!pool || followupRodando) return;
  followupRodando = true;
  try {
    if ((await cfgGet('followup_ativo', '0')) !== '1') return;
    const h = horaBrasilia();
    if (h < 8 || h >= 20) return;
    const desde = await cfgGet('followup_desde', null);
    const { rows } = await pool.query(
      `SELECT phone, client_name, followups_sent, last_in_at, last_followup_at FROM conversations
       WHERE funil IN ('novo','explicacao','valores') AND NOT followup_off AND followups_sent < 3
         AND last_in_at IS NOT NULL AND last_out_at IS NOT NULL AND last_out_at >= last_in_at
         AND ($1::timestamptz IS NULL OR last_in_at >= $1::timestamptz)`, [desde]);
    const textos = await followupTextos();
    for (const r of rows) {
      const sess = sessions.get(r.phone);
      if (sess && sess.pausado) continue;
      const horasSilencio = (Date.now() - new Date(r.last_in_at).getTime()) / 3600000;
      if (horasSilencio < FOLLOWUP_HORAS[r.followups_sent]) continue;
      if (r.last_followup_at && Date.now() - new Date(r.last_followup_at).getTime() < 3600000) continue;
      const passo = r.followups_sent;
      const nome = (r.client_name || '').split(' ')[0];
      const texto = textos[passo].replace(/\{nome\}/g, nome || 'tudo bem').replace('Olá, tudo bem!', 'Olá!').replace(/^tudo bem, tudo bem\?/, 'Tudo bem?');
      try {
        if (horasSilencio < 23.7) {
          await sendMessage(r.phone, texto);
          if (sess) sess.history.push({ role: 'assistant', content: texto });
        } else {
          const tpl = await cfgGet('followup_template_' + (passo + 1), '');
          if (!tpl) { console.log('⏭️  Follow-up ' + (passo + 1) + ' de ' + r.phone + ' pendente: fora da janela de 24h e sem template configurado.'); continue; }
          await enviarTemplate(r.phone, tpl, [nome || 'tudo bem']);
          await saveMessage(r.phone, 'out', '[Template ' + tpl + '] ' + texto);
          await crmSaida(r.phone);
          if (sess) sess.history.push({ role: 'assistant', content: texto });
        }
        await pool.query('UPDATE conversations SET followups_sent = followups_sent + 1, last_followup_at = now() WHERE phone = $1', [r.phone]);
        await crmEvento(r.phone, 'followup', 'Follow-up ' + (passo + 1) + ' de 3 enviado');
        if (passo === 2) await pool.query("UPDATE conversations SET funil = 'sem_resposta' WHERE phone = $1", [r.phone]);
      } catch (e) { console.error('❌ Follow-up ' + r.phone + ':', e.response?.data || e.message); }
      await sleep(3000);
    }
  } catch (e) { console.error('❌ Follow-ups:', e.message); }
  finally { followupRodando = false; }
}

// ─── PÓS-PAGAMENTO: avisos em dias úteis (feriados do Brasil, de SP e de São José do Rio Preto) ───
function dataBR(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d); }
function pascoaMs(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}
const _feriadosCache = {};
function feriadosDoAno(ano) {
  if (_feriadosCache[ano]) return _feriadosCache[ano];
  const s = new Set(), D = 86400000, p = pascoaMs(ano);
  // nacionais + estadual (09/07) + municipais de São José do Rio Preto (19/03 São José, 08/12 Imaculada Conceição)
  ['01-01', '03-19', '04-21', '05-01', '07-09', '09-07', '10-12', '11-02', '11-15', '11-20', '12-08', '12-25'].forEach(x => s.add(ano + '-' + x));
  // Carnaval (segunda e terça), Sexta-feira Santa e Corpus Christi (municipal em Rio Preto)
  [-48, -47, -2, 60].forEach(n => s.add(new Date(p + n * D).toISOString().slice(0, 10)));
  return (_feriadosCache[ano] = s);
}
function ehDiaUtil(ms) {
  const dt = new Date(ms), dow = dt.getUTCDay();
  return dow !== 0 && dow !== 6 && !feriadosDoAno(dt.getUTCFullYear()).has(dt.toISOString().slice(0, 10));
}
function paraMs(dataStr) { return Date.parse(dataStr + 'T00:00:00Z'); }
function uteisDecorridos(baseStr, hojeStr) {
  let n = 0;
  for (let ms = paraMs(baseStr) + 86400000; ms <= paraMs(hojeStr); ms += 86400000) if (ehDiaUtil(ms)) n++;
  return n;
}
function somarUteis(baseStr, n) {
  let ms = paraMs(baseStr), c = 0;
  while (c < n) { ms += 86400000; if (ehDiaUtil(ms)) c++; }
  return new Date(ms).toISOString().slice(0, 10);
}
function formatoBR(dataStr) { const p = dataStr.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

const POS_TEXTOS = [
  'Olá, {{1}}! Passando para avisar que está tudo certo com o seu trabalho de apometria no Instituto Apometria Brasil. Você não precisa fazer mais nada agora, apenas aguardar o término do prazo. Faltam {{2}} dias úteis para a entrega, prevista para {{3}}. Qualquer dúvida, é só nos chamar por aqui. 🙏',
  'Olá, {{1}}! O seu trabalho de apometria segue em andamento e já estamos na reta final. Faltam {{2}} dias úteis para o término do prazo, com entrega prevista para {{3}}. Siga apenas aguardando; qualquer dúvida, estamos por aqui. 🙏'
];
const POS_NOMES = ['andamento_trabalho_4d', 'andamento_trabalho_11d'];
function textoPos(i, params) { return POS_TEXTOS[i].replace(/\{\{(\d)\}\}/g, (m, n) => params[parseInt(n, 10) - 1]); }
let posRodando = false;
const posTentativa = new Map();
async function rodarPosPagamento() {
  if (!pool || posRodando) return;
  posRodando = true;
  try {
    if ((await cfgGet('pos_ativo', '1')) !== '1') return;
    const h = horaBrasilia();
    if (h < 9 || h >= 19) return;
    const hoje = dataBR(new Date());
    const { rows } = await pool.query("SELECT phone, client_name, opcao, comprovante_at, COALESCE(pos_enviados,0) AS enviados FROM conversations WHERE funil IN ('comprovante','questionario','pago') AND comprovante_at IS NOT NULL AND NOT COALESCE(pos_off,false) AND COALESCE(pos_enviados,0) < 2");
    for (const r of rows) {
      const emerg = /emergenc/.test(semAcento(r.opcao || ''));
      const total = emerg ? 8 : 15, marcos = emerg ? [4] : [4, 11];
      if (r.enviados >= marcos.length) continue;
      const base = dataBR(new Date(r.comprovante_at));
      const dec = uteisDecorridos(base, hoje), marco = marcos[r.enviados];
      if (dec < marco) continue;
      if (dec >= total || dec - marco > 2) { await pool.query('UPDATE conversations SET pos_enviados = $2 WHERE phone = $1', [r.phone, dec >= total ? 9 : r.enviados + 1]); continue; }
      if (posTentativa.get(r.phone) && Date.now() - posTentativa.get(r.phone) < 3600000) continue;
      const nome = (r.client_name || '').trim().split(' ')[0] || 'cliente';
      const params = [nome, String(total - dec), formatoBR(somarUteis(base, total))];
      const tpl = (await cfgGet('pos_template_' + (r.enviados + 1), '')) || POS_NOMES[r.enviados];
      try {
        await enviarTemplate(r.phone, tpl, params);
        const texto = textoPos(r.enviados, params);
        await saveMessage(r.phone, 'out', '[Template ' + tpl + '] ' + texto);
        await crmSaida(r.phone);
        await pool.query('UPDATE conversations SET pos_enviados = COALESCE(pos_enviados,0) + 1 WHERE phone = $1', [r.phone]);
        await crmEvento(r.phone, 'pos_pagamento', 'Aviso ' + (r.enviados + 1) + ' de ' + marcos.length + ' (dias úteis: faltam ' + params[1] + ', entrega ' + params[2] + ')');
      } catch (e) { posTentativa.set(r.phone, Date.now()); console.error('❌ Pós-pagamento ' + r.phone + ':', e.response?.data ? JSON.stringify(e.response.data) : e.message); }
      await sleep(3000);
    }
  } catch (e) { console.error('❌ Pós-pagamento:', e.message); }
  finally { posRodando = false; }
}
// Cria os 2 modelos no WhatsApp Manager (uma vez; fica aguardando aprovação da Meta)
async function criarTemplatesPos() {
  try {
    if (!pool || (await cfgGet('pos_tpl_ok2', '0')) === '1') return;
    let waba = ((await cfgGet('waba_id', '')) || process.env.WABA_ID || '1802521334091114').trim();
    if (!waba) {
      const d = await axios.get('https://graph.facebook.com/v21.0/debug_token', { params: { input_token: WHATSAPP_TOKEN, access_token: WHATSAPP_TOKEN } });
      const gs = (d.data && d.data.data && d.data.data.granular_scopes) || [];
      const alvo = gs.find(x => x.scope === 'whatsapp_business_management') || gs.find(x => /whatsapp_business/.test(x.scope));
      waba = alvo && alvo.target_ids && alvo.target_ids[0];
    }
    if (!waba) { console.error('⚠️ Modelos pós-pagamento: WABA não encontrada (defina WABA_ID).'); return; }
    const res = [];
    for (let i = 0; i < 2; i++) {
      try {
        await axios.post('https://graph.facebook.com/v21.0/' + waba + '/message_templates', {
          name: POS_NOMES[i], language: 'pt_BR', category: 'UTILITY',
          components: [{ type: 'BODY', text: POS_TEXTOS[i], example: { body_text: [['Maria', i === 0 ? '11' : '4', '02/12/2026']] } }]
        }, { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN } });
        res.push(POS_NOMES[i] + ': criado');
      } catch (e) {
        const er = e.response && e.response.data && e.response.data.error;
        if (er && (er.error_subcode === 2388023 || /already exist|já existe/i.test((er.error_user_msg || '') + (er.message || '')))) res.push(POS_NOMES[i] + ': já existe');
        else { res.push(POS_NOMES[i] + ': ERRO ' + (er ? er.message + ' | ' + (er.error_user_msg || '') : e.message)); }
      }
    }
    console.log('📨 Modelos pós-pagamento (WABA ' + waba + '): ' + res.join(' ; '));
    await cfgSet('pos_tpl_status', res.join(' ; '));
    if (res.every(x => /criado|já existe/.test(x))) await cfgSet('pos_tpl_ok2', '1');
  } catch (e) { console.error('⚠️ Modelos pós-pagamento:', e.response?.data ? JSON.stringify(e.response.data) : e.message); }
}
setInterval(() => { rodarPosPagamento(); }, 5 * 60 * 1000);
setTimeout(() => { criarTemplatesPos(); }, 25000);
// Zerar o CRM uma única vez (pedido do Guilherme em 11/11/2026: apagar testes e contar métricas desde o início)
setTimeout(async () => {
  try {
    if (!pool || (await cfgGet('zerado_20261111', '0')) === '1') return;
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM eventos');
    await pool.query('DELETE FROM conversations');
    await pool.query("DELETE FROM crm_config WHERE key LIKE 'sess_%'");
    sessions.clear();
    await cfgSet('zerado_20261111', '1');
    console.log('🗑️ CRM zerado: contatos, cards, conversas e avisos apagados (pedido de 11/11/2026).');
  } catch (e) { console.error('❌ Zerar CRM:', e.message); }
}, 8000);

// Contexto do cliente que volta: quem já pagou é tratado como cliente (andamento/prazo), quem só conversou retoma de onde parou
async function contextoCliente(phone, session) {
  const vazio = { nota: '', pago: false };
  if (!pool) return vazio;
  try {
    const { rows } = await pool.query('SELECT funil, comprovante_at, opcao, questionario_at FROM conversations WHERE phone = $1', [phone]);
    const r = rows[0];
    if (!r) return vazio;
    if (['comprovante', 'questionario', 'pago'].includes(r.funil) && r.comprovante_at) {
      const emerg = /emergenc/.test(semAcento(r.opcao || ''));
      const total = emerg ? 8 : 15, base = dataBR(new Date(r.comprovante_at));
      const dec = uteisDecorridos(base, dataBR(new Date()));
      const prevista = formatoBR(somarUteis(base, total));
      const falta = Math.max(0, total - dec);
      const nota = '[SITUAÇÃO DESTA PESSOA (dado do sistema): ela JÁ É CLIENTE. Enviou o comprovante em ' + formatoBR(base) + (r.opcao ? ' (opção: ' + r.opcao + ')' : '') + '. '
        + 'Prazo: ' + total + ' dias úteis a partir do comprovante, contando sem sábados, domingos e feriados (nacionais, SP e São José do Rio Preto). '
        + (dec >= total ? 'O prazo previsto (' + prevista + ') já terminou: se ela perguntar, diga que vai confirmar o resultado com o Paulo e que ele retornará em breve. ' : 'Entrega prevista para ' + prevista + '; faltam ' + falta + ' dias úteis. ')
        + (r.questionario_at ? 'O questionário inicial já foi respondido. ' : 'O questionário inicial ainda não consta como respondido: se fizer sentido, lembre-a de preenchê-lo. ')
        + 'NÃO trate como contato novo: não repita apresentação, etapas, valores nem pergunte para quem é o trabalho. Responda com atenção às dúvidas sobre andamento, prazo, orientações e questionário. Se não souber algo, diga que vai confirmar com a equipe.]';
      return { nota, pago: true };
    }
    if (r.funil && r.funil !== 'novo' && session && session.history && session.history.length) {
      return { nota: '[SITUAÇÃO DESTA PESSOA: já conversou conosco antes. Retome exatamente de onde parou, SEM nova apresentação, e responda primeiro ao que ela está perguntando agora, entendendo o que ela precisa saber.]', pago: false };
    }
  } catch (e) { console.error('❌ Contexto do cliente:', e.message); }
  return vazio;
}

// ─── ROTAS DO CRM ─────────────────────────────────────────────────────────────
app.get('/painel/api/crm', async (req, res) => {
  if (!pool) return res.json({ conversas: [], eventos: [], config: {} });
  try {
    const conv = await pool.query(`SELECT phone, client_name, funil, last_in_at, last_out_at, followups_sent, followup_off,
        comprovante_at, questionario_at, notas, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 500`);
    const ev = await pool.query(`SELECT e.id, e.phone, e.tipo, e.detalhe, e.created_at, c.client_name
        FROM eventos e LEFT JOIN conversations c ON c.phone = e.phone ORDER BY e.created_at DESC LIMIT 60`);
    res.json({
      conversas: conv.rows.map(r => ({ ...r, pausado: sessions.get(r.phone)?.pausado || false })),
      eventos: ev.rows,
      rotulos: FUNIL_ROTULO,
      config: {
        followup_ativo: (await cfgGet('followup_ativo', '0')) === '1',
        followup_textos: await followupTextos(),
        alerta_numeros: await cfgGet('alerta_numeros', process.env.ALERTA_NUMEROS || ''),
        alerta_template: await cfgGet('alerta_template', process.env.ALERTA_TEMPLATE || ''),
        alerta_templates: { novo_contato: (await cfgGet('alerta_template_novo_contato', '')) || ALERTA_PADRAO.novo_contato, saiu_do_fluxo: (await cfgGet('alerta_template_saiu_do_fluxo', '')) || ALERTA_PADRAO.saiu_do_fluxo, pagamento_solicitado: (await cfgGet('alerta_template_pagamento_solicitado', '')) || ALERTA_PADRAO.pagamento_solicitado, comprovante: (await cfgGet('alerta_template_comprovante', '')) || ALERTA_PADRAO.comprovante, questionario: (await cfgGet('alerta_template_questionario', '')) || ALERTA_PADRAO.questionario },
        templates: [1, 2, 3].map(() => ''),
        followup_templates: [await cfgGet('followup_template_1', ''), await cfgGet('followup_template_2', ''), await cfgGet('followup_template_3', '')]
      }
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/painel/api/crm/config', async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.followup_ativo === 'boolean') {
      await cfgSet('followup_ativo', b.followup_ativo ? '1' : '0');
      if (b.followup_ativo && !(await cfgGet('followup_desde', null))) await cfgSet('followup_desde', new Date().toISOString());
    }
    if (b.followup_incluir_antigos === true) await pool.query("DELETE FROM crm_config WHERE key = 'followup_desde'");
    if (Array.isArray(b.followup_textos) && b.followup_textos.length === 3) await cfgSet('followup_textos', JSON.stringify(b.followup_textos.map(String)));
    if (typeof b.alerta_numeros === 'string') await cfgSet('alerta_numeros', b.alerta_numeros);
    if (typeof b.alerta_template === 'string') await cfgSet('alerta_template', b.alerta_template.trim());
    if (b.alerta_templates && typeof b.alerta_templates === 'object') for (const k of ['novo_contato', 'saiu_do_fluxo', 'pagamento_solicitado', 'comprovante', 'questionario']) if (typeof b.alerta_templates[k] === 'string') await cfgSet('alerta_template_' + k, b.alerta_templates[k].trim());
    if (Array.isArray(b.followup_templates)) for (let i = 0; i < 3; i++) await cfgSet('followup_template_' + (i + 1), String(b.followup_templates[i] || '').trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/painel/api/crm/:phone', async (req, res) => {
  try {
    const b = req.body || {}; const campos = {};
    if (typeof b.funil === 'string' && FUNIL_ROTULO[b.funil]) campos.funil = b.funil;
    if (typeof b.followup_off === 'boolean') campos.followup_off = b.followup_off;
    if (typeof b.notas === 'string') campos.notas = b.notas;
    await crmSet(req.params.phone, campos);
    if (campos.funil) await crmEvento(req.params.phone, 'funil_manual', 'Movido para: ' + FUNIL_ROTULO[campos.funil]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Integração com o formulário do site: o formulário envia um POST para cá quando alguém responde
app.post('/crm/questionario', async (req, res) => {
  if (!CRM_TOKEN) return res.status(503).json({ erro: 'CRM_TOKEN não configurado.' });
  if ((req.headers['x-crm-token'] || req.query.token) !== CRM_TOKEN) return res.status(401).json({ erro: 'Token inválido.' });
  try {
    const b = req.body || {};
    const tel = String(b.telefone || b.phone || b.whatsapp || '').replace(/\D/g, '');
    const nome = String(b.nome || b.name || '').trim();
    let achou = null;
    if (pool && tel.length >= 8) {
      const { rows } = await pool.query('SELECT phone, client_name FROM conversations WHERE right(phone, 8) = $1 ORDER BY updated_at DESC LIMIT 1', [tel.slice(-8)]);
      achou = rows[0] || null;
    }
    if (!achou && pool && nome) {
      const { rows } = await pool.query("SELECT phone, client_name FROM conversations WHERE lower(client_name) = lower($1) ORDER BY updated_at DESC LIMIT 1", [nome.split(' ')[0]]);
      achou = rows[0] || null;
    }
    if (achou) {
      await pool.query("UPDATE conversations SET funil = 'questionario', questionario_at = now() WHERE phone = $1", [achou.phone]);
      await crmAlertar('questionario', achou.phone, 'Formulário respondido por ' + (nome || 'nome não informado') + '.', achou.client_name);
    } else {
      await crmEvento(tel || 'desconhecido', 'questionario_sem_conversa', 'Formulário de ' + (nome || '?') + ' (' + (tel || 'sem telefone') + ') sem conversa correspondente.');
    }
    res.json({ ok: true, vinculado: !!achou });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

const CRM_HTML = "<!doctype html>\n<html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><title>CRM — Instituto Apometria Brasil</title>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap\" rel=\"stylesheet\">\n<style>\n:root{--teal:#12585C;--deep:#08262A;--mint:#B0D6D0;--cream:#F5F1E8;--paper:#FBF9F4;--ink:#17302F;--mut:#6B7F7C;--line:#E4DFD2;--ok:#2E8B57;--warn:#C99A2E;--bad:#B5645C;\n--lgu:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAA/CAQAAAD6FAZBAAAKWklEQVR42sXZe7RU9XUH8M85M3OfiF6URyBojOElKBgTbGnwFStCkKopRMVljMuyNK1p1KIrbYJtKi6TUJIYm9Yommg0anEVCMWgaK2ooEgkKFR5mUB5KAUE7os7M+f0jzncOzN35l6Sla781rp3zTrnd36//dv7u/f+7v0LVvvDjvAPvL/07/BNUPS/fMTJ3/+bACGizq16m/N7FSAQiJOF+6ozwkT9RDoQiPCBld5zOJkTio9FF8HqYz15YdkRznCuiWod9oEGbJNDxkDNMvpZ5w0b/Aqk5H8fAhTOUud8U01xok3etMYeLzqMJvU4qEXGMGfp4xKRnVZ4Tpsg0c7vLMDRBc53s6maLfOUV+1L3jb5ous0Cm13t+eSp32MMckwjRZY2psxehYgEGO0WW7S4lGPWtOJnViTb/sSiIR2u8YL0qLkxE0+52pt5nulJz30JEAoknaLmw31tHlWd0IxlpJ3u29pEwsQafSiq+3udNIIJ7rRlZ50VxGKjjkQhSJ9/MC3DfE1060WCsUisVDex90gEksJhdLanetSQaLwSCC0z1yXG+YRp4gq71VNgJTIGE+50XZfcE/yJCoKRac4Wbbo+1hojFg+0UFBiJQtrsezxoqkjlWAUN6ZHjLZWhdZKKTEoWI0lblYIO+TPlUSIWN5KXnXWuBxfyTfXYTUDZWVf6YHjPeqK/xGuttWsSH+ySmiou0CWQPwizLExwKBVzS6w+t2C0vfhxWQHznefOOtc61d0nIVdNSmn3QJrGIZdd6qYOsYoe94yYLuWAgrJJo6f+cC+33NVqmK23PYMw5LdZ4mFmh3p4cS1y0XIRaYbaN/VJP4TQ8YuN6Nsu72bJVQWsh4X/dDtZ3v82ot8y25KmkqFsj5igFm92SCUGyUWY7zH37YmXoqjbx2D9qpQVYkp16zh0RFOikfkdAB3zHN+GIdhGXgyphlrN3ma6uozK4TpWwxW7M+6jQ65Jte6CXuR0LPe9lXNHTxiWIvCMSmmqPev/rxMRCLQI193pfynx72sl29fhOIbTHDIRuPChCWvEybrp8tHipxsGpJijtNsthsP3Kx7+vfK8WLhLZZ40tdUEyXCDDBZ+UtsqUXZYZCOee7UKMRdjrBUB2mWiCsFvOLxlPOc7GlBROHJdie6iN2+je5qucPki1yJnpQvRZ9nWGIVsw1Uz4JwEFVHQTWe815R+EaluB/Mt6ysaotC8kocrq7LXSaI9Jy2hyREjnRfe5P8kFc1RiBwGITDS3MKeaEH3WavJ9rroL/QKTBZ13lAoPktAk70VAIxY1mmeYlj3vRwSrGiMW2anGmX3dpIBAJTVErsrcKlAKxcyz0765ykla5brNCea36m2GRpT5dBcixlF1Wubyg565FGpwjtN6GigYIxYZZYLIOrXJVrBxIyWrV4jOeNL6qVwT26C8QC7om1AixwbtVPeBPjdbaI8SOCpF2yKkuq4KkWGwlhhebgLOcgrYqJ4v0MSVJrccyMnI+b3BFHhRjs0HOQdj1eoQB8tqrxrIag3sMzuUmyxqeUNbKeqorkJMuDWSEWmysWPUFGGdIBeDpIVtwifoqUMzaW3geFrFAjthdtRwdbYCOYzRAYeV2nzKhAhBjZO0vPC+NhB0OVDlNaGgyJ+o11BaYcyCvzkW9mS0sOWWtE6sQ9KG+kFDKOrW9ICGlXkosJTJDv25GCBBqKA3FBdab0beKCUYamGSIF2yVqSpCLGO7eQ5IiR3xMdMrRoOU+mIBYhxBRmMVv71WrbxYxr3+vhK/L0o2y832iIxYLPRnGkpZYKLVunIN7HFQg5Hd4mAgNtBosUit9V7zrLXqKrLFSJ0P/Bj3Wq0OHc41rkI0CDQUgzDGO3aiT0WUXORMbdKynvC+//VMSU1UuvBrNgns8GUH1DqiwRXltQD6+dAmxF3L7HIYDWoqJI/xCaa3+JlA4OcOSndbNBbq8ISDAinrPCAlFJumbwkQQ1zgQ6tKBWj2KkYaWZLLA5GTXCov7Yh/sSMBV1TRvdL2+J/EGMy1RoN2A13aDYinHa04wk7ZIytljfaxbi4zykBH1HvFI4m5tvtVBSBGUtZ6PVkvVi9Ah74u7MYqTvZfBXwVy/WuLTLGdiMSeYGMnBMMF8vLOODNikk71i4rFMob7kFnaXWcFsuL+mYBPmGsZYXfYZH7bLREYLJ+RfkgEnjZN7XidAvdpElWKFsBAQVBUyJ5Ez1smnaN9vpLT5QYLDbeFrvLCUmAlxwywp+UJKRY7B43O6TWYN/zUxNEWks8O5KXcpwPPS2rv7/1ExPkNFprup8UbR+IHW+G5fYVfCMsqd5etlg/k8oiXSDwqGvskJEzxZOu8oq96pNYEKnToMViM61wjcfNdapWG93uMitLyrVQ7HJpzxw1YXGPKBT5pKVyJnmnhBcVmkwXmuscrerk3GW7+fppE6i3zRKv22mQq12i1i4rLPOGrWW9oQB9Pekldx/VSnFpFgvsNshkhzxf1BMOknpgm2fVm+AILva2+13oeGlr3SRlpllmGuOQn5rtAesdEJbRu1DseuPMcbh7aXZUxu9Z6TrDxFLSSU8sFsljh1vNUy+lxTeMNdMO7e5wg+/LyqizzAKxpoTiFE4ZSCUEPjLYVR6zsys2lrfpQpEzLLfErVqTfl8XIg5rx1+Zo79WtR63zAZD3O8em9zneavNM1DOSo96uKTJGwrUutcJvqi1y4m79wlT8q5zkb8w1h873Th9OgPpO9Z63XPO8LCztam33pftNsknbNRkkHU+Kutk59ljkf5GuQGTbfMm7nSNz1tfjItKjcpQWr1b3JakprgERG1Wu80m883UiMNWGG+faf5Z6HMmu8xgww3RgJ9Z5G+c7QNvuEfeAEtKg3hlASJf9V0dOoRlbbdYWq395vuuUW7150nyatZhl6+a6M7O2U9b6eNuVKNNRlqL+eZIiXoWIBQZaamTZSsSj1hejYxf+roNTjLalXKarLfJTOO1SanxtsekXGmMdlHS5KyRcYd5pa3rygKM9wvH9VCkx/IaxTZ7TLNGWUOc71SN8kI7LLPFBSYLtRYdIq/Wf7vaW8UYSFdpQeV6JJ6BtDaBYf6h7M1Wi6xztr82VLu4RIehyElO6O3KJsZ7VplWxQTFtKJdlDQk6rV4zxJLnOUbRom0dqshI3XWlOfRdMUaYL8fmKiv9h7ulOKELTWixXLLPK3eHNPVaRWWCR+L1NvsvvLuQ+X7glBkhh85XmtSM5UvVohuaXkbrLDcG/ZjvlsqfFFo6td62+2eKWdS6ark+imH3OVstHe24Av5okYarfZZ5G1L7Ols8K9xQFNR86KgpXqhNgvNt6o7kat+YxKK9Hebz/h0GVHdZbNfW2yzd2WTRFUoxmKXmWNccodytJT/jVUes0J7paZNb1c29HWFJnVOk7LL+/LW+aWOhAuUXkgFYh8xxUSn66/FZhvs8YKNJVnht7q06kJsWiBb4T6t0jVXKmnmN2spuvSMf/ub0zhRMOSSjCZZKq7aFQ/l7e3UYpCk8yrj/wDSQck3oBJtNAAAAABJRU5ErkJggg==);--serif:'Libre Baskerville',Baskerville,Georgia,serif;--sans:Inter,system-ui,-apple-system,Segoe UI,sans-serif}\n*{box-sizing:border-box}body{margin:0;font-family:var(--sans);background:var(--cream);color:var(--ink);font-size:14px}\na{color:var(--teal)}button{font:inherit;cursor:pointer}\n.app{display:grid;grid-template-columns:232px 1fr;min-height:100vh}\naside{background:linear-gradient(180deg,var(--deep),var(--teal));color:#fff;padding:20px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}\n.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 22px}.lg{display:block;flex:none;width:44px;height:43px;background:var(--mint);-webkit-mask:var(--lgu) center/contain no-repeat;mask:var(--lgu) center/contain no-repeat}\n.brand b{font-family:var(--serif);font-size:15px;line-height:1.2;font-weight:700;display:block}.brand small{font-size:11px;color:var(--mint);letter-spacing:.08em;text-transform:uppercase}\nnav button{display:flex;align-items:center;gap:10px;width:100%;background:none;border:0;color:#cfe6e2;padding:10px 12px;border-radius:10px;margin-bottom:4px;text-align:left;font-weight:500;transition:.15s}\nnav button:hover{background:rgba(255,255,255,.08);color:#fff}nav button.on{background:var(--cream);color:var(--teal);font-weight:600}\nnav svg{width:18px;height:18px;flex:none}.side-foot{margin-top:auto;font-size:12px;color:var(--mint);padding:8px}\n.side-foot a{color:#fff;text-decoration:none;display:block;margin-bottom:10px;font-weight:500}\n.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:#5fd38d;margin-right:6px;box-shadow:0 0 0 3px rgba(95,211,141,.25)}\nmain{padding:22px 28px 60px;min-width:0}\n.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:20px}\n.top h1{font-family:var(--serif);font-size:24px;margin:0;color:var(--deep)}.top p{margin:3px 0 0;color:var(--mut);font-size:13px}\n.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}\n.search{position:relative}.search input.sq{padding:10px 14px 10px 36px !important;border:1px solid var(--line);border-radius:12px;background:#fff;width:260px;font:inherit}\n.search svg{position:absolute;left:11px;top:11px;width:16px;height:16px;color:var(--mut)}\n.btn{background:var(--teal);color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600}.btn:hover{background:var(--deep)}\n.btn.ghost{background:#fff;color:var(--teal);border:1px solid var(--line)}.btn.ghost:hover{border-color:var(--teal)}\n.view{display:none}.view.on{display:block}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:18px}\n.kpi{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px 18px;position:relative;overflow:hidden;cursor:pointer;transition:.15s}\n.kpi:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(8,38,42,.08)}\n.kpi:before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--c,var(--teal))}\n.kpi span{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;font-weight:600}\n.kpi b{display:block;font-family:var(--serif);font-size:32px;margin-top:6px;color:var(--deep)}.kpi small{color:var(--mut);font-size:12px}\n.panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:18px}\n.panel h2{font-family:var(--serif);font-size:16px;margin:0 0 14px;color:var(--deep);display:flex;justify-content:space-between;align-items:center}\n.panel h2 small{font-family:var(--sans);font-weight:500;font-size:12px;color:var(--mut)}\n.cols2{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}@media(max-width:1100px){.cols2{grid-template-columns:1fr}}\n.fr{display:grid;grid-template-columns:150px 1fr 40px;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;cursor:pointer}\n.fr:hover{background:var(--paper)}.fr .bar{height:14px;border-radius:8px;background:#EEF3F1;overflow:hidden}.fr .bar i{display:block;height:100%;border-radius:8px;transition:width .5s}\n.fr em{font-style:normal;font-weight:700;text-align:right}.fr span{font-size:13px}\n.chart{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:10px}\n.chart div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%}\n.chart i{width:100%;max-width:34px;background:linear-gradient(180deg,var(--teal),var(--mint));border-radius:6px 6px 2px 2px;min-height:3px}\n.chart small{font-size:10px;color:var(--mut)}.chart b{font-size:11px}\n.item{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line);cursor:pointer}.item:first-child{border-top:0}\n.item:hover{background:var(--paper)}.item .t{flex:1;min-width:0}.item .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.item .t small{color:var(--mut)}\n.av{width:36px;height:36px;border-radius:50%;background:var(--mint);color:var(--deep);display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}\n.pill{display:inline-block;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;background:color-mix(in srgb,var(--c,#888) 16%,#fff);color:var(--c,#555);white-space:nowrap}\n.empty{color:var(--mut);font-size:13px;padding:14px 0;text-align:center}\n/* kanban */\n.board{display:flex;gap:16px;overflow-x:auto;padding:4px 4px 18px;align-items:flex-start;scroll-snap-type:x proximity}\n.col{flex:0 0 288px;background:#EEEADD;border-radius:18px;padding:12px;scroll-snap-align:start;border:2px solid transparent;transition:.15s;max-height:calc(100vh - 190px);display:flex;flex-direction:column}\n.col.over{border-color:var(--c);background:color-mix(in srgb,var(--c) 10%,#EEEADD)}\n.col header{display:flex;align-items:center;gap:8px;padding:6px 8px 12px;border-bottom:3px solid var(--c);margin-bottom:12px}\n.col header b{flex:1;font-size:13px;color:var(--deep)}.col header span{background:var(--c);color:#fff;border-radius:20px;font-size:12px;font-weight:700;padding:2px 9px}\n.cards{overflow-y:auto;display:flex;flex-direction:column;gap:12px;flex:1;padding:2px 2px 6px;min-height:60px}\n.lead{background:#fff;border-radius:14px;padding:12px 14px;border:1px solid var(--line);border-left:5px solid var(--c);box-shadow:0 1px 2px rgba(8,38,42,.06);cursor:grab;transition:.15s}\n.lead:hover{box-shadow:0 8px 18px rgba(8,38,42,.12);transform:translateY(-2px)}.lead.drag{opacity:.4}\n.lead .h{display:flex;gap:10px;align-items:center}.lead .h b{display:block;font-size:14px;color:var(--deep);line-height:1.2}.lead .h small{color:var(--mut);font-size:12px}\n.lead .m{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--mut)}\n.chip{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:2px 8px}.chip.hot{background:#fff4dc;border-color:#ecd49a;color:#8a6410}.chip.pause{background:#efe6f5;border-color:#d9c6ea;color:#6a3f8e}\n.lead .n{margin-top:8px;font-size:12px;color:var(--ink);background:var(--paper);border-radius:8px;padding:6px 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.colempty{border:2px dashed #cfc9b8;border-radius:12px;color:var(--mut);font-size:12px;text-align:center;padding:18px 8px}\n/* list */\ntable{width:100%;border-collapse:collapse}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);text-align:left;padding:10px 8px;cursor:pointer;white-space:nowrap;user-select:none}\ntd{padding:11px 8px;border-top:1px solid var(--line);vertical-align:middle}tr.row{cursor:pointer}tr.row:hover td{background:var(--paper)}\n.tw{overflow-x:auto}\n/* drawer */\n.shade{position:fixed;inset:0;background:rgba(8,38,42,.45);opacity:0;pointer-events:none;transition:.2s;z-index:30}.shade.on{opacity:1;pointer-events:auto}\n.drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:#fff;z-index:31;transform:translateX(105%);transition:.25s;display:flex;flex-direction:column;box-shadow:-10px 0 40px rgba(0,0,0,.2)}.drawer.on{transform:none}\n.dh{background:linear-gradient(135deg,var(--deep),var(--teal));color:#fff;padding:20px}.dh h3{font-family:var(--serif);margin:10px 0 2px;font-size:20px}.dh a{color:var(--mint)}\n.dh .x{float:right;background:rgba(255,255,255,.15);border:0;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px}\n.db{padding:18px 20px;overflow-y:auto;flex:1}.db label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}\nselect,input[type=text],input:not([type]),textarea{width:100%;font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fff;color:var(--ink)}\ntextarea{resize:vertical}select:focus,input:focus,textarea:focus{outline:2px solid var(--mint);border-color:var(--teal)}\n.stages{display:flex;flex-wrap:wrap;gap:6px}.stages button{border:1px solid var(--line);background:#fff;border-radius:20px;padding:5px 11px;font-size:12px;font-weight:600;color:var(--mut)}\n.stages button.on{background:var(--c);border-color:var(--c);color:#fff}\n.tl{border-left:2px solid var(--mint);margin-left:6px;padding-left:14px}.tl div{margin-bottom:12px;font-size:13px}.tl small{color:var(--mut);display:block}\n.sw{display:flex;gap:10px;align-items:center;font-size:14px;margin-top:14px;cursor:pointer}.sw input{width:18px;height:18px;accent-color:var(--teal)}\n.cfg{max-width:760px}.cfg label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin:12px 0 5px}.cfg p{font-size:12px;color:var(--mut)}\n.toast{position:fixed;bottom:22px;left:50%;transform:translate(-50%,30px);background:var(--deep);color:#fff;padding:11px 20px;border-radius:30px;opacity:0;transition:.25s;z-index:50;font-weight:500}.toast.on{opacity:1;transform:translate(-50%,0)}\n@media(max-width:820px){.app{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;align-items:center;overflow-x:auto;padding:10px}.brand{padding:0 10px 0 0}.brand div{display:none}nav{display:flex;gap:4px}nav button{white-space:nowrap;margin:0}.side-foot{display:none}main{padding:16px 14px 60px}.search input{width:100%}.search{flex:1}.col{flex-basis:260px}.fr{grid-template-columns:110px 1fr 34px}}\n</style></head><body>\n<div class=\"app\">\n<aside>\n <div class=\"brand\"><i class=\"lg\"></i><div><b>Instituto<br>Apometria Brasil</b><small>CRM</small></div></div>\n <nav id=\"nav\">\n  <button data-v=\"dash\" class=\"on\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"9\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"5\" rx=\"1.5\"/><rect x=\"14\" y=\"12\" width=\"7\" height=\"9\" rx=\"1.5\"/><rect x=\"3\" y=\"16\" width=\"7\" height=\"5\" rx=\"1.5\"/></svg>Painel</button>\n  <button data-v=\"kanban\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"5\" height=\"18\" rx=\"1.5\"/><rect x=\"10\" y=\"3\" width=\"5\" height=\"12\" rx=\"1.5\"/><rect x=\"17\" y=\"3\" width=\"4\" height=\"8\" rx=\"1.5\"/></svg>Funil (Kanban)</button>\n  <button data-v=\"lista\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01\"/></svg>Lista de leads</button>\n  <button data-v=\"config\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/></svg>Avisos e follow-up</button>\n </nav>\n <div class=\"side-foot\"><a href=\"/painel\">← Conversas do bot</a><span class=\"live\"></span><span id=\"upd\">carregando…</span></div>\n</aside>\n<main>\n <div class=\"top\"><div><h1 id=\"titulo\">Painel</h1><p id=\"sub\"></p></div>\n  <div class=\"tools\"><div class=\"search\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/></svg><input class=\"sq\" id=\"q\" placeholder=\"Buscar nome ou telefone…\"></div><button class=\"btn ghost\" id=\"rec\">Atualizar</button></div></div>\n\n <section class=\"view on\" id=\"v-dash\">\n  <div class=\"kpis\" id=\"kpis\"></div>\n  <div class=\"cols2\"><div>\n    <div class=\"panel\"><h2>Funil de atendimento <small>clique numa etapa para abrir no Kanban</small></h2><div id=\"funil\"></div></div>\n    <div class=\"panel\"><h2>Atividade dos últimos 14 dias <small>pessoas que escreveram em cada dia</small></h2><div class=\"chart\" id=\"chart\"></div></div>\n  </div><div>\n    <div class=\"panel\"><h2>Precisam de atenção <small id=\"atN\"></small></h2><div id=\"atencao\"></div></div>\n    <div class=\"panel\"><h2>Avisos recentes</h2><div id=\"eventos\"></div></div>\n  </div></div>\n </section>\n\n <section class=\"view\" id=\"v-kanban\"><div class=\"board\" id=\"board\"></div></section>\n\n <section class=\"view\" id=\"v-lista\"><div class=\"panel\"><div class=\"tw\"><table><thead><tr><th data-s=\"client_name\">Nome</th><th data-s=\"funil\">Etapa</th><th data-s=\"last_in_at\">Última mensagem dele(a)</th><th data-s=\"last_out_at\">Última nossa</th><th data-s=\"followups_sent\">Follow-ups</th><th>Notas</th></tr></thead><tbody id=\"linhas\"></tbody></table></div></div></section>\n\n <section class=\"view\" id=\"v-config\"><div class=\"panel cfg\">\n   <h2>Follow-up automático</h2>\n   <label class=\"sw\"><input type=\"checkbox\" id=\"fuAtivo\"> Enviar follow-ups (3 mensagens em 3 dias, das 8h às 20h)</label>\n   <div id=\"fuTextos\"></div>\n   <p>Use {nome}. Depois de 24h sem resposta, o WhatsApp só permite mensagem modelo (template) aprovada: informe o nome de cada uma abaixo.</p>\n   <div id=\"fuTpl\"></div>\n   <h2 style=\"margin-top:28px\">Avisos para a equipe</h2>\n   <label>Números (com DDI, separados por vírgula)</label><input id=\"alNum\">\n   <label>Mensagem: novo contato (use {pessoa} e {detalhe})</label><input id=\"alTplN\">\n   <label>Mensagem: conversa saiu do fluxo (use {pessoa} e {detalhe})</label><input id=\"alTplS\">\n   <label>Mensagem: Pix ou cartão solicitado (use {pessoa} e {detalhe})</label><input id=\"alTplP\">\n   <label>Mensagem: comprovante recebido (use {pessoa} e {detalhe})</label><input id=\"alTplC\">\n   <label>Mensagem: questionário respondido (use {pessoa} e {detalhe}; \\n = nova linha)</label><input id=\"alTplQ\">\n   <p style=\"margin-top:16px\"><button class=\"btn\" id=\"salvar\">Salvar configurações</button> <span id=\"ok\" style=\"color:var(--ok);font-weight:600\"></span></p>\n </div></section>\n</main></div>\n\n<div class=\"shade\" id=\"shade\"></div>\n<div class=\"drawer\" id=\"drawer\"></div>\n<div class=\"toast\" id=\"toast\"></div>\n\n<script>\nvar COR={novo:'#6FB1AA',explicacao:'#3E8A8E',valores:'#12585C',comprovante:'#C99A2E',pago:'#2E8B57',questionario:'#5B7DB1',paulo:'#8A6BAE',sem_resposta:'#8E9A97',perdido:'#B5645C'};\nvar dados=null,vista='dash',busca='',filtroEtapa='',ordem={k:'last_in_at',d:-1},aberto=null,arrastando=false;\nvar TIT={dash:['Painel','Visão geral do atendimento'],kanban:['Funil de atendimento','Arraste os cartões entre as colunas para mudar a etapa'],lista:['Lista de leads','Todos os contatos, com busca e ordenação'],config:['Avisos e follow-up','Mensagens automáticas e alertas para a equipe']};\nfunction $(i){return document.getElementById(i);}\nfunction esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}\nfunction ago(d){if(!d)return '—';var m=Math.max(0,Math.round((Date.now()-new Date(d))/60000));if(m<1)return 'agora';if(m<60)return m+' min';if(m<1440)return Math.round(m/60)+' h';return Math.round(m/1440)+' d';}\nfunction ini(n){n=(n||'?').trim().split(/\\s+/);return ((n[0]||'?')[0]+(n.length>1?n[n.length-1][0]:'')).toUpperCase();}\nfunction fone(p){p=String(p);return p.length>=12?'+'+p.slice(0,2)+' ('+p.slice(2,4)+') '+p.slice(4,p.length-4)+'-'+p.slice(-4):'+'+p;}\nfunction api(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();});}\nfunction toast(t){var e=$('toast');e.textContent=t;e.className='toast on';setTimeout(function(){e.className='toast';},2200);}\nfunction rot(k){return (dados&&dados.rotulos[k])||k;}\nfunction pill(k){return '<span class=\"pill\" style=\"--c:'+(COR[k]||'#777')+'\">'+esc(rot(k))+'</span>';}\nfunction nome(c){return c.client_name||'Sem nome';}\nfunction visiveis(){var q=busca.toLowerCase().trim();return dados.conversas.filter(function(c){return !q||(nome(c).toLowerCase().indexOf(q)>=0)||String(c.phone).indexOf(q.replace(/\\D/g,'')||'§§')>=0;});}\nfunction parado(c){return c.last_in_at&&(!c.last_out_at||new Date(c.last_in_at)>new Date(c.last_out_at))&&(Date.now()-new Date(c.last_in_at))>30*60000&&['pago','perdido','paulo'].indexOf(c.funil)<0;}\nfunction hoje(d){return d&&new Date(d).toDateString()===new Date().toDateString();}\n\nfunction setVista(v){vista=v;document.querySelectorAll('.view').forEach(function(e){e.classList.toggle('on',e.id==='v-'+v);});\n document.querySelectorAll('#nav button').forEach(function(b){b.classList.toggle('on',b.dataset.v===v);});\n $('titulo').textContent=TIT[v][0];$('sub').textContent=TIT[v][1];$('q').parentNode.style.display=v==='config'?'none':'';render();}\n\nfunction render(){if(!dados)return;\n if(vista==='dash')rDash();else if(vista==='kanban')rKanban();else if(vista==='lista')rLista();\n $('upd').textContent='atualizado '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}\n\nfunction rDash(){var cv=dados.conversas,tot=cv.length,cont={};cv.forEach(function(c){cont[c.funil]=(cont[c.funil]||0)+1;});\n var pagos=cont.pago||0,comp=cont.comprovante||0,aguard=cv.filter(parado).length;\n var novosHoje=cv.filter(function(c){return hoje(c.created_at||c.updated_at)&&c.funil==='novo';}).length;\n var ativosHoje=cv.filter(function(c){return hoje(c.last_in_at);}).length;\n var conv=tot?Math.round((pagos+comp)/tot*1000)/10:0;\n var K=[['Leads no total',tot,'todas as conversas','#12585C',''],['Falaram hoje',ativosHoje,'mensagens recebidas hoje','#3E8A8E',''],['Aguardando resposta',aguard,'ele(a) escreveu e ainda não respondemos','#C99A2E',''],\n  ['Comprovantes',comp,'para conferir','#B5645C','comprovante'],['Pagos / confirmados',pagos,'tratamentos fechados','#2E8B57','pago'],['Conversão',conv.toString().replace('.',',')+'%','pago + comprovante ÷ leads','#5B7DB1','']];\n $('kpis').innerHTML=K.map(function(k,i){return '<div class=\"kpi\" style=\"--c:'+k[3]+'\" data-e=\"'+k[4]+'\" data-i=\"'+i+'\"><span>'+k[0]+'</span><b>'+k[1]+'</b><small>'+k[2]+'</small></div>';}).join('');\n document.querySelectorAll('.kpi').forEach(function(e){e.onclick=function(){var s=e.dataset.e;if(s){filtroEtapa=s;setVista('lista');}else if(e.dataset.i==='2'){busca='';filtroEtapa='__parado';setVista('lista');}};});\n var mx=Math.max.apply(null,Object.keys(dados.rotulos).map(function(k){return cont[k]||0;}).concat([1]));\n $('funil').innerHTML=Object.keys(dados.rotulos).map(function(k){var n=cont[k]||0;return '<div class=\"fr\" data-k=\"'+k+'\"><span>'+esc(rot(k))+'</span><div class=\"bar\"><i style=\"width:'+(n/mx*100)+'%;background:'+COR[k]+'\"></i></div><em>'+n+'</em></div>';}).join('');\n document.querySelectorAll('.fr').forEach(function(e){e.onclick=function(){setVista('kanban');var c=document.querySelector('.col[data-k=\"'+e.dataset.k+'\"]');if(c)c.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});};});\n var dias=[],now=new Date();for(var i=13;i>=0;i--){var d=new Date(now);d.setDate(d.getDate()-i);dias.push({s:d.toDateString(),l:d.getDate()+'/'+(d.getMonth()+1),n:0});}\n cv.forEach(function(c){if(!c.last_in_at)return;var s=new Date(c.last_in_at).toDateString();dias.forEach(function(x){if(x.s===s)x.n++;});});\n var m=Math.max.apply(null,dias.map(function(x){return x.n;}).concat([1]));\n $('chart').innerHTML=dias.map(function(x){return '<div title=\"'+x.n+' pessoa(s)\"><b>'+(x.n||'')+'</b><i style=\"height:'+(x.n/m*100)+'%\"></i><small>'+x.l+'</small></div>';}).join('');\n var at=cv.filter(function(c){return c.funil==='comprovante'||c.funil==='paulo'||c.pausado||parado(c);}).slice(0,8);$('atN').textContent=at.length?at.length+' lead(s)':'';\n $('atencao').innerHTML=at.map(function(c){var why=c.funil==='comprovante'?'Comprovante para conferir':c.funil==='paulo'?'Aguardando o Paulo':c.pausado?'Bot pausado':'Sem resposta nossa há '+ago(c.last_in_at);return '<div class=\"item\" data-p=\"'+c.phone+'\"><div class=\"av\">'+ini(nome(c))+'</div><div class=\"t\"><b>'+esc(nome(c))+'</b><small>'+why+'</small></div>'+pill(c.funil)+'</div>';}).join('')||'<div class=\"empty\">Tudo em dia. 🙏</div>';\n $('eventos').innerHTML=dados.eventos.slice(0,10).map(function(v){return '<div class=\"item\" data-p=\"'+v.phone+'\"><div class=\"t\"><b>'+esc((dados.avisos&&dados.avisos[v.tipo])||v.tipo.replace(/_/g,' '))+'</b><small>'+esc(v.client_name||v.phone)+(v.detalhe?' · '+esc(v.detalhe):'')+'</small></div><small style=\"color:var(--mut)\">há '+ago(v.created_at)+'</small></div>';}).join('')||'<div class=\"empty\">Nenhum aviso ainda.</div>';\n bindItems();}\n\nfunction bindItems(){document.querySelectorAll('[data-p].item,tr.row,.lead').forEach(function(e){e.onclick=function(ev){if(ev.target.closest('a'))return;abrir(e.dataset.p);};});}\n\nfunction rKanban(){var vis=visiveis(),by={};vis.forEach(function(c){(by[c.funil]=by[c.funil]||[]).push(c);});\n $('board').innerHTML=Object.keys(dados.rotulos).map(function(k){var L=by[k]||[];\n  return '<div class=\"col\" data-k=\"'+k+'\" style=\"--c:'+COR[k]+'\"><header><b>'+esc(rot(k))+'</b><span>'+L.length+'</span></header><div class=\"cards\">'+\n  (L.map(function(c){var h=parado(c);return '<div class=\"lead\" draggable=\"true\" data-p=\"'+c.phone+'\" style=\"--c:'+COR[k]+'\"><div class=\"h\"><div class=\"av\">'+ini(nome(c))+'</div><div><b>'+esc(nome(c))+'</b><small>'+fone(c.phone)+'</small></div></div>'+\n   '<div class=\"m\"><span class=\"chip\">💬 '+ago(c.last_in_at)+'</span>'+(h?'<span class=\"chip hot\">responder</span>':'')+(c.pausado?'<span class=\"chip pause\">bot pausado</span>':'')+(c.followup_off?'<span class=\"chip\">follow-up off</span>':(c.followups_sent?'<span class=\"chip\">follow-ups '+c.followups_sent+'/3</span>':''))+'</div>'+(c.notas?'<div class=\"n\">'+esc(c.notas)+'</div>':'')+'</div>';}).join('')||'<div class=\"colempty\">Solte um cartão aqui</div>')+'</div></div>';}).join('');\n bindItems();\n document.querySelectorAll('.lead').forEach(function(e){e.ondragstart=function(ev){arrastando=true;e.classList.add('drag');ev.dataTransfer.setData('text/plain',e.dataset.p);ev.dataTransfer.effectAllowed='move';};e.ondragend=function(){arrastando=false;e.classList.remove('drag');document.querySelectorAll('.col').forEach(function(c){c.classList.remove('over');});};});\n document.querySelectorAll('.col').forEach(function(col){col.ondragover=function(ev){ev.preventDefault();col.classList.add('over');};col.ondragleave=function(ev){if(!col.contains(ev.relatedTarget))col.classList.remove('over');};\n  col.ondrop=function(ev){ev.preventDefault();col.classList.remove('over');var p=ev.dataTransfer.getData('text/plain');mover(p,col.dataset.k);};});}\n\nfunction mover(p,k){var c=dados.conversas.filter(function(x){return String(x.phone)===String(p);})[0];if(!c||c.funil===k)return;var ant=c.funil;c.funil=k;render();if(aberto)drawer();\n api('/painel/api/crm/'+p,{funil:k}).then(function(){toast(nome(c)+' → '+rot(k));}).catch(function(){c.funil=ant;render();toast('Não foi possível mover');});}\n\nfunction rLista(){var q=vis=visiveis();if(filtroEtapa==='__parado')q=q.filter(parado);else if(filtroEtapa)q=q.filter(function(c){return c.funil===filtroEtapa;});\n q=q.slice().sort(function(a,b){var x=a[ordem.k],y=b[ordem.k];if(ordem.k==='client_name'){x=nome(a).toLowerCase();y=nome(b).toLowerCase();}if(x==null)x='';if(y==null)y='';return (x>y?1:x<y?-1:0)*ordem.d;});\n var chips='<div class=\"stages\" style=\"margin-bottom:12px\"><button data-e=\"\" class=\"'+(!filtroEtapa?'on':'')+'\" style=\"--c:#12585C\">Todos</button>'+Object.keys(dados.rotulos).map(function(k){return '<button data-e=\"'+k+'\" class=\"'+(filtroEtapa===k?'on':'')+'\" style=\"--c:'+COR[k]+'\">'+esc(rot(k))+'</button>';}).join('')+(filtroEtapa==='__parado'?'<button class=\"on\" style=\"--c:#C99A2E\">Aguardando resposta</button>':'')+'</div>';\n var old=document.querySelector('#v-lista .stages');if(old)old.remove();$('v-lista').querySelector('.panel').insertAdjacentHTML('afterbegin',chips);\n document.querySelectorAll('#v-lista .stages button[data-e]').forEach(function(b){b.onclick=function(){filtroEtapa=b.dataset.e;rLista();};});\n $('linhas').innerHTML=q.map(function(c){return '<tr class=\"row\" data-p=\"'+c.phone+'\"><td><div style=\"display:flex;gap:10px;align-items:center\"><div class=\"av\">'+ini(nome(c))+'</div><div><b>'+esc(nome(c))+'</b>'+(c.pausado?' <span class=\"chip pause\">pausado</span>':'')+'<br><small style=\"color:var(--mut)\">'+fone(c.phone)+'</small></div></div></td><td>'+pill(c.funil)+'</td><td>há '+ago(c.last_in_at)+'</td><td>há '+ago(c.last_out_at)+'</td><td>'+(c.followup_off?'desligado':c.followups_sent+'/3')+'</td><td style=\"max-width:260px;color:var(--mut);font-size:13px\">'+esc((c.notas||'').slice(0,90))+'</td></tr>';}).join('')||'<tr><td colspan=\"6\" class=\"empty\">Nenhum lead encontrado.</td></tr>';\n bindItems();}\ndocument.querySelectorAll('th[data-s]').forEach(function(t){t.onclick=function(){var k=t.dataset.s;ordem=ordem.k===k?{k:k,d:-ordem.d}:{k:k,d:-1};rLista();};});\n\nfunction abrir(p){aberto=String(p);drawer();$('drawer').classList.add('on');$('shade').classList.add('on');}\nfunction fechar(){aberto=null;$('drawer').classList.remove('on');$('shade').classList.remove('on');}\nfunction drawer(){var c=dados.conversas.filter(function(x){return String(x.phone)===aberto;})[0];if(!c){fechar();return;}\n var ev=dados.eventos.filter(function(e){return String(e.phone)===aberto;});\n $('drawer').innerHTML='<div class=\"dh\"><button class=\"x\" id=\"dx\">×</button><div class=\"av\" style=\"width:52px;height:52px;font-size:18px\">'+ini(nome(c))+'</div><h3>'+esc(nome(c))+'</h3><a href=\"https://wa.me/'+c.phone+'\" target=\"_blank\" rel=\"noopener\">'+fone(c.phone)+' · abrir no WhatsApp ↗</a></div>'+\n '<div class=\"db\"><label>Etapa do funil</label><div class=\"stages\" id=\"dst\">'+Object.keys(dados.rotulos).map(function(k){return '<button data-k=\"'+k+'\" class=\"'+(c.funil===k?'on':'')+'\" style=\"--c:'+COR[k]+'\">'+esc(rot(k))+'</button>';}).join('')+'</div>'+\n '<label>Atividade</label><div style=\"font-size:13px\">Última mensagem dele(a): <b>há '+ago(c.last_in_at)+'</b><br>Última nossa: <b>há '+ago(c.last_out_at)+'</b><br>Follow-ups enviados: <b>'+c.followups_sent+'/3</b>'+(c.comprovante_at?'<br>Comprovante: <b>'+new Date(c.comprovante_at).toLocaleString('pt-BR')+'</b>':'')+(c.questionario_at?'<br>Questionário: <b>'+new Date(c.questionario_at).toLocaleString('pt-BR')+'</b>':'')+'</div>'+\n '<label class=\"sw\" style=\"text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink);font-weight:500\"><input type=\"checkbox\" id=\"dfo\"'+(c.followup_off?' checked':'')+'> Parar follow-ups automáticos</label>'+\n '<label>Notas da equipe</label><textarea id=\"dnt\" rows=\"5\" placeholder=\"Anote aqui o que combinou, dúvidas, horário…\">'+esc(c.notas)+'</textarea><p style=\"margin:10px 0 0\"><button class=\"btn\" id=\"dsv\">Salvar nota</button></p>'+\n '<label>Histórico de avisos</label><div class=\"tl\">'+(ev.map(function(e){return '<div><b>'+esc(e.tipo.replace(/_/g,' '))+'</b><small>'+esc(e.detalhe||'')+' · há '+ago(e.created_at)+'</small></div>';}).join('')||'<small style=\"color:var(--mut)\">Sem avisos para este contato.</small>')+'</div></div>';\n $('dx').onclick=fechar;\n document.querySelectorAll('#dst button').forEach(function(b){b.onclick=function(){mover(c.phone,b.dataset.k);};});\n $('dfo').onchange=function(){c.followup_off=this.checked;api('/painel/api/crm/'+c.phone,{followup_off:this.checked}).then(function(){toast('Salvo');});};\n $('dsv').onclick=function(){c.notas=$('dnt').value;api('/painel/api/crm/'+c.phone,{notas:c.notas}).then(function(){toast('Nota salva');render();});};}\n$('shade').onclick=fechar;document.addEventListener('keydown',function(e){if(e.key==='Escape')fechar();});\ndocument.querySelectorAll('#nav button').forEach(function(b){b.onclick=function(){filtroEtapa='';setVista(b.dataset.v);};});\n$('q').oninput=function(){busca=this.value;render();};$('rec').onclick=function(){load(true);};\n\nvar primeira=true;\nfunction load(manual){fetch('/painel/api/crm').then(function(r){return r.json();}).then(function(d){\n if(arrastando||(aberto&&document.activeElement&&document.activeElement.id==='dnt'))return;\n dados=d;render();if(aberto)drawer();if(manual)toast('Atualizado');\n if(primeira){primeira=false;$('sub').textContent=TIT[vista][1];\n  $('fuAtivo').checked=d.config.followup_ativo;\n  $('fuTextos').innerHTML=d.config.followup_textos.map(function(t,i){return '<label>Mensagem '+(i+1)+'</label><textarea rows=\"3\" class=\"ft\">'+esc(t)+'</textarea>';}).join('');\n  $('fuTpl').innerHTML=d.config.followup_templates.map(function(t,i){return '<label>Template da mensagem '+(i+1)+'</label><input class=\"ftp\" value=\"'+esc(t)+'\">';}).join('');\n  $('alNum').value=d.config.alerta_numeros||'';var at=d.config.alerta_templates||{};$('alTplC').value=at.comprovante||'';$('alTplN').value=at.novo_contato||'';$('alTplP').value=at.pagamento_solicitado||'';$('alTplS').value=at.saiu_do_fluxo||'';$('alTplQ').value=at.questionario||'';}\n }).catch(function(){$('upd').textContent='sem conexão';});}\n$('salvar').onclick=function(){\n api('/painel/api/crm/config',{followup_ativo:$('fuAtivo').checked,\n  followup_textos:Array.prototype.map.call(document.querySelectorAll('.ft'),function(e){return e.value;}),\n  followup_templates:Array.prototype.map.call(document.querySelectorAll('.ftp'),function(e){return e.value;}),\n  alerta_numeros:$('alNum').value,alerta_templates:{novo_contato:$('alTplN').value,pagamento_solicitado:$('alTplP').value,comprovante:$('alTplC').value,saiu_do_fluxo:$('alTplS').value,questionario:$('alTplQ').value}}).then(function(){$('ok').textContent='Salvo.';toast('Configurações salvas');setTimeout(function(){$('ok').textContent='';},2500);});};\nsetVista('dash');load();setInterval(load,20000);\n</script></body></html>\n";
app.get('/painel/crm', (req, res) => { res.type('html').send(CRM_HTML.replace('</body>', '<script src="/painel/crm-extra.js"></script></body>')); });
// ─── CRM: excluir contato / zerar tudo ────────────────────────────────────────
async function apagarContatos(cond, params) {
  const alvo = '(SELECT phone FROM conversations WHERE ' + cond + ')';
  const ph = (await pool.query('SELECT phone FROM conversations WHERE ' + cond, params)).rows.map(r => r.phone);
  if (!ph.length) return 0;
  await pool.query('DELETE FROM messages WHERE phone IN ' + alvo, params);
  await pool.query('DELETE FROM eventos WHERE phone IN ' + alvo, params);
  await pool.query("DELETE FROM crm_config WHERE key IN (SELECT 'sess_' || phone FROM conversations WHERE " + cond + ')', params);
  await pool.query('DELETE FROM conversations WHERE ' + cond, params);
  ph.forEach(p => sessions.delete(p));
  return ph.length;
}
app.post('/painel/api/crm/:phone/excluir', async (req, res) => {
  try {
    const n = await apagarContatos('phone = $1', [String(req.params.phone)]);
    console.log('🗑️ Contato excluído do CRM: ' + req.params.phone + ' (' + n + ')');
    res.json({ ok: true, apagados: n });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
app.post('/painel/api/crmzerar', async (req, res) => {
  try {
    if ((req.body || {}).confirmar !== 'ZERAR') return res.status(400).json({ erro: 'Confirmação ausente.' });
    const n = await apagarContatos('TRUE', []);
    await pool.query("DELETE FROM eventos");
    console.log('🗑️ CRM zerado pelo painel: ' + n + ' contatos.');
    res.json({ ok: true, apagados: n });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
const CRM_EXTRA_JS = String.raw`(function(){
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{}),credentials:'include'}).then(function(r){return r.json();});}
var drawerOrig=window.drawer;
window.drawer=function(){
  drawerOrig();
  var db=document.querySelector('#drawer .db');if(!db||!window.aberto)return;
  var box=document.createElement('div');box.style.cssText='margin-top:22px;padding-top:14px;border-top:1px solid #e3ddcf';
  box.innerHTML='<button id="xdel" style="background:#fff;color:#b3261e;border:2px solid #b3261e;border-radius:12px;padding:11px 16px;font-weight:700;font-size:14px;cursor:pointer;width:100%">🗑 Excluir este contato e a conversa</button>';
  db.appendChild(box);
  var b=document.getElementById('xdel'),fase=0,tm;
  b.onclick=function(){
    if(!fase){fase=1;b.textContent='Toque de novo para confirmar (não dá para desfazer)';b.style.background='#b3261e';b.style.color='#fff';tm=setTimeout(function(){fase=0;b.textContent='🗑 Excluir este contato e a conversa';b.style.background='#fff';b.style.color='#b3261e';},5000);return;}
    clearTimeout(tm);b.disabled=true;b.textContent='Excluindo…';var p=String(window.aberto);
    post('/painel/api/crm/'+p+'/excluir').then(function(r){
      if(!r.ok){b.disabled=false;b.textContent='Não foi possível excluir';return;}
      window.dados.conversas=window.dados.conversas.filter(function(c){return String(c.phone)!==p;});
      window.fechar();window.render();toast('Contato excluído');
    }).catch(function(){b.disabled=false;b.textContent='Erro de conexão';});
  };
};
var sv=document.getElementById('salvar');
if(sv&&sv.parentNode){
  var z=document.createElement('div');z.style.cssText='margin-top:30px;padding:16px;border:2px solid #b3261e;border-radius:14px;background:#fff6f4';
  z.innerHTML='<b style="color:#b3261e">Zerar o CRM (começar as métricas do zero)</b><p style="margin:8px 0;font-size:13px">Apaga TODOS os contatos, cards do kanban, conversas salvas e avisos. Não dá para desfazer. Quem chamar depois entra como contato novo.</p><input id="zin" placeholder="Digite ZERAR para liberar" style="padding:10px;border:2px solid #d6d0c1;border-radius:10px;font-size:15px;width:100%;max-width:280px"> <button id="zbt" disabled style="margin-top:8px;background:#b3261e;color:#fff;border:0;border-radius:12px;padding:11px 16px;font-weight:700;opacity:.5">Apagar tudo</button>';
  sv.parentNode.parentNode.appendChild(z);
  var zi=document.getElementById('zin'),zb=document.getElementById('zbt');
  zi.oninput=function(){var ok=zi.value.trim()==='ZERAR';zb.disabled=!ok;zb.style.opacity=ok?1:.5;};
  zb.onclick=function(){zb.disabled=true;zb.textContent='Apagando…';post('/painel/api/crmzerar',{confirmar:'ZERAR'}).then(function(r){if(r.ok){window.dados.conversas=[];window.dados.eventos=[];window.render();toast('CRM zerado ('+r.apagados+' contatos)');zb.textContent='Apagar tudo';zi.value='';}else{zb.textContent='Erro';}});};
}
})();`;
app.get('/painel/crm-extra.js', (req, res) => { res.type('application/javascript').send(CRM_EXTRA_JS); });

setInterval(() => { rodarFollowups(); }, 5 * 60 * 1000);
app.rodarFollowups = rodarFollowups;

// ─── DESVIO DO FLUXO: respostas fora do esperado durante as etapas ───────────────
const ESTADOS_ETAPAS = ['para_quem', 'queixa', 'aguarda1', 'aguarda2', 'aguarda3', 'oferta'];
function detectarTopicoEtapa(text) {
  const t = semAcento(text).replace(/[^a-z0-9?\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const dig = t.match(/^(opcao |etapa |numero |passo )?([1-3])$/);
  if (dig) return { topico: ({ 1: 'proc', 2: 'recebe', 3: 'valores' })[dig[2]], rotulo: ({ 1: 'o procedimento', 2: 'o que você recebe', 3: 'as opções de agendamento' })[dig[2]] };
  if (t.split(' ').length > 9 && !t.includes('?')) return null; // relato longo: não é pergunta sobre etapa
  const mapa = [
    ['proc', /questionario/, 'o questionário'],
    ['proc', /quanto tempo|quantos dias|demora|prazo|dias uteis/, 'o prazo'],
    ['proc', /precisa estar|estar presente|presenca|presente/, 'a sua participação'],
    ['proc', /pdf|orientac/, 'as orientações'],
    ['proc', /estudo do caso|estudo/, 'o estudo do caso'],
    ['proc', /procediment|como funciona|como e feito|passo a passo/, 'o procedimento'],
    ['recebe', /relatorio|audio/, 'o relatório em áudios'],
    ['recebe', /reiki|limpeza|complemento|bonus/, 'o complemento do atendimento'],
    ['recebe', /equipe|acolhimento/, 'o acompanhamento da equipe'],
    ['recebe', /o que (eu )?(recebo|vou receber|ganho)|receber|inclui|incluso|investig|o que (voces )?(tratam|fazem)/, 'o que você recebe']
  ];
  for (const [topico, re, rotulo] of mapa) if (re.test(t)) return { topico, rotulo };
  return null;
}
function ehLixoEtapa(text) {
  const t = semAcento(text).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ehSim(text) || /^(nao|n|nope)$/.test(t)) return false;
  if (!t) return !/^(👍|🙏)/.test(text.trim());
  return t.length <= 2 || /^\d+$/.test(t);
}
function textoOferta(session) {
  const itens = [];
  if (!session.vistoProc) itens.push('os detalhes do procedimento');
  if (!session.vistoRecebe) itens.push('o que você recebe');
  if (!session.viuValores) itens.push('as opções de agendamento');
  if (!itens.length) return null;
  const lista = itens.length === 1 ? itens[0] : itens.slice(0, -1).join(', ') + ' ou ' + itens[itens.length - 1];
  return 'Gostaria que expliquemos também sobre ' + lista + '?';
}
async function explicarTopico(from, session, topico, rotulo, textoUsuario) {
  const enviados = [];
  const intro = 'Ok, vou lhe explicar com mais detalhes sobre ' + rotulo + '.';
  await sleep(1500); await sendMessage(from, intro); enviados.push(intro);
  const partes = (topico === 'proc' ? ETAPA1 : ETAPA2).slice(1); // sem o título da etapa
  for (const parte of partes) { await sleep(typingDelay(parte)); await sendMessage(from, parte); enviados.push(parte); }
  if (topico === 'proc') {
    session.vistoProc = true;
    await enviarPdf(from, session);
  } else session.vistoRecebe = true;
  const oferta = textoOferta(session);
  if (oferta) { session.etapa = 'oferta'; await sleep(typingDelay(oferta)); await sendMessage(from, oferta); enviados.push(oferta); }
  else { session.etapa = 'agenda'; await sleep(typingDelay(PERGUNTA_AGENDA)); await sendMessage(from, PERGUNTA_AGENDA); enviados.push(PERGUNTA_AGENDA); }
  session.history.push({ role: 'user', content: textoUsuario }, { role: 'assistant', content: enviados.join('\n\n') });
}
// Retorna true se tratou a mensagem; 'valores' se a pessoa quer os valores (o fluxo de valores segue); false para seguir o fluxo normal
async function desvioFluxo(from, text, session) {
  if (!ESTADOS_ETAPAS.includes(session.etapa)) return false;
  const emOferta = session.etapa === 'oferta';
  if (emOferta && ehSim(text)) {
    const prox = !session.vistoProc ? 'proc' : (!session.vistoRecebe ? 'recebe' : 'valores');
    if (prox === 'valores') return session.viuValores ? false : 'valores';
    session.etapa = 'oferta_andamento';
    await explicarTopico(from, session, prox, prox === 'proc' ? 'o procedimento' : 'o que você recebe', text);
    await upsertConversation(from, session.clientName, session.stage);
    return true;
  }
  const tp = detectarTopicoEtapa(text);
  if (tp) {
    if (tp.topico === 'valores') return session.viuValores ? false : 'valores';
    const ja = tp.topico === 'proc' ? session.vistoProc : session.vistoRecebe;
    session.etapa = 'oferta_andamento';
    await explicarTopico(from, session, tp.topico, tp.rotulo, text);
    await upsertConversation(from, session.clientName, session.stage);
    return true;
  }
  if (ehLixoEtapa(text)) {
    const agora = Date.now();
    if (session.ultimoLixo && agora - session.ultimoLixo < 20000) return true; // não responde em rajada
    session.ultimoLixo = agora;
    const msg = (session.etapa === 'para_quem' || session.etapa === 'queixa') ? 'Ok. ' + PERGUNTA_PARA_QUEM.split('\n')[0]
      : session.etapa === 'aguarda1' ? 'Ok. ' + PERGUNTA1
      : session.etapa === 'aguarda2' ? 'Ok. ' + PERGUNTA2
      : session.etapa === 'aguarda3' ? 'Ok. ' + PERGUNTA3
      : 'Ok. ' + (textoOferta(session) || PERGUNTA_AGENDA);
    await sleep(typingDelay(msg)); await sendMessage(from, msg);
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: msg });
    await upsertConversation(from, session.clientName, session.stage);
    return true;
  }
  return false;
}
// ─── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📡 Webhook em: http://localhost:${PORT}/webhook`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`🗂️  Painel em: http://localhost:${PORT}/painel`);
  });
});

module.exports = app;
