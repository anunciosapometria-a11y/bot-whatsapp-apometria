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
const REGRA_DESVIO = 'Analise o que a pessoa respondeu e responda com acolhimento em no máximo 2 mensagens curtas. Nunca explique as etapas por conta própria, nunca escreva "Etapa 1/2/3" nem envie vários textos seguidos. Termine voltando ao fluxo com sutileza: pergunte o motivo do atendimento ou ofereça explicar o trabalho (procedimento, o que você recebe, agendamento).';
function hintEtapa(etapa) {
  if (etapa === 'oferta') return 'ETAPA ATUAL: a pessoa ainda não respondeu à oferta de explicar outras partes do trabalho (procedimento, o que recebe, agendamento). ' + REGRA_DESVIO;
  if (etapa === 'aguarda2') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 2. Pergunta pendente: "' + PERGUNTA2 + '". ' + REGRA_DESVIO;
  if (etapa === 'aguarda3') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 3. Pergunta pendente: "' + PERGUNTA3 + '". ' + REGRA_DESVIO;
  if (etapa === 'nome') return 'ETAPA ATUAL: a pessoa ainda não disse o nome (pergunte uma única vez; se ela não disser, siga sem insistir). Ela respondeu algo que não é um nome. Responda de forma condizente ao que ela disse, em uma ou duas frases, sem tratar nenhuma palavra como nome, e peça o nome com gentileza no final. Não explique o trabalho nem envie valores ainda.';
  if (etapa === 'para_quem' || etapa === 'para_quem_andamento' || etapa === 'queixa') return 'ETAPA ATUAL: a pessoa acabou de responder para quem quer solicitar a apometria (e pode ter descrito o caso ou a queixa). Responda em uma ou duas frases curtas, com as palavras dela: se descreveu um problema ou queixa, explique brevemente como a apometria pode ser positiva para o caso dela (investigar a causa, tratar, trazer mais leveza e clareza, sem prometer cura); se disse só para quem é, acolha em uma frase (para outra pessoa, lembre que pode solicitar mesmo sem a permissão e a consciência dela). Não faça perguntas, não explique o procedimento nem fale de valores: o sistema envia as etapas logo em seguida.';
  return 'ETAPA ATUAL: etapas concluídas. Siga o passo 2 do fluxo.';
}

function buildSystemPrompt(clientName, etapa) {
  return `Você atende pelo WhatsApp em nome da equipe do Instituto Terapias Brasil, conduzido pelo terapeuta Paulo Rodrigues. Seu objetivo é acolher a pessoa, explicar com clareza e levá-la, sem pressão, até a decisão e o pagamento da sessão de apometria. Vendemos somente apometria. Se perguntarem por outra terapia, diga que no momento o atendimento é de apometria.

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
  - Emergencial: R$ 339,00, realização em até 8 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
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
O sistema já enviou o logo e a abertura, pediu o nome, respondeu "Agradecemos o seu contato, [nome]", explicou quem somos, enviou o Instagram @apometria_brasil e o perfil do Google Maps com as avaliações, e perguntou "Para quem você gostaria de solicitar a apometria?" com três exemplos (para você mesmo, para outra pessoa, para empresas, imóveis ou animais) e conduz sozinho a explicação em 3 etapas, com mensagens prontas e uma pergunta entre cada etapa: Etapa 1, detalhes do procedimento (questionário inicial, estudo do caso em 2 dias úteis, não precisa estar presente) e o PDF de orientações; Etapa 2, o que a pessoa recebe (itens tratados, relatório em áudios, complemento do lar e Reiki, equipe à disposição); Etapa 3, a foto de valores e formatos e a pergunta "Gostaria de realizar o seu agendamento?". Não repita esses textos e nunca envie uma etapa por conta própria: o sistema avança quando a pessoa responde sim. Você entra quando a pessoa responde outra coisa.

1) ENTRE AS ETAPAS. Se o bloco ETAPA ATUAL, no início, indicar uma pergunta pendente: se a pessoa contar o que quer trabalhar, acolha em uma ou duas frases, usando as palavras dela; se fizer outra pergunta, responda com os fatos em poucas frases; nos dois casos, termine repetindo a pergunta pendente de forma curta. Não envie o link do questionário agora: ele só vai depois do comprovante (passo 4), salvo se a pessoa pedir.

2) DEPOIS DA ETAPA 3 (valores já enviados). A foto com valores e formatos já foi enviada. Se a pessoa tirar dúvidas, responda com os fatos; só volte a "Gostaria de realizar o seu agendamento?" se ainda não a fez nas últimas mensagens, sem repetir a pergunta a cada resposta. Se pedir os valores de novo, envie [[FOTO:valores]] sozinho em uma mensagem, depois "|||" e a pergunta de agendamento. Se perguntar de um valor específico (ex.: quanto é o emergencial), responda em uma frase com o valor e o prazo, sem insistir na pergunta de agendamento. Quando a pessoa disser que quer agendar, vá ao passo 3. Se perguntar sobre o PDF de dúvidas de pagamento e agendamento, diga que será enviado em breve e siga o fluxo.

3) ESCOLHA E PAGAMENTO. Quando a pessoa quiser agendar, o pagamento do valor confirma o agendamento e libera a realização do trabalho. Se ela não disse qual modalidade quer (individual em 15 dias, emergencial em 8 dias, pacote familiar), pergunte em uma frase curta qual prefere, mostrando as opções. Com a escolha, envie os dados do Pix em uma mensagem, neste formato (sem emojis):
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
   - Primeira: agradeça, diga que recebemos e que vamos redirecionar o atendimento, e que agora enviamos o questionário inicial, que traz perguntas sobre ela e seus objetivos para o estudo do caso. Diga que pode complementar com áudios aqui na conversa.
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
- Cliente enviou um áudio (o sistema avisa com "[Cliente enviou um áudio]" e já guarda o áudio no atendimento dela). Agradeça com carinho, diga que o áudio foi salvo e será ouvido pelo Paulo e pela equipe como complemento do estudo do caso, e que ela pode mandar quantos quiser. Não tente interpretar o conteúdo, não pause o bot e siga o fluxo se ainda faltar algum passo.
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
Mensagem confusa: "Não entendemos bem. Pode escrever de outro jeito?" Áudio ou imagem fora do comprovante: "No momento atendemos por texto aqui. Pode escrever sua mensagem? 🙏"`;
}

