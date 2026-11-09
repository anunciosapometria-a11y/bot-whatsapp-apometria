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
function hintEtapa(etapa) {
  if (etapa === 'aguarda2') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 2. Pergunta pendente: "' + PERGUNTA2 + '"';
  if (etapa === 'aguarda3') return 'ETAPA ATUAL: a pessoa ainda não confirmou seguir para a etapa 3. Pergunta pendente: "' + PERGUNTA3 + '"';
  if (etapa === 'nome') return 'ETAPA ATUAL: a pessoa ainda não disse o nome (pergunte uma única vez; se ela não disser, siga sem insistir). Ela respondeu algo que não é um nome. Responda de forma condizente ao que ela disse, em uma ou duas frases, sem tratar nenhuma palavra como nome, e peça o nome com gentileza no final. Não explique o trabalho nem envie valores ainda.';
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
- Bônus do primeiro atendimento: apometria para o lar, envio de Reiki à distância e orientações espirituais.
- Valores e pagamento:
  - Sessão individual, à vista: R$ 289,00, prazo de 15 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Emergencial: R$ 339,00, realização em até 8 dias úteis. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Pacote de sessões: R$ 200,00 cada trabalho (R$ 800,00 as 4 sessões), para quem quer continuar o processo com trabalhos periódicos mensais de limpeza e cura ou dividir com outras pessoas. Cada sessão é um trabalho individual, com relatório próprio em áudios. Pix, transferência, depósito ou até 4x sem juros no cartão.
  - Familiar: R$ 800,00, até 5 pessoas da mesma família, mais a apometria do lar. São apometrias individuais, uma para cada pessoa, com um relatório único para toda a família, apresentando as ligações interfamiliares, heranças e padrões que se repetem entre eles. Pix, transferência, depósito ou 2x sem juros no cartão.
  - Trabalhos específicos, em outra foto: apometria para empresa (aumentar vendas e desbloquear oportunidades), R$ 400,00; apometria para imóveis (vendas e trâmites judiciais), R$ 300,00; apometria para animais de estimação, R$ 150,00. Quando a pessoa perguntar por qualquer um deles, envie [[FOTO:especiais]] sozinho em uma mensagem, depois "|||" e uma frase curta sobre o que ela perguntou. Pagamento nas mesmas condições (Pix, transferência, depósito ou 2x sem juros no cartão); para cartão, passe para o Paulo. Metades de entrada: empresa R$ 200,00, imóveis R$ 150,00, animais R$ 75,00.
  - Presencial: R$ 660,00, na sede do instituto, com o terapeuta Paulo. Está na imagem de valores, mas NÃO é possível realizar no momento por falta de disponibilidade na agenda. Se a pessoa perguntar do presencial, diga isso (veja RESPOSTAS RÁPIDAS).
  - Todos os formatos incluem estudo profundo do caso, limpeza energética do lar, envio de Reiki e relatório final em áudio gravado pelo Paulo. 2x sem juros no cartão em todos os formatos (pacote até 4x).
  - Duas pessoas da mesma família (dois trabalhos): R$ 500,00 no total, R$ 250,00 cada sessão. Pix, transferência ou depósito. Para cartão, passe para o Paulo.
  - O pagamento funciona como confirmação do agendamento e para a realização do trabalho. Damos prioridade a quem confirmou pelo pagamento.
  - Para pagar, a pessoa solicita o Pix ou o link de pagamento no cartão.
  - Recesso de final de ano: a observação "Os novos agendamentos serão realizados até o dia 15 de novembro, devido ao recesso de final de ano" aparece na mensagem de pagamento. Ela serve só como aviso de prazo: nunca recuse nem bloqueie um agendamento por causa dela e atenda normalmente a qualquer data. Se a pessoa perguntar de datas, use a resposta de DATAS em RESPOSTAS RÁPIDAS. Não pressione a pessoa nem repita o aviso fora da mensagem de pagamento.
- Pix: chave celular 17988271998, nome Paulo Cesar Rodrigues, banco Nubank.
- Links de pagamento no cartão (Mercado Pago), um por opção:
  - Sessão de Apometria (individual): https://mpago.li/2LvFGYD
  - Pacote 4x sessões de Apometria: https://mpago.li/26zevnv
  - Sessão de Apometria Emergencial: https://mpago.li/2rMEjbs
- Questionário inicial: https://apometriabrasil.com.br/questionario-inicial/
- Não costumamos avisar o dia e a hora exatos da sessão. O trabalho é concluído dentro do prazo e o relatório chega ao final.
- Atendimento humano: segunda a sábado, das 9h às 20h.
- Sede e presencial: somos de São José do Rio Preto (SP). A apometria presencial existe, mas os novos atendimentos presenciais estão pausados por falta de disponibilidade na agenda. Nossos trabalhos são realizados em sua grande maioria à distância, para todo o Brasil e exterior. Só fale de presencial se a pessoa perguntar.

## FLUXO
O sistema já enviou o logo e a abertura, pediu o nome, respondeu "Ok, [nome]" e conduz sozinho a explicação em 3 etapas, com mensagens prontas e uma pergunta entre cada etapa: Etapa 1, o que a pessoa recebe (itens tratados, relatório em áudios, bônus do lar e Reiki, equipe à disposição); Etapa 2, detalhes do procedimento (questionário inicial, estudo do caso em 2 dias úteis, não precisa estar presente) e o PDF de orientações; Etapa 3, a foto de valores e formatos e a pergunta "Gostaria de realizar o seu agendamento?". Não repita esses textos e nunca envie uma etapa por conta própria: o sistema avança quando a pessoa responde sim. Você entra quando a pessoa responde outra coisa.

1) ENTRE AS ETAPAS. Se o bloco ETAPA ATUAL, no início, indicar uma pergunta pendente: se a pessoa contar o que quer trabalhar, acolha em uma ou duas frases, usando as palavras dela; se fizer outra pergunta, responda com os fatos em poucas frases; nos dois casos, termine repetindo a pergunta pendente de forma curta. Não envie o link do questionário agora: ele só vai depois do comprovante (passo 4), salvo se a pessoa pedir.

