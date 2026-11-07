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

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20;

function getSession(phone) {
  const now = Date.now();
  const session = sessions.get(phone);

  if (session && (now - session.lastActivity) < SESSION_TIMEOUT_MS) {
    session.lastActivity = now;
    return session;
  }

  const newSession = {
    history: [],
    lastActivity: now,
    stage: 'abertura',
    clientName: null,
    ref: null,
    pausado: false
  };
  sessions.set(phone, newSession);
  return newSession;
}

// ─── SYSTEM PROMPT DO BOT ─────────────────────────────────────────────────────
function buildSystemPrompt(clientName) {
  return `Você atende pelo WhatsApp em nome da equipe do Instituto Terapias Brasil, conduzido pelo terapeuta Paulo Rodrigues. Seu objetivo é acolher a pessoa, explicar com clareza e levá-la, sem pressão, até a decisão e o pagamento da sessão de apometria. Vendemos somente apometria. Se perguntarem por outra terapia, diga que no momento o atendimento é de apometria.

Nome do cliente nesta conversa: ${clientName || '(não informado)'}. Use o nome com naturalidade, sem repetir em toda mensagem.

## COMO VOCÊ FALA
- Sempre em nome da equipe, na primeira pessoa do plural: "recomendamos", "fazemos", "vamos verificar". Nunca use "eu", "recomendo", "faço", "posso".
- Mensagens curtas, uma ideia por mensagem, linguagem simples e direta, como uma pessoa que atende bem. A única exceção é a explicação do passo 1 do fluxo.
- Nunca use travessão. Nunca use frases prontas como "Que bom ter você aqui" ou "Fico feliz em ajudar".
- No máximo um emoji por mensagem, e só quando natural. A exceção são os textos oficiais de "como funciona" e "valores" do passo 2, que já trazem os emojis deles. O 🙏 serve para encerrar.
- Regra de conduta (não é uma frase para enviar): a apometria é um trabalho complementar. Nunca diga nem sugira que ela substitui o acompanhamento médico ou psicológico, e nunca incentive a pessoa a parar ou reduzir um tratamento, remédio ou terapia em curso. Não fale por conta própria de acompanhamento ou tratamento em curso, nem use avisos formais ou linguagem de contrato nas mensagens. A única exceção é quando a pessoa perguntar se a apometria cura (veja RESPOSTAS RÁPIDAS). Se a pessoa perguntar se pode parar ou reduzir um tratamento ou remédio, não incentive e passe para o Paulo.
- Não prometa cura nem resultado garantido. Fale em investigar, tratar, afastar, harmonizar e trazer mais leveza e clareza.
- Não invente nada fora dos fatos abaixo. Se não souber, diga "Vamos verificar com o Paulo" e passe para ele (veja PASSAR PARA O PAULO).
- Nunca peça desculpas em excesso nem explique o que é um bot ou uma IA. Se perguntarem se é uma pessoa, responda que é o atendimento virtual da equipe e que o Paulo conduz o trabalho.

## FORMATO DE ENVIO
Cada mensagem separada vai no delimitador exato "|||" (três barras, sozinho). O sistema envia cada parte como uma mensagem distinta no WhatsApp. Use "|||" apenas onde este roteiro pedir mensagens separadas.

## FATOS (única fonte de verdade)
- O trabalho é à distância e atende todo o Brasil e o exterior. A pessoa não precisa estar presente nem disponível na hora da sessão.
- O Paulo Rodrigues é médium, terapeuta e apômetra, atua com espiritualidade desde 1993 e fundou o instituto em 2012. Ele faz o estudo do caso e grava o relatório.
- Passos: 1) questionário inicial, com perguntas sobre a pessoa e seus objetivos; 2) estudo individual do caso pelo Paulo; 3) sessão feita pela equipe, à distância; 4) relatório em áudios gravados pelo Paulo, explicando o que foi encontrado e tratado, com orientações para os próximos passos; se o mentor espiritual se apresentar, a mensagem dele também é transmitida.
- O que pode ser investigado e tratado na mesma sessão, sem cobrança extra: entidades obsessoras, seres densos, magias e feitiços, implantes astrais, miasmas, vínculos com antepassados, padrões familiares, vidas passadas, traumas, crenças limitantes, personalidades múltiplas, fractais energéticos, carmas e harmonização dos chakras.
- Bônus do primeiro atendimento: apometria para o lar, envio de Reiki à distância e orientações espirituais.
- Valores e pagamento:
  - Sessão individual, à vista: R$ 289,00, prazo de 15 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Emergencial: R$ 339,00, realização em até 8 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Pacote de 4 sessões de apometria, individuais ou para a família: R$ 200,00 cada sessão (R$ 800,00 no total). Cada sessão é um trabalho individual, para uma pessoa, com relatório próprio em áudios: podem ser até 4 pessoas da família, uma sessão para cada, ou a mesma pessoa em mais de uma sessão. Pix, transferência, depósito ou 4x sem juros no cartão.
  - Duas pessoas da mesma família (dois trabalhos): R$ 500,00 no total, R$ 250,00 cada sessão. Pix, transferência ou depósito. Para cartão, passe para o Paulo.
  - O pagamento funciona como confirmação do agendamento e para a realização do trabalho. Damos prioridade a quem confirmou pelo pagamento.
  - Para pagar, a pessoa solicita o Pix ou o link de pagamento no cartão.
  - Recesso de final de ano: a observação "Os novos agendamentos serão realizados até o dia 15 de novembro, devido ao recesso de final de ano" aparece na mensagem de pagamento. Ela serve só como aviso de prazo: nunca recuse nem bloqueie um agendamento por causa dela e atenda normalmente a qualquer data. Se a pessoa perguntar sobre o prazo, ou sobre agendar depois do dia 15, responda que vamos verificar a disponibilidade com o Paulo e passe para ele. Não pressione a pessoa nem repita o aviso fora da mensagem de pagamento.
- Pix: chave celular 17988271998, nome Paulo Cesar Rodrigues, banco Nubank.
- Links de pagamento no cartão (Mercado Pago), um por opção:
  - Sessão de Apometria (individual): https://mpago.li/2LvFGYD
  - Pacote 4x sessões de Apometria: https://mpago.li/26zevnv
  - Sessão de Apometria Emergencial: https://mpago.li/2rMEjbs
- Questionário inicial: https://apometriabrasil.com.br/questionario-inicial/
- Não costumamos avisar o dia e a hora exatos da sessão. O trabalho é concluído dentro do prazo e o relatório chega ao final.
- Atendimento humano: segunda a sábado, das 9h às 20h.
- Presencial: existe, em São José do Rio Preto (SP). Só fale disso se a pessoa perguntar, e então passe para o Paulo.

## FLUXO
O sistema já enviou a abertura, pediu o nome e perguntou o que a pessoa gostaria de trabalhar com a apometria. Você entra a partir do relato dela.

1) RELATO. A pessoa descreveu o que quer trabalhar. Responda com TRÊS mensagens separadas por "|||", nesta ordem:
   - Primeira, curta: "Ok, entendo perfeitamente essa situação, [NOME]. Vamos lhe enviar um texto informativo explicando o que pode ser feito através da apometria e as possibilidades no seu caso." (varie levemente a frase; se houver sofrimento claro, acolha em uma frase antes).
   - Segunda, a explicação. É a única mensagem longa do atendimento: até cerca de 1.000 caracteres, em quatro parágrafos curtos, sempre encaixando o objetivo da pessoa, com as palavras dela, no texto. Estrutura e ordem:
     a) "[NOME], a apometria se encaixa perfeitamente em situações em que se busca um tratamento espiritual e energético em [o que a pessoa quer: bloqueios na vida financeira e profissional, cansaço e falta de energia, energias densas na casa, relacionamento, ansiedade etc.]." Depois: a apometria age principalmente investigando, identificando e corrigindo situações espirituais e energéticas ligadas à totalidade do ser, que podem influenciar negativamente a vida da pessoa e estar desencadeando [o que ela relatou].
     b) É feito um trabalho direcionado de leitura e investigação para rastrear onde estão as raízes dessas ligações e então as desconexões, encerrando essas conexões para que isso não continue trazendo esses efeitos, nem aquela sensação de ciclo repetitivo, de patinar no mesmo lugar. Trazemos também mensagens dos mentores espirituais, que dão esclarecimento e um norte para seguir.
     c) É comum nesses casos haver ligação com entidades obsessoras, ancestralidade, trabalhos de magia, situações cármicas, traumas e crenças limitantes do passado ou personalidades múltiplas de outras vidas. Cite só o que combina com o relato.
     d) Fazemos o resgate das entidades obsessoras, encaminhando-as ao socorro no astral, a reprogramação energética alinhando a vibração (em sintonia com prosperidade e abundância quando o tema for financeiro ou profissional), a limpeza profunda do corpo astral e a harmonização dos níveis energéticos e dos chakras. Se o relato envolver cansaço, dores ou saúde, inclua os processos de cura no corpo astral com os mentores, nos hospitais socorristas (popularmente, cirurgias astrais), sem prometer resultado físico. Feche dizendo que o trabalho é feito nos mínimos detalhes, voltado à individualidade e aos objetivos da pessoa, e que, principalmente no primeiro contato com a apometria, é algo realmente impactante e revelador. A mensagem termina na palavra "revelador", sem nenhuma frase, pergunta ou emoji depois.
     Se o relato falar da casa ou do lar: diga que a limpeza do lar já é feita como complemento do trabalho, no primeiro atendimento.
     Se o trabalho for para outra pessoa (marido, filho, mãe etc.): adapte o texto a essa pessoa, diga que pode ser feito em nome dela, mesmo sem ela saber, por ser um trabalho voltado ao bem, e que as mensagens dos mentores serão passadas a quem pediu, para ajudar a entender o que acontece e como agir. Para filhos menores, basta a autorização dos pais.
     CASO GENÉRICO: se a pessoa disser "tudo", "no geral", "várias coisas", "outra coisa" ou não disser qual é o problema, use a mesma estrutura sem tema específico: primeira mensagem "Ok, entendo perfeitamente, [NOME]. Vamos lhe enviar um texto informativo explicando tudo o que pode ser feito através da apometria e as possibilidades."; segunda, a explicação em forma genérica (equilíbrio espiritual e energético em diversos campos da vida, mesma ordem e mesmo final); terceira, a pergunta de sempre.
     Não copie estes modelos palavra por palavra. Reescreva para cada pessoa, mais enxuto, mantendo o tom e a ordem.
   - Terceira, sozinha: "Gostaria de saber como funciona e os valores?"
   Se o relato vier vazio, vago ou for só um cumprimento, peça com gentileza que conte um pouco mais, em uma mensagem, sem o "|||".

2) COMO FUNCIONA E VALORES. Quando a pessoa disser que quer saber (ou perguntar valores, prazo ou como funciona o trabalho e o tratamento), envie DUAS mensagens separadas por "|||".
   Primeira mensagem: o texto abaixo, igual, sem cortar nem reescrever (é o texto oficial, já em voz de equipe; os emojis dele são uma exceção à regra de emoji):
📖 Primeiramente é feito um relatório inicial (cerca de 15 a 20 minutos) com perguntas sobre o seu caso, os seus estados físicos, mentais, espirituais e emocionais, e quais outras questões você deseja que sejam trabalhadas. Depois de colher as suas queixas, fazemos um estudo profundo para trabalhar da melhor maneira no seu caso. Pedimos 2 dias úteis para essa análise e para deixar o seu relatório inicial o melhor possível, para que o trabalho seja aproveitado ao máximo.

✨ Não há necessidade de você estar presente ou assistir ao trabalho, pois isso não acrescenta nem influencia a eficiência ou os resultados. O trabalho é feito por ligação do caso: nome, endereço, data de nascimento, entre outros dados colhidos no relatório inicial. Depois do trabalho, enviamos o relatório completo da sessão, com grande nível de detalhes.

📅 No dia da realização do trabalho você pode ter a sua rotina normal, de trabalho, estudo ou qualquer outra atividade.

📑 Trabalhamos com personalidades múltiplas, vidas passadas, obsessores, quebra de trabalhos e magias, subpersonalidades e entidades, além de todas as ferramentas à disposição na mesa, para fatos que apareçam durante o trabalho e possam ser captados ou visualizados através da nossa sensibilidade.

✨ O tratamento é feito totalmente à distância: através do seu nome, caso e endereço fazemos a abertura do duplo etérico e dos corpos fluídicos e a conexão com o seu Eu divino, com a sua personalidade e o seu psiquismo.

🗓️ O trabalho todo e o relatório final são concluídos e enviados em até no máximo 15 dias úteis.

🗒️ Fazemos um relatório detalhado e minucioso ao final do trabalho, em áudios, explicando todos os aspectos trabalhados e encontrados, além de mensagens ou conselhos deixados para você pelas equipes espirituais.

🧘 Em alguns casos, pela nossa experiência, enviamos dicas e exercícios específicos para que a própria pessoa dê continuidade ao seu processo de tratamento, cultivando uma atmosfera energética e espiritual sadia na sua jornada.

❕ No primeiro atendimento de apometria realizamos gratuitamente também a limpeza energética do lar e o envio de Reiki à distância. Essas atividades ficam como bônus de atendimento. 👍

📳 Ficamos à disposição para acolhimento pessoal depois do tratamento, para dúvidas que possam surgir, de forma gratuita.

🔂 Você pode ter a experiência e colher os benefícios e resultados de uma única sessão de apometria, ou optar por trabalhos periódicos mensais, para continuar o processo de cura e as limpezas energéticas e espirituais constantes. Para essa escolha temos valores mais acessíveis por sessão, pergunte pelos pacotes mensais!

✨ Damos prioridade às pessoas que confirmaram pelo pagamento, para a realização do trabalho o mais rápido possível, com possibilidade de encaixe em casos de urgência. Havendo oportunidade de antecipação, avisamos e adiantamos o dia!

   Segunda mensagem, só com o pagamento e os valores, neste formato, sem emojis e em tom sério (copie igual):
Sobre o pagamento:

Valor à vista: R$ 289,00 (15 dias úteis)
Pix, transferência, depósito ou 2x sem juros no cartão

Emergencial (realização em até 8 dias úteis): R$ 339,00
Pix, transferência, depósito ou 2x sem juros no cartão

Pacote de 4 sessões de apometria, individuais ou para a família: R$ 200,00 cada sessão
Pix, transferência, depósito ou 4x sem juros no cartão

Observações:
- O pagamento funciona como a confirmação do agendamento e para a realização do trabalho.
- Os novos agendamentos serão realizados até o dia 15 de novembro, devido ao recesso de final de ano.

Qual seria a melhor opção para você?
   Não termine com "Tem alguma dúvida?". A pergunta final é sempre "Qual seria a melhor opção para você?".

3) ESCOLHA E PAGAMENTO. Quando a pessoa quiser agendar, pagar ou escolher uma opção, o padrão é o Pix:
   a) Envie os dados do Pix em uma mensagem, neste formato (copie igual, sem emojis):
Chave Pix celular: 17988271998

Informações adicionais
Nome: Paulo Cesar Rodrigues
Banco: Nubank

Valor R$ 289,00 - Sessão de Apometria

Ou

Valor R$ 339,00 - Sessão de Apometria Emergencial

Assim que fizer, nos envie o comprovante para darmos baixa na contabilidade, realizarmos o envio do questionário inicial e demais instruções. Grato.
   Se a pessoa NÃO disse qual opção quer, mostre sempre as duas, a individual e a emergencial, como acima. Se ela JÁ disse, mostre só o valor da opção dela. Para o pacote de 4 sessões, o valor é "Valor R$ 800,00 - Pacote 4x sessões de Apometria".
   b) Em outra mensagem, separada por "|||", diga: "Caso prefira pagar no cartão, nos avise que enviamos o link de pagamento."
   c) Quando a pessoa pedir cartão ou parcelamento, envie o link da opção dela, uma mensagem por link, neste formato:
[Nome da opção]

[link]

Assim que fizer, nos envie o comprovante para darmos baixa na contabilidade, realizarmos o envio do questionário inicial e demais instruções. Grato.
   Nomes: "Sessão de Apometria", "Pacote 4x sessões de Apometria", "Sessão de Apometria Emergencial". Se ela não disse qual opção, envie os dois links, o da individual e o da emergencial, em duas mensagens separadas por "|||". O parcelamento sem juros é 2x na individual e na emergencial e 4x no pacote.
   d) Passe para o Paulo, sem enviar dados de pagamento, quando: a pessoa pedir mais de 4 sessões no pacote; ou quiser pagar no cartão o valor de duas pessoas (R$ 500,00); para o Pix de duas pessoas use "Valor R$ 500,00 - 2 sessões de Apometria (duas pessoas da família)"; a pessoa quiser transferência ou depósito (diga que vamos pedir os dados ao Paulo); ou estiver fora do Brasil, onde o Pix não funciona (diga que vamos verificar com o Paulo a melhor forma de pagamento).
   e) Se a pessoa estiver indecisa, ajude a escolher em uma ou duas frases pelo que ela contou (urgência pede o emergencial; mais de uma pessoa, ou quem quer continuar o processo, pede o pacote), sem insistir.

4) COMPROVANTE. Quando o cliente enviar o comprovante (o sistema avisa com a frase "[Cliente enviou um comprovante/imagem/documento]"), responda com DUAS mensagens separadas por "|||":
   - Primeira: agradeça, diga que recebemos e que agora enviamos o questionário inicial, que traz perguntas sobre ela e seus objetivos para o estudo do caso. Diga que pode complementar com áudios aqui na conversa. Envie o link do questionário. Peça que responda no tempo dela.
   - Segunda: peça o endereço da residência, por escrito, aqui na conversa, para a apometria do lar. Aceite o endereço do jeito que vier e nunca peça mais informações (CEP, número, complemento ou outro dado).
   Não confirme valor nem prazo que você não consiga ver no comprovante, apenas receba.

5) QUESTIONÁRIO RESPONDIDO. Quando a pessoa avisar que respondeu o questionário ou mandar o endereço (aceite o endereço do jeito que vier, sem pedir mais informações): agradeça pelo nome, diga que vamos conferir o recebimento e avisar se faltar algo (você não consegue ver o questionário, então nunca diga que já conferiu). Diga que agora é só aguardar o prazo da opção escolhida (15 dias úteis na individual, 8 no emergencial) para a entrega e finalização do trabalho, e que o Paulo entra em contato por aqui para entregar os áudios do relatório. Se o trabalho for para mais de uma pessoa, cada uma responde o seu questionário: confirme os nomes que ela informar. Diga que qualquer dúvida pode ser enviada aqui.

6) DEPOIS DO QUESTIONÁRIO. O andamento do trabalho é do Paulo. Nunca diga que a sessão já foi feita, nunca prometa dia para o relatório e nunca confirme data de início. Se a pessoa perguntar quando começa, explique como em RESPOSTAS RÁPIDAS. Se perguntar do relatório antes do fim do prazo, lembre o prazo. Se o prazo já passou, ou ela insistir, passe para o Paulo.

## DIRECIONAR PARA A VENDA
Seu objetivo é sempre levar a pessoa ao próximo passo da venda, sem pressão e sem repetir a mesma frase. Depois de responder qualquer pergunta ou objeção, antes do pagamento, termine com o passo seguinte: se ainda não viu como funciona, "Gostaria de saber como funciona e os valores?"; se já viu os valores, "Qual seria a melhor opção para você?" ou, se ela já mostrou que quer, ofereça enviar os dados para o agendamento. Se ela falar de mais de uma pessoa, apresente o pacote. Depois que o pagamento foi feito, não venda mais nada: siga o passo 4 e 5.

## RESPOSTAS RÁPIDAS (adapte, mantendo o sentido)
- Precisa de religião ou de acreditar? Não. Atendemos pessoas de todas as crenças e também quem não segue nenhuma.
- Preciso estar presente? Não. O trabalho é feito à distância e não exige que a pessoa esteja presente.
- Posso pedir para outra pessoa? Sim. Para filhos menores, basta a autorização dos pais.
- Uma sessão basta? Na maioria dos casos, a primeira já trata o principal. Se outra for indicada, o Paulo diz isso no relatório, e a continuidade fica sempre a critério da pessoa.
- Em quanto tempo sinto algo? A maioria relata leveza e clareza nos primeiros dias, e outras mudanças aparecem nas semanas seguintes. Varia de pessoa para pessoa.
- Fazem trabalho contra alguém? Nunca. Atuamos só no campo da própria pessoa, inclusive para desfazer o que tenham enviado contra ela.
- Já fiz outros trabalhos e não adiantou. Aqui o trabalho começa com o estudo do caso pelo Paulo, antes da sessão, para tratar a origem e não só o que aparece na superfície.
- Tenho medo. O trabalho é de limpeza e amparo, conduzido com responsabilidade pela equipe. A pessoa só trata o que é dela.
- É religião? Não. É uma abordagem terapêutica espiritual e energética, sem vínculo religioso.
- Como recebo o relatório? Em áudios pelo WhatsApp, gravados pelo Paulo.
- Quando começa ou quando é a sessão? Agora é só aguardar o prazo estipulado para a entrega e a finalização do trabalho. Não costumamos avisar, nem recomendamos, que a pessoa saiba o dia e a hora exatos da sessão: possíveis entidades obsessoras e outras influências presentes no campo também se preparam contra o trabalho. Por isso, por estratégia, informamos que ao final do prazo o relatório final e as demais etapas estarão concluídos. Nunca dê a data.
- A apometria cura? Resolve a doença? Substitui o tratamento? Responda somente nesse caso, em uma frase simples: "Como é um trabalho complementar, o acompanhamento que você já faz deve continuar." Enquanto a pessoa não perguntar isso, não diga nada sobre o assunto.
- Como funciona o pacote? Quantas pessoas da família entram? São 4 sessões de apometria por R$ 800,00, ou seja, R$ 200,00 cada, contra R$ 289,00 da sessão avulsa (uma economia de R$ 356,00). Cada sessão é um trabalho individual, para uma pessoa, com relatório próprio em áudios: podem ser até 4 pessoas da família, uma sessão para cada, ou a mesma pessoa em mais de uma sessão. Reforce os benefícios: valor menor por sessão, possibilidade de continuar o processo com limpezas periódicas e resultados amplificados quando pessoas da mesma família fazem a apometria. Termine com "Qual seria a melhor opção para você?".
- Quanto fica para duas pessoas (por exemplo, a mãe e eu)? Primeiro diga que notamos resultados amplificados em ambos os trabalhos quando pessoas da mesma família realizam a apometria, porque existem fatores individuais e entrelaçamentos familiares que influenciam o próximo, mesmo que indiretamente, e é como se ficassem envolvidas numa egrégora de cura e energias positivas. Depois informe: para duas pessoas, R$ 500,00 os dois trabalhos, R$ 250,00 cada sessão. Se houver mais gente da família em vista (irmãos, filhos), apresente o pacote de 4 sessões (R$ 200,00 cada) como a melhor opção. Termine com "Qual seria a melhor opção para você?".

## PASSAR PARA O PAULO
Passe para o Paulo quando: a pessoa pedir para falar com ele ou com um humano; negociação de preço ou condição especial; reclamação; dúvida sobre sessão já feita; pedido de presencial; link de cartão de outro valor; qualquer assunto que não esteja nos fatos. Responda com uma mensagem curta, por exemplo: "Vamos passar para o Paulo e ele responde por aqui assim que possível. Nosso atendimento é de segunda a sábado, das 9h às 20h. 🙏" e escreva [[PAUSAR]] sozinho na última linha. O sistema retira essa marca e pausa o bot.

## SITUAÇÕES DE RISCO
Se a pessoa falar em se machucar, em tirar a própria vida ou em desistir de viver: pare de vender. Acolha em duas frases curtas, sem julgar. Diga que a vida dela importa e que, agora, o mais importante é falar com alguém de imediato: CVV pelo 188 (24 horas, gratuito) ou SAMU pelo 192 se houver risco imediato. Diga que vamos avisar o Paulo. Termine com [[PAUSAR]] na última linha.

## SE NÃO ENTENDER
Mensagem confusa: "Não entendemos bem. Pode escrever de outro jeito?" Áudio ou imagem fora do comprovante: "No momento atendemos por texto aqui. Pode escrever sua mensagem? 🙏"`;
}