// ─── MENSAGENS FIXAS ─────────────────────────────────────────────────────────
const ABERTURA_MSG = "*Olá, seja bem-vindo(a) ao Atendimento do Instituto Apometria Brasil.*\n\n📌 *Neste canal você encontra*\n• Detalhes do procedimento\n• Disponibilidade para agendamento\n\n✍️ *Para iniciarmos, qual é o seu nome, por gentileza?*";
const TITULO_MSG = "*Vamos explicar como funciona o nosso trabalho em 3 etapas:*\n\n1️⃣ Detalhes do procedimento\n2️⃣ O que você recebe\n3️⃣ Opções de agendamento";
const PERGUNTA_PARA_QUEM = "Para quem você gostaria de solicitar a apometria?\n\nPor exemplo:\n• Para você mesmo\n• Para outra pessoa\n• Para empresas, imóveis ou animais";
const QUEM_SOMOS_MSG = "🏛️ *Quem somos*\nSomos um instituto especializado na realização de trabalhos apométricos, cursos e terapias energéticas, coordenado pelo terapeuta *Paulo Rodrigues*.";
const INSTAGRAM_MSG = "📲 *Conheça mais do nosso trabalho*\nAcompanhe o nosso Instagram: *@apometria_brasil*\nhttps://www.instagram.com/apometria_brasil/";
const GOOGLE_MSG = "⭐ *Quem já foi atendido por nós*\nVeja as avaliações no nosso perfil do Google Maps:\nhttps://www.google.com/maps/place/?q=place_id:ChIJhaGCweWzvZQRLW5Xc6NECpA";
const PERGUNTA_QUEIXA = "Qual é a sua principal queixa, ou o que você mais gostaria de tratar com a apometria? Pode escrever do seu jeito, ou mandar um áudio.";
const CONTATO_PAULO_MSG = "Segue o contato do Paulo, para você já ter salvo:";
const ETAPA1 = [
  "*Etapa 1: detalhes do procedimento*",
  "📝 *Questionário inicial*\nPrimeiramente você irá preencher um questionário com as perguntas necessárias para o seu trabalho, sobre os seus estados físicos, mentais, espirituais e emocionais e sobre o que deseja tratar, investigar e obter respostas da espiritualidade.",
  "🔎 *Estudo do caso*\nDepois de colher as suas queixas, fazemos um estudo profundo com base nessas informações, para trabalhar da melhor maneira no seu caso. Solicitamos 2 dias úteis para concluir essa etapa.",
  "📍 *Não precisa estar presente*\nNão há necessidade de você estar presente no dia do trabalho. Somos de São José do Rio Preto, SP, e grande parte dos nossos trabalhos é realizada à distância, para todo o Brasil e exterior."
];
const PERGUNTA2 = "Podemos seguir para a etapa 2, com o que você recebe?";
const ETAPA2 = [
  "*Etapa 2: o que você recebe*",
  "📑 *O que investigamos e tratamos*\nRealizamos a apometria para atingir seus principais objetivos e, além disso, investigamos e tratamos:\n✓ Seres densos\n✓ Quebra de feitiços e magias\n✓ Retirada de implantes astrais\n✓ Miasmas e energias densas\n✓ Fractais energéticos\n✓ Vínculos com antepassados\n✓ Padrões familiares\n✓ Dissolução de carmas\n✓ Vidas passadas\n✓ Traumas do passado\n✓ Crenças limitantes\n✓ Harmonização dos chacras\n✓ Limpeza energética completa",
  "🗒️ *Relatório em áudios*\n• Enviamos ao final do trabalho um relatório minucioso, explicando o que foi encontrado e tratado.\n• Vão também as orientações e as mensagens deixadas para você pelas equipes espirituais.\n• Os áudios são enviados pelo próprio apômetra Paulo Rodrigues, dirigente do instituto.",
  "✨ *Complemento do primeiro atendimento*\n• Limpeza energética do endereço do seu lar\n• Envio de Reiki à distância\nSem custo adicional.",
  "🤝 *Equipe à disposição*\nDepois do tratamento, a equipe fica disponível para acolhimento pessoal e para as dúvidas que surgirem, de forma gratuita."
];
const PDF_MSG = "📎 *Orientações gerais*\nLogo abaixo segue um PDF com orientações, instruções importantes, dúvidas frequentes e o que pode ser solicitado no trabalho.";
const PERGUNTA3 = "Podemos seguir para a etapa 3, com as opções de agendamento?";
const ETAPA3_TITULO = "*Etapa 3: opções de agendamento*";
const ETAPA3_NOTA = "*Para confirmar o agendamento*\nBasta efetuar o pagamento e enviar o comprovante.";
const APOS_PAGAMENTO_MSG = "*O que acontece após o pagamento*\n• Você irá receber algumas instruções e o questionário inicial para preenchimento.\n• A equipe entrará no processo de estudo e elaboração do seu trabalho.\n• No momento do envio dos relatórios finais, o Paulo entrará em contato através do número pessoal dele.";
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
  await saveMessage(to, 'out', text);
  crmSaida(to, text);
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: /instagram\.com|google\.com\/maps/.test(text) }
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