2) DEPOIS DA ETAPA 3 (valores já enviados). A foto com valores e formatos já foi enviada. Se a pessoa tirar dúvidas, responda com os fatos; só volte a "Gostaria de realizar o seu agendamento?" se ainda não a fez nas últimas mensagens, sem repetir a pergunta a cada resposta. Se pedir os valores de novo, envie [[FOTO:valores]] sozinho em uma mensagem, depois "|||" e a pergunta de agendamento. Se perguntar de um valor específico (ex.: quanto é o emergencial), responda em uma frase com o valor e o prazo, sem insistir na pergunta de agendamento. Quando a pessoa disser que quer agendar, vá ao passo 3. Se perguntar sobre o PDF de dúvidas de pagamento e agendamento, diga que será enviado em breve e siga o fluxo.

3) ESCOLHA E PAGAMENTO. Quando a pessoa quiser agendar, o agendamento exige pagar apenas metade do valor, e o restante só quando receber os relatórios finais. Se ela não disse qual modalidade quer (individual em 15 dias, emergencial em 8 dias, pacote familiar), pergunte em uma frase curta qual prefere, mostrando as opções. Com a escolha, envie os dados do Pix em uma mensagem, neste formato (sem emojis):
Chave Pix celular: 17988271998

Informações adicionais
Nome: Paulo Cesar Rodrigues
Banco: Nubank

Valor de entrada (metade): [metade do valor da opção] - [nome da opção]