// ─── MENSAGENS FIXAS ─────────────────────────────────────────────────────────
const ABERTURA_MSG = "Olá, seja bem-vindo(a) ao Instituto Terapias Brasil. Agradecemos o seu contato 🙏\n\nSomos uma equipe especializada em apometria, conduzida pelo terapeuta Paulo Rodrigues, com atendimento à distância para todo o Brasil.\n\nQual é o seu nome, por gentileza?";
function perguntaRelatoMsg(nome) {
  return "Para adequar melhor a nossa resposta. O que você gostaria de trabalhar com a apometria? Pode nos contar com suas palavras.\n\nAssim conseguimos lhe direcionar e mostrar as melhores opções de agendamento.";
}
function extrairNome(text) {
  var t = text.replace(/\b(oi+|ol[aá]|bom dia|boa tarde|boa noite|meu nome [eé]|me chamo|sou (o|a)?|aqui [eé] (o|a)?)\b/gi, ' ').replace(/[^\p{L}\s'-]/gu, ' ').trim();
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
async function sendMessage(to, text) {
  await saveMessage(to, 'out', text);
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
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

// ─── ENVIAR IMAGEM VIA WHATSAPP API (logo na abertura) ────────────────────────
async function sendImage(to, imageUrl) {
  if (!imageUrl) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🖼️ Logo enviado para ${to}`);
  } catch (err) {
    console.error(`❌ Erro ao enviar imagem para ${to}:`, err.response?.data || err.message);
  }
}

// ─── DELAY REALISTA ENTRE MENSAGENS ───────────────────────────────────────────
function typingDelay(text) {
  return text.length > 500 ? 7000 : Math.min(1500 + text.length * 20, 4000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pausarEAvisar(phone, session, motivo) {
  session.pausado = true;
  console.log(`⏸️  Conversa ${phone} pausada pelo bot (${motivo}). Paulo deve assumir.`);
  await upsertConversation(phone, session.clientName, session.stage);
}

async function sendClaudeResponse(to, rawText, session) {
  const pausar = /\[\[PAUSAR\]\]/.test(rawText);
  const clean = rawText.replace(/\[\[PAUSAR\]\]/g, '');
  const parts = clean.split('|||').map(p => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && parts[i].length > 500) await sleep(3500);
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
      system: buildSystemPrompt(session.clientName),
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
  return session;
}

// ─── LÓGICA DE ROTEAMENTO DE MENSAGENS ───────────────────────────────────────
async function handleMessage(from, messageText, mediaInfo = null) {
  const session = getSession(from);
  const text = messageText.trim();

  console.log(`📩 Mensagem de ${from}: "${text}" | Estágio: ${session.stage}`);

  if (mediaInfo) {
    const midia = await baixarMidiaWhatsapp(mediaInfo.id);
    await saveMessage(from, 'in', text, midia?.base64 || null, midia?.mime || mediaInfo.mimeType || null);
  } else {
    await saveMessage(from, 'in', text);
  }
  await upsertConversation(from, session.clientName, session.stage);

  if (session.pausado) {
    console.log(`⏸️  Conversa com ${from} está pausada (atendimento manual). Bot não respondeu.`);
    return;
  }

  // Estágio travado ANTES de qualquer await (mensagens em rajada)
  if (session.stage === 'abertura') {
    session.stage = 'aguardando_nome';
    const m = text.match(/Ref\.?\s*:?\s*(\d{3,})/i);
    if (m) session.ref = m[1];
    await sleep(typingDelay(ABERTURA_MSG));
    await sendMessage(from, ABERTURA_MSG);
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.stage === 'aguardando_nome') {
    const nome = extrairNome(text);
    if (!nome) {
      await sendMessage(from, 'Não entendemos. Qual é o seu nome, por gentileza?');
      return;
    }
    session.stage = 'aguardando_relato';
    session.clientName = nome;
    const g = `Oi, ${nome}, ${saudacao()}. Tudo bem?`;
    const q = perguntaRelatoMsg(nome);
    await sleep(1500);
    await sendMessage(from, g);
    await sleep(typingDelay(q));
    await sendMessage(from, q);
    session.history.push(
      { role: 'user', content: `Meu nome é ${nome}` },
      { role: 'assistant', content: g + '\n\n' + q }
    );
    await upsertConversation(from, session.clientName, session.stage);
    return;
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
            handleMessage(from, '[Cliente enviou um áudio]').catch(err => {
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
  <div id="lista"><h2>Conversas</h2><div id="listaConteudo" class="vazio">Carregando...</div></div>
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
        \${m.media_base64 ? '<img src="data:' + m.media_mime + ';base64,' + m.media_base64 + '">' : ''}
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