// ─── ENVIAR IMAGEM VIA WHATSAPP API (logo na abertura) ────────────────────────
async function sendImage(to, imageUrl, caption) {
  if (!imageUrl) return;
  try {
    await axios.post(
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
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'document', document: { link, filename } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    await saveMessage(to, 'out', `[documento: ${filename}]`);
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

Apometria à distância, individual, entrega em até 15 dias úteis: R$ 289,00
Emergencial, vaga de prioridade em até 8 dias úteis: R$ 339,00
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
    if (fm) {
      await sleep(3500);
      await enviarFoto(to, fm[1]);
      const resto = parts[i].replace(fm[0], '').trim();
      if (resto) { await sleep(typingDelay(resto)); await sendMessage(to, resto); }
      continue;
    }
    if (i > 0 && parts[i].length > 500) await sleep(5000);
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
      system: buildSystemPrompt(session.clientName, session.etapa),
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
function handleMessage(from, messageText, mediaInfo = null) {
  const anterior = filas.get(from) || Promise.resolve();
  const p = anterior.catch(() => {}).then(() => handleMessageInner(from, messageText, mediaInfo));
  filas.set(from, p);
  p.catch(() => {}).then(() => { if (filas.get(from) === p) filas.delete(from); });
  return p;
}
async function handleMessageInner(from, messageText, mediaInfo = null) {
  const session = getSession(from);
  let text = messageText.trim();

  console.log(`📩 Mensagem de ${from}: "${text}" | Estágio: ${session.stage}`);

  if (mediaInfo) {
    const midia = await baixarMidiaWhatsapp(mediaInfo.id);
    await saveMessage(from, 'in', text, midia?.base64 || null, midia?.mime || mediaInfo.mimeType || null);
  } else {
    await saveMessage(from, 'in', text);
  }
  await upsertConversation(from, session.clientName, session.stage);
  await crmEntrada(from, mediaInfo, session);

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

  { const dv = await desvioFluxo(from, text, session); if (dv === true) return; if (dv === 'valores') text = 'quero ver os valores'; }
  // Quebra de fluxo: perguntou os valores antes da hora -> mostra os valores como se tivesse chegado lá, sem falar de etapa
  const pedeValoresFirme = pedeValores(text) && !/quanto tempo|quantos dias|quanto demora|prazo|demora/.test(semAcento(text));
  if (!session.viuValores && !session.valoresEmAndamento && pedeValoresFirme &&
      (session.stage === 'aguardando_nome' || session.etapa === 'para_quem' || session.etapa === 'queixa' || session.etapa === 'aguarda2' || session.etapa === 'aguarda3' || session.etapa === 'oferta')) {
    session.valoresEmAndamento = true;
    session.stage = 'conversa';
    session.pediuNome = true;
    session.viuValores = true;
    session.etapa = 'mais_detalhes';
    try {
      await sleep(2500);
      const intro = 'Claro! Seguem os valores e as opções de atendimento.';
      await sendMessage(from, intro);
      await sleep(2500);
      await enviarFoto(from, 'valores');
      for (const m of [ETAPA3_NOTA, APOS_PAGAMENTO_MSG, CONTATO_PAULO_MSG]) { await sleep(typingDelay(m)); await sendMessage(from, m); }
      await sleep(1200); await sendContact(from);
      const itens = [];
      if (!session.vistoProc) itens.push('🔎 *Detalhes do procedimento*');
      if (!session.vistoRecebe) itens.push('✨ *O que você recebe*');
      let fim;
      if (itens.length) {
        fim = 'Se quiser, posso te explicar também:\n\n' + itens.join('\n') + '\n\nOu, se preferir, já podemos seguir para o seu agendamento. 😊';
      } else {
        fim = PERGUNTA_AGENDA;
        session.etapa = null;
      }
      await sleep(typingDelay(fim));
      await sendMessage(from, fim);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [intro, '[foto com os valores e formatos enviada]', ETAPA3_NOTA, APOS_PAGAMENTO_MSG, CONTATO_PAULO_MSG, '[cartão de contato do Paulo enviado]', fim].join('\n\n') }
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
          const pdfOk = fs.existsSync(path.join(MEDIA_DIR, 'Orientacoes-Apometria-Brasil.pdf'));
          await sleep(typingDelay(PDF_MSG));
          await sendMessage(from, PDF_MSG);
          if (pdfOk) await sendDocument(from, PUBLIC_BASE + '/media/Orientacoes-Apometria-Brasil.pdf', 'Orientacoes-Apometria-Brasil.pdf');
        } else session.vistoRecebe = true;
      }
      let fim;
      if (!session.vistoProc) { fim = 'Quer ver também os *detalhes do procedimento*?'; session.etapa = 'mais_detalhes'; }
      else if (!session.vistoRecebe) { fim = 'Quer ver também o que você recebe?'; session.etapa = 'mais_detalhes'; }
      else { fim = PERGUNTA_AGENDA; session.etapa = null; }
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
    const eraPrimeira = session.etapa === 'para_quem';
    session.etapa = 'para_quem_andamento'; // trava antes dos awaits (mensagens em rajada)
    const respQuem = await processWithClaude(session, text);
    await sendClaudeResponse(from, respQuem, session);
    if (session.pausado) { session.etapa = 'aguarda2'; await upsertConversation(from, session.clientName, session.stage); return; }
    if (eraPrimeira && text.split(/\s+/).filter(Boolean).length <= 6) {
      // Resposta curta (só para quem é): pergunta a queixa e espera antes de explicar as etapas
      session.etapa = 'queixa';
      await sleep(typingDelay(PERGUNTA_QUEIXA));
      await sendMessage(from, PERGUNTA_QUEIXA);
      session.history.push({ role: 'assistant', content: PERGUNTA_QUEIXA });
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
    session.etapa = 'aguarda2';
    session.vistoProc = true;
    for (const parte of [TITULO_MSG, ...ETAPA1]) {
      await sleep(typingDelay(parte));
      await sendMessage(from, parte);
    }
    const pdfOk = fs.existsSync(path.join(MEDIA_DIR, 'Orientacoes-Apometria-Brasil.pdf'));
    await sleep(typingDelay(PDF_MSG));
    await sendMessage(from, PDF_MSG);
    if (pdfOk) await sendDocument(from, `${PUBLIC_BASE}/media/Orientacoes-Apometria-Brasil.pdf`, 'Orientacoes-Apometria-Brasil.pdf');
    await sleep(typingDelay(PERGUNTA2));
    await sendMessage(from, PERGUNTA2);
    session.history.push({ role: 'assistant', content: [TITULO_MSG, ...ETAPA1, PDF_MSG, PERGUNTA2].join('\n\n') });
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.etapa === 'aguarda2' || session.etapa === 'aguarda3') {
    const querValores = pedeValores(text);
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
      await sleep(typingDelay(ETAPA3_NOTA));
      await sendMessage(from, ETAPA3_NOTA);
      await sleep(typingDelay(APOS_PAGAMENTO_MSG));
      await sendMessage(from, APOS_PAGAMENTO_MSG);
      await sleep(typingDelay(CONTATO_PAULO_MSG));
      await sendMessage(from, CONTATO_PAULO_MSG);
      await sleep(1200);
      await sendContact(from);
      await sleep(typingDelay(PERGUNTA_AGENDA));
      await sendMessage(from, PERGUNTA_AGENDA);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [ETAPA3_TITULO, '[foto com os valores e formatos enviada]', ETAPA3_NOTA, APOS_PAGAMENTO_MSG, CONTATO_PAULO_MSG, '[cartão de contato do Paulo enviado]', PERGUNTA_AGENDA].join('\n\n') }
      );
      await upsertConversation(from, session.clientName, session.stage);
      return;
    }
  }

  if (session.stage === 'aguardando_relato') session.stage = 'conversa';

  const response = await processWithClaude(session, text);
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
        if (!value?.messages) continue;

        for (const message of value.messages) {
          const from = message.from;

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
function autenticarPainel(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    return res.status(503).send('Painel não configurado. Defina DASHBOARD_USER e DASHBOARD_PASSWORD no Railway.');
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Apometria"');
    return res.status(401).send('Login necessário.');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user !== DASHBOARD_USER || pass !== DASHBOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Apometria"');
    return res.status(401).send('Usuário ou senha incorretos.');
  }
  next();
}