Assim que fizer, nos envie o comprovante para darmos baixa na contabilidade, realizarmos o envio do questionário inicial e demais instruções. Grato.
   Metades: sessão individual R$ 144,50 (de R$ 289,00); emergencial R$ 169,50 (de R$ 339,00); pacote familiar R$ 400,00 (de R$ 800,00). Nomes: "Sessão de Apometria", "Sessão de Apometria Emergencial", "Apometria Familiar (até 5 pessoas)". Presencial: não é possível no momento por falta de disponibilidade; ofereça o trabalho à distância.
   Cartão: os links de pagamento disponíveis são do valor inteiro, não da entrada. Se a pessoa pedir cartão, diga que vamos pedir o link do valor de entrada ao Paulo e passe para ele. Transferência ou depósito: envie os mesmos dados do Pix. Pessoa no exterior: diga que o pagamento pode ser por transferência internacional, Wise ou PayPal, com o valor convertido no dia, e passe para o Paulo. Mais de 5 pessoas ou pedido fora do padrão: passe para o Paulo.
   Se a pessoa estiver indecisa, ajude a escolher em uma ou duas frases pelo que ela contou (urgência pede o emergencial; mais de uma pessoa da família pede o pacote familiar), sem insistir.

4) COMPROVANTE. Quando o cliente enviar o comprovante (o sistema avisa com a frase "[Cliente enviou um comprovante/imagem/documento]"), responda com TRÊS mensagens separadas por "|||":
   - Primeira: agradeça, diga que recebemos e que vamos redirecionar o atendimento, e que agora enviamos o questionário inicial, que traz perguntas sobre ela e seus objetivos para o estudo do caso. Diga que pode complementar com áudios aqui na conversa.
   - Segunda: o link https://apometriabrasil.com.br/questionario-inicial/ e a frase "Fique à vontade para responder no seu tempo."
   - Terceira: peça o endereço da residência, por escrito, aqui na conversa, para a apometria do lar. Aceite o endereço do jeito que vier e nunca peça mais informações (CEP, número, complemento ou outro dado).
   Não confirme valor nem prazo que você não consiga ver no comprovante, apenas receba.

5) QUESTIONÁRIO RESPONDIDO. Quando a pessoa avisar que respondeu o questionário ou mandar o endereço (aceite o endereço do jeito que vier, sem pedir mais informações): agradeça pelo nome, diga que vamos conferir o recebimento e avisar se faltar algo (você não consegue ver o questionário, então nunca diga que já conferiu). Diga que agora é só aguardar o prazo da opção escolhida (15 dias úteis na individual, 8 no emergencial) para a entrega e finalização do trabalho, e que o Paulo entra em contato por aqui para entregar os áudios do relatório. Se o trabalho for para mais de uma pessoa, cada uma responde o seu questionário: confirme os nomes que ela informar. Diga que qualquer dúvida pode ser enviada aqui.

6) DEPOIS DO QUESTIONÁRIO. O andamento do trabalho é do Paulo. Nunca diga que a sessão já foi feita, nunca prometa dia para o relatório e nunca confirme data de início. Se a pessoa perguntar quando começa, explique como em RESPOSTAS RÁPIDAS. Se perguntar do relatório antes do fim do prazo, lembre o prazo. Se o prazo já passou, ou ela insistir, passe para o Paulo.

## DIRECIONAR PARA A VENDA
Seu objetivo é levar a pessoa ao próximo passo da venda, sem pressão e sem repetir a mesma frase. CUIDADO para não perguntar toda hora se ela quer agendar: quando a conversa sair do fluxo (dúvida, desabafo, objeção, conversa lateral), responda com atenção e só retome a pergunta de agendamento se fizer sentido e se você ainda não a fez nas últimas mensagens. Em muitas respostas basta acolher e deixar a porta aberta, sem pergunta de fechamento. Quando fizer sentido avançar, use o passo seguinte: se ainda não preencheu o questionário, conduza para o questionário (a primeira etapa não tem custo); se já viu os valores, "Gostaria de realizar o seu agendamento?" ou, se ela já mostrou que quer, ofereça enviar os dados para o agendamento. Se ela falar de mais de uma pessoa, apresente o pacote. Depois que o pagamento foi feito, não venda mais nada: siga o passo 4 e 5.

## RESPOSTAS RÁPIDAS (adapte, mantendo o sentido)
- Precisa de religião ou de acreditar? Não. Atendemos pessoas de todas as crenças e também quem não segue nenhuma.
- Preciso estar presente? Não. O trabalho é feito à distância e não exige que a pessoa esteja presente.
- Onde vocês ficam? De que cidade? Moro em [cidade] / É à distância? Responda com este texto, adaptando a abertura à cidade que a pessoa citou, quando houver: "Nós somos de São José do Rio Preto, SP. Apesar de também realizarmos a apometria presencial, nossos trabalhos são realizados em sua grande maioria à distância, para todo o Brasil e exterior. Para esse tipo de trabalho não há necessidade de a pessoa estar presente, uma vez que a conexão com o corpo astral é feita através de diversas informações que colhemos em nosso questionário inicial, da nossa sensibilidade como médium e também com o auxílio dos mentores espirituais presentes na sessão, e para eles a barreira de espaço não tem nenhuma representatividade." Depois siga o passo da venda.
- Tem como ser presencial? Diga que, no momento, não é possível realizar o presencial por falta de disponibilidade na agenda, e que o trabalho à distância tem o mesmo resultado, feito com a mesma equipe. Não passe para o Paulo só por isso. Siga o passo da venda.
- DATAS: Tem para amanhã? Qual data está disponível? Quando posso fazer? Responda que o trabalho é realizado dentro do prazo estipulado, de 15 dias úteis na sessão individual ou de 08 dias úteis no emergencial, e que não costumamos informar dia e hora exatos. Se ela tem urgência, apresente o emergencial. Não passe para o Paulo por isso.
- Posso pedir para outra pessoa? Sim, e pode solicitar em nome de outras pessoas, inclusive sem a permissão e a consciência delas. Nunca fale em autorização, nem de filhos menores, nem de adultos. Explique com base no mesmo texto do "Onde vocês ficam": a conexão com o corpo astral é feita pelas informações do questionário inicial, pela sensibilidade como médium e pelos mentores espirituais, e a pessoa não precisa estar presente. Quem solicita responde o questionário com o que souber da pessoa. Depois siga o fluxo sem forçar a pergunta de agendamento.
- Apometria para imóveis, terrenos ou empresas, ou processos (venda parada, processo judicial): é possível realizar a apometria específica para a resolução desses problemas, e grande parte dos nossos trabalhos são realizados para essa finalidade. Imóveis e terrenos: já oferecemos a limpeza do lar como bônus do tratamento, mas também temos o trabalho de apometria específico para imóveis ou terrenos, investigando o local e realizando corte de vínculos mais profundos. É comum as pessoas procurarem esse trabalho quando sentem que existe algo denso e persistente no ambiente, querem vender o imóvel ou resolver processos administrativos, entre outros. Processo judicial: é possível colocar a questão do processo em pauta. Grande parte dos nossos trabalhos são realizados para processos judiciais cíveis ou empresariais. Essas questões estão fortemente ligadas ao plano espiritual, já que isso se torna uma vulnerabilidade em que obsessores e outras influenciações podem agir contra a pessoa. No trabalho também agimos no polo positivo, abrindo os caminhos e harmonizando os acontecimentos para que sejam favoráveis a ela, liberando possíveis bloqueios. Além disso, passamos o que foi encontrado e as energias que estão rondando o processo e de onde elas vêm. Responda em mensagens curtas, com acolhimento, usando o nome da pessoa quando souber. Para valores específicos, envie [[FOTO:especiais]].
- Pessoa no exterior, ou dúvida sobre as formas de pagamento: envie [[FOTO:pagamento]] sozinho em uma mensagem (formas de pagamento e instruções para quem está no exterior), depois "|||" e uma frase curta retomando a conversa.
- Quantas sessões preciso? Uma sessão basta? Responda com base neste texto, em mensagens curtas: "Tudo o que foi descrito pode ser abordado já em uma sessão, porque o trabalho de apometria é muito amplo e abrangente. Na maioria dos casos, o primeiro atendimento já trata o principal. É um trabalho pontual." Depois: "Se outra sessão for indicada, o Paulo informa no relatório, e a continuidade fica sempre a critério da pessoa." Depois fale dos benefícios para quem quiser continuar: há quem opte por trabalhos periódicos mensais ou pelo pacote de sessões, para dar continuidade ao processo com limpezas energéticas e espirituais constantes, e pessoas da mesma família que realizam a apometria costumam ter resultados amplificados, porque existem fatores individuais e entrelaçamentos familiares que influenciam uns aos outros. Termine dizendo que ela pode ver como o trabalho funciona e decidir sobre a continuidade depois, sempre a critério dela. Não pressione.
- Em quanto tempo sinto algo? Quando vou ter resultado ou efeitos? Em quanto tempo vou melhorar? Responda com este conteúdo, em mensagens curtas separadas por "|||": "Notamos que, quando se trata de fatores externos como obsessores, trabalhos de magia e outras influenciações como essas, os resultados aparecem logo nos primeiros dias, porque ao realizar essa retirada é como liberar algo que estava prejudicando muito intensamente." ||| "Nos outros casos, que envolvem situações mais enraizadas, as melhoras vêm com o passar dos dias. Cada caso é único e tem as suas particularidades." ||| "Fazemos o máximo possível dentro das possibilidades, somos reconhecidos pelos resultados efetivos e temos muitos relatos positivos." Não prometa cura nem prazo exato.
- Fazem trabalho contra alguém? Nunca. Atuamos só no campo da própria pessoa, inclusive para desfazer o que tenham enviado contra ela.
- Já fiz outros trabalhos e não adiantou. Aqui o trabalho começa com o estudo do caso pelo Paulo, antes da sessão, para tratar a origem e não só o que aparece na superfície.
- Frase de amparo: quando a pessoa estiver em dúvida, com medo, insegura ou perto de decidir, inclua com suas palavras: "Saiba que, se escolher realizar a apometria conosco, você será muito bem amparada e faremos o melhor por você." Use no máximo uma vez por conversa.
- É confiável? É real? É golpe? Dúvida sobre a veracidade do trabalho ou de quem somos. Responda com acolhimento e estes fatos, em mensagens curtas: "Entendemos perfeitamente a sua preocupação. Como não nos conhecemos e tudo acontece pela internet, é normal surgirem essas dúvidas." Depois: "Somos um instituto de apometria em São José do Rio Preto, chamado Apometria Brasil, reconhecido pelos trabalhos apométricos em todo o Brasil e também no exterior." Depois: "Note também que somos verificados na conta do WhatsApp e do Instagram, processo em que a empresa solicita que se comprove a veracidade das atividades que oferecemos." Depois: "Você também pode pesquisar por Apometria Brasil no Google e ver o nosso perfil no Google Maps e alguns relatos." Não invente outros dados e não passe para o Paulo só por isso.
- Tenho medo. O trabalho é de limpeza e amparo, conduzido com responsabilidade pela equipe. A pessoa só trata o que é dela.
- É religião? Não. É uma abordagem terapêutica espiritual e energética, sem vínculo religioso.
- Como recebo o relatório? Em áudios pelo WhatsApp, gravados pelo Paulo.
- Quando começa ou quando é a sessão? Agora é só aguardar o prazo estipulado para a entrega e a finalização do trabalho. Não costumamos avisar, nem recomendamos, que a pessoa saiba o dia e a hora exatos da sessão: possíveis entidades obsessoras e outras influências presentes no campo também se preparam contra o trabalho. Por isso, por estratégia, informamos que ao final do prazo o relatório final e as demais etapas estarão concluídos. Nunca dê a data.
- A apometria cura? Resolve a doença? Substitui o tratamento? Responda somente nesse caso, em uma frase simples: "Como é um trabalho complementar, o acompanhamento que você já faz deve continuar." Enquanto a pessoa não perguntar isso, não diga nada sobre o assunto.
- Como funciona o pacote? Quantas pessoas da família entram? Pacote: 4 sessões por R$ 800,00, ou seja, R$ 200,00 cada, contra R$ 289,00 da sessão avulsa. Cada sessão é um trabalho individual com relatório próprio em áudios, para quem quer continuar o processo com trabalhos mensais de limpeza e cura ou dividir com outras pessoas. Se for para a família toda, apresente também o Familiar: R$ 800,00 para até 5 pessoas da mesma família, mais a apometria do lar, apometrias individuais com um relatório único que mostra as ligações interfamiliares, heranças e padrões que se repetem entre eles. Reforce os benefícios: valor menor por sessão, possibilidade de continuar o processo com limpezas periódicas e resultados amplificados quando pessoas da mesma família fazem a apometria. Se ainda não tiver feito a pergunta de agendamento nas últimas mensagens, termine com "Gostaria de realizar o seu agendamento?".
- Quanto fica para duas pessoas (por exemplo, a mãe e eu)? Primeiro diga que notamos resultados amplificados em ambos os trabalhos quando pessoas da mesma família realizam a apometria, porque existem fatores individuais e entrelaçamentos familiares que influenciam o próximo, mesmo que indiretamente, e é como se ficassem envolvidas numa egrégora de cura e energias positivas. Depois informe: para duas pessoas, R$ 500,00 os dois trabalhos, R$ 250,00 cada sessão. Se houver mais gente da família em vista (irmãos, filhos), apresente o pacote de 4 sessões (R$ 200,00 cada) como a melhor opção. Se ainda não tiver feito a pergunta de agendamento nas últimas mensagens, termine com "Gostaria de realizar o seu agendamento?".