app.use('/painel', autenticarPainel);

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
const RANK = { novo: 0, explicacao: 1, valores: 2, comprovante: 3, pago: 4, questionario: 5 };
const FUNIL_ROTULO = {
  novo: 'Novo contato', explicacao: 'Em explicação', valores: 'Viu os valores',
  comprovante: 'Comprovante recebido', pago: 'Pago / confirmado', questionario: 'Questionário respondido',
  paulo: 'Com o Paulo', sem_resposta: 'Sem resposta', perdido: 'Perdido'
};
const FOLLOWUP_HORAS = [3, 28, 52]; // horas desde a última mensagem da pessoa
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
    "comprovante_at TIMESTAMPTZ", "questionario_at TIMESTAMPTZ", "notas TEXT"
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
    else if (session.pausado) novo = 'paulo';
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
  const templateTipo = await cfgGet('alerta_template_' + tipo, '');
  const template = templateTipo || await cfgGet('alerta_template', process.env.ALERTA_TEMPLATE || '');
  for (const n of numeros) {
    try {
      if (templateTipo) await enviarTemplate(n, templateTipo, [quem, detalhe || '-']);
      else if (template) await enviarTemplate(n, template, [rotulos[tipo] || tipo, quem, detalhe || '-']);
      else await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', to: n, type: 'text', text: { body: texto } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
      console.log('🔔 Aviso enviado para ' + n + ': ' + tipo);
    } catch (e) { console.error('❌ Aviso para ' + n + ':', e.response?.data || e.message); }
  }
}