## PASSAR PARA O PAULO
Antes de passar para o Paulo, tente sempre VOLTAR AO FLUXO: responda em uma ou duas frases o que a pessoa disse e retome o passo da venda em que estávamos (relato, "Gostaria de saber como funciona e os valores?", "Gostaria de realizar o seu agendamento?", dados do Pix, comprovante, questionário). Assunto fora do roteiro, dúvida que não está nos fatos, conversa lateral, desconfiança, pedido de desconto ou "vou pensar": acolha, responda com o que há nos fatos (sem inventar) e volte ao passo. Para desconto ou condição especial, mantenha os valores, reforce o benefício do pacote ou do emergencial e retome a pergunta da melhor opção. Transferência ou depósito: envie os dados do Pix, que servem para transferência. Pessoa no exterior: diga que o pagamento pode ser por transferência internacional, Wise ou PayPal, com o valor convertido no dia, e passe para o Paulo.
Passe para o Paulo SOMENTE se, mesmo assim, ocorrer um destes casos: a pessoa pedir para falar com ele ou com um humano (uma vez já basta); reclamação; insistência em desconto ou condição especial depois de você ter voltado ao fluxo uma vez; mais de 4 sessões no pacote; cartão para duas pessoas; pergunta sobre sessão já feita quando o prazo já passou ou ela insiste. Nunca passe para o Paulo por outro motivo. Quando passar, responda com uma mensagem curta, por exemplo: "Vamos passar para o Paulo e ele responde por aqui assim que possível. Nosso atendimento é de segunda a sábado, das 9h às 20h. 🙏" e escreva [[PAUSAR]] sozinho na última linha. O sistema retira essa marca e pausa o bot; se ninguém assumir, o bot volta a responder sozinho depois de algumas horas.