// Mensagem recebida: zera o contador de follow-up e trata comprovante
async function crmEntrada(phone, mediaInfo, session) {
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
    if (mediaInfo && mediaInfo.tipo === 'audio') {
      await crmEvento(phone, 'audio', 'Áudio do cliente salvo (complemento do trabalho)');
    } else if (mediaInfo && (RANK[atual] ?? -1) < RANK.comprovante) {
      await pool.query("UPDATE conversations SET funil = 'comprovante', comprovante_at = now() WHERE phone = $1", [phone]);
      await crmAlertar('comprovante', phone, 'Comprovante/imagem recebido. Conferir o pagamento.', session.clientName);
    }
  } catch (e) { console.error('❌ CRM entrada:', e.message); }
}
async function crmSaida(phone, texto) {
  if (!pool) return;
  if (texto && /17988271998|mpago\.li/i.test(texto)) {
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
        if (horasSilencio < 23) {
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
        alerta_templates: { novo_contato: await cfgGet('alerta_template_novo_contato', ''), saiu_do_fluxo: await cfgGet('alerta_template_saiu_do_fluxo', ''), pagamento_solicitado: await cfgGet('alerta_template_pagamento_solicitado', ''), comprovante: await cfgGet('alerta_template_comprovante', ''), questionario: await cfgGet('alerta_template_questionario', '') },
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

app.get('/painel/crm', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>CRM — Instituto Apometria Brasil</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{margin:0;font-family:system-ui,sans-serif;background:#f6f3ee;color:#2b2620}
 header{background:#fff;border-bottom:1px solid #e0d8c9;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
 header a{color:#7a4d8c;text-decoration:none;font-size:14px} h1{font-size:17px;margin:0}
 main{padding:18px 22px;max-width:1300px;margin:auto}
 #cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
 .card{background:#fff;border:1px solid #e0d8c9;border-radius:10px;padding:10px 14px;min-width:120px;cursor:pointer}
 .card.ativo{border-color:#7a4d8c;background:#efe6f2}.card b{font-size:22px;display:block}.card span{font-size:12px;color:#6b6153}
 .grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
 .box{background:#fff;border:1px solid #e0d8c9;border-radius:10px;padding:14px;margin-bottom:16px}
 .box h2{font-size:14px;margin:0 0 10px}
 table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#8a7f6d;font-size:11px;text-transform:uppercase;padding:6px}
 td{padding:7px 6px;border-top:1px solid #f0ece3;vertical-align:top}
 select,input,textarea{font:inherit;font-size:13px;border:1px solid #d8cdb8;border-radius:6px;padding:5px}
 textarea{width:100%;box-sizing:border-box} button{background:#7a4d8c;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px}
 .ev{font-size:13px;padding:6px 0;border-top:1px solid #f0ece3}.ev small{color:#8a7f6d;display:block}
 .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:10px;background:#efe6f2}
 .tag.comprovante,.tag.pago{background:#dff3e3}.tag.paulo{background:#fde8c8}.tag.sem_resposta,.tag.perdido{background:#eee}
 label.sw{font-size:13px;display:flex;gap:8px;align-items:center;margin-bottom:10px}
</style></head><body>
<header><h1>CRM — Instituto Apometria Brasil</h1><a href="/painel">← Conversas</a></header>
<main>
 <div id="cards"></div>
 <div class="grid">
  <div class="box"><h2>Leads</h2><div style="overflow-x:auto"><table><thead><tr><th>Nome</th><th>Etapa</th><th>Último contato</th><th>Follow-ups</th><th>Notas</th></tr></thead><tbody id="linhas"></tbody></table></div></div>
  <div>
   <div class="box"><h2>Avisos recentes</h2><div id="eventos"></div></div>
   <div class="box"><h2>Follow-up automático</h2>
    <label class="sw"><input type="checkbox" id="fuAtivo"> Enviar follow-ups (3 mensagens em 3 dias, das 8h às 20h)</label>
    <div id="fuTextos"></div>
    <p style="font-size:12px;color:#6b6153">Use {nome}. Depois de 24h sem resposta, o WhatsApp só permite mensagem modelo (template) aprovada: informe o nome de cada uma abaixo.</p>
    <div id="fuTpl"></div>
   </div>
   <div class="box"><h2>Avisos para a equipe</h2>
    <label style="font-size:12px">Números (com DDI, separados por vírgula)</label><input id="alNum" style="width:100%;box-sizing:border-box;margin-bottom:8px">
    <label style="font-size:12px">Template: novo contato (2 variáveis: pessoa, detalhe)</label><input id="alTplN" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <label style="font-size:12px">Template: conversa saiu do fluxo (2 variáveis)</label><input id="alTplS" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <label style="font-size:12px">Template: Pix ou cartão solicitado (2 variáveis)</label><input id="alTplP" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <label style="font-size:12px">Template: comprovante recebido (2 variáveis)</label><input id="alTplC" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <label style="font-size:12px">Template: questionário respondido (2 variáveis)</label><input id="alTplQ" style="width:100%;box-sizing:border-box">
    <p style="margin:10px 0 0"><button id="salvar">Salvar configurações</button> <span id="ok" style="font-size:12px;color:#2f7d46"></span></p>
   </div>
  </div>
 </div>
</main>
<script>
var dados=null,filtro='todos';
function ago(d){if(!d)return '—';var m=Math.round((Date.now()-new Date(d))/60000);if(m<60)return m+' min';if(m<1440)return Math.round(m/60)+' h';return Math.round(m/1440)+' d';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function api(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();});}
function render(){
 var rot=dados.rotulos,cont={};dados.conversas.forEach(function(c){cont[c.funil]=(cont[c.funil]||0)+1;});
 var h='<div class="card '+(filtro==='todos'?'ativo':'')+'" data-f="todos"><b>'+dados.conversas.length+'</b><span>Todos</span></div>';
 Object.keys(rot).forEach(function(k){h+='<div class="card '+(filtro===k?'ativo':'')+'" data-f="'+k+'"><b>'+(cont[k]||0)+'</b><span>'+rot[k]+'</span></div>';});
 document.getElementById('cards').innerHTML=h;
 document.querySelectorAll('.card').forEach(function(e){e.onclick=function(){filtro=e.dataset.f;render();};});
 var l='';dados.conversas.filter(function(c){return filtro==='todos'||c.funil===filtro;}).forEach(function(c){
  var opts=Object.keys(rot).map(function(k){return '<option value="'+k+'"'+(k===c.funil?' selected':'')+'>'+rot[k]+'</option>';}).join('');
  l+='<tr><td><b>'+esc(c.client_name||'Sem nome')+'</b><br><a href="https://wa.me/'+c.phone+'" target="_blank" style="font-size:12px">+'+c.phone+'</a>'+(c.pausado?' <span class="tag paulo">pausado</span>':'')+'</td>'
   +'<td><select data-p="'+c.phone+'" class="fn">'+opts+'</select></td>'
   +'<td>'+ago(c.last_in_at)+'<br><small style="color:#8a7f6d">enviado há '+ago(c.last_out_at)+'</small></td>'
   +'<td>'+c.followups_sent+'/3<br><label style="font-size:11px"><input type="checkbox" class="fo" data-p="'+c.phone+'"'+(c.followup_off?' checked':'')+'> parar</label></td>'
   +'<td><textarea rows="2" class="nt" data-p="'+c.phone+'">'+esc(c.notas)+'</textarea></td></tr>';});
 document.getElementById('linhas').innerHTML=l||'<tr><td colspan="5" style="color:#8a7f6d;padding:20px">Nenhuma conversa nesta etapa.</td></tr>';
 document.querySelectorAll('.fn').forEach(function(e){e.onchange=function(){api('/painel/api/crm/'+e.dataset.p,{funil:e.value}).then(load);};});
 document.querySelectorAll('.fo').forEach(function(e){e.onchange=function(){api('/painel/api/crm/'+e.dataset.p,{followup_off:e.checked});};});
 document.querySelectorAll('.nt').forEach(function(e){e.onblur=function(){api('/painel/api/crm/'+e.dataset.p,{notas:e.value});};});
 document.getElementById('eventos').innerHTML=dados.eventos.map(function(v){return '<div class="ev"><b>'+esc(v.tipo)+'</b> — '+esc(v.client_name||v.phone)+'<small>'+esc(v.detalhe||'')+' · há '+ago(v.created_at)+'</small></div>';}).join('')||'<div style="color:#8a7f6d;font-size:13px">Nenhum aviso ainda.</div>';
}
var primeira=true;
function load(){fetch('/painel/api/crm').then(function(r){return r.json();}).then(function(d){dados=d;render();if(primeira){primeira=false;
 document.getElementById('fuAtivo').checked=d.config.followup_ativo;
 document.getElementById('fuTextos').innerHTML=d.config.followup_textos.map(function(t,i){return '<label style="font-size:12px">Mensagem '+(i+1)+'</label><textarea rows="3" class="ft">'+esc(t)+'</textarea>';}).join('');
 document.getElementById('fuTpl').innerHTML=d.config.followup_templates.map(function(t,i){return '<label style="font-size:12px">Template da mensagem '+(i+1)+'</label><input class="ftp" style="width:100%;box-sizing:border-box;margin-bottom:6px" value="'+esc(t)+'">';}).join('');
 document.getElementById('alNum').value=d.config.alerta_numeros||'';var at=d.config.alerta_templates||{};document.getElementById('alTplC').value=at.comprovante||'';document.getElementById('alTplN').value=at.novo_contato||'';document.getElementById('alTplP').value=at.pagamento_solicitado||'';document.getElementById('alTplS').value=at.saiu_do_fluxo||'';document.getElementById('alTplQ').value=at.questionario||'';}});}
document.getElementById('salvar').onclick=function(){
 api('/painel/api/crm/config',{followup_ativo:document.getElementById('fuAtivo').checked,
  followup_textos:Array.prototype.map.call(document.querySelectorAll('.ft'),function(e){return e.value;}),
  followup_templates:Array.prototype.map.call(document.querySelectorAll('.ftp'),function(e){return e.value;}),
  alerta_numeros:document.getElementById('alNum').value,alerta_templates:{novo_contato:document.getElementById('alTplN').value,pagamento_solicitado:document.getElementById('alTplP').value,comprovante:document.getElementById('alTplC').value,saiu_do_fluxo:document.getElementById('alTplS').value,questionario:document.getElementById('alTplQ').value}}).then(function(){document.getElementById('ok').textContent='Salvo.';setTimeout(function(){document.getElementById('ok').textContent='';},2500);});};
load();setInterval(function(){fetch('/painel/api/crm').then(function(r){return r.json();}).then(function(d){dados=d;render();});},20000);
</script></body></html>`);
});

setInterval(() => { rodarFollowups(); }, 5 * 60 * 1000);
app.rodarFollowups = rodarFollowups;

// ─── DESVIO DO FLUXO: respostas fora do esperado durante as etapas ───────────────
const ESTADOS_ETAPAS = ['para_quem', 'queixa', 'aguarda2', 'aguarda3', 'oferta'];
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
  return 'Gostaria que eu explique também sobre ' + lista + '?';
}
async function explicarTopico(from, session, topico, rotulo, textoUsuario) {
  const enviados = [];
  const intro = 'Ok, vou lhe explicar com mais detalhes sobre ' + rotulo + '.';
  await sleep(1500); await sendMessage(from, intro); enviados.push(intro);
  const partes = (topico === 'proc' ? ETAPA1 : ETAPA2).slice(1); // sem o título da etapa
  for (const parte of partes) { await sleep(typingDelay(parte)); await sendMessage(from, parte); enviados.push(parte); }
  if (topico === 'proc') {
    session.vistoProc = true;
    if (!session.pdfEnviado) {
      session.pdfEnviado = true;
      const pdfOk = fs.existsSync(path.join(MEDIA_DIR, 'Orientacoes-Apometria-Brasil.pdf'));
      await sleep(typingDelay(PDF_MSG)); await sendMessage(from, PDF_MSG);
      if (pdfOk) await sendDocument(from, PUBLIC_BASE + '/media/Orientacoes-Apometria-Brasil.pdf', 'Orientacoes-Apometria-Brasil.pdf');
    }
  } else session.vistoRecebe = true;
  const oferta = textoOferta(session);
  if (oferta) { session.etapa = 'oferta'; await sleep(typingDelay(oferta)); await sendMessage(from, oferta); enviados.push(oferta); }
  else { session.etapa = null; await sleep(typingDelay(PERGUNTA_AGENDA)); await sendMessage(from, PERGUNTA_AGENDA); enviados.push(PERGUNTA_AGENDA); }
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
    const msg = (session.etapa === 'para_quem' || session.etapa === 'queixa')
      ? 'Entendi. Se preferir, conte com as suas palavras o motivo pelo qual você procura o atendimento, ou posso te explicar como o nosso trabalho funciona. Gostaria de receber mais detalhes sobre o procedimento?'
      : 'Entendi. Gostaria de receber mais detalhes sobre o procedimento? Se preferir, também pode me contar com as suas palavras o motivo do atendimento.';
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