## SITUAÇÕES DE RISCO
Se a pessoa falar em se machucar, em tirar a própria vida ou em desistir de viver: pare de vender. Acolha em duas frases curtas, sem julgar. Diga que a vida dela importa e que, agora, o mais importante é falar com alguém de imediato: CVV pelo 188 (24 horas, gratuito) ou SAMU pelo 192 se houver risco imediato. Diga que vamos avisar o Paulo. Termine com [[PAUSAR]] na última linha.

## SE NÃO ENTENDER
Mensagem confusa: "Não entendemos bem. Pode escrever de outro jeito?" Áudio ou imagem fora do comprovante: "No momento atendemos por texto aqui. Pode escrever sua mensagem? 🙏"`;
}

// ─── MENSAGENS FIXAS ─────────────────────────────────────────────────────────
const ABERTURA_MSG = "*Olá, seja bem-vindo(a) ao Atendimento do Instituto Apometria Brasil.*\n\n🏛️ *Quem somos*\nUma equipe especializada em apometria, coordenada pelo terapeuta *Paulo Rodrigues*.\n\n📌 *Neste canal você encontra*\n• Detalhes do procedimento\n• Disponibilidade para agendamento\n\n✍️ *Para iniciarmos, qual é o seu nome, por gentileza?*";
const TITULO_MSG = "*Vamos explicar como funciona o nosso trabalho em 3 etapas:*\n\n1️⃣ O que você recebe\n2️⃣ Detalhes do procedimento\n3️⃣ Opções de agendamento";
const ETAPA1 = [
  "*Etapa 1: o que você recebe*",
  "📑 *O que investigamos e tratamos*\nRealizamos a apometria para atingir seus principais objetivos e, além disso, investigamos e tratamos:\n✓ Seres densos\n✓ Quebra de feitiços e magias\n✓ Retirada de implantes astrais\n✓ Miasmas e energias densas\n✓ Fractais energéticos\n✓ Vínculos com antepassados\n✓ Padrões familiares\n✓ Dissolução de carmas\n✓ Vidas passadas\n✓ Traumas do passado\n✓ Crenças limitantes\n✓ Harmonização dos chacras\n✓ Limpeza energética completa",
  "🗒️ *Relatório em áudios*\n• Enviamos ao final do trabalho um relatório minucioso, explicando o que foi encontrado e tratado.\n• Vão também as orientações e as mensagens deixadas para você pelas equipes espirituais.\n• Os áudios são enviados pelo próprio apômetra Paulo Rodrigues, dirigente do instituto.",
  "🎁 *Bônus do primeiro atendimento*\n• Limpeza energética do endereço do seu lar\n• Envio de Reiki à distância\nSem custo adicional.",
  "🤝 *Equipe à disposição*\nDepois do tratamento, a equipe fica disponível para acolhimento pessoal e para as dúvidas que surgirem, de forma gratuita.",
  "👥 *Para quem pode ser solicitada a apometria*\n\n*• Para você mesmo*\n\n*• Para outra pessoa*\n\n*• Para empresas, imóveis ou animais*"
];
const PERGUNTA2 = "Podemos seguir para a etapa 2, com os detalhes do procedimento?";
const ETAPA2 = [
  "*Etapa 2: detalhes do procedimento*",
  "1️⃣ *Questionário inicial*\nPrimeiramente você irá preencher um questionário com as perguntas necessárias para o seu trabalho, sobre os seus estados físicos, mentais, espirituais e emocionais e sobre o que deseja tratar, investigar e obter respostas da espiritualidade.",
  "2️⃣ *Estudo do caso*\nDepois de colher as suas queixas, fazemos um estudo profundo com base nessas informações, para trabalhar da melhor maneira no seu caso. Solicitamos 2 dias úteis para concluir essa etapa.",
  "3️⃣ *Não precisa estar presente*\nNão há necessidade de você estar presente no dia do trabalho. Somos de São José do Rio Preto, SP, e grande parte dos nossos trabalhos é realizada à distância, para todo o Brasil e exterior."
];
const PDF_MSG = "📎 *Orientações gerais*\nLogo abaixo segue um PDF com orientações, instruções importantes, dúvidas frequentes e o que pode ser solicitado no trabalho.";
const PERGUNTA3 = "Podemos seguir para a etapa 3, com as opções de agendamento?";
const ETAPA3_TITULO = "*Etapa 3: opções de agendamento*";
const ETAPA3_NOTA = "💳 *Para confirmar o agendamento*\n• Basta pagar metade do valor e enviar o comprovante.\n• O restante pode ser pago somente quando você receber os relatórios finais.\n• Prezamos por dar o primeiro passo em direção à confiança: queremos passar segurança desde o início.";
const APOS_PAGAMENTO_MSG = "📋 *O que acontece após o pagamento*\n• Você irá receber algumas instruções e o questionário inicial para preenchimento.\n• A equipe entrará no processo de estudo e elaboração do seu trabalho.\n• No momento do envio dos relatórios finais, o Paulo entrará em contato através do número pessoal dele.";
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
Pacote de sessões, 4 sessões: R$ 200,00 cada trabalho (R$ 800,00), até 4x no cartão
Familiar, até 5 pessoas da mesma família mais o lar, relatório único: R$ 800,00
Presencial, na sede do instituto: R$ 660,00

Inclusos em todos: estudo profundo do caso, limpeza energética do lar, envio de Reiki e relatório final em áudio gravado pelo Paulo. Cartão em 2x sem juros em todos os formatos (pacote em até 4x).`,
  pagamento: `Formas de pagamento: Pix, transferência, depósito ou cartão em 2x sem juros. Basta solicitar o Pix ou o link para pagamento via cartão pelo WhatsApp.

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
    return fs.readdirSync(MEDIA_DIR).find(f => re.test(f)) || null;
  } catch (e) { return null; }
}

async function enviarFoto(to, nome) {
  const arq = acharFoto(nome);
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
}

async function sendClaudeResponse(to, rawText, session) {
  const pausar = /\[\[PAUSAR\]\]/.test(rawText);
  const clean = rawText.replace(/\[\[PAUSAR\]\]/g, '');
  const parts = clean.split('|||').map(p => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
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
    session.etapa = 'aguarda2';
    session.clientName = nome || null;
    const ok = nome ? `Ok, ${nome}.` : 'Tudo bem.';
    await sleep(2500);
    await sendMessage(from, ok);
    for (const parte of [TITULO_MSG, ...ETAPA1, PERGUNTA2]) {
      await sleep(typingDelay(parte));
      await sendMessage(from, parte);
    }
    session.history.push(
      { role: 'user', content: nome ? `Meu nome é ${nome}` : text },
      { role: 'assistant', content: [ok, TITULO_MSG, ...ETAPA1, PERGUNTA2].join('\n\n') }
    );
    await upsertConversation(from, session.clientName, session.stage);
    return;
  }

  if (session.etapa === 'aguarda2' || session.etapa === 'aguarda3') {
    const querValores = pedeValores(text);
    if (session.etapa === 'aguarda2' && ehSim(text) && !querValores) {
      session.etapa = 'aguarda3'; // trava antes dos awaits (mensagens em rajada)
      for (const parte of ETAPA2) {
        await sleep(typingDelay(parte));
        await sendMessage(from, parte);
      }
      const pdfOk = fs.existsSync(path.join(MEDIA_DIR, 'orientacoes.pdf'));
      await sleep(typingDelay(PDF_MSG));
      await sendMessage(from, PDF_MSG);
      if (pdfOk) await sendDocument(from, `${PUBLIC_BASE}/media/orientacoes.pdf`, 'Orientacoes-Apometria-Brasil.pdf');
      await sleep(typingDelay(PERGUNTA3));
      await sendMessage(from, PERGUNTA3);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [...ETAPA2, PDF_MSG, PERGUNTA3].join('\n\n') }
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
      await sleep(typingDelay(PERGUNTA_AGENDA));
      await sendMessage(from, PERGUNTA_AGENDA);
      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: [ETAPA3_TITULO, '[foto com os valores e formatos enviada]', ETAPA3_NOTA, APOS_PAGAMENTO_MSG, PERGUNTA_AGENDA].join('\n\n') }
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
